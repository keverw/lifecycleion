import { isObjectLike } from '../internal/is-object-like';
import { LoggerService } from '../logger/logger-service';
import { adoptResult, UnreadableReturn } from '../internal/adopt-promise';
import {
  applyIntrinsic,
  getIntrinsic,
  observePromise,
  observeRejection,
} from '../internal/intrinsics';
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
// Captured for identity comparison only; invocation always preserves the receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const builtinEntity = LoggerService.prototype.entity;

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
  //
  // A cached child is shared, so an assignment through it (`entity('db').warn = fn`)
  // outlives the call that made it, and it keeps the parts the service held when it was
  // built. Deliberately not guarded against: this guard is the manager's private logger,
  // over a service the manager made itself and never hands out, and the manager only
  // ever logs through its children - it never assigns to them or swaps the service's
  // private parts. Only the built-in `entity` is memoized; a custom one is called fresh.
  let entityCache: {
    method: unknown;
    call: (entityName: string) => LoggerService;
  } | null = null;

  // See the note on the proxy's target above. Inherits from `logger` so `instanceof`
  // and `in` still answer as they would for the service. Reads, assignments, deletes,
  // definitions and own-property reflection - `Object.keys()`,
  // `Object.getOwnPropertyDescriptor()` - are all forwarded, so what is defined through
  // the guard is also listed and described by it. The shadow is kept extensible and
  // empty, which is what lets every trap answer with the service's properties.
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
    // Definitions too, or one would land on the shadow, which no read below consults.
    // An explicitly non-configurable one is refused, the service left untouched: the
    // proxy may only accept it by holding the same property on the shadow, and every
    // read of that property would then have to answer with the shadow's value - or
    // throw. One that leaves `configurable` out would create a non-configurable
    // property just the same when the service has no own property of that name, so it
    // is defined as configurable instead, and can still be reassigned or redefined.
    defineProperty(_shadow, property, descriptor): boolean {
      if (descriptor.configurable === false) {
        return false;
      }

      if (
        descriptor.configurable === undefined &&
        !Object.hasOwn(target, property)
      ) {
        return Reflect.defineProperty(target, property, {
          ...descriptor,
          configurable: true,
        });
      }

      return Reflect.defineProperty(target, property, descriptor);
    },
    // The service's own keys and descriptors, so the guard lists and describes what it
    // reads. A non-configurable property is described as configurable: the proxy may
    // only report one as non-configurable if the shadow holds it, which is what the
    // shadow exists to avoid. A log method the service holds as an own data property is
    // described with the guarded wrapper a read returns, not the service's method, so a
    // descriptor-based copy of it stays guarded; every other value is the service's own.
    // Methods inherited from `LoggerService.prototype` are not own, so they are guarded
    // only when read through this proxy - a copy, or `Object.getPrototypeOf()`, which
    // answers with the service itself, reaches them unguarded. The guard is the
    // manager's private logger and is never handed out, so that is not a path it takes.
    ownKeys(): (string | symbol)[] {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(
      _shadow,
      property,
    ): PropertyDescriptor | undefined {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);

      if (descriptor === undefined) {
        return undefined;
      }

      if (
        Object.hasOwn(descriptor, 'value') &&
        typeof property === 'string' &&
        (property === 'entity' || Object.hasOwn(GUARDED_LOG_METHODS, property))
      ) {
        return {
          ...descriptor,
          value: getIntrinsic(guarded, property) as unknown,
          configurable: true,
        };
      }

      return { ...descriptor, configurable: true };
    },
    // Refused, so the shadow stays extensible: once it was not, every own property the
    // two traps above report would be one the proxy may not report, and a definition
    // forwarded to the service one it may not accept. Freezing or sealing the guard
    // throws instead of quietly locking nothing.
    preventExtensions(): boolean {
      return false;
    },
    get(_shadow, property): unknown {
      // `Object.hasOwn`, not `in`: `in` walks `Object.prototype`, so `toString` and
      // friends would come back as log methods and be wrapped. Everything else -
      // including the service's own fields - passes straight through untouched.
      if (
        typeof property !== 'string' ||
        (property !== 'entity' && !Object.hasOwn(GUARDED_LOG_METHODS, property))
      ) {
        // Contained like a method read below: anything probing the logger - `await`
        // reading `then`, a template literal reading `Symbol.toPrimitive`, a sink's
        // `JSON.stringify` reading `toJSON` - would otherwise throw at its call site
        // for a service whose accessor throws. Answered as absent.
        try {
          const passthrough: unknown = getIntrinsic(target, property, target);

          return passthrough;
        } catch (error) {
          reportCallbackError(
            `${GUARDED_LOGGER_LABEL}.${String(property)}`,
            error,
          );

          return undefined;
        }
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
        method = getIntrinsic(target, property, target);
      } catch (error) {
        reportCallbackError(`${GUARDED_LOGGER_LABEL}.${property}`, error);

        // Same fallbacks the call-time failures use: a no-op for a log method, and for
        // `entity` something the rest of the chain can still call.
        return property === 'entity'
          ? (): LoggerService => guarded
          : (): void => {};
      }

      if (property === 'entity') {
        // Custom factories may capture request or registration context even when
        // their method identity and entity name stay unchanged. Only the built-in
        // name-scoping implementation has the contract needed for memoization.
        if (method !== builtinEntity) {
          entityCache = null;
          return (entityName: string): LoggerService =>
            guardEntity(target, method, entityName, guarded);
        }

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

              // A failed entity method may recover without changing its identity.
              // Caching the parent fallback would silently discard entity context
              // until eviction or method replacement, so only successful children
              // are memoized and each failed invocation retains its own report.
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
  // Built once per wrapper rather than per log line.
  const onError = (error: unknown): void => {
    reportCallbackError(label, error);
  };

  return (...args: unknown[]): void => {
    // `runCallbackSafely` also covers a logger method that returns a rejecting promise, and
    // a `method` that is not a function at all. `target` as `thisArg` keeps it bound.
    runCallbackSafely(label, method, args, onError, target);
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
    // Use `applyIntrinsic`, not `method.call(...)`: that reads `call` off the untrusted
    // method, so one carrying its own `call` property would run that instead. A `method`
    // that is not a function throws here too, and is reported the same way.
    child = applyIntrinsic(method as (name: string) => unknown, target, [
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
  // Classification captures then once; both malformed returns and rejected
  // thenables remain contained, and no asynchronous child can be used as a logger.
  const pending = adoptResult(child);
  if (pending instanceof UnreadableReturn) {
    reportCallbackError(label, pending);
    return parent;
  }
  if (pending !== undefined) {
    const reported = observePromise(
      pending,
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
    // Reporting is the last boundary of this floating operation. Discard its
    // fulfillment and contain an unexpected reporter failure on either reaction,
    // just as the callback and sink observers do.
    observeRejection(reported, () => {});
    return parent;
  }

  // A function is an object too, and may well be a logger with call behavior.
  if (!isObjectLike(child)) {
    // A logger handing back a non-logger, which nothing else would surface.
    reportCallbackError(label, new Error(`${label} did not return a logger`));

    return parent;
  }

  return createGuardedLoggerService(child as LoggerService);
}
