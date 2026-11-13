import { cloneBodyValue } from './request-body-copy';
import { once } from './once';
import type { AttemptRequest } from '../types';

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
const pendingByToken = new WeakMap<object, () => unknown>();

declare const pendingBodyBrand: unique symbol;

/** A token standing in for a body value; see `pendingByToken`. */
export interface PendingBody {
  readonly [pendingBodyBrand]: true;
}

/**
 * An attempt's request as the client holds it, whose `body` and `rawBody` may be tokens
 * (see `pendingByToken`): handed to an observer only as the copy `handedBodyValue` reads
 * them into, so one passed where caller code is handed an `AttemptRequest` does not type
 * check - for `body`; `rawBody` is typed `unknown` either way.
 */
export type HeldAttemptRequest = Omit<AttemptRequest, 'body' | 'rawBody'> & {
  body?: AttemptRequest['body'] | PendingBody;
  rawBody?: unknown;
};

/** The tokens whose build failure has been reported; see `claimBuildFailureReport`. */
const claimedFailures = new WeakSet<object>();

/**
 * A token for `build()`'s value, built once (see `once`): its value kept - and the build,
 * holding the source body, let go - or the error it threw, thrown again rather than built
 * again. See `pendingByToken`.
 */
function deferred(build: () => unknown): PendingBody {
  const token = Object.freeze({});
  pendingByToken.set(token, once(build));
  return token as PendingBody;
}

/** A token for the value `text` parses to; see `pendingByToken`. */
export function deferredJSONRawBody(text: string): PendingBody {
  return deferred(() => JSON.parse(text) as unknown);
}

/**
 * A token for a copy of the bytes or form an attempt sends; see `pendingByToken`. The
 * body is the attempt's own, which no caller holds and nothing changes once it is sent -
 * the adapter is handed a copy of a form, and a built-in network adapter copies bytes as
 * it is called (see `adapterRequestBody`) - so the copy taken when an observer is first
 * handed it is the body sent.
 */
export function deferredBodyCopy(body: Uint8Array | FormData): PendingBody {
  return deferred(() => cloneBodyValue(body));
}

/**
 * The value an observer is handed for a `body` or `rawBody` as an attempt's request holds
 * it: the value a token stands for, built the first time it is asked for and kept - or
 * the error the build threw, thrown again - or the value itself. Told by the token's own
 * record, so a caller's value - a best-effort snapshot's body, say - is never asked
 * anything.
 */
export function handedBodyValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const pending = pendingByToken.get(value);
  if (pending === undefined) {
    return value;
  }

  return pending();
}

/**
 * Claims the report of a failure `handedBodyValue` threw for `value`: `true` the first time
 * for a token, so its failure is reported then, and `false` after - the copies of one
 * attempt's request share its tokens, so a failure is reported once for the attempt,
 * whichever phases hand its request out, and once for a bytes or form `body` and `rawBody`
 * that share one token. A value that is no token is always claimed.
 */
export function claimBuildFailureReport(value: unknown): boolean {
  if (
    typeof value !== 'object' ||
    value === null ||
    !pendingByToken.has(value)
  ) {
    return true;
  }

  if (claimedFailures.has(value)) {
    return false;
  }

  claimedFailures.add(value);
  return true;
}
