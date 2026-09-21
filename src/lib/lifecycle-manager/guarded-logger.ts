import type { LoggerService } from '../logger/logger-service';
import { isPromise } from '../is-promise';
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
 * stop loop rejected the shutdown pass, whose `catch` then announced
 * `lifecycle-manager:shutdown-completed` with `success: false` while the components were
 * still running.
 *
 * Guarding at the logger rather than at each call site is what makes that impossible:
 * there is one wrapper, applied once in the constructor, instead of ~140 call sites that
 * each have to remember.
 *
 * A `Proxy` over the instance rather than a hand-written subclass or object literal:
 * `LoggerService` is a concrete class with private members, so the proxy is the only
 * shape that keeps the nominal type without copying its internals - and an assignment
 * through it (`logger.warn = fn`, which the hostile-logger tests use) still lands on the
 * underlying service.
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
  const guarded: LoggerService = new Proxy(logger, {
    get(target, property, receiver): unknown {
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

      // Resolved on every read rather than built once, because a read is what precedes
      // every call: a caller - and several tests - may replace a method on the underlying
      // service after construction, and a wrapper built once would keep calling the one
      // it replaced.
      //
      // Resolving here rather than inside the wrapper matters for the other half of that
      // swap. A test captures `logger.warn` (a wrapper), installs a throwing one, then
      // assigns the captured wrapper back. A wrapper that re-read `target.warn` when
      // called would then find itself and recurse forever; one that closed over what it
      // read calls the real method.
      const method: unknown = Reflect.get(target, property, target);

      if (property === 'entity') {
        return (entityName: string): LoggerService =>
          guardEntity(target, method, entityName, guarded);
      }

      return guardLogMethod(target, method, property);
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
    // `runCallbackSafely` also covers a logger method that returns a rejecting promise.
    //
    // TODO: the closure only exists to keep the method bound to `target`. Once
    // `runCallbackSafely` accepts a `thisArg` (PR #28), pass `method` with its args and
    // `target` as `thisArg` instead.
    runCallbackSafely(
      label,
      () => (method as (...callArgs: unknown[]) => unknown).apply(target, args),
      [],
      (error) => {
        reportCallbackError(label, error);
      },
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
 */
function guardEntity(
  target: LoggerService,
  method: unknown,
  entityName: string,
  parent: LoggerService,
): LoggerService {
  const label = `${GUARDED_LOGGER_LABEL}.entity`;
  let child: unknown;

  runCallbackSafely(
    label,
    () => {
      child = (method as (name: string) => unknown).call(target, entityName);

      // Returned so `runCallbackSafely` adopts a promise-returning `entity()` and
      // reports its rejection instead of leaving it floating.
      return child;
    },
    [],
    (error) => {
      reportCallbackError(label, error);
    },
  );

  if (isPromise(child)) {
    // `runCallbackSafely` adopted it above, so a rejection is already reported. Either
    // way a promise is not something the rest of the chain can call.
    return parent;
  }

  if (child === null || typeof child !== 'object') {
    // `undefined` is the shape of "it threw", which was reported above. Anything else is
    // a logger handing back a non-logger, which nothing else would surface.
    if (child !== undefined) {
      reportCallbackError(label, new Error(`${label} did not return a logger`));
    }

    return parent;
  }

  return createGuardedLoggerService(child as LoggerService);
}
