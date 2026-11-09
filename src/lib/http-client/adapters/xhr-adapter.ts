import {
  describeRefusedHeader,
  dropTransportFramedHeaders,
  requestHeaderPairs,
  lowerCaseHeaderName,
} from '../internal/header-utils';
import { asciiUppercase, trimHTTPWhitespace } from '../../internal/ascii-text';
import { defineEntry } from '../../internal/define-entry';
import { XHR_BROWSER_TIMEOUT_FLAG } from '../consts';
import {
  byteProgressEvent,
  completeProgressEvent,
  knownBodyByteLength,
} from '../internal/progress';
import {
  connectRefusal,
  defineHiddenTags,
  markNonRetryableAdapterError,
  makeAbortError,
  markResponseStreamAbort,
  nonRetryableAdapterErrorFrom,
} from '../internal/adapter-error';
import {
  isSignalAborted,
  isSignalAbortedQuietly,
  readAdapterRequestFields,
} from '../internal/request-fields';
import {
  tooLargeAnswer,
  hasResponseBody,
  isAnsweredBodyOverLimit,
  isIdentityContentEncoding,
  parseContentLength,
  streamErrorAnswer,
} from '../internal/response-limit';
import { isArrayBufferLike } from '../../internal/binary-view';
import { safeParseURL } from '../../domain-utils/domain-utils';
import { readUnknownMember } from '../../internal/read-member';
import { isLoopbackHost } from '../internal/loopback-host';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
} from '../types';
import {
  derivedRedirectFields,
  findBrowserPage,
  isBrowserEnvironment,
  isCrossOrigin,
  keepFirstJoinedLocation,
  resolveBrowserDispatchURL,
  stripURLCredentials,
} from '../utils';
import { markBuiltInNetworkAdapter } from '../internal/built-in-adapter';

/**
 * XHR-based adapter for environments that expose `XMLHttpRequest`. Primary
 * advantage over FetchAdapter is real per-chunk upload progress via
 * `xhr.upload.onprogress`: FetchAdapter fires only 0% and 100% for an upload,
 * because the Fetch API has no upload progress.
 *
 * XHR constraints compared to FetchAdapter and NodeAdapter:
 * - `followRedirects: false` is required — XHR offers no opt-out from
 *   automatic redirect following, so individual hops cannot be observed or
 *   controlled. Redirect following is unsupported and treated as an error.
 * - In browser runtimes, cookies, CORS, and restricted headers (e.g. Cookie,
 *   User-Agent) are browser-managed; `cookieJar` must not be passed there.
 */
export class XHRAdapter implements HTTPAdapter {
  constructor() {
    // Its class's `send`, so the client hands it the request body uncopied while that is
    // the `send` called (see `isBuiltInNetworkSend`).
    markBuiltInNetworkAdapter(this, Reflect.get(XHRAdapter.prototype, 'send'));
  }

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
    const upperMethod = asciiUppercase(method);
    if (upperMethod === 'CONNECT') {
      throw connectRefusal('XHRAdapter');
    }

    // A browser's XHR drops a GET or HEAD body - the XHR standard sends those bodiless - so
    // the request would go out without it and be answered as though it had been sent.
    // `HTTPClient` refuses one before this, on the same rule, and hands a JSON body that
    // serializes to nothing over as `null`. In a browser only: a non-browser XHR (React
    // Native, a shim) may send the body.
    if (
      (upperMethod === 'GET' || upperMethod === 'HEAD') &&
      requestBody !== null &&
      requestBody !== undefined &&
      isBrowserEnvironment()
    ) {
      const refusal = new Error(
        `[XHRAdapter] Cannot send a ${upperMethod} request with a body: XMLHttpRequest drops it. Send the body with POST.`,
      );
      markNonRetryableAdapterError(refusal);
      throw refusal;
    }

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

    /** Takes the abort listener off the signal; set once it is on. */
    let removeAbortListener = (): void => {};

    const startRequest = (
      resolveSend: (response: AdapterResponse) => void,
      rejectSend: (reason: unknown) => void,
    ): void => {
      // Set by every settle. An XHR whose `abort()` threw, or that was answered and then
      // stopped, may keep firing events: once the send has settled, the listeners below
      // call none of the caller's callbacks, so nothing reaches them after the request
      // ended - nor alongside a retry's.
      // A settle also takes the abort listener off the caller's signal: nothing is left for
      // it to stop, and an XHR outside a browser may fire no `loadend` to take it off.
      let didSettle = false;
      const resolve = (response: AdapterResponse): void => {
        didSettle = true;
        resolveSend(response);
        removeAbortListener();
      };
      const reject = (reason: unknown): void => {
        didSettle = true;
        rejectSend(reason);
        removeAbortListener();
      };

      // The caller's progress callbacks, called only while the send is pending: the one
      // place that rule is kept, so a listener that runs on after a settle reports nothing.
      type ProgressCallback = NonNullable<typeof guardedUploadProgress>;
      const whilePending = (
        callback: ProgressCallback | undefined,
      ): ProgressCallback | undefined =>
        callback &&
        ((event) => {
          if (!didSettle) {
            callback(event);
          }
        });
      const reportUpload = whilePending(guardedUploadProgress);
      const reportDownload = whilePending(guardedDownloadProgress);

      // Refused the same way on every attempt - a method or header value `open` or
      // `setRequestHeader` will not take - so failed once as non-retryable, as the other
      // adapters fail a request their transport refuses to build.
      const refuse = (error: unknown): void => {
        // On a carrier: the throw may be the caller's own, from a method or header value.
        reject(nonRetryableAdapterErrorFrom(error));
      };

      // Refused as NodeAdapter refuses a URL it cannot parse or of another scheme:
      // whether an answer came from where the request was sent cannot be told without an
      // absolute URL to compare `responseURL` with, and XHR would open a `file:` or
      // `data:` URL where the runtime loads one.
      if (typeof answeredURL !== 'string') {
        refuse(answeredURL);
        return;
      }

      const xhr = new XMLHttpRequest();

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
        dropTransportFramedHeaders(headers, requestBody);
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

      // Both read by the abort listener, so declared before it is added: a caller's getter
      // read before the send (a `Blob`'s `size`) may abort the signal at once.
      //
      // Set as `load` starts, which answers whatever a progress callback then cancels.
      let didLoad = false;
      // Set as the request is handed to `send()`. Until then `xhr.abort()` does nothing and
      // fires no event, so the abort listener answers a cancel itself.
      let didSend = false;

      // The answer, read once and kept: as its headers arrive (the `readystatechange`
      // listener below), or where it is first needed, for an XHR that reports no change of
      // state. Kept because the XHR does not keep it: `abort()`, and the `error` or
      // `timeout` of a failure later on, reset its status and headers (the XHR standard's
      // request error steps), and a failure once the server has answered is a stream error
      // with the real status, as the other adapters report one - not a network failure,
      // retried as though nothing had been answered. Only an answer is kept: headers in,
      // with a status. A failure sets the state to done with the status already `0`.
      let answeredAtHeaders: AnsweredHeaders | undefined;

      /**
       * Stop a send the caller cancelled once it is sent. The answer is read first, before
       * `abort()`, which resets the status to `0`, where the headers did not report it: a
       * timeout that lands once the headers are in has a real answer behind it, and
       * FetchAdapter carries it out on the abort so the client reports a terminal stream
       * error with that status rather than a retryable plain timeout (or, behind a redirect
       * the browser followed, the refused redirect; a cancel stays cancelled either way).
       *
       * Done already - a cancel from a download progress event the runtime fires once the
       * response is complete, just before `load` (Chromium flushes its last throttled one
       * then, where the XHR standard fires it while loading), from an upload event of a
       * failure, which sets the state to done before its `error`, or within a `send()` that
       * completes the response - it is ended here, as the cancel over that answer, with no
       * `abort()` to reset it.
       *
       * Each read guarded, as an XHR outside a browser may throw from any of them: the
       * transfer is still stopped, and the abort is reported with what was read already.
       */
      const stopCancelledSend = (): void => {
        try {
          captureAnswer();
        } catch {
          // Nothing more was read to carry out.
        }

        let isDone = false;
        try {
          isDone = xhr.readyState === 4;
        } catch {
          // Stopped as any other.
        }

        if (isDone) {
          settleAborted(answeredAtHeaders);
          return;
        }

        // Guarded too: refused, no `abort` event would follow to end the send.
        try {
          xhr.abort();
        } catch {
          settleAborted(answeredAtHeaders);
        }
      };

      /** Whether `responseURL` is where the browser followed a redirect to. */
      const isFollowedRedirect = (responseURL: string): boolean =>
        responseURL !== '' &&
        didBrowserFollowRedirect(responseURL, answeredURL);

      /**
       * The answer as the XHR has it now. A redirect the browser followed is told by its URL
       * alone, which is all it is reported by: its headers are the final page's, so they are
       * not read, and one that cannot be read does not lose the redirect.
       */
      const readAnswer = (status: number = xhr.status): AnsweredHeaders => {
        // A string or none: an XHR outside a browser may have no `responseURL` at all, which
        // says nothing of a redirect.
        const reportedURL: unknown = xhr.responseURL;
        const responseURL = typeof reportedURL === 'string' ? reportedURL : '';

        const redirectURL = isFollowedRedirect(responseURL)
          ? responseURL
          : undefined;

        return {
          status,
          headers:
            redirectURL === undefined
              ? parseXHRResponseHeaders(xhr.getAllResponseHeaders())
              : {},
          responseURL,
          redirectURL,
        };
      };

      /** The answer, read the first time there is one. */
      const captureAnswer = (): AnsweredHeaders | undefined => {
        if (answeredAtHeaders === undefined && xhr.readyState >= 2) {
          const status = xhr.status;
          if (status > 0) {
            answeredAtHeaders = readAnswer(status);
          }
        }

        return answeredAtHeaders;
      };

      // --- Abort signal ---
      //
      // Check for pre-aborted signal before calling xhr.send — if we called
      // send first and then aborted, the abort event fires asynchronously and
      // we'd resolve the promise rather than reject it with an AbortError.
      //
      // The signal is the caller's: one whose `aborted` or `addEventListener` throws is
      // refused as non-retryable, as every other field they hand over is, rather than
      // rejecting with the raw error and being retried as a network failure.
      if (signal) {
        if (isSignalAborted(signal)) {
          reject(makeAbortError());
          return;
        }

        const onAbort = (): void => {
          // Ended already: a listener a signal of the caller's kept past the end.
          if (didSettle) {
            return;
          }

          // Not sent yet - a caller's getter read while the request is prepared (a `Blob`'s
          // `size`), or the 0% upload callback, cancelled it: answered here, and never sent.
          if (!didSend) {
            reject(makeAbortError());
            return;
          }

          // Once `load` has started it ends the cancel itself, before it reads the body, and
          // answers a cancel from its final download callback, as FetchAdapter does.
          if (didLoad) {
            return;
          }

          stopCancelledSend();
        };

        // Set before the listener is added, which a signal of the caller's own may call at
        // once. And removed as the send settles (see `resolve`), however it ends. `once`
        // only fires on abort, so on a long-lived shared signal - one controller over a
        // whole page session - every completed request would leave its listener behind,
        // one per request, until the signal finally aborted or was collected.
        removeAbortListener = () => {
          // Guarded: a signal of the caller's own that throws on removal would throw out
          // of this listener, as an uncaught exception.
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            // The listener stays; `once` still bounds it to one call.
          }
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

        // Answered already by a signal that called the listener as it was added, and
        // took the listener after: off it now.
        if (didSettle) {
          removeAbortListener();
          return;
        }
      }

      // --- Upload progress ---

      // Real per-chunk upload progress — the main advantage over FetchAdapter,
      // which has no streaming upload and can only fire 0% then 100%.
      // Deduplication guard — upload.progress and upload.load can both report
      // 100%, and an environment that skips upload.load gets its 100% as the request
      // ends. It fires as soon as all bytes are sent, always before xhr.load per spec.
      let didFireUpload100 = false;
      let uploadedBytes = 0;
      let uploadTotalBytes = 0;

      // The size of a body that is not text, read once, so a value of the caller's (a
      // `Blob`'s `size`) is read at most once: `0` for none or an empty one, `undefined`
      // where it cannot be known up front (a `FormData`). Text with any characters is at
      // least a byte, so it is measured only by the final upload event, and only when the
      // browser reported nothing. Only when upload progress was asked for: nothing else
      // reads it.
      const binaryBodyByteLength =
        !guardedUploadProgress || typeof requestBody === 'string'
          ? undefined
          : knownBodyByteLength(requestBody);

      // Whether the body has, or may have, bytes to send - read only for a request that
      // asked for upload progress, as above.
      const hasBytesToSend =
        guardedUploadProgress !== undefined &&
        (typeof requestBody === 'string'
          ? requestBody !== ''
          : binaryBodyByteLength !== 0);

      // The one final upload event, on every way the request ends with an answer, a refused
      // one too, and however the upload ends: the bytes the browser
      // reported, or the body's own size where it reported none - `0` for an empty
      // string, as FetchAdapter reports it - not a stand-in `1`. Answers whether the send
      // is still pending after it: that callback may cancel, which ends it.
      const emitFinalUpload = (): boolean => {
        if (didSettle || didFireUpload100 || !guardedUploadProgress) {
          return !didSettle;
        }

        didFireUpload100 = true;
        // One number for both, as every terminal event reports it. The browser's last
        // `upload.progress` is throttled, so it may fall short of a body that was sent
        // whole, and a body whose size cannot be known (a `FormData`) reported only one
        // of the two - `total: 0`, or `loaded: 0`. An upload a server answered partway
        // through cannot be told from a finished one here, as FetchAdapter cannot.
        const bytes =
          Math.max(uploadedBytes, uploadTotalBytes) ||
          ((typeof requestBody === 'string'
            ? knownBodyByteLength(requestBody)
            : binaryBodyByteLength) ??
            0);
        reportUpload?.(completeProgressEvent(bytes));
        return !didSettle;
      };

      // A listener's reads of an XHR outside a browser may throw, and a throw out of a
      // listener would leave the send pending with nothing left to end it. Those reads fail
      // the same way on every attempt, so the request is refused as non-retryable. One that
      // fires on an answer ends the upload first, as on every other answered path.
      const refusingOnThrow = <Event>(
        listener: (event: Event) => void,
        isOnAnswer: boolean,
      ): ((event: Event) => void) => {
        return (event) => {
          try {
            listener(event);
          } catch (error) {
            if (isOnAnswer) {
              emitFinalUpload();
            }

            refuse(error);

            try {
              xhr.abort();
            } catch {
              // Nothing more to stop it with.
            }
          }
        };
      };

      // `upload` is optional where XHR runs outside a browser - Node's `xmlhttprequest` has
      // none - so without one there is no per-chunk upload progress, and the final upload
      // event still fires when the request ends. One whose getter or `addEventListener`
      // throws fails the same way on every attempt, so it is refused as non-retryable, as a
      // send the XHR refuses is - and, never sent, takes the abort listener off itself.
      //
      // Listened on only when upload progress was asked for, and only for a body with bytes
      // to send. A listener on `upload` makes a browser preflight a cross-origin request -
      // the XHR standard exempts a request with no body, but not every engine need honour
      // that - so a request with no progress hook goes out as `fetch` would send it, and a
      // body of no bytes has no upload to report on: its final event, `0` bytes, fires when
      // the request ends.
      try {
        const upload: XMLHttpRequestUpload | null | undefined =
          guardedUploadProgress && hasBytesToSend ? xhr.upload : undefined;

        if (upload) {
          upload.addEventListener(
            'progress',
            refusingOnThrow((event: ProgressEvent) => {
              // Nor once the upload has ended: an answer that comes before the body is
              // sent ends it, and the bytes the browser goes on reporting would run it
              // backwards.
              if (didSettle || didFireUpload100) {
                return;
              }

              const reported = readProgressEvent(event);

              if (reported.progress === 1) {
                didFireUpload100 = true;
              }

              // The reported total, which stands for the bytes so far where the runtime's
              // is not a length (see `readProgressEvent`).
              uploadedBytes = Math.max(uploadedBytes, reported.loaded);
              uploadTotalBytes = Math.max(uploadTotalBytes, reported.total);

              reportUpload?.(reported);
            }, false),
          );

          upload.addEventListener(
            'load',
            refusingOnThrow((event: ProgressEvent) => {
              // As for `progress`: an upload an answer has ended is not read again, so a
              // refusal from here is only ever one before the answer.
              if (didSettle || didFireUpload100) {
                return;
              }

              const reported = readProgressEvent(event);
              uploadedBytes = Math.max(uploadedBytes, reported.loaded);
              uploadTotalBytes = Math.max(uploadTotalBytes, reported.total);

              emitFinalUpload();
            }, false),
          );
        }
      } catch (error) {
        refuse(error);
        return;
      }

      // The final download event, the only one at 100%. Not for a download cancelled
      // already, which reports no completion - from its last progress event, which a
      // runtime may fire once the response is complete, or from the final upload event,
      // whose cancel can reach a redirect's settle again through the `abort` event.
      const reportDownloadComplete = (bytes: number): void => {
        if (!isSignalAbortedQuietly(signal)) {
          reportDownload?.(completeProgressEvent(bytes));
        }
      };

      /**
       * End the send at a redirect the browser followed, as soon as it is seen: the client
       * refuses it whatever the page it led to, so that page is not downloaded nor held -
       * past `maxResponseBytes` included - nor its bytes reported. No body is handed over
       * for it, so its download ends at `0` bytes, as FetchAdapter reports its opaque
       * redirect.
       */
      const settleFollowedRedirect = (redirectURL: string): void => {
        // A cancel from that upload callback ended it already.
        if (!emitFinalUpload()) {
          return;
        }

        reportDownloadComplete(0);
        resolve(browserRedirectResponse(redirectURL));

        try {
          xhr.abort();
        } catch {
          // Whatever the page goes on to deliver is reported to no one.
        }
      };

      // --- Download progress ---

      // Real per-chunk download progress, where FetchAdapter reports only the terminal
      // event.

      // Whether the bytes progress counts are the body's own (see `isKnownUncodedBody`):
      // read once, when they first pass the limit.
      let isBodyKnownUncoded: boolean | undefined;

      /**
       * Stop the download at `answer`, settled by `settle`. A browser-followed redirect is
       * reported as the redirect instead, as on `load`: the client refuses those whatever
       * the body, and the answer may be read here for the first time. Every way the
       * download is stopped early goes through here, so none can skip that check.
       */
      const endDownloadAt = (
        answer: AnsweredHeaders,
        settle: () => void,
      ): void => {
        if (answer.redirectURL !== undefined) {
          settleFollowedRedirect(answer.redirectURL);
          return;
        }

        // A cancel from that upload callback ends the send as the cancel.
        if (!emitFinalUpload()) {
          return;
        }

        settle();

        try {
          xhr.abort();
        } catch {
          // Whatever the answer goes on to deliver is reported to no one.
        }
      };

      /**
       * Fail a body past `maxResponseBytes` as a stream error with the real status and
       * headers of `answer`, and stop the download.
       */
      const refuseTooLargeBody = (answer: AnsweredHeaders): void => {
        endDownloadAt(answer, () => {
          resolve(
            tooLargeAnswer(
              answeredURL,
              answer.status,
              answer.headers,
              maxResponseBytes,
            ),
          );
        });
      };

      /**
       * End the send at a bodiless answer - a `205` - whose bytes pass `maxResponseBytes`:
       * answered as `load` answers it, with no body, and the download stopped, so an XHR
       * that keeps a bodiless answer's bytes does not hold them all first.
       */
      const answerBodilessEarly = (answer: AnsweredHeaders): void => {
        endDownloadAt(answer, () => {
          reportDownloadComplete(0);
          resolve({
            status: answer.status,
            ...derivedRedirectFields(
              answeredURL,
              answer.status,
              answer.headers,
            ),
            headers: answer.headers,
            body: null,
          });
        });
      };

      /**
       * Whether an answer's status says it carries no body (see `hasResponseBody`). Not a
       * `0`, the status an XHR reads before it has an answer - a followed redirect's, say -
       * which is left to the size limit and `load`.
       */
      const isBodilessAnswer = (status: number): boolean =>
        status !== 0 && !hasResponseBody(method, status);

      /**
       * Act on the answer as it is first read: a redirect the browser followed ends the send, and
       * any other ends the upload - and the send too, for a body whose `Content-Length`
       * says up front it is past `maxResponseBytes`, as FetchAdapter refuses one before
       * reading it, so it is not downloaded first. Only where that length counts the body
       * itself (see `isKnownUncodedBody`), and only for an answer with a body: a `HEAD`'s
       * `Content-Length` is the `GET`'s.
       */
      const onAnswered = (answer: AnsweredHeaders): void => {
        if (answer.redirectURL !== undefined) {
          settleFollowedRedirect(answer.redirectURL);
          return;
        }

        // A cancel from that upload callback may have ended the send.
        if (
          !emitFinalUpload() ||
          !Number.isFinite(maxResponseBytes) ||
          !hasResponseBody(method, answer.status)
        ) {
          return;
        }

        const declaredLength = parseContentLength(
          answer.headers['content-length'],
        );

        if (
          declaredLength === undefined ||
          declaredLength <= maxResponseBytes
        ) {
          return;
        }

        // The same decision the download's bytes would come to (see `isBodyKnownUncoded`).
        isBodyKnownUncoded = isKnownUncodedBody(answer, answeredURL);

        if (isBodyKnownUncoded) {
          refuseTooLargeBody(answer);
        }
      };

      /**
       * The answer, read the first time there is one and acted on as it is (see
       * `onAnswered`), by every listener that reads it on its way in. A read that throws
       * captures nothing: the request ends as it would have.
       */
      const readAndActOnAnswer = (): AnsweredHeaders | undefined => {
        if (answeredAtHeaders !== undefined) {
          return answeredAtHeaders;
        }

        let answered: AnsweredHeaders | undefined;
        try {
          answered = captureAnswer();
        } catch {
          return undefined;
        }

        if (answered !== undefined) {
          onAnswered(answered);
        }

        return answered;
      };

      xhr.addEventListener(
        'progress',
        refusingOnThrow((event: ProgressEvent) => {
          // Stopped as soon as the download passes the limit, rather than once the whole
          // body has been buffered - when the bytes counted are the body's own. For a
          // compressed body `loaded` may count encoded or decoded bytes, as the runtime
          // has it (Chrome counts decoded, Firefox and React Native's Android networking
          // encoded), and the two bound each other in neither direction: a body can decode
          // to many times its encoded bytes, and one a server flushes in small writes takes
          // several times more bytes encoded than decoded, so no margin over the limit
          // proves a decoded body past it. So only a body known to carry no coding is
          // stopped here; one that is or may be compressed is left to `load`, which checks
          // the decoded size exactly.
          if (didSettle) {
            return;
          }

          // Answered by now, for an XHR that reports no change of state too: read once, so
          // a failure later keeps it. One that cannot be read yet is read again where it
          // is needed: past the limit, and on `load`.
          const answeredSoFar = readAndActOnAnswer();

          // Ended by that answer, or by a cancel from its upload callback.
          if (didSettle) {
            return;
          }

          // A bodiless answer's bytes - a `205` that carries some - are neither measured
          // nor reported: no body is handed over, as `load` hands over none. Past the
          // limit, the answer is given without waiting for the rest.
          if (
            answeredSoFar !== undefined &&
            isBodilessAnswer(answeredSoFar.status)
          ) {
            if (event.loaded > maxResponseBytes) {
              answerBodilessEarly(answeredSoFar);
            }
            return;
          }

          // Decided once: a body known uncoded is refused at once, and one that is not is
          // left to `load`.
          if (
            event.loaded > maxResponseBytes &&
            isBodyKnownUncoded === undefined
          ) {
            const answer = readAndActOnAnswer() ?? readAnswer();

            // Ended by the answer, read for the first time here.
            if (didSettle) {
              return;
            }

            if (isBodilessAnswer(answer.status)) {
              answerBodilessEarly(answer);
              return;
            }

            isBodyKnownUncoded = isKnownUncodedBody(answer, answeredURL);

            if (isBodyKnownUncoded) {
              refuseTooLargeBody(answer);
              return;
            }
          }

          const reported = readProgressEvent(event);

          // The one `progress: 1` is `load`'s, with the body's own size: the runtime's 100%
          // may be of an encoded `Content-Length` (Firefox, React Native count a compressed
          // body encoded), which the body itself then differs from.
          if (reported.progress !== 1) {
            reportDownload?.(reported);
          }
        }, true),
      );

      // --- Headers received ---

      // The answer, read as its headers arrive (see `answeredAtHeaders`), and acted on (see
      // `onAnswered`). It ends the upload, as it does in FetchAdapter, so its final event
      // fires here, before any download progress. A read that throws captures nothing; the
      // request ends as it would have. A throw from acting on it is refused, as on
      // `progress`.
      xhr.addEventListener(
        'readystatechange',
        refusingOnThrow(() => {
          if (!didSettle) {
            readAndActOnAnswer();
          }
        }, true),
      );

      // --- Load (success) ---

      xhr.addEventListener(
        'load',
        refusingOnThrow(() => {
          if (didSettle) {
            return;
          }

          didLoad = true;

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
          // Read before any progress callback, as everything this listener reports is: the
          // answer, captured once (see `answeredAtHeaders`).
          const answer = captureAnswer() ?? readAnswer();
          const redirectURL = answer.redirectURL;
          // Seen here only by an XHR that reported none of it before.
          if (redirectURL !== undefined) {
            settleFollowedRedirect(redirectURL);
            return;
          }

          const { status, headers: responseHeaders } = answer;

          // Before the body is read, so a refused body sees it too. A cancel from that upload
          // callback, which `onAbort` leaves to this listener, ends the send as the cancel
          // over the answer, as FetchAdapter and MockAdapter end one, rather than answering
          // as though nothing had cancelled it - and before the body is copied for nothing.
          if (!emitFinalUpload()) {
            return;
          }

          if (isSignalAbortedQuietly(signal)) {
            // With the answer read here, for an XHR that reported none of it before - an
            // answer only with a status.
            settleAborted(
              answeredAtHeaders ?? (status > 0 ? answer : undefined),
            );
            return;
          }

          const body = readResponseBody(method, status, xhr, maxResponseBytes);

          // The server answered and what failed is taking delivery, so a stream error with
          // the real status, as FetchAdapter reports a body it could not read. Left as no
          // body, an XHR that kept it elsewhere would read as a healthy empty answer.
          if (body === RESPONSE_UNREADABLE) {
            resolve(
              streamErrorAnswer(
                answeredURL,
                status,
                responseHeaders,
                'stream_response_error',
                new TypeError(
                  'XHRAdapter response body was neither an ArrayBuffer nor text',
                ),
              ),
            );
            return;
          }

          // The body as handed over can be larger than the bytes progress counted - a
          // runtime may count a compressed response encoded there, and a body that is or
          // may be compressed is not stopped on them - and a runtime need not report
          // progress at all, so the whole body is checked once more here.
          if (
            body === RESPONSE_TOO_LARGE ||
            (body !== null && body.length > maxResponseBytes)
          ) {
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

          // The final download event: the body's own size.
          reportDownloadComplete(body?.length ?? 0);

          // A 3xx the browser did not follow - one with no `Location` - or one handed over
          // by an XHR outside a browser is reported as a redirect, as FetchAdapter reports
          // a real 3xx.
          resolve({
            status,
            ...derivedRedirectFields(answeredURL, status, responseHeaders),
            headers: responseHeaders,
            body,
          });
        }, true),
      );

      // --- Error / timeout / abort ---

      // The error event fires for network-level failures (DNS failure, refused
      // connection, CORS rejection). It never fires for HTTP error status codes
      // (4xx, 5xx) — those arrive on the load event with a real status.
      xhr.addEventListener('error', () => {
        // Not once `load` has started, as for `timeout` and `abort` below: it answers what
        // it loaded. A shim can fire one from a callback `load` runs, before it settles.
        if (didSettle || didLoad) {
          return;
        }

        // Neither replay signal is set here, on purpose. This adapter can never
        // prove non-delivery: upload progress is suppressed for cross-origin
        // requests CORS does not grant access to, and those are still delivered —
        // the browser blocks the response, not the request. The omission is what
        // keeps a `POST` from being replayed by default.
        //
        // `isRetryable: false` does not stand in for it: that flag blocks every
        // method, so it would stop retrying an idempotent `PUT` after an ordinary
        // network error and override `retryNonIdempotentMethods`.
        //
        // Unless the headers had arrived: then the server answered, and what failed is the
        // body, so it is the stream error FetchAdapter reports for one - a redirect the
        // browser had followed reported as the redirect, as on `load`.
        if (answeredAtHeaders !== undefined) {
          const {
            status,
            headers: answeredHeaders,
            redirectURL,
          } = answeredAtHeaders;

          if (redirectURL !== undefined) {
            settleFollowedRedirect(redirectURL);
            return;
          }

          // Ended with the answer already, where it was acted on as it was read: ended here
          // as on every answered exit all the same.
          if (!emitFinalUpload()) {
            return;
          }

          resolve(
            streamErrorAnswer(
              answeredURL,
              status,
              answeredHeaders,
              'stream_response_error',
              new Error('XHR network error'),
            ),
          );
          return;
        }

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
      // than an unexpected abort (non-retryable cancel). One after the headers carries
      // the answer out, as a timeout from the client's own timer does (see `onAbort`).
      // Not once `load` has started, as for `abort` below: it answers what it loaded. A
      // shim can fire one from a callback `load` runs, before `load` has settled.
      xhr.addEventListener('timeout', () => {
        if (!didLoad) {
          settleAborted(answeredAtHeaders, true);
        }
      });

      xhr.addEventListener('abort', () => {
        // Not once `load` has started: it answers whatever its callbacks then cancel, as a
        // browser's `abort()` on a finished XHR fires no event at all. One after the send
        // has settled - the adapter's own, after a `response_too_large` or a followed
        // redirect - `settleAborted` ignores.
        if (!didLoad) {
          settleAborted(answeredAtHeaders);
        }
      });

      /**
       * End the send on an abort, or on a timeout the runtime's XHR fired itself: over an
       * answer, with it carried out (behind a redirect the browser followed, the redirect).
       * Whether it came from the signal or not - a browser aborts a request whose page is
       * leaving - the client sorts it: a cancel stays cancelled. `answer` is the one the
       * caller has, `undefined` for none: told explicitly, so no caller hands over another
       * by omission. Once the send has settled - its own `abort()` after an answer - it
       * does nothing.
       */
      function settleAborted(
        answer: AnsweredHeaders | undefined,
        isBrowserTimeout = false,
      ): void {
        if (didSettle) {
          return;
        }

        if (answer !== undefined) {
          if (answer.redirectURL !== undefined) {
            settleFollowedRedirect(answer.redirectURL);
            return;
          }

          // An answer, as on `load`: the upload ended with it, wherever the download got to.
          // A cancel from that upload callback ended it already.
          if (!emitFinalUpload()) {
            return;
          }
        }

        const abortError = isBrowserTimeout
          ? makeAbortError('Request timed out')
          : makeAbortError();
        const failure =
          answer === undefined
            ? abortError
            : markResponseStreamAbort(
                abortError,
                answer.status,
                answer.headers,
              );

        // Hidden, as the adapters' other tags are: kept out of a serialized error.
        if (isBrowserTimeout) {
          try {
            defineHiddenTags(failure, { [XHR_BROWSER_TIMEOUT_FLAG]: true });
          } catch {
            // An error that refuses the tag is reported as the plain abort it is.
          }
        }

        reject(failure);
      }

      // Fire initial 0% upload progress before any bytes leave the browser, mirroring the
      // FetchAdapter pattern so callers see a consistent first event regardless of
      // adapter. Here, once every refusal above has passed, so a request refused before
      // it is sent reports no upload start.
      //
      // Nor for one cancelled already, as FetchAdapter reports none for a request aborted
      // at dispatch: answered by the abort listener (see `didSend`), or by a signal that
      // reads aborted without telling its listeners. Asked again after the 0% callback,
      // which may cancel, so the request is not sent once it is.
      const endedBeforeSend = (): boolean => {
        if (didSettle) {
          return true;
        }

        let isAborted: boolean;
        try {
          isAborted = isSignalAborted(signal);
        } catch (error) {
          // The caller's signal, refused as at the start.
          refuse(error);
          return true;
        }

        if (isAborted) {
          reject(makeAbortError());
        }

        return isAborted;
      };

      if (endedBeforeSend()) {
        return;
      }

      reportUpload?.({ loaded: 0, total: 0, progress: 0 });

      if (endedBeforeSend()) {
        return;
      }

      // The send itself, guarded. An asynchronous `send()` throws only an
      // `InvalidStateError` or a body it cannot convert (a `toString` that throws, a
      // detached buffer) - network failures arrive as events - and either fails the same
      // way on every attempt, so it is refused as non-retryable - unless the request was
      // cancelled as it was handed over, which stays the cancel, as FetchAdapter keeps one
      // that lands while `fetch` dispatches.
      try {
        didSend = true;
        // A `string`, a `Uint8Array` (a BufferSource) and a `FormData` are all
        // `XMLHttpRequestBodyInit`: the cast is safe for the bodies the client produces.
        xhr.send(requestBody as XMLHttpRequestBodyInit | null);
      } catch (error) {
        if (isSignalAbortedQuietly(signal)) {
          reject(makeAbortError());
        } else {
          refuse(error);
        }
        return;
      }

      // A cancel while `send()` read the body - a value of the caller's converted to text
      // can run code - came before the XHR marked itself sent, where the XHR standard has
      // `abort()` do nothing and fire no event, so the request went out regardless: stopped
      // now, and ended as the cancel it is if no `abort` event did.
      //
      // Stopped as `onAbort` stops one, and ended here where that fired no event.
      if (!didSettle && isSignalAbortedQuietly(signal)) {
        stopCancelledSend();
        settleAborted(answeredAtHeaders);
      }
    };

    return await new Promise((resolve, reject) => {
      // A constructor or `addEventListener` of an XHR outside a browser that throws fails
      // the same way on every attempt, so it is refused as non-retryable too, and, never
      // sent, takes the abort listener off itself.
      try {
        startRequest(resolve, reject);
      } catch (error) {
        removeAbortListener();
        reject(nonRetryableAdapterErrorFrom(error));
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the response body is known to carry no content coding, so the bytes XHR
 * progress counts are the decoded body's own, read off its parsed `headers`. Known only
 * from a `Content-Encoding` of `identity` (or empty) the adapter can read, or from none at
 * all on a browser response that would show one: the request and the response URL both
 * same-origin with the page.
 * A browser hides `Content-Encoding` on a cross-origin response unless the server lists
 * it in `Access-Control-Expose-Headers` - a cross-origin request redirected back to the
 * page's origin included - and outside a browser (no page origin) a runtime may decode
 * the body itself and drop the header (React Native's Android networking does), so
 * there its absence proves nothing and the body is taken as possibly coded.
 */
function isKnownUncodedBody(
  answer: AnsweredHeaders,
  answeredURL: string,
): boolean {
  const contentEncoding = answer.headers['content-encoding'];

  if (contentEncoding !== undefined) {
    return isIdentityContentEncoding(contentEncoding);
  }

  const pageOrigin = readPageOrigin();

  return (
    pageOrigin !== undefined &&
    !isCrossOrigin(pageOrigin, answeredURL) &&
    !isCrossOrigin(pageOrigin, answer.responseURL || answeredURL)
  );
}

/**
 * The origin of the page or worker running the request, which a browser holds a response
 * to for CORS: its global's `origin` (`'null'` in a sandboxed frame, which matches none),
 * else its `location`'s. The page is the scope whose `location` a relative request URL
 * falls back to when the document has no base URL of its own (see `findBrowserPage`); a
 * `<base href>` can resolve the URL elsewhere, but the origin is still that page's.
 * `undefined` where there is no page, or it names no origin, as outside a browser.
 */
function readPageOrigin(): string | undefined {
  const page = findBrowserPage();

  if (page === undefined) {
    return undefined;
  }

  const origin = readUnknownMember(page.scope, 'origin');

  if (typeof origin === 'string') {
    return origin;
  }

  const locationOrigin = readUnknownMember(page.location, 'origin');

  return typeof locationOrigin === 'string' ? locationOrigin : undefined;
}

/**
 * An XHR progress event as the adapter reports it, for upload and download alike. A length
 * is known only where it is one (see `byteProgressEvent`): a shim's `lengthComputable` with
 * a total of `0` would make the progress `NaN` or `Infinity`, and a compressed response can
 * count `loaded` in decoded bytes against an encoded `Content-Length` (Chrome does), so a
 * count past the total says the total is not the body's length.
 */
function readProgressEvent(event: {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}): { loaded: number; total: number; progress: number } {
  return byteProgressEvent(
    event.loaded,
    event.lengthComputable ? event.total : 0,
  );
}

/** An answer as read when its headers arrived, before a later failure resets the XHR. */
interface AnsweredHeaders {
  status: number;
  headers: Record<string, string | string[]>;
  responseURL: string;
  /**
   * The URL of a redirect the browser followed, worked out once as the answer is read.
   * Its headers are then the final page's, which the original URL never answered with:
   * the redirect is what was answered, and the client refuses it.
   */
  redirectURL: string | undefined;
}

/** What `readResponseBody` answers for a body an XHR handed over in no form it can read. */
const RESPONSE_UNREADABLE = Symbol('response unreadable');

/**
 * What `readResponseBody` answers for text whose UTF-8 bytes are over the limit, measured
 * before it is encoded (see `isAnsweredBodyOverLimit`), so it is not copied to be refused.
 */
const RESPONSE_TOO_LARGE = Symbol('response too large');

/**
 * The response for a redirect the browser followed on its own: `status: 0` with the
 * final URL, which the client reports as `redirect_disabled`. A `responseURL` that does
 * not parse reports no `detectedRedirectURL`, as a `Location` that does not resolve
 * reports none, rather than the raw string handed on as though it were a URL.
 */
function browserRedirectResponse(responseURL: string): AdapterResponse {
  const isURL = safeParseURL(responseURL) !== null;

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
 * carry no body (HEAD, 204, 205, 304 and 1xx - see `hasResponseBody`), or
 * `RESPONSE_UNREADABLE` for a body in no form it can read.
 */
function readResponseBody(
  method: string,
  status: number,
  xhr: XMLHttpRequest,
  maxResponseBytes: number,
): Uint8Array | null | typeof RESPONSE_UNREADABLE | typeof RESPONSE_TOO_LARGE {
  // The shared rule, so a `205` or `1xx` is bodiless here as in the other adapters.
  if (!hasResponseBody(method, status)) {
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

  // An XHR outside a browser may not honor `responseType`; its text is taken as UTF-8 bytes,
  // as FetchAdapter takes a polyfilled body's. A browser answers `null` only when it could
  // not allocate the buffer.
  if (typeof response === 'string') {
    return isAnsweredBodyOverLimit(response, maxResponseBytes)
      ? RESPONSE_TOO_LARGE
      : new TextEncoder().encode(response);
  }

  return RESPONSE_UNREADABLE;
}

/**
 * Parses the raw header string from `xhr.getAllResponseHeaders()` into a
 * lowercase-keyed record.
 *
 * `getAllResponseHeaders()` returns CRLF-delimited `name: value` lines; an XHR
 * outside a browser may end them with a bare LF, and both are read. When
 * a server sends multiple headers with the same name the browser combines them
 * into a single comma-joined line for most headers, but emits each `Set-Cookie`
 * value as its own line (per spec) to avoid ambiguity with the comma in cookie
 * values. Those are collected here as `string[]` to match the
 * `AdapterResponse.headers` contract. Any other header but `Location` given on
 * more than one line - by an XHR outside a browser - is joined with `, ` as a
 * browser joins it, so both forms read the same. A repeated `Location` keeps its
 * first value: the first line's, whole, when the XHR gives each on a line of its
 * own, and otherwise the first of one the XHR joined, as FetchAdapter keeps it.
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
  let locationLines = 0;

  if (!raw) {
    return result;
  }

  // Split on LF alone: a CRLF line's CR is HTTP whitespace, trimmed with its value.
  for (const line of raw.split('\n')) {
    // Lines are `Name: value` pairs separated by the first colon.
    // indexOf is used (not split) so colons in the value are preserved.
    const colonIndex = line.indexOf(':');

    if (colonIndex < 0) {
      // No colon — malformed or trailing empty line; skip
      continue;
    }

    // Lowercase to normalize across servers (header names are case-insensitive).
    // Trimmed of HTTP whitespace only: `trim()` would also take U+00A0, the 0xA0 byte a
    // value read as latin1 may end with (the second byte of a UTF-8 `à`).
    const key = lowerCaseHeaderName(
      trimHTTPWhitespace(line.slice(0, colonIndex)),
    );
    const value = trimHTTPWhitespace(line.slice(colonIndex + 1));

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
    } else if (key === 'location') {
      // The first line's value: the others are repeats, and the value is not joined.
      locationLines++;

      if (locationLines === 1) {
        result['location'] = value;
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

  // A `Location` on one line may be one the XHR joined from repeats (a browser joins
  // them): its first value is kept, rather than standing as the one mangled URL
  // `a,%20b` that an XHR outside a browser would follow and `detectedRedirectURL` would
  // report. One given on lines of its own already is its first value, whole.
  if (locationLines === 1) {
    keepFirstJoinedLocation(result);
  }

  return result;
}

/**
 * Compares URLs as browsers evaluate request destinations:
 * - strips userinfo (omitted by responseURL) and hash fragments (not sent over HTTP)
 * - relies on URL normalization for equivalent forms
 *   (default ports, dot segments, encoding normalization, etc.)
 * - on an `https:` page, reads an `http:` URL answered from its `https:` form as the
 *   same URL (see `isUpgradeFromSecurePage`)
 *
 * `answeredURL` is the absolute URL `send` opened. A `responseURL` that does not parse
 * cannot name it, so it is taken as a redirect.
 */
function didBrowserFollowRedirect(
  responseURL: string,
  answeredURL: string,
): boolean {
  const normalizedResponse = safeParseURL(responseURL);

  if (normalizedResponse === null) {
    return true;
  }

  normalizedResponse.hash = '';

  const normalizedRequest = new URL(answeredURL);
  normalizedRequest.hash = '';

  const responseHref = stripURLCredentials(normalizedResponse.href);

  if (responseHref === stripURLCredentials(normalizedRequest.href)) {
    return false;
  }

  return !isUpgradeFromSecurePage(normalizedRequest, responseHref);
}

/**
 * Whether `responseHref` is `request` - an `http:` URL - upgraded to `https:` by the
 * browser itself, on an `https:` page. A browser blocks a plain `http:` request from an
 * `https:` page as mixed content, unless its host is this machine's (see
 * `isLoopbackHost`), so one that was answered was upgraded before it was sent - by the
 * page's `upgrade-insecure-requests` policy, or HSTS - and no server redirected it, as
 * FetchAdapter's `fetch` reports it. The upgrade is the URL with its scheme changed - a
 * default port stays the default, any other port is kept. On an `http:` page an upgrade looks exactly
 * like a server's redirect to `https:`, and is reported as one.
 */
function isUpgradeFromSecurePage(request: URL, responseHref: string): boolean {
  if (request.protocol !== 'http:' || isLoopbackHost(request.hostname)) {
    return false;
  }

  const pageOrigin = readPageOrigin();

  if (pageOrigin === undefined || !pageOrigin.startsWith('https:')) {
    return false;
  }

  const upgraded = new URL(request.href);
  upgraded.protocol = 'https:';

  return stripURLCredentials(upgraded.href) === responseHref;
}
