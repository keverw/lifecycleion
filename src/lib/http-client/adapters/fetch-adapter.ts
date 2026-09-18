import {
  extractFetchHeaders,
  resolveDetectedRedirectURL,
  stripCrossOriginURLCredentials,
} from '../utils';
import { guardProgressCallback } from '../internal/progress';
import { isTLSCertificateError } from '../internal/tls-error-utils';
import { REDIRECT_STATUS_CODES, RESPONSE_STREAM_ABORT_FLAG } from '../consts';
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
import { readMember as readObjectMember } from '../../internal/read-member';

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

    const { requestURL, method, headers, body, signal } = request;
    const dispatchedURL = stripCrossOriginURLCredentials(
      requestURL,
      request.initialURL,
    );

    // Fire 0% upload progress
    guardedUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

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
      guardedUploadProgress?.({ loaded: 1, total: 1, progress: 1 });
      guardedDownloadProgress?.({ loaded: 0, total: 0, progress: 1 });

      return {
        status: 0,
        wasRedirectDetected: true,
        headers: {},
        body: null,
      };
    }

    // Fire 100% upload + download progress (fetch has no real per-chunk progress)
    guardedUploadProgress?.({ loaded: 1, total: 1, progress: 1 });

    const responseHeadersForBody = extractFetchHeaders(response.headers);

    let rawBody: Uint8Array | null;

    try {
      rawBody = await readResponseBody(method, response);
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

async function readResponseBody(
  method: string,
  response: Response,
): Promise<Uint8Array | null> {
  if (method === 'HEAD' || response.status === 204 || response.status === 304) {
    return null;
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
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

  Object.assign(tagged, {
    [RESPONSE_STREAM_ABORT_FLAG]: true,
    streamAbortStatus: status,
    streamAbortHeaders: headers,
    cause: error,
  });

  return tagged;
}
