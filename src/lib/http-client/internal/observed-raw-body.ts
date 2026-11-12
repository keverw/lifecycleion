/**
 * A JSON body's `rawBody` for the observers, parsed back from the text sent the first time
 * an observer is handed the attempt's request (see `handedRawBody`), rather than as the
 * attempt is dispatched: an attempt no observer runs for - a retry with only `final`
 * observers registered, an observer whose filter does not match - never parses it.
 *
 * The attempt's request holds a token in place of the value. The token is the client's:
 * a request holding one is never handed to caller code, only the copy `handedRawBody`
 * reads it into. The copies of one attempt's request share the token, and so the one
 * value parsed for it, as they would share a value parsed at dispatch.
 */
const pendingByToken = new WeakMap<object, { text: string; value?: unknown }>();

/** A token for the value `text` parses to; see `pendingByToken`. */
export function deferredJSONRawBody(text: string): object {
  const token = Object.freeze({});
  pendingByToken.set(token, { text });
  return token;
}

/**
 * The `rawBody` an observer is handed for `rawBody` as an attempt's request holds it: the
 * value a token stands for, parsed the first time it is asked for and kept, or `rawBody`
 * itself. Told by the token's own record, so a caller's value - a best-effort snapshot's
 * body, say - is never asked anything.
 */
export function handedRawBody(rawBody: unknown): unknown {
  if (typeof rawBody !== 'object' || rawBody === null) {
    return rawBody;
  }

  const pending = pendingByToken.get(rawBody);
  if (pending === undefined) {
    return rawBody;
  }

  if (!('value' in pending)) {
    pending.value = JSON.parse(pending.text) as unknown;
  }

  return pending.value;
}
