import { XHR_BROWSER_TIMEOUT_FLAG } from '../consts';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
} from '../types';
import { resolveAbsoluteURLForRuntime } from '../utils';

/**
 * XHR-based adapter for environments that expose `XMLHttpRequest`. Primary
 * advantage over FetchAdapter is real per-chunk upload and download progress
 * via `xhr.upload.onprogress` / `xhr.onprogress`. FetchAdapter only fires 0%
 * and 100% because the Fetch API has no streaming upload and requires
 * buffering the full response to read body bytes.
 *
 * XHR constraints compared to FetchAdapter and NodeAdapter:
 * - `followRedirects: false` is required — XHR offers no opt-out from
 *   automatic redirect following, so individual hops cannot be observed or
 *   controlled. Redirect following is unsupported and treated as an error.
 * - In browser runtimes, cookies, CORS, and restricted headers (e.g. Cookie,
 *   User-Agent) are browser-managed; `cookieJar` must not be passed there.
 */
export class XHRAdapter implements HTTPAdapter {
  public getType(): AdapterType {
    return 'xhr';
  }

  public send(request: AdapterRequest): Promise<AdapterResponse> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      // responseType 'arraybuffer' gives us a raw ArrayBuffer on load,
      // consistent with how FetchAdapter and NodeAdapter deliver body bytes.
      xhr.open(request.method, request.requestURL);
      xhr.responseType = 'arraybuffer';

      // Timeout is managed by the client via the abort signal — the client's
      // per-attempt timer fires AbortController.abort(), which propagates to
      // xhr.abort() through the signal listener below. We disable XHR's own
      // timeout mechanism (0 = no timeout) so the client retains full control.
      // The 'timeout' event listener below is kept as a defensive fallback in
      // case a browser fires it anyway (e.g. a hard-coded internal limit).
      xhr.timeout = 0;

      // --- Request headers ---
      //
      // Calling setRequestHeader multiple times for the same key causes XHR to
      // combine values with ", " per spec — which is correct for all headers
      // the browser allows scripts to set. Cookie is a forbidden header name
      // and is silently dropped by the browser regardless; the browser manages
      // cookies on its own.
      for (const [key, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            xhr.setRequestHeader(key, v);
          }
        } else {
          xhr.setRequestHeader(key, value);
        }
      }

      // --- Abort signal ---
      //
      // Check for pre-aborted signal before calling xhr.send — if we called
      // send first and then aborted, the abort event fires asynchronously and
      // we'd resolve the promise rather than reject it with an AbortError.
      if (request.signal) {
        if (request.signal.aborted) {
          reject(new DOMException('Request aborted', 'AbortError'));
          return;
        }

        request.signal.addEventListener(
          'abort',
          () => {
            xhr.abort();
          },
          // once: true — the XHR is already done after the first abort, no
          // need to keep the listener alive and risk a second call.
          { once: true },
        );
      }

      // --- Upload progress ---

      // Fire initial 0% upload progress before any bytes leave the browser,
      // mirroring the FetchAdapter pattern so callers see a consistent first
      // event regardless of adapter.
      request.onUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

      // Real per-chunk upload progress — the main advantage over FetchAdapter,
      // which has no streaming upload and can only fire 0% then 100%.
      // Deduplication guard — upload.progress and upload.load can both report
      // 100% (see upload.load listener below for details).
      let didFireUpload100 = false;
      let uploadedBytes = 0;
      let uploadTotalBytes = 0;

      xhr.upload.addEventListener('progress', (event) => {
        const progress = event.lengthComputable
          ? event.loaded / event.total
          : -1;

        if (progress === 1) {
          didFireUpload100 = true;
        }

        uploadedBytes = Math.max(uploadedBytes, event.loaded);
        uploadTotalBytes = Math.max(uploadTotalBytes, event.total);

        request.onUploadProgress?.({
          loaded: event.loaded,
          total: event.total || 0,
          progress,
        });
      });

      // 100% upload fires as soon as all bytes are sent, always before xhr.load
      // per spec. Skip if upload.progress already reported 100% to avoid a
      // duplicate event. We still track whether this fired so xhr.load can use
      // it as a fallback for environments that skip upload.load entirely.
      let didUploadComplete = false;

      xhr.upload.addEventListener('load', (event) => {
        didUploadComplete = true;

        uploadedBytes = Math.max(uploadedBytes, event.loaded);
        uploadTotalBytes = Math.max(
          uploadTotalBytes,
          event.total || event.loaded,
        );

        if (!didFireUpload100) {
          const finalLoaded = uploadedBytes > 0 ? uploadedBytes : 1;
          const finalTotal = uploadTotalBytes > 0 ? uploadTotalBytes : 1;
          request.onUploadProgress?.({
            loaded: finalLoaded,
            total: finalTotal,
            progress: 1,
          });
        }
      });

      // --- Download progress ---

      // Real per-chunk download progress. Same advantage over FetchAdapter:
      // FetchAdapter buffers the full response body before firing any progress,
      // so it can only ever report 0% then 100%.
      // Deduplication guard — when Content-Length is known and the final
      // progress chunk reaches 100%, xhr.load would otherwise fire it again.
      let didFireDownload100 = false;
      let downloadedBytes = 0;
      let downloadTotalBytes = 0;

      xhr.addEventListener('progress', (event) => {
        const progress = event.lengthComputable
          ? event.loaded / event.total
          : -1;

        if (progress === 1) {
          didFireDownload100 = true;
        }

        downloadedBytes = Math.max(downloadedBytes, event.loaded);
        downloadTotalBytes = Math.max(downloadTotalBytes, event.total);

        request.onDownloadProgress?.({
          loaded: event.loaded,
          total: event.total || 0,
          progress,
        });
      });

      // --- Load (success) ---

      xhr.addEventListener('load', () => {
        // Detect browser-followed redirects.
        //
        // In a browser, FetchAdapter uses `redirect: 'manual'` which yields an
        // opaqueredirect response (status 0) — redirects are intercepted before
        // they happen. XHR has no equivalent opt-out; the browser always follows
        // redirects automatically. We detect them after-the-fact by comparing
        // xhr.responseURL (the final URL after all hops) to the original URL.
        //
        // Both browser adapters surface the same signal: status 0 +
        // wasRedirectDetected, which routes through HTTPClient's
        // redirect_disabled error path so callers get a consistent isFailed
        // response regardless of adapter.
        if (
          xhr.responseURL &&
          didBrowserFollowRedirect(xhr.responseURL, request.requestURL)
        ) {
          // The browser completed the transport and surfaced the final URL even
          // though the client will treat the result as redirect_disabled, so
          // emit terminal progress before returning the synthetic redirect
          // response.
          if (!didUploadComplete && !didFireUpload100) {
            request.onUploadProgress?.({
              loaded: uploadedBytes,
              total: uploadTotalBytes,
              progress: 1,
            });
          }

          if (!didFireDownload100) {
            request.onDownloadProgress?.({
              loaded: downloadedBytes,
              total: downloadTotalBytes,
              progress: 1,
            });
          }

          resolve({
            status: 0,
            wasRedirectDetected: true,
            // XHR exposes the post-redirect final URL via responseURL. Browser
            // fetch opaque redirects do not, so this is intentionally
            // adapter-specific and surfaced separately from requestURL.
            detectedRedirectURL: xhr.responseURL,
            headers: {},
            body: null,
          });
          return;
        }

        // Fallback: upload.load didn't fire (no request body, or the browser
        // skipped the event). Ensure callers always see a 100% upload event,
        // unless upload.progress already reported it.
        if (!didUploadComplete && !didFireUpload100) {
          request.onUploadProgress?.({
            loaded: uploadedBytes,
            total: uploadTotalBytes,
            progress: 1,
          });
        }

        const body = readResponseBody(request.method, xhr);

        // Final 100% download progress — skip if a progress event already
        // fired exactly 100% (Content-Length known and final chunk completed it).
        if (!didFireDownload100) {
          request.onDownloadProgress?.({
            loaded: body?.length ?? 0,
            total: body?.length ?? 0,
            progress: 1,
          });
        }

        resolve({
          status: xhr.status,
          headers: parseXHRResponseHeaders(xhr.getAllResponseHeaders()),
          body,
        });
      });

      // --- Error / timeout / abort ---

      // The error event fires for network-level failures (DNS failure, refused
      // connection, CORS rejection). It never fires for HTTP error status codes
      // (4xx, 5xx) — those arrive on the load event with a real status.
      xhr.addEventListener('error', () => {
        resolve({
          status: 0,
          isTransportError: true,
          headers: {},
          body: null,
          errorCause: new Error('XHR network error'),
        });
      });

      // Defensive fallback: fires if the browser has a hard-coded internal
      // timeout limit (xhr.timeout is 0 so we never set one ourselves). Mark
      // the error so HTTPClient classifies it as a timeout (retryable) rather
      // than an unexpected abort (non-retryable cancel).
      xhr.addEventListener('timeout', () => {
        reject(
          Object.assign(new DOMException('Request timed out', 'AbortError'), {
            [XHR_BROWSER_TIMEOUT_FLAG]: true,
          }),
        );
      });

      xhr.addEventListener('abort', () => {
        reject(new DOMException('Request aborted', 'AbortError'));
      });

      xhr.send(prepareBody(request.body));
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the response body as a Uint8Array, or null for response types that
 * carry no body (HEAD, 204 No Content, 304 Not Modified).
 */
function readResponseBody(
  method: string,
  xhr: XMLHttpRequest,
): Uint8Array | null {
  if (method === 'HEAD' || xhr.status === 204 || xhr.status === 304) {
    return null;
  }

  if (xhr.response instanceof ArrayBuffer) {
    return new Uint8Array(xhr.response);
  }

  return null;
}

/**
 * Converts the adapter request body to a value accepted by `xhr.send()`.
 * `string`, `Uint8Array` (BufferSource), and `FormData` are all valid
 * `XMLHttpRequestBodyInit` values — the cast is safe for the body types
 * the client produces.
 */
function prepareBody(
  body: AdapterRequest['body'],
): XMLHttpRequestBodyInit | null {
  if (body === null) {
    return null;
  }

  return body as XMLHttpRequestBodyInit;
}

/**
 * Parses the raw header string from `xhr.getAllResponseHeaders()` into a
 * lowercase-keyed record.
 *
 * `getAllResponseHeaders()` returns CRLF-delimited `name: value` lines. When
 * a server sends multiple headers with the same name the browser combines them
 * into a single comma-joined line for most headers, but emits each `Set-Cookie`
 * value as its own line (per spec) to avoid ambiguity with the comma in cookie
 * values. Those are collected here as `string[]` to match the
 * `AdapterResponse.headers` contract.
 *
 * Note: browsers unconditionally block `Set-Cookie` and `Set-Cookie2` from
 * `getAllResponseHeaders()` per the XHR spec, so the `set-cookie` array
 * branch below is effectively unreachable in a real browser — it exists to
 * satisfy the shared `AdapterResponse` type contract.
 */
function parseXHRResponseHeaders(
  raw: string,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  if (!raw) {
    return result;
  }

  for (const line of raw.split('\r\n')) {
    // Lines are `Name: value` pairs separated by the first colon.
    // indexOf is used (not split) so colons in the value are preserved.
    const colonIndex = line.indexOf(':');

    if (colonIndex < 0) {
      // No colon — malformed or trailing empty line; skip
      continue;
    }

    // Lowercase to normalize across servers (header names are case-insensitive)
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (!key) {
      // Colon at position 0 — no name; skip
      continue;
    }

    if (key === 'set-cookie') {
      // Each Set-Cookie directive arrives as its own line — collect into an
      // array so callers never need to split on commas (which are valid inside
      // cookie values). Guarded by the XHR spec in standard browsers, but kept
      // for correctness in legacy environments or platforms with non-standard
      // XHR implementations.
      const existing = result['set-cookie'];

      if (existing === undefined) {
        result['set-cookie'] = [value];
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result['set-cookie'] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Compares URLs as browsers evaluate request destinations:
 * - strips hash fragments (not sent over HTTP)
 * - relies on URL normalization for equivalent forms
 *   (default ports, dot segments, encoding normalization, etc.)
 */
function didBrowserFollowRedirect(
  responseURL: string,
  requestURL: string,
): boolean {
  try {
    const normalizedResponse = new URL(responseURL);
    normalizedResponse.hash = '';

    const normalizedRequest = new URL(
      resolveAbsoluteURLForRuntime(requestURL, undefined, true),
      normalizedResponse.href,
    );
    normalizedRequest.hash = '';

    return normalizedResponse.href !== normalizedRequest.href;
  } catch {
    // Fallback for non-URL inputs: preserve prior behavior.
    return responseURL !== requestURL;
  }
}
