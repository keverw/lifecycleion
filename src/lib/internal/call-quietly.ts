import { adoptPromise } from './adopt-promise';
import { isObjectLike } from './is-object-like';
import { noop, observeRejection } from './promise-reactions';

/**
 * Calls `method` on `target` for a teardown whose outcome changes nothing - a stream's
 * `cancel`, an iterator's `return`, a sink's `destroy` - minding no refusal: a throw is
 * contained, and any thenable it returns, another realm's promise or a polyfill's
 * included, is followed so its rejection is never left unhandled. A `method` that is not
 * a function is not called.
 */
export function callQuietly(method: unknown, target: unknown): void {
  if (typeof method !== 'function') {
    return;
  }

  try {
    const result: unknown = Reflect.apply(method, target, []);

    if (isObjectLike(result)) {
      observeRejection(adoptPromise(result), noop);
    }
  } catch {
    // A teardown that throws has nothing more to let go of.
  }
}
