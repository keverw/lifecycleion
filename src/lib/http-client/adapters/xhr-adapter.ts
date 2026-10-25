import {
  deleteHeader,
  describeRefusedHeader,
  requestHeaderPairs,
  lowerCaseHeaderName,
} from '../internal/header-utils';
import { defineEntry } from '../../internal/define-entry';
import { XHR_BROWSER_TIMEOUT_FLAG } from '../consts';
import { knownBodyByteLength } from '../internal/progress';
import {
  makeAbortError,
  markResponseStreamAbort,
  nonRetryableAdapterErrorFrom,
} from '../internal/adapter-error';
import {
  isSignalAborted,
  readAdapterRequestFields,
} from '../internal/request-fields';
import { tooLargeAnswer, hasResponseBody } from '../internal/response-limit';
import { isArrayBufferLike } from '../../internal/binary-view';
import { readUnknownMember } from '../../internal/read-member';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
} from '../types';
import {
  derivedRedirectFields,
  isCrossOrigin,
  keepFirstJoinedLocation,
  resolveBrowserDispatchURL,
  stripURLCredentials,
} from '../utils';

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

  // Async, so a request field that throws when read rejects rather than throwing out of
  // `send` - refused as non-retryable, as a method or header value `open` will not take
  // is: the same request fails the same way on every attempt.
  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    const {
      method,
      maxResponseBytes,
      body: requestBody,
      headers,
      signal,
      guardedUploadProgress,
      guardedDownloadProgress,
      requestURL,
      initialURL,
    } = readAdapterRequestFields(request);
    // Resolved once, as the browser resolves it - against the document's base URL, or the
    // worker's `location` - with credentials withheld for another origin than the initial
    // URL's, and that one absolute URL is what is opened, what `didBrowserFollowRedirect`
    // compares `responseURL` with, and what a `Location` resolves against. One that does
    // not resolve, or is not http(s), is the non-retryable error it is refused with below
    // (see `resolveBrowserDispatchURL`).
    const answeredURL = resolveBrowserDispatchURL(
      requestURL,
      initialURL,
      'XHRAdapter',
    );

    return await new Promise((resolve, reject) => {
      // Refused the same way on every attempt - a method or header value `open` or
      // `setRequestHeader` will not take - so failed once as non-retryable, as the other
      // adapters fail a request their transport refuses to build.
      const refuse = (error: unknown): void => {
        // On a carrier: the throw may be the caller's own, from a method or header value.
        reject(nonRetryableAdapterErrorFrom(error));
      };

      // Refused as NodeAdapter refuses a URL it cannot parse or of another scheme:
      // whether an answer came from where the request was sent cannot be told without an
      // absolute URL to compare `responseURL` with, and XHR opened a `file:` or `data:`
      // URL where the runtime would load one.
      if (typeof answeredURL !== 'string') {
        refuse(answeredURL);
        return;
      }

      const xhr = new XMLHttpRequest();
      /** A redirect the browser followed before an abort, read before `abort()` resets it. */
      let followedRedirectBeforeAbort: string | undefined;
      /** The answer an abort landed on, read before `abort()` resets it. */
      let answeredBeforeAbort:
        | { status: number; headers: Record<string, string | string[]> }
        | undefined;

      try {
        // Refused in its own words, and without the runtime's error, as a header below is:
        // a browser's quotes the method it refused.
        try {
          xhr.open(method, answeredURL);
        } catch {
          refuse(
            new TypeError(
              'XHRAdapter could not open the request: the runtime refused its method or URL',
            ),
          );
          return;
        }
        // responseType 'arraybuffer' gives us a raw ArrayBuffer on load,
        // consistent with how FetchAdapter and NodeAdapter deliver body bytes.
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
        //
        // Except `cookie`, set once as NodeAdapter sends it - every spelling and item
        // joined with `; `: where XHR runs outside a browser (React Native, a test shim)
        // it is sent, and `, ` read as one cookie.
        //
        // A header refused is named, never its value, and the runtime's error is not kept:
        // Chrome's `DOMException` quotes the value - a token, in an `authorization`. A
        // browser refuses a name only when it is not a token, but an XHR outside one may
        // refuse a token name too, so with a token the part refused is not claimed.
        //
        // A caller's `Content-Length` is left to XHR, which frames the body itself, as
        // FetchAdapter leaves it to `fetch`: a browser refuses to send one, and an XHR
        // outside a browser sent one that disagreed with the body, so the server waited for
        // bytes that never came. Taken off the adapter's own copy, in place.
        deleteHeader(headers, 'content-length');
        for (const [name, value] of requestHeaderPairs(headers)) {
          try {
            xhr.setRequestHeader(name, value);
          } catch {
            refuse(
              new TypeError(
                `XHRAdapter refused ${describeRefusedHeader(name, 'header')}`,
              ),
            );
            return;
          }
        }
      } catch (error) {
        refuse(error);
        return;
      }

      // --- Abort signal ---
      //
      // Check for pre-aborted signal before calling xhr.send — if we called
      // send first and then aborted, the abort event fires asynchronously and
      // we'd resolve the promise rather than reject it with an AbortError.
      //
      // The signal is the caller's: one whose `aborted` or `addEventListener` throws is
      // refused as non-retryable, as every other field they hand over is, rather than
      // rejecting with the raw error and being retried as a network failure.
      /** Takes the abort listener off the signal; set once it is on. */
      let removeAbortListener = (): void => {};
      if (signal) {
        if (isSignalAborted(signal)) {
          reject(makeAbortError());
          return;
        }

        const onAbort = (): void => {
          // Read before `abort()`, which resets the status to `0`: a timeout that lands
          // once the headers are in has a real answer behind it, and FetchAdapter
          // carries it out on the abort so the client reports a terminal stream error
          // with that status rather than a retryable plain timeout.
          //
          // Unless the browser had already followed a redirect: those headers are the
          // final page's, which the original URL never answered with. The redirect is
          // what was answered, so it is resolved as the load path resolves it, and the
          // client sorts the abort (a cancel stays cancelled; a timeout ends at the
          // refused redirect, as the docs have it for `followRedirects: false`).
          const responseURL = xhr.responseURL;
          if (
            xhr.readyState >= 2 &&
            responseURL &&
            didBrowserFollowRedirect(responseURL, answeredURL)
          ) {
            followedRedirectBeforeAbort = responseURL;
          } else if (
            xhr.readyState >= 2 &&
            xhr.readyState < 4 &&
            xhr.status > 0
          ) {
            answeredBeforeAbort = {
              status: xhr.status,
              headers: parseXHRResponseHeaders(xhr.getAllResponseHeaders()),
            };
          }

          xhr.abort();
        };

        try {
          signal.addEventListener(
            'abort',
            onAbort,
            // once: true — the XHR is already done after the first abort, no
            // need to keep the listener alive and risk a second call.
            { once: true },
          );
        } catch (error) {
          refuse(error);
          return;
        }

        // And removed when the request ends any other way. `once` only fires on
        // abort, so on a long-lived shared signal - one controller over a whole
        // page session - every completed request left its listener behind, one
        // per request, until the signal finally aborted or was collected.
        // `loadend` fires after load, error, timeout and abort alike - and a send
        // that throws, which fires none of them, removes it itself.
        removeAbortListener = () => {
          // Guarded: a signal of the caller's own that throws on removal would throw out
          // of this listener, as an uncaught exception.
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            // The listener stays; `once` still bounds it to one call.
          }
        };
        xhr.addEventListener('loadend', removeAbortListener);
      }

      // --- Upload progress ---

      // Real per-chunk upload progress — the main advantage over FetchAdapter,
      // which has no streaming upload and can only fire 0% then 100%.
      // Deduplication guard — upload.progress and upload.load can both report
      // 100% (see upload.load listener below for details).
      let didFireUpload100 = false;
      let uploadedBytes = 0;
      let uploadTotalBytes = 0;

      // 100% upload fires as soon as all bytes are sent, always before xhr.load
      // per spec. Skip if upload.progress already reported 100% to avoid a
      // duplicate event. We still track whether this fired so xhr.load can use
      // it as a fallback for environments that skip upload.load entirely.
      let didUploadComplete = false;

      // The body's own size, measured once: `0` for none or an empty one, `undefined`
      // where it cannot be known up front (a `FormData`).
      const bodyByteLength = knownBodyByteLength(requestBody);

      // The one final upload event, however the upload ends: the bytes the browser
      // reported, or the body's own size where it reported none - `0` for an empty
      // string, as FetchAdapter reports it - not a stand-in `1`.
      const emitFinalUpload = (): void => {
        if (didFireUpload100) {
          return;
        }

        didFireUpload100 = true;
        // One number for both, as every terminal event reports it. The browser's last
        // `upload.progress` is throttled, so it may fall short of a body that was sent
        // whole, and a body whose size cannot be known (a `FormData`) reported only one
        // of the two - `total: 0`, or `loaded: 0`. An upload a server answered partway
        // through cannot be told from a finished one here, as FetchAdapter cannot.
        const bytes =
          Math.max(uploadedBytes, uploadTotalBytes) || (bodyByteLength ?? 0);
        guardedUploadProgress?.({ loaded: bytes, total: bytes, progress: 1 });
      };

      // `upload` is optional where XHR runs outside a browser - Node's `xmlhttprequest` has
      // none - so without one there is no per-chunk upload progress, and the final upload
      // event still fires when the request ends. One whose getter or `addEventListener`
      // throws fails the same way on every attempt, so it is refused as non-retryable, as a
      // send the XHR refuses is - and, never sent, takes the abort listener off itself.
      //
      // Listened on only for a body with bytes to send. A listener on `upload` makes a
      // browser preflight a cross-origin request - the XHR standard exempts a request with
      // no body, but not every engine need honour that - and a body of no bytes has no
      // upload to report on: its final event, `0` bytes, fires when the request ends.
      try {
        const upload: XMLHttpRequestUpload | null | undefined =
          bodyByteLength === 0 ? undefined : xhr.upload;

        if (upload) {
          upload.addEventListener('progress', (event) => {
            const { progress, total } = readProgressEvent(event);

            if (progress === 1) {
              didFireUpload100 = true;
            }

            uploadedBytes = Math.max(uploadedBytes, event.loaded);
            uploadTotalBytes = Math.max(uploadTotalBytes, event.total);

            guardedUploadProgress?.({ loaded: event.loaded, total, progress });
          });

          upload.addEventListener('load', (event) => {
            didUploadComplete = true;

            uploadedBytes = Math.max(uploadedBytes, event.loaded);
            uploadTotalBytes = Math.max(
              uploadTotalBytes,
              event.total || event.loaded,
            );

            emitFinalUpload();
          });
        }
      } catch (error) {
        removeAbortListener();
        refuse(error);
        return;
      }

      // --- Download progress ---

      // Real per-chunk download progress. Same advantage over FetchAdapter:
      // FetchAdapter buffers the full response body before firing any progress,
      // so it can only ever report 0% then 100%.
      // Deduplication guard — when Content-Length is known and the final
      // progress chunk reaches 100%, xhr.load would otherwise fire it again.
      let didFireDownload100 = false;
      let downloadedBytes = 0;
      let downloadTotalBytes = 0;

      // Set when this adapter aborted the XHR itself over a body past `maxResponseBytes`,
      // so the `abort` event that follows is not reported as a cancel.
      let didExceedMaxResponseBytes = false;
      // Whether the bytes progress counts are the body's own (see `isKnownUncodedBody`):
      // read once, when they first pass the limit.
      let isBodyKnownUncoded: boolean | undefined;

      // Fallback: upload.load didn't fire (no request body, or the browser skipped the
      // event). Callers always see a 100% upload event, unless upload.progress already
      // reported it - on every way the request ends with an answer, a refused one too.
      const finishUploadProgress = (): void => {
        if (!didUploadComplete) {
          emitFinalUpload();
        }
      };

      /**
       * Fail a body past `maxResponseBytes` as a stream error with the real status and
       * headers, and stop the download. Both are read before `xhr.abort()`, which resets
       * them. A browser-followed redirect is reported as the redirect, as on `load`: the
       * client refuses those whatever the body.
       */
      const refuseTooLargeBody = (): void => {
        didExceedMaxResponseBytes = true;
        // Read before the upload callback below: one that cancels makes `xhr.abort()`
        // reset this XHR, wiping its URL, status and headers.
        const responseURL = xhr.responseURL;
        const status = xhr.status;
        const headers = parseXHRResponseHeaders(xhr.getAllResponseHeaders());
        finishUploadProgress();

        if (responseURL && didBrowserFollowRedirect(responseURL, answeredURL)) {
          resolve(browserRedirectResponse(responseURL));
        } else {
          resolve(
            tooLargeAnswer(answeredURL, status, headers, maxResponseBytes),
          );
        }

        xhr.abort();
      };

      xhr.addEventListener('progress', (event) => {
        // Stopped as soon as the download passes the limit, rather than once the whole
        // body has been buffered - when the bytes counted are the body's own. For a
        // compressed body `loaded` may count encoded or decoded bytes, as the runtime
        // has it (Chrome counts decoded, Firefox and React Native's Android networking
        // encoded), and encoded bytes have no fixed bound on the decoded size either way.
        // So only a body known to carry no coding is stopped here; one that is or may be
        // compressed is left to `load`, which checks the decoded size exactly.
        if (didExceedMaxResponseBytes) {
          return;
        }

        if (event.loaded > maxResponseBytes) {
          isBodyKnownUncoded ??= isKnownUncodedBody(xhr, answeredURL);

          if (isBodyKnownUncoded) {
            refuseTooLargeBody();
            return;
          }
        }

        const { progress, total } = readProgressEvent(event);

        if (progress === 1) {
          didFireDownload100 = true;
        }

        downloadedBytes = Math.max(downloadedBytes, event.loaded);
        downloadTotalBytes = Math.max(downloadTotalBytes, event.total);

        guardedDownloadProgress?.({
          loaded: event.loaded,
          total,
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
        // Read once, before any progress callback: one that aborts the signal resets this
        // finished XHR, and `responseURL` with it.
        const responseURL = xhr.responseURL;
        if (responseURL && didBrowserFollowRedirect(responseURL, answeredURL)) {
          // The browser completed the transport and surfaced the final URL even
          // though the client will treat the result as redirect_disabled, so
          // emit terminal progress before returning the synthetic redirect
          // response.
          finishUploadProgress();

          if (!didFireDownload100) {
            // One number for both, as on every other path: the bytes counted where the
            // length was unknown, the length where the last throttled event fell short.
            const bytes = Math.max(downloadedBytes, downloadTotalBytes);
            guardedDownloadProgress?.({
              loaded: bytes,
              total: bytes,
              progress: 1,
            });
          }

          resolve(browserRedirectResponse(responseURL));
          return;
        }

        // Read before the progress callbacks below: one that aborts the signal makes
        // `xhr.abort()` reset this finished XHR, wiping its status and headers.
        const status = xhr.status;
        const responseHeaders = parseXHRResponseHeaders(
          xhr.getAllResponseHeaders(),
        );
        const body = readResponseBody(method, xhr);

        // Before the refusal below, so a refused body sees it too.
        finishUploadProgress();

        // The body as handed over can be larger than the bytes progress counted - a
        // runtime may count a compressed response encoded there, and a body that is or
        // may be compressed is not stopped on them - and a runtime need not report
        // progress at all, so the whole body is checked once more here.
        if (body !== null && body.length > maxResponseBytes) {
          resolve(
            tooLargeAnswer(
              answeredURL,
              status,
              responseHeaders,
              maxResponseBytes,
            ),
          );
          return;
        }

        // Final 100% download progress — skip if a progress event already
        // fired exactly 100% (Content-Length known and final chunk completed it).
        if (!didFireDownload100) {
          guardedDownloadProgress?.({
            loaded: body?.length ?? 0,
            total: body?.length ?? 0,
            progress: 1,
          });
        }

        // A 3xx the browser did not follow - one with no `Location` - or one handed over
        // by an XHR outside a browser is reported as a redirect, as FetchAdapter reports
        // a real 3xx.
        resolve({
          status,
          ...derivedRedirectFields(answeredURL, status, responseHeaders),
          headers: responseHeaders,
          body,
        });
      });

      // --- Error / timeout / abort ---

      // The error event fires for network-level failures (DNS failure, refused
      // connection, CORS rejection). It never fires for HTTP error status codes
      // (4xx, 5xx) — those arrive on the load event with a real status.
      xhr.addEventListener('error', () => {
        // Neither replay signal is set here, on purpose. This adapter can never
        // prove non-delivery: upload progress is suppressed for cross-origin
        // requests CORS does not grant access to, and those are still delivered —
        // the browser blocks the response, not the request. The omission is what
        // keeps a `POST` from being replayed by default.
        //
        // `isRetryable: false` does not stand in for it: that flag blocks every
        // method, so it would stop retrying an idempotent `PUT` after an ordinary
        // network error and override `retryNonIdempotentMethods`.
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
          Object.assign(makeAbortError('Request timed out'), {
            [XHR_BROWSER_TIMEOUT_FLAG]: true,
          }),
        );
      });

      xhr.addEventListener('abort', () => {
        // Already resolved as `response_too_large`; this abort is the adapter's own.
        if (didExceedMaxResponseBytes) {
          return;
        }

        if (followedRedirectBeforeAbort !== undefined) {
          // An answer, as on `load`: the final upload event fires for it there too.
          finishUploadProgress();
          resolve(browserRedirectResponse(followedRedirectBeforeAbort));
          return;
        }

        const abortError = makeAbortError();
        reject(
          answeredBeforeAbort === undefined
            ? abortError
            : markResponseStreamAbort(
                abortError,
                answeredBeforeAbort.status,
                answeredBeforeAbort.headers,
              ),
        );
      });

      // Fire initial 0% upload progress before any bytes leave the browser, mirroring the
      // FetchAdapter pattern so callers see a consistent first event regardless of
      // adapter. Here, once every refusal above has passed, so a request refused before
      // it is sent reports no upload start.
      guardedUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

      // Checked again here: a cancel from the 0% upload progress callback above aborts the
      // signal while the XHR is opened but not sent, where `xhr.abort()` does nothing and
      // fires no event - so the request would go out regardless, its one-shot listener spent.
      //
      // And the send itself, guarded. An asynchronous `send()` throws only an
      // `InvalidStateError` or a body it cannot convert (a `toString` that throws, a
      // detached buffer) - network failures arrive as events - and either fails the same
      // way on every attempt, so it is refused as non-retryable. Never sent, the request
      // fires no `loadend` to take the abort listener off the signal, so that is done here.
      try {
        if (isSignalAborted(signal)) {
          removeAbortListener();
          reject(makeAbortError());
          return;
        }

        // A `string`, a `Uint8Array` (a BufferSource) and a `FormData` are all
        // `XMLHttpRequestBodyInit`: the cast is safe for the bodies the client produces.
        xhr.send(requestBody as XMLHttpRequestBodyInit | null);
      } catch (error) {
        removeAbortListener();
        refuse(error);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the response body is known to carry no content coding, so the bytes XHR
 * progress counts are the decoded body's own. Known only from a `Content-Encoding` of
 * `identity` (or empty) the adapter can read, or from none at all on a browser response
 * that would show one: the request and the response URL both same-origin with the page.
 * A browser hides `Content-Encoding` on a cross-origin response unless the server lists
 * it in `Access-Control-Expose-Headers` - a cross-origin request redirected back to the
 * page's origin included - and outside a browser (no page origin) a runtime may decode
 * the body itself and drop the header (React Native's Android networking does), so
 * there its absence proves nothing and the body is taken as possibly coded.
 */
function isKnownUncodedBody(xhr: XMLHttpRequest, answeredURL: string): boolean {
  const contentEncoding = parseXHRResponseHeaders(xhr.getAllResponseHeaders())[
    'content-encoding'
  ];

  if (contentEncoding !== undefined) {
    return (contentEncoding as string)
      .split(',')
      .every((token) => ['', 'identity'].includes(token.trim().toLowerCase()));
  }

  const pageOrigin = readPageOrigin();

  return (
    pageOrigin !== undefined &&
    !isCrossOrigin(pageOrigin, answeredURL) &&
    !isCrossOrigin(pageOrigin, xhr.responseURL || answeredURL)
  );
}

/**
 * The origin of the page or worker running the request, which a browser holds a response
 * to for CORS: its `origin` (`'null'` in a sandboxed frame, which matches none), else its
 * `location`'s. `undefined` where there is neither, as outside a browser. Read through
 * guarded accessors, as the resolution base is.
 */
function readPageOrigin(): string | undefined {
  for (const scope of [
    globalThis,
    readUnknownMember(globalThis, 'window'),
    readUnknownMember(globalThis, 'self'),
  ]) {
    const origin = readUnknownMember(scope, 'origin');

    if (typeof origin === 'string') {
      return origin;
    }

    const locationOrigin = readUnknownMember(
      readUnknownMember(scope, 'location'),
      'origin',
    );

    if (typeof locationOrigin === 'string') {
      return locationOrigin;
    }
  }

  return undefined;
}

/**
 * An XHR progress event's `progress` and `total`, for upload and download alike. A length
 * is known only where it is one: a shim's `lengthComputable` with a total of `0` made the
 * progress `NaN` or `Infinity`. An unknown length has progress `-1`, and the bytes so far
 * stand for the total, as NodeAdapter reports them.
 */
function readProgressEvent(event: {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}): { progress: number; total: number } {
  const isLengthKnown = event.lengthComputable && event.total > 0;

  return isLengthKnown
    ? { progress: event.loaded / event.total, total: event.total }
    : { progress: -1, total: event.loaded };
}

/**
 * The response for a redirect the browser followed on its own: `status: 0` with the
 * final URL, which the client reports as `redirect_disabled`. A `responseURL` that does
 * not parse reports no `detectedRedirectURL`, as a `Location` that does not resolve
 * reports none, rather than the raw string handed on as though it were a URL.
 */
function browserRedirectResponse(responseURL: string): AdapterResponse {
  let isURL = true;
  try {
    new URL(responseURL);
  } catch {
    isURL = false;
  }

  return {
    status: 0,
    wasRedirectDetected: true,
    // XHR exposes the post-redirect final URL via responseURL. Browser
    // fetch opaque redirects do not, so this is intentionally
    // adapter-specific and surfaced separately from requestURL.
    ...(isURL ? { detectedRedirectURL: responseURL } : {}),
    headers: {},
    body: null,
  };
}

/**
 * Returns the response body as a Uint8Array, or null for response types that
 * carry no body (HEAD, 204, 205, 304 and 1xx - see `hasResponseBody`).
 */
function readResponseBody(
  method: string,
  xhr: XMLHttpRequest,
): Uint8Array | null {
  // The shared rule, so a `205` or `1xx` is bodiless here as in the other adapters.
  if (!hasResponseBody(method, xhr.status)) {
    return null;
  }

  // Recognized without `instanceof`, which is realm-bound: a test shim's XHR may hand
  // back a buffer made in another realm (see `isArrayBufferLike`).
  const response: unknown = xhr.response;
  if (
    typeof response === 'object' &&
    response !== null &&
    isArrayBufferLike(response)
  ) {
    return new Uint8Array(response as ArrayBuffer);
  }

  return null;
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
 * `AdapterResponse.headers` contract. Any other header given on more than one
 * line - by an XHR outside a browser - is joined with `, ` as a browser joins
 * it, so both forms read the same, and a repeated `Location` keeps its first
 * value, as FetchAdapter keeps the first of one fetch joined.
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
    const key = lowerCaseHeaderName(line.slice(0, colonIndex).trim());
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
      const existing = Object.hasOwn(result, key) ? result[key] : undefined;

      // Defined, not assigned, as every other adapter does: a `__proto__` header
      // would otherwise hit the prototype setter and vanish.
      defineEntry(
        result,
        key,
        existing === undefined ? value : `${existing as string}, ${value}`,
      );
    }
  }

  // A repeated `Location` keeps its first value, rather than standing as the one mangled
  // URL `a,%20b` that an XHR outside a browser would follow and `detectedRedirectURL`
  // would report.
  keepFirstJoinedLocation(result);

  return result;
}

/**
 * Compares URLs as browsers evaluate request destinations:
 * - strips userinfo (omitted by responseURL) and hash fragments (not sent over HTTP)
 * - relies on URL normalization for equivalent forms
 *   (default ports, dot segments, encoding normalization, etc.)
 *
 * `answeredURL` is the absolute URL `send` opened. A `responseURL` that does not parse
 * cannot name it, so it is taken as a redirect.
 */
function didBrowserFollowRedirect(
  responseURL: string,
  answeredURL: string,
): boolean {
  let normalizedResponse: URL;

  try {
    normalizedResponse = new URL(responseURL);
  } catch {
    return true;
  }

  normalizedResponse.hash = '';

  const normalizedRequest = new URL(answeredURL);
  normalizedRequest.hash = '';

  return (
    stripURLCredentials(normalizedResponse.href) !==
    stripURLCredentials(normalizedRequest.href)
  );
}
