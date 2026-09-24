import type { LoggerService } from '../logger/logger-service';
import { adoptPromise, isAdoptable } from '../internal/adopt-promise';
import {
  reportCallbackError,
  runCallbackSafely,
} from '../safe-handle-callback';

/**
 * Prefix for every failure this module reports. The method name is appended, so a report
 * reads `Error in a callback lifecycle-manager logger.warn`.
 *
 * Deliberately generic. The guard sits at the logger, not at the ~140 call sites that
 * use it, so it cannot name the operation that was being logged - and a per-call-site
 * label was what made the old line-by-line guards expensive to keep correct. The thrown
 * value travels on `cause` (see {@link reportCallbackError}), and the logger's own
 * message and params are the caller's to recognize.
 */
const GUARDED_LOGGER_LABEL = 'lifecycle-manager logger';

/**
 * How many guarded `entity()` children one guarded logger keeps. The manager only ever
 * passes component names, so an ordinary app never gets near this; the cap is for one
 * that registers and unregisters uniquely named components - per job, per tenant - where
 * the cache would otherwise grow for the manager's whole lifetime. Past it, the least
 * recently used name is dropped and simply rebuilt if it is logged about again.
 */
const MAX_CACHED_ENTITY_CHILDREN = 256;

/**
 * Every `LoggerService` method whose call is routed through `runCallbackSafely`.
 *
 * `entity()` is absent because it returns a value and needs its own handling; everything
 * else returns `void`. Declared as a `Record` over the service's public surface minus
 * `entity` so that adding a method to `LoggerService` fails this file's type-check
 * instead of silently shipping an unguarded one.
 */
const GUARDED_LOG_METHODS: Record<
  Exclude<keyof LoggerService, 'entity'>,
  true
> = {
  debug: true,
  error: true,
  errorObject: true,
  info: true,
  notice: true,
  raw: true,
  success: true,
  warn: true,
};

/**
 * Wrap a `LoggerService` so none of its methods can throw or reject at the caller.
 *
 * `LifecycleManager` logs from inside OS signal handlers, timer callbacks, terminal
 * promise handlers, and the middle of its own startup and shutdown passes. The logger is
 * caller-supplied, so a method that throws - or returns a rejecting promise - used to
 * propagate into whichever lifecycle operation happened to be logging: a throw in the
 * stop loop rejected the shutdown pass, leaving the components it had not reached
 * running and every `lifecycle-manager:shutdown-completed` listener waiting on a pass
 * that was already over. The guard keeps a logger failure off that path entirely, rather
 * than relying on the pass reporting its own death.
 *
 * Guarding at the logger rather than at each call site is what makes that impossible:
 * there is one wrapper, applied once in the constructor, instead of ~140 call sites that
 * each have to remember.
 *
 * A `Proxy` rather than a hand-written subclass or object literal: `LoggerService` is a
 * concrete class with private members, so the proxy is the only shape that keeps the
 * nominal type without copying its internals - and an assignment through it
 * (`logger.warn = fn`, which the hostile-logger tests use) still lands on the
 * underlying service.
 *
 * Its target is a fresh object inheriting from the service, not the service itself. A
 * proxy may not answer a read of its target's non-configurable own properties with
 * anything but their actual values, so over a frozen service - or one with a frozen
 * method - the engine would throw on the read itself, outside every guard here, or hand
 * the method back unguarded. The fresh object has no own properties to hold the proxy
 * to, so every method is guarded whatever the service does to its own.
 *
 * Every failure is reported on the global `'error'` channel through
 * {@link reportCallbackError}, never through the logger: the logger is the likeliest
 * thing to have just failed.
 *
 * This is the manager's *own* logger. The caller's `Logger` is kept unwrapped as
 * `rootLogger` - `setBeforeExitCallback`, `exit()`, and anything handed to components or
 * user code must stay the object the caller passed in.
 *
 * @param logger The service logger to guard. Never modified.
 * @returns A guarded stand-in with the same type and the same log output.
 */
export function createGuardedLoggerService(
  logger: LoggerService,
): LoggerService {
  // Each wrapper is built once per method it wraps and then reused, rather than on
  // every read: the manager's logger is its own private service logger, so in practice
  // every method stays the same for the manager's lifetime and each is wrapped once.
  // Keyed on the resolved method rather than on the property name alone, so a method
  // replaced after construction - which the hostile-logger tests do - still gets a
  // wrapper of its own on the next read.
  const methodWrappers = new Map<
    string,
    { method: unknown; wrapper: (...args: unknown[]) => void }
  >();

  // Guarded children of `entity()`, by entity name, for the `entity` method that built
  // them. `LoggerService.entity()` builds a fresh logger from the same parts plus the
  // name on every call, so one child per name answers every later call the same way.
  // Capped at `MAX_CACHED_ENTITY_CHILDREN`. Dropped whenever the resolved `entity`
  // changes, and a call that failed - and fell back to this parent - is never cached, so
  // each failure is still reported when it happens.
  let entityCache: {
    method: unknown;
    call: (entityName: string) => LoggerService;
  } | null = null;

  // See the note on the proxy's target above. Inherits from `logger` so `instanceof`
  // and `in` still answer as they would for the service. Only reads, assignments and
  // deletes are forwarded: `Object.keys()`, `Object.getOwnPropertyDescriptor()` and
  // `Object.defineProperty()` see the empty target, not the service. The manager never
  // does any of those; forwarding them would bring back the invariants the empty
  // target exists to avoid, so add traps only if the guarded logger is ever handed to
  // code that does.
  const shadow = Object.create(logger) as LoggerService;
  const target = logger;

  const guarded: LoggerService = new Proxy(shadow, {
    // Assignments and deletes go to the service, where every read below looks.
    set(_shadow, property, value): boolean {
      return Reflect.set(target, property, value);
    },
    deleteProperty(_shadow, property): boolean {
      return Reflect.deleteProperty(target, property);
    },
    get(_shadow, property, receiver): unknown {
      // `Object.hasOwn`, not `in`: `in` walks `Object.prototype`, so `toString` and
      // friends would come back as log methods and be wrapped. Everything else -
      // including the service's own fields - passes straight through untouched.
      if (
        typeof property !== 'string' ||
        (property !== 'entity' && !Object.hasOwn(GUARDED_LOG_METHODS, property))
      ) {
        const passthrough: unknown = Reflect.get(target, property, receiver);

        return passthrough;
      }

      // Resolved on every read - a cheap property read - even though the wrapper built
      // from it is cached below, because a read is what precedes every call: a caller -
      // and several tests - may replace a method on the underlying service after
      // construction, and a wrapper built once would keep calling the one it replaced.
      //
      // Resolving here rather than inside the wrapper matters for the other half of that
      // swap. A test captures `logger.warn` (a wrapper), installs a throwing one, then
      // assigns the captured wrapper back. A wrapper that re-read `target.warn` when
      // called would then find itself and recurse forever; one that closed over what it
      // read calls the real method.
      //
      // Contained, because the read itself runs code the caller owns: a logger whose
      // `warn` is a getter that throws would otherwise escape every guard below, the
      // read happening before there is a wrapper to route through.
      let method: unknown;

      try {
        method = Reflect.get(target, property, target);
      } catch (error) {
        reportCallbackError(`${GUARDED_LOGGER_LABEL}.${property}`, error);

        // Same fallbacks the call-time failures use: a no-op for a log method, and for
        // `entity` something the rest of the chain can still call.
        return property === 'entity'
          ? (): LoggerService => guarded
          : (): void => {};
      }

      if (property === 'entity') {
        if (entityCache === null || entityCache.method !== method) {
          // A plain `Map` kept in recency order, not the repo's `LRUCache`: that one
          // sizes every value it stores, which for a logger child means
          // `JSON.stringify` - running the child's getters and `toJSON`, caller code,
          // outside every guard here - and costs more per hit than the lookup it saves.
          // String keys, so nothing below can throw.
          const children = new Map<string, LoggerService>();

          entityCache = {
            method,
            call: (entityName: string): LoggerService => {
              const cached = children.get(entityName);

              if (cached !== undefined) {
                // Re-inserted, so the oldest entry is the least recently used one.
                children.delete(entityName);
                children.set(entityName, cached);

                return cached;
              }

              const child = guardEntity(target, method, entityName, guarded);

              if (child !== guarded) {
                if (children.size >= MAX_CACHED_ENTITY_CHILDREN) {
                  const oldest = children.keys().next();

                  if (!oldest.done) {
                    children.delete(oldest.value);
                  }
                }

                children.set(entityName, child);
              }

              return child;
            },
          };
        }

        return entityCache.call;
      }

      const cachedWrapper = methodWrappers.get(property);

      if (cachedWrapper !== undefined && cachedWrapper.method === method) {
        return cachedWrapper.wrapper;
      }

      const wrapper = guardLogMethod(target, method, property);

      methodWrappers.set(property, { method, wrapper });

      return wrapper;
    },
  });

  return guarded;
}

/**
 * Build the stand-in for one `void`-returning log method.
 */
function guardLogMethod(
  target: LoggerService,
  method: unknown,
  property: string,
): (...args: unknown[]) => void {
  const label = `${GUARDED_LOGGER_LABEL}.${property}`;

  return (...args: unknown[]): void => {
    // `runCallbackSafely` also covers a logger method that returns a rejecting promise, and
    // a `method` that is not a function at all. `target` as `thisArg` keeps it bound.
    runCallbackSafely(
      label,
      method,
      args,
      (error) => {
        reportCallbackError(label, error);
      },
      target,
    );
  };
}

/**
 * Build the guarded child for `entity()`.
 *
 * `entity()` returns a value, so it cannot simply be fired through
 * `runCallbackSafely` and forgotten: a chain like `logger.entity(name).info(...)` needs
 * something callable back even when the entity call itself fails. When it does - it
 * threw, it returned a promise, or it returned something that is not an object - the
 * failure is reported and the guarded *parent* is returned. That loses the entity name
 * from the line, which is the smaller loss: the chain still logs and still cannot throw.
 * A promise is a non-logger like any other, reported once when it settles - with the
 * rejection reason if it rejects, or as a non-logger return if it resolves.
 */
function guardEntity(
  target: LoggerService,
  method: unknown,
  entityName: string,
  parent: LoggerService,
): LoggerService {
  const label = `${GUARDED_LOGGER_LABEL}.entity`;
  let child: unknown;

  try {
    // `Reflect.apply`, not `method.call(...)`: that reads `call` off the untrusted
    // method, so one carrying its own `call` property would run that instead. A `method`
    // that is not a function throws here too, and is reported the same way.
    child = Reflect.apply(method as (name: string) => unknown, target, [
      entityName,
    ]);
  } catch (error) {
    reportCallbackError(label, error);

    return parent;
  }

  // A promise is an object, so it is checked first; it is a non-logger like any other,
  // since nothing in the chain can call it. Reported once it settles rather than now: a
  // rejection carries the reason, which is the more useful report, and one that
  // resolves still says so. Nothing is left floating either way.
  //
  // Contained, because detecting and adopting a thenable each read `child.then`, and
  // that read runs code the logger owns: a `then` getter that throws would otherwise
  // escape here, past every other guard.
  //
  // Through `adoptPromise()` rather than `.then`: `Promise.resolve()` hands a native
  // promise back as it is, own `then` property included, and a no-op one there would
  // swallow the rejection, leaving it unhandled.
  try {
    if (isAdoptable(child)) {
      void adoptPromise(child).then(
        () => {
          reportCallbackError(
            label,
            new Error(`${label} did not return a logger`),
          );
        },
        (error: unknown) => {
          reportCallbackError(label, error);
        },
      );

      return parent;
    }
  } catch (error) {
    reportCallbackError(label, error);

    return parent;
  }

  // A function is an object too, and may well be a logger with call behavior.
  if (
    child === null ||
    (typeof child !== 'object' && typeof child !== 'function')
  ) {
    // A logger handing back a non-logger, which nothing else would surface.
    reportCallbackError(label, new Error(`${label} did not return a logger`));

    return parent;
  }

  return createGuardedLoggerService(child as LoggerService);
}
