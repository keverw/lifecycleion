import { extractFetchHeaders, resolveDetectedRedirectURL } from '../utils';
import { isTLSCertificateError } from '../internal/tls-error-utils';
import { REDIRECT_STATUS_CODES, RESPONSE_STREAM_ABORT_FLAG } from '../consts';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
} from '../types';

export class FetchAdapter implements HTTPAdapter {
  public getType(): AdapterType {
    return 'fetch';
  }

  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    const { requestURL, method, headers, body, signal } = request;

    // Fire 0% upload progress
    request.onUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

    let response: Response;

    try {
      response = await fetch(requestURL, {
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
      // certificate is deterministic: the same request against the same server
      // will fail identically, so retrying only burns the policy's attempts.
      // Without this the failure arrives as `status: 0`, which is retryable.
      //
      // Server runtimes only. Bun exposes the OpenSSL code on the error and
      // Node hangs it off `cause`, both of which are recognized; a browser
      // reports an opaque `TypeError` with neither, so this cannot fire there
      // and such a failure keeps the ordinary transport-error shape.
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
      request.onUploadProgress?.({ loaded: 1, total: 1, progress: 1 });
      request.onDownloadProgress?.({ loaded: 0, total: 0, progress: 1 });

      return {
        status: 0,
        wasRedirectDetected: true,
        headers: {},
        body: null,
      };
    }

    // Fire 100% upload + download progress (fetch has no real per-chunk progress)
    request.onUploadProgress?.({ loaded: 1, total: 1, progress: 1 });

    const responseHeadersForBody = extractFetchHeaders(response.headers);

    let rawBody: Uint8Array | null;

    try {
      rawBody = await readResponseBody(method, response);
    } catch (error) {
      // Headers already arrived, so the server responded and the status is
      // real — the body transfer is what failed (peer reset mid-body, premature
      // close, short read against Content-Length). Resolve with isStreamError
      // and the real status rather than throwing, which would land on the
      // client's generic network-error path as status 0 and be eligible for
      // retry. The request reached the server, so replay is not safe.
      //
      // An abort here is re-thrown rather than resolved, so a cancellation stays
      // a cancellation. But `signal` is the client's composite attempt signal,
      // aborted for a per-attempt timeout as much as for a caller cancel, and
      // this adapter cannot tell the two apart — only the client knows which
      // fired.
      //
      // So the error carries the response metadata out with it, the way
      // NodeAdapter tags its response-stream aborts. The client already sorts
      // it: a caller cancel resolves as cancelled, while a timeout that struck
      // after headers becomes a stream error with the real status. Rethrowing
      // bare would lose the status and headers and leave an otherwise terminal
      // post-header failure eligible for retry — the same fetch-versus-Node
      // divergence this adapter's buffered path was fixed for.
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
        requestURL,
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

    request.onDownloadProgress?.({
      loaded: rawBody?.length ?? 0,
      total: rawBody?.length ?? 0,
      progress: 1,
    });

    const responseHeaders = responseHeadersForBody;
    const detectedRedirectURL = resolveDetectedRedirectURL(
      requestURL,
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

/** Return an Error value without letting a Proxy prototype trap escape. */
function asError(value: unknown): Error | undefined {
  try {
    return value instanceof Error ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeError(value: unknown): Error {
  const existing = asError(value);

  if (existing !== undefined) {
    return existing;
  }

  try {
    return new Error(String(value));
  } catch {
    return new Error('Unknown error');
  }
}

/** Guard error members for the same reason adapter marker reads are guarded. */
function readObjectMember(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
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
 * Tag an abort thrown while reading the body with the response already
 * received, matching what NodeAdapter attaches to its response-stream aborts.
 *
 * Headers had arrived by the time the read started, so the status is real and
 * worth carrying out. The client decides what the abort meant; this only makes
 * sure the evidence survives the throw.
 *
 * Unlike NodeAdapter this omits `effectiveRequestHeaders`, here and everywhere
 * else in this adapter. `fetch` exposes no view of the final wire headers —
 * Host, Content-Length, and Accept-Encoding are added below the API, and in a
 * browser they are forbidden header names JS may not read. Echoing the request's
 * own headers back would claim a proof this adapter does not have, and the field
 * means the headers actually sent.
 */
function markResponseStreamAbort(
  error: unknown,
  status: number,
  headers: Record<string, string | string[]>,
): unknown {
  // Per the Fetch Standard the rejection is the signal's abort reason verbatim,
  // so `abort('stop')` rejects with the string itself, and `abort(err)` rejects
  // with that very object. Returning it untagged sends the client down its early
  // cancellation path, where the response headers — and any Set-Cookie on them —
  // are dropped.
  //
  // Always a fresh object, never the reason itself. A signal hands the same
  // reason to every consumer, so writing the metadata onto it would let two
  // requests sharing one controller overwrite each other's status and headers,
  // and store one response's cookies under the other's URL. A frozen reason
  // would throw here outright.
  //
  // `name` is copied because the client routes on it: a genuine AbortError must
  // still reach the branch that turns a post-header timeout into a stream
  // failure, while a caller's plain Error must still read as a cancellation.
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
