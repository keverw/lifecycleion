import {
  defineHiddenTags,
  markNonRetryableAdapterError,
  nonRetryableAdapterErrorFrom,
} from '../internal/adapter-error';
import {
  extractFetchHeaders,
  resolveDetectedRedirectURL,
  stripCrossOriginURLCredentials,
} from '../utils';
import {
  guardProgressCallback,
  knownBodyByteLength,
  uploadCompleteEvent,
} from '../internal/progress';
import { isTLSCertificateError } from '../internal/tls-error-utils';
import {
  hasResponseBody,
  makeResponseTooLargeError,
  parseContentLength,
  readMaxResponseBytes,
} from '../internal/response-limit';
import {
  REDIRECT_STATUS_CODES,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_ABORT_HEADERS_KEY,
  STREAM_ABORT_STATUS_KEY,
} from '../consts';
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
    // Guarded once, at the boundary, so every call site below is covered - including the
    // ones handed to `streamResponseBody`, `writeRequestBodyChunked` and
    // `serializeMultipartFormData`. Progress reporting is advisory and must not be able to
    // change whether a request succeeded; a throwing callback used to propagate out and be
    // classified as a transport failure. See `guardProgressCallback`.
    const guardedUploadProgress = guardProgressCallback(
      request.onUploadProgress,
      'onUploadProgress',
    );
    const guardedDownloadProgress = guardProgressCallback(
      request.onDownloadProgress,
      'onDownloadProgress',
    );

    const { requestURL, method, body, signal } = request;
    // The most a buffered body may hold, as `fetch` decodes it; `Infinity` for none.
    const maxResponseBytes = readMaxResponseBytes(request);
    // A caller's `Content-Length` is left to `fetch`, which frames the body itself:
    // browsers refuse to send one, and Node's undici, given one that disagrees with the
    // body, waited for bytes that never came until the attempt timed out - on every retry.
    const headers = withoutHeader(request.headers, 'content-length');
    const dispatchedURL = stripCrossOriginURLCredentials(
      requestURL,
      request.initialURL,
    );

    // Fire 0% upload progress
    guardedUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

    // Checked before it is sent, so a request fetch refuses to build - Node's fetch refuses
    // a URL carrying credentials, on every attempt - fails once as the non-retryable
    // `adapter_error` it is, rather than as a network error retried to no end. Built
    // without the body or signal, which `fetch` below takes, so nothing is consumed.
    //
    // Only where it can be: an absolute URL (a relative one resolves against a browser's
    // document, which `fetch` decides itself), and a runtime with `Request` - a test
    // setup that polyfills only `fetch` has none. The URL is tested with `new URL` in a
    // try of its own: `URL.canParse` is missing from older browsers and early Node 18,
    // and a check that throws there must not fail every request.
    let isAbsoluteURL = false;
    try {
      new URL(dispatchedURL);
      isAbsoluteURL = true;
    } catch {
      // Relative: `fetch` resolves it, or refuses it, as it always did.
    }

    if (isAbsoluteURL && typeof Request === 'function') {
      let builtMethod: string;
      try {
        builtMethod = new Request(dispatchedURL, {
          method,
          headers: materializeFetchHeaders(headers),
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

    let response: Response;

    try {
      response = await fetch(dispatchedURL, {
        method,
        headers: materializeFetchHeaders(headers),
        body: body as BodyInit | null,
        signal: signal ?? null,
        redirect: 'manual',
      });
    } catch (error) {
      // Re-throw AbortErrors and any error thrown when the signal is already
      // aborted. When abort(string) is called, fetch rejects with the string
      // itself (not an AbortError), so checking signal.aborted covers that case.
      if (isAbortError(error) || signal?.aborted) {
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
      if (isAbortError(error) || signal?.aborted) {
        throw markResponseStreamAbort(
          error,
          response.status,
          responseHeadersForBody,
        );
      }

      // Redirect detection is reported the same way as on the success path: the
      // headers arrived, so a 3xx here still knows where it was pointing, and a
      // truncated body must not lose the target an intact one would report.
      const detectedRedirectURL = resolveDetectedRedirectURL(
        dispatchedURL,
        response.status,
        responseHeadersForBody,
      );

      return {
        status: response.status,
        wasRedirectDetected:
          detectedRedirectURL !== undefined ||
          REDIRECT_STATUS_CODES.has(response.status),
        ...(detectedRedirectURL ? { detectedRedirectURL } : {}),
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
      const detectedRedirectURL = resolveDetectedRedirectURL(
        dispatchedURL,
        response.status,
        responseHeadersForBody,
      );

      return {
        status: response.status,
        wasRedirectDetected:
          detectedRedirectURL !== undefined ||
          REDIRECT_STATUS_CODES.has(response.status),
        ...(detectedRedirectURL ? { detectedRedirectURL } : {}),
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

    const responseHeaders = responseHeadersForBody;
    const detectedRedirectURL = resolveDetectedRedirectURL(
      dispatchedURL,
      response.status,
      responseHeaders,
    );

    return {
      status: response.status,
      // Server/runtime manual redirects reach this path as real 3xx responses.
      // Browser opaque redirects returned above never reach this branch.
      wasRedirectDetected:
        detectedRedirectURL !== undefined ||
        REDIRECT_STATUS_CODES.has(response.status),
      ...(detectedRedirectURL ? { detectedRedirectURL } : {}),
      headers: responseHeaders,
      body: rawBody,
    };
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

  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
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

  for await (const value of body) {
    const chunk =
      typeof value === 'string' ? new TextEncoder().encode(value) : value;
    loadedBytes += chunk.byteLength;

    if (loadedBytes > maxResponseBytes) {
      cancelBodyQuietly(body);
      return RESPONSE_TOO_LARGE;
    }

    chunks.push(chunk);
  }

  const bytes = new Uint8Array(loadedBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
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

function materializeFetchHeaders(
  headers: Record<string, string | string[]>,
): HeadersInit {
  let shouldUseHeadersObject = false;

  for (const value of Object.values(headers)) {
    if (Array.isArray(value)) {
      shouldUseHeadersObject = true;
      break;
    }
  }

  if (!shouldUseHeadersObject) {
    return headers as Record<string, string>;
  }

  const materialized = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      if (key.toLowerCase() === 'cookie') {
        materialized.set(key, value.join('; '));
      } else {
        for (const item of value) {
          materialized.append(key, item);
        }
      }
    } else {
      materialized.append(key, value);
    }
  }

  return materialized;
}

/**
 * Tag an abort thrown while reading the body with the response already received,
 * matching what NodeAdapter attaches to its response-stream aborts. The client
 * decides what the abort meant; this only makes the evidence survive the throw.
 *
 * `effectiveRequestHeaders` is omitted throughout this adapter: `fetch` exposes
 * no view of the final wire headers, and echoing the request's own back would
 * claim a proof it does not have.
 */
function markResponseStreamAbort(
  error: unknown,
  status: number,
  headers: Record<string, string | string[]>,
): unknown {
  // Per the Fetch Standard the rejection is the abort reason verbatim, so
  // returning it untagged sends the client down its early cancellation path and
  // drops the response headers, Set-Cookie included.
  //
  // Always a fresh object, never the reason itself: a signal hands the same
  // reason to every consumer, so two requests sharing one controller would
  // overwrite each other's status and headers (and a frozen reason would throw).
  // `name` is copied because the client routes on it.
  const original = asError(error);
  const originalMessage =
    original === undefined ? undefined : readObjectMember(original, 'message');
  const originalName =
    original === undefined ? undefined : readObjectMember(original, 'name');
  const tagged = new Error(
    typeof originalMessage === 'string' ? originalMessage : 'Request aborted',
  );

  tagged.name = typeof originalName === 'string' ? originalName : 'AbortError';

  // Hidden, as NodeAdapter's tags are: the response headers carry its `Set-Cookie`, and a
  // serialized error must not.
  defineHiddenTags(tagged, {
    [RESPONSE_STREAM_ABORT_FLAG]: true,
    [STREAM_ABORT_STATUS_KEY]: status,
    [STREAM_ABORT_HEADERS_KEY]: headers,
    cause: error,
  });

  return tagged;
}

/** `headers` without any entry named `name`, in any case; the same object when it has none. */
function withoutHeader(
  headers: Record<string, string | string[]>,
  name: string,
): Record<string, string | string[]> {
  const names = Object.keys(headers);
  if (!names.some((key) => key.toLowerCase() === name)) {
    return headers;
  }

  const result: Record<string, string | string[]> = {};
  for (const key of names) {
    if (key.toLowerCase() !== name) {
      result[key] = headers[key];
    }
  }

  return result;
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
