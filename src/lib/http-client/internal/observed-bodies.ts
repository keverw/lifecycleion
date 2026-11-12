import { cloneBodyValue } from './request-body-copy';

/**
 * The parts of an attempt's body its observers are handed but that cost something to
 * build - a JSON body's `rawBody`, parsed back from the text sent; a copy of the bytes or
 * form sent - built the first time an observer is handed the attempt's request (see
 * `handedBodyValue`): an attempt no observer runs for - a retry with only `final`
 * observers registered, an observer whose filter does not match - never builds them.
 *
 * The attempt's request holds a token in place of each value. The token is the client's:
 * a request holding one is never handed to caller code, only the copy `handedBodyValue`
 * reads it into. The copies of one attempt's request share the token, and so the one
 * value built for it, as an attempt's bytes or form `body` and `rawBody` share one token.
 */
const pendingByToken = new WeakMap<
  object,
  { build: () => unknown; value?: unknown }
>();

/** A token for `build()`'s value; see `pendingByToken`. */
function deferred(build: () => unknown): object {
  const token = Object.freeze({});
  pendingByToken.set(token, { build });
  return token;
}

/** A token for the value `text` parses to; see `pendingByToken`. */
export function deferredJSONRawBody(text: string): object {
  return deferred(() => JSON.parse(text) as unknown);
}

/**
 * A token for a copy of the bytes or form an attempt sends; see `pendingByToken`. The
 * body is the attempt's own, which no caller holds and nothing changes once it is sent -
 * the adapter is handed a copy of a form, and a built-in network adapter copies bytes as
 * it is called (see `adapterRequestBody`) - so the copy taken when an observer is first
 * handed it is the body sent.
 */
export function deferredBodyCopy(body: Uint8Array | FormData): object {
  return deferred(() => cloneBodyValue(body));
}

/**
 * The value an observer is handed for a `body` or `rawBody` as an attempt's request holds
 * it: the value a token stands for, built the first time it is asked for and kept, or the
 * value itself. Told by the token's own record, so a caller's value - a best-effort
 * snapshot's body, say - is never asked anything.
 */
export function handedBodyValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const pending = pendingByToken.get(value);
  if (pending === undefined) {
    return value;
  }

  if (!('value' in pending)) {
    pending.value = pending.build();
  }

  return pending.value;
}
