import {
  deleteHeader,
  joinCookieHeader,
  lowerCaseHeaderName,
} from '../internal/header-utils';
import { defineEntry } from '../../internal/define-entry';
import { concatChunks } from '../internal/concat-chunks';
import {
  isSignalAborted,
  isSignalAbortedQuietly,
  readAdapterRequestFields,
} from '../internal/request-fields';
import {
  markResponseStreamAbort,
  markNonRetryableAdapterError,
  nonRetryableAdapterErrorFrom,
} from '../internal/adapter-error';
import {
  extractFetchHeaders,
  derivedRedirectFields,
  stripCrossOriginURLCredentials,
} from '../utils';
import { knownBodyByteLength, uploadCompleteEvent } from '../internal/progress';
import { isTLSCertificateError } from '../internal/tls-error-utils';
import {
  hasResponseBody,
  makeResponseTooLargeError,
  parseContentLength,
} from '../internal/response-limit';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
} from '../types';
// Shared error normalization preserves Error instances and wraps other thrown values.
// Non-Error values receive a "Non-error value thrown: <description>" message, with the
// original value retained on cause for consumers of the normalized error.
import { isErrorValue, toError as normalizeError } from '../../to-error';
// Guard error members for the same reason adapter marker reads are guarded.
import {
  readMember as readObjectMember,
  readUnknownMember,
} from '../../internal/read-member';

export class FetchAdapter implements HTTPAdapter {
  public getType(): AdapterType {
    return 'fetch';
  }

  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    // `maxResponseBytes` is the most a buffered body may hold, as `fetch` decodes it.
    const {
      guardedUploadProgress,
      guardedDownloadProgress,
      body,
      signal,
      headers,
      method,
      maxResponseBytes,
      requestURL,
      initialURL,
    } = readAdapterRequestFields(request);
    const dispatchedURL = stripCrossOriginURLCredentials(
      requestURL,
      initialURL,
    );
    // A caller's `Content-Length` is left to `fetch`, which frames the body itself:
    // browsers refuse to send one, and Node's undici, given one that disagrees with the
    // body, waited for bytes that never came until the attempt timed out - on every retry.
    // Taken off the adapter's own copy, in place.
    deleteHeader(headers, 'content-length');

    // Fire 0% upload progress
    guardedUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

    // Checked before it is sent, so a request fetch refuses to build - Node's fetch refuses
    // a URL carrying credentials, on every attempt - fails once as the non-retryable
    // `adapter_error` it is, rather than as a network error retried to no end. Built
    // without the body or signal, which `fetch` below takes, so nothing is consumed.
    //
    // Only where it can be: a URL that resolves (see `resolveProbeURL`), and a runtime
    // with `Request` - a test setup that polyfills only `fetch` has none.
    //
    // The headers it is built with are kept for `fetch` below, so they are materialized
    // once; where it is not built, `fetch` materializes them inside its own `try`.
    let fetchHeaders: HeadersInit | undefined;

    // A relative URL is checked too, resolved as `fetch` resolves it: unchecked, a header
    // value or method `fetch` refuses came back as its `TypeError`, retried as a network
    // failure to no end. Only where there is a base to resolve against; elsewhere `fetch`
    // resolves it, or refuses it, as it always did.
    const probeURL = resolveProbeURL(dispatchedURL);

    if (probeURL !== undefined && typeof Request === 'function') {
      let builtMethod: string;
      try {
        fetchHeaders = materializeFetchHeaders(headers);
        builtMethod = new Request(probeURL, {
          method,
          headers: fetchHeaders,
          redirect: 'manual',
        }).method;
      } catch (error) {
        // On a carrier: the throw may be the caller's own, from a header value.
        throw nonRetryableAdapterErrorFrom(error);
      }

      // A runtime that rewrites the method - Bun's fetch reads one it does not know as
      // `GET` - would send a different request than the caller's, and report its answer
      // as a success: a state-changing custom verb landing on a GET handler. Refused.
      if (builtMethod.toUpperCase() !== method.toUpperCase()) {
        const refusal = new Error(
          `[FetchAdapter] This runtime's fetch would send the ${method} request as ${builtMethod}. Use NodeAdapter for it.`,
        );
        markNonRetryableAdapterError(refusal);
        throw refusal;
      }
    }

    // Read through the guarded accessor before anything is dispatched, as the other
    // adapters read it: `fetch` reads the signal's internal state, not the getter, so a
    // signal whose `aborted` throws went out unrefused. An aborted one is `fetch`'s to
    // reject, with its reason. The failure paths below read it quietly.
    const wasAbortedAtDispatch = isSignalAborted(signal);

    let response: Response;

    try {
      response = await fetch(dispatchedURL, {
        method,
        headers: fetchHeaders ?? materializeFetchHeaders(headers),
        body: body as BodyInit | null,
        signal: signal ?? null,
        redirect: 'manual',
      });
    } catch (error) {
      // Re-throw AbortErrors and any error thrown when the signal is already
      // aborted. When abort(string) is called, fetch rejects with the string
      // itself (not an AbortError), so checking signal.aborted covers that case.
      if (
        isAbortError(error) ||
        wasAbortedAtDispatch ||
        isSignalAbortedQuietly(signal)
      ) {
        throw error; // preserve cancellation / timeout classification
      }

      const normalizedError = normalizeError(error);

      // A request Node's undici refuses at dispatch rather than at `new Request` - a
      // `keep-alive`, `expect` or `upgrade` header, a fetch-blocked port - is refused the
      // same way on every attempt, so it fails once as the non-retryable `adapter_error`
      // it is, as the `new Request` refusals above do, rather than as a network error
      // retried to no end with nothing sent.
      if (isFetchDispatchRefusal(normalizedError)) {
        throw nonRetryableAdapterErrorFrom(normalizedError);
      }

      // TLS certificate failures → 495, matching NodeAdapter. A rejected
      // certificate fails identically every time, and `status: 0` is retryable.
      // Server runtimes only: Bun puts the OpenSSL code on the error and Node
      // hangs it off `cause`, while a browser reports an opaque `TypeError`.
      if (isTLSCertificateError(normalizedError)) {
        return {
          status: 495,
          isTransportError: true,
          isRetryable: false,
          headers: {},
          body: null,
          errorCause: normalizedError,
        };
      }

      return {
        status: 0,
        isTransportError: true,
        headers: {},
        body: null,
        errorCause: normalizedError,
      };
    }

    // Browser-only: `redirect: 'manual'` in a browser context yields an opaque
    // redirect response (status 0, no accessible Location header) due to CORS
    // security constraints. In server runtimes (Bun, Node) `redirect: 'manual'`
    // returns the real 3xx with a Location header, so this branch is never hit
    // there — the real status falls through to the normal return path below and
    // HTTPClient's redirect loop handles it as usual.
    if (response.type === 'opaqueredirect') {
      // Even though the client will classify this as redirect_disabled, the
      // browser completed the fetch operation. Emit terminal progress so the
      // browser adapters match the server/mock adapters' completion semantics.
      guardedUploadProgress?.(uploadCompleteEvent(knownBodyByteLength(body)));
      guardedDownloadProgress?.({ loaded: 0, total: 0, progress: 1 });

      return {
        status: 0,
        wasRedirectDetected: true,
        headers: {},
        body: null,
      };
    }

    // Fire 100% upload + download progress (fetch has no real per-chunk progress)
    guardedUploadProgress?.(uploadCompleteEvent(knownBodyByteLength(body)));

    const responseHeadersForBody = extractFetchHeaders(response.headers);

    let rawBody: Uint8Array | null | typeof RESPONSE_TOO_LARGE;

    try {
      rawBody = await readResponseBody(method, response, maxResponseBytes);
    } catch (error) {
      // Headers already arrived, so the status is real and the body transfer is
      // what failed. Resolve with isStreamError rather than throwing, which would
      // land on the client's generic network path as a retryable status 0.
      //
      // An abort is re-thrown so a cancellation stays a cancellation, but
      // `signal` is the composite attempt signal — this adapter cannot tell a
      // per-attempt timeout from a caller cancel. So the response metadata rides
      // out with the error, the way NodeAdapter tags its aborts, and the client
      // sorts it: cancel stays cancelled, a post-header timeout becomes a
      // terminal stream error with the real status.
      if (
        isAbortError(error) ||
        wasAbortedAtDispatch ||
        isSignalAbortedQuietly(signal)
      ) {
        throw markResponseStreamAbort(
          error,
          response.status,
          responseHeadersForBody,
        );
      }

      // Redirect detection is reported the same way as on the success path: the
      // headers arrived, so a 3xx here still knows where it was pointing, and a
      // truncated body must not lose the target an intact one would report.
      return {
        status: response.status,
        ...derivedRedirectFields(
          dispatchedURL,
          response.status,
          responseHeadersForBody,
        ),
        headers: responseHeadersForBody,
        body: null,
        isStreamError: true,
        // fetch buffers the body for us, so there is no per-chunk delivery to
        // distinguish a local write failure from an upstream stream failure.
        // Everything reaching here is an upstream/transfer failure.
        streamErrorCode: 'stream_response_error',
        errorCause: normalizeError(error),
      };
    }

    // A body over the limit fails as a stream error with the real status, as a body that
    // failed in transit does just above: the server answered, and what failed is taking
    // delivery. No terminal progress, for the reason a failed read reports none.
    if (rawBody === RESPONSE_TOO_LARGE) {
      return {
        status: response.status,
        ...derivedRedirectFields(
          dispatchedURL,
          response.status,
          responseHeadersForBody,
        ),
        headers: responseHeadersForBody,
        body: null,
        isStreamError: true,
        streamErrorCode: 'response_too_large',
        errorCause: makeResponseTooLargeError(maxResponseBytes, false),
      };
    }

    guardedDownloadProgress?.({
      loaded: rawBody?.length ?? 0,
      total: rawBody?.length ?? 0,
      progress: 1,
    });

    return {
      status: response.status,
      // Server/runtime manual redirects reach this path as real 3xx responses.
      // Browser opaque redirects returned above never reach this branch.
      ...derivedRedirectFields(
        dispatchedURL,
        response.status,
        responseHeadersForBody,
      ),
      headers: responseHeadersForBody,
      body: rawBody,
    };
  }
}

/**
 * The URL to check a request against before it is sent: `url` itself when absolute, or
 * resolved as `fetch` resolves it - against the document's base URL in a window (which a
 * `<base href>` sets), the global `location` in a worker; `undefined` when it is relative
 * and there is no base. Tested with `new URL` in a `try`: `URL.canParse` is missing from
 * older browsers and early Node 18, and a check that throws there must not fail every
 * request.
 */
function resolveProbeURL(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    // Relative: resolved below, where there is a base.
  }

  try {
    const documentBase = readUnknownMember(
      readUnknownMember(globalThis, 'document'),
      'baseURI',
    );
    const base =
      typeof documentBase === 'string'
        ? documentBase
        : readUnknownMember(readUnknownMember(globalThis, 'location'), 'href');
    return typeof base === 'string' ? new URL(url, base).href : undefined;
  } catch {
    return undefined;
  }
}

/** What {@link readResponseBody} answers for a body over `maxResponseBytes`. */
const RESPONSE_TOO_LARGE = Symbol('response too large');

/**
 * The response body's bytes, `null` for a response that carries none, or
 * {@link RESPONSE_TOO_LARGE} once the body passes `maxResponseBytes`.
 *
 * With a limit, the body is read chunk by chunk and counted as it arrives, so a body over
 * it is cancelled - the rest neither downloaded nor held - rather than buffered whole by
 * `arrayBuffer()` and refused afterwards. Without one, or without a readable `body` (a
 * test double, an older runtime), it is read as it always was.
 */
async function readResponseBody(
  method: string,
  response: Response,
  maxResponseBytes: number,
): Promise<Uint8Array | null | typeof RESPONSE_TOO_LARGE> {
  if (!hasResponseBody(method, response.status)) {
    return null;
  }

  if (maxResponseBytes === Number.POSITIVE_INFINITY) {
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  // Refused before reading when the body says up front it is over the limit - only where
  // its `Content-Length` counts what `fetch` hands over, which is the decoded body: so
  // not when a coding is applied, nor when one may be hidden. A browser exposes
  // `Content-Encoding` on a cross-origin (`cors`) response only when the server lists it
  // in `Access-Control-Expose-Headers`, so its absence there proves nothing.
  const contentEncoding = response.headers.get('content-encoding');
  const isIdentityEncoded =
    contentEncoding === null
      ? response.type !== 'cors'
      : contentEncoding
          .split(',')
          .every((token) =>
            ['', 'identity'].includes(token.trim().toLowerCase()),
          );
  const declaredLength = isIdentityEncoded
    ? parseContentLength(response.headers.get('content-length'))
    : undefined;

  if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
    cancelBodyQuietly(response.body);
    return RESPONSE_TOO_LARGE;
  }

  // Read through a reader only where the body is a web stream. A polyfilled `fetch`
  // (node-fetch, cross-fetch) hands over a Node `Readable`, which has no `getReader`, and
  // a test double may hand over anything: they are read whole and checked after, as
  // before the limit was read through a reader.
  const body: unknown = response.body;

  if (!body || typeof readUnknownMember(body, 'getReader') !== 'function') {
    // A Node `Readable` is async-iterable: read it a chunk at a time as well, so a body
    // over the limit is neither read whole first nor left holding its socket.
    if (
      body &&
      typeof (body as { [Symbol.asyncIterator]?: unknown })[
        Symbol.asyncIterator
      ] === 'function'
    ) {
      return await readIterableBody(
        body as AsyncIterable<Uint8Array | string>,
        maxResponseBytes,
      );
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    return bytes.length > maxResponseBytes ? RESPONSE_TOO_LARGE : bytes;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  while (true) {
    const { done: isDone, value } = await reader.read();

    if (isDone) {
      break;
    }

    loadedBytes += value.byteLength;

    // Counted before the chunk is kept, so a body over the limit is never held whole.
    // Cancelled, not awaited: the cancel settles once the stream has let go, and the
    // answer here does not depend on when that is.
    if (loadedBytes > maxResponseBytes) {
      reader.cancel().catch(() => {
        // The body is being discarded; a stream that fails to cancel has nothing to add.
      });
      return RESPONSE_TOO_LARGE;
    }

    chunks.push(value);
  }

  return concatChunks(chunks, loadedBytes);
}

/**
 * A polyfilled `fetch`'s async-iterable body (a Node `Readable`) read a chunk at a time,
 * counted as it comes and released the moment it passes the limit.
 */
async function readIterableBody(
  body: AsyncIterable<Uint8Array | string>,
  maxResponseBytes: number,
): Promise<Uint8Array | typeof RESPONSE_TOO_LARGE> {
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;

  const encoder = new TextEncoder();

  for await (const value of body) {
    const chunk = typeof value === 'string' ? encoder.encode(value) : value;
    loadedBytes += chunk.byteLength;

    if (loadedBytes > maxResponseBytes) {
      cancelBodyQuietly(body);
      return RESPONSE_TOO_LARGE;
    }

    chunks.push(chunk);
  }

  return concatChunks(chunks, loadedBytes);
}

/**
 * Let go of a body that will not be read, ignoring one that refuses: a web stream is
 * cancelled, and a polyfilled `fetch`'s Node `Readable` - which has no `cancel` - is
 * destroyed, so its socket is not held with the body unread.
 */
function cancelBodyQuietly(body: unknown): void {
  if (!body) {
    return;
  }

  try {
    const cancel = readUnknownMember(body, 'cancel');
    if (typeof cancel === 'function') {
      const cancelled: unknown = cancel.call(body);
      if (cancelled instanceof Promise) {
        cancelled.catch(() => {
          // The body is being discarded; a stream that fails to cancel has nothing to add.
        });
      }
      return;
    }

    const destroy = readUnknownMember(body, 'destroy');
    if (typeof destroy === 'function') {
      destroy.call(body);
    }
  } catch {
    // A locked or already-cancelled stream: nothing left to release.
  }
}

function isAbortError(error: unknown): boolean {
  const normalized = asError(error);

  return (
    normalized !== undefined &&
    readObjectMember(normalized, 'name') === 'AbortError'
  );
}

/**
 * Return an Error value without letting a Proxy prototype trap escape.
 *
 * The shared check, not a local `instanceof`, so this answers the same question
 * `normalizeError` above already answers: an error built in another realm - a `vm`
 * context, an iframe - fails `instanceof` while being an error in every respect. A
 * cross-realm `AbortError` was therefore invisible to `isAbortError`.
 */
function asError(value: unknown): Error | undefined {
  return isErrorValue(value) ? value : undefined;
}

/**
 * The request headers as `fetch` takes them, each value read once: a fresh record, or a
 * `Headers` when a value repeats. Never the caller's own object, which the build check
 * and `fetch` would each read again - a getter could answer one and send the other.
 */
function materializeFetchHeaders(
  headers: Record<string, string | string[]>,
): HeadersInit {
  const entries = Object.entries(headers);
  // The `Cookie` field built by NodeAdapter's rule on either path (see `joinCookieHeader`),
  // so whether it is sent, and how, does not turn on how the other headers are given.
  const cookie = joinCookieHeader(entries);

  // A `Headers` whenever a value repeats as an array.
  if (!entries.some(([, value]) => Array.isArray(value))) {
    const record: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (lowerCaseHeaderName(key) !== 'cookie') {
        defineEntry(record, key, value as string);
      }
    }
    if (cookie !== undefined) {
      defineEntry(record, cookie.name, cookie.value);
    }
    return record;
  }

  const materialized = new Headers();

  for (const [key, value] of entries) {
    if (lowerCaseHeaderName(key) === 'cookie') {
      // Joined below, every spelling at once.
      continue;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        materialized.append(key, item);
      }
    } else {
      materialized.append(key, value);
    }
  }

  // As NodeAdapter sends it: `append` would join with `, `, which reads as one cookie.
  if (cookie !== undefined) {
    materialized.set(cookie.name, cookie.value);
  }

  return materialized;
}

/**
 * Whether `fetch` failed because the runtime refused to dispatch the request at all:
 * undici's invalid-argument and not-supported refusals (a `keep-alive`, `expect`,
 * `transfer-encoding` or `upgrade` header), and the Fetch standard's blocked ports. Read
 * off the `cause` Node hangs them on, guardedly; a browser's opaque `TypeError` is none.
 */
function isFetchDispatchRefusal(error: Error): boolean {
  const cause = readUnknownMember(error, 'cause');
  const code = readUnknownMember(cause, 'code');
  const message = readUnknownMember(cause, 'message');

  return (
    code === 'UND_ERR_INVALID_ARG' ||
    code === 'UND_ERR_NOT_SUPPORTED' ||
    (typeof message === 'string' && message.toLowerCase() === 'bad port')
  );
}
