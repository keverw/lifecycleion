import {
  isMalformedServerStatus,
  malformedStatusAnswer,
} from '../internal/status-code';
import {
  describeRefusedHeader,
  dropTransportFramedHeaders,
  requestHeaderPairs,
  lowerCaseHeaderName,
} from '../internal/header-utils';
import { asciiUppercase, trimHTTPWhitespace } from '../../internal/ascii-text';
import { defineEntry } from '../../internal/define-entry';
import { XHR_BROWSER_TIMEOUT_FLAG } from '../consts';
import { SINGLE_VALUE_RESPONSE_HEADERS } from '../utils';
import {
  byteProgressEvent,
  completeProgressEvent,
  knownBodyByteLength,
} from '../internal/progress';
import {
  connectRefusal,
  defineHiddenTags,
  makeAbortError,
  markResponseStreamAbort,
  nonRetryableAdapterErrorFrom,
  nonRetryableRefusal,
  unsendableBrowserBodyRefusal,
} from '../internal/adapter-error';
import {
  isSignalAborted,
  isSignalAbortedQuietly,
  readAdapterRequestFields,
} from '../internal/request-fields';
import {
  RESPONSE_TOO_LARGE,
  tooLargeAnswer,
  hasResponseBody,
  isAnsweredBodyOverLimit,
  isIdentityContentEncoding,
  declaredContentLength,
  streamErrorAnswer,
} from '../internal/response-limit';
import {
  arrayBufferKindOf,
  assertTypedArrayInBounds,
  fixedUnsharedByteLength,
  plainBytesView,
  readBinaryByteLength,
  typedArrayNameOf,
} from '../../internal/binary-view';
import { safeParseURL } from '../../domain-utils/domain-utils';
import {
  blockedPortMessage,
  bodyOnBodilessMethodMessage,
  fetchBlockedPort,
  forbiddenMethodMessage,
  isBodilessMethod,
  isForbiddenBrowserMethod,
} from '../internal/transport-refusal';
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
  type BrowserPage,
  isBrowserEnvironment,
  isAmbiguousSetCookieLine,
  isCrossOrigin,
  firstJoinedLocation,
  locationText,
  firstNonEmptyValue,
  resolveBrowserDispatchURL,
  stripURLCredentials,
} from '../utils';
import { markBuiltInNetworkAdapter } from '../internal/built-in-adapter';
import { parseURL } from '../../domain-utils/helpers';

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
    // Resolved once, as the browser resolves it - against the document's base URL, or the
    // worker's `location` - with credentials withheld for another origin than the initial
    // URL's, and that one absolute URL is what is opened, what `compareResponseURL`
    // compares `responseURL` with, and what a `Location` resolves against. One that does
    // not resolve, or is not http(s), is refused first, as FetchAdapter and NodeAdapter
    // refuse it, as the non-retryable error it is (see `resolveBrowserDispatchURL`):
    // whether an answer came from where the request was sent cannot be told without an
    // absolute URL to compare `responseURL` with, and XHR would open a `file:` or `data:`
    // URL where the runtime loads one.
    const dispatchedURL = resolveBrowserDispatchURL(
      requestURL,
      initialURL,
      'XHRAdapter',
    );
    if (typeof dispatchedURL !== 'string') {
      throw dispatchedURL;
    }

    // Read once, for the three refusals below that hold in a browser only.
    const isBrowser = isBrowserEnvironment();

    // A browser's XHR fails a request to a port the Fetch Standard blocks on every
    // attempt, as an opaque network error: refused here, as part of the URL, in
    // FetchAdapter's words. In a browser only: a non-browser XHR may reach it.
    const blockedPort = isBrowser ? fetchBlockedPort(dispatchedURL) : undefined;
    if (blockedPort !== undefined) {
      throw nonRetryableRefusal(
        TypeError,
        blockedPortMessage('XHRAdapter', blockedPort),
      );
    }

    // Port 0 on every runtime, as NodeAdapter refuses it: no server listens there, and a
    // non-browser XHR's native networking may read it as no port and dial the scheme's
    // default instead, with the request's credentials and cookies, while the client
    // takes `host:0` as the origin that answered.
    if (safeParseURL(dispatchedURL)?.port === '0') {
      throw nonRetryableRefusal(
        TypeError,
        'XHRAdapter cannot send a request to port 0',
      );
    }

    // XHR sends a plain object as `[object Object]` and a number as its text: refused, as
    // every adapter refuses a body it does not send. A React Native form is one XHR
    // sends (see `unsendableBrowserBodyRefusal`).
    const bodyRefusal = unsendableBrowserBodyRefusal('XHRAdapter', requestBody);
    if (bodyRefusal !== undefined) {
      throw bodyRefusal;
    }

    const upperMethod = asciiUppercase(method);
    if (upperMethod === 'CONNECT') {
      throw connectRefusal('XHRAdapter');
    }

    // A browser's XHR refuses a TRACE or TRACK at `open`, on every attempt: refused here,
    // in the words `HTTPClient` and FetchAdapter use. In a browser only, as the client
    // refuses one: a non-browser XHR (React Native, a shim) may send it.
    if (isBrowser && isForbiddenBrowserMethod(upperMethod)) {
      throw nonRetryableRefusal(
        Error,
        forbiddenMethodMessage('XHRAdapter', method),
      );
    }

    // A browser's XHR drops a GET or HEAD body - the XHR standard sends those bodiless - so
    // the request would go out without it and be answered as though it had been sent.
    // `HTTPClient` refuses one before this, on the same rule, and hands a JSON body that
    // serializes to nothing over as `null`. In a browser only: a non-browser XHR (React
    // Native, a shim) may send the body.
    if (
      isBrowser &&
      isBodilessMethod(upperMethod) &&
      requestBody !== null &&
      requestBody !== undefined
    ) {
      throw nonRetryableRefusal(
        Error,
        bodyOnBodilessMethodMessage('xhr', upperMethod),
      );
    }

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
      // The first settle wins; any after it does nothing.
      let didSettle = false;
      const resolve = (response: AdapterResponse): void => {
        if (didSettle) {
          return;
        }

        didSettle = true;
        resolveSend(response);
        removeAbortListener();
      };
      const reject = (reason: unknown): void => {
        if (didSettle) {
          return;
        }

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

      const xhr = new XMLHttpRequest();

      try {
        // Refused in its own words, and without the runtime's error, as a header below is:
        // a browser's quotes the method it refused.
        try {
          xhr.open(method, dispatchedURL);
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

      // Both read by the abort listener, so declared before it is added: a signal of the
      // caller's may call it as it is added.
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
      // Set once a status no server may send has ended the send (see
      // `endOnMalformedStatus`).
      let didEndOnMalformedStatus = false;

      /**
       * The URL of a redirect the browser followed, fixed as the send begins to end there
       * (see `settleFollowedRedirect`) and before any caller callback runs. A cancel from
       * one of those callbacks then ends the send as that redirect too, however it reaches
       * a settle, rather than as a plain abort where no answer was read.
       */
      let followedRedirectURL: string | undefined;

      // Set while `send()` runs, where the XHR standard has `abort()` do nothing and fire no
      // event until the XHR has marked itself sent: an XHR outside a browser may fire events
      // inside it, and a stop asked for there - a malformed status, a followed redirect, a
      // body over the limit, a cancel - that changes nothing is owed, and made once `send()`
      // has returned (see the send below).
      let isInsideSend = false;
      let isAbortOwed = false;
      /** The XHR's `readyState`, or `undefined` for one whose read throws. */
      const readyStateQuietly = (): unknown => {
        try {
          return xhr.readyState;
        } catch {
          return undefined;
        }
      };

      /**
       * Stop the XHR, then end the send as the abort if nothing has ended it: an `abort()`
       * that throws, or that fires no `abort` event (a shim's that only tears down its
       * transport), leaves nothing else to settle it. A browser's fires the event within
       * the call, which settles first, so the settle here does nothing.
       */
      const abortQuietly = (): void => {
        const stateBefore = isInsideSend ? readyStateQuietly() : undefined;

        try {
          xhr.abort();
        } catch {
          // Settled below.
        }

        // Owed where it changed nothing: an `abort()` that took resets the state. Not for an
        // XHR whose state cannot be read, which shows nothing either way.
        if (
          isInsideSend &&
          stateBefore !== undefined &&
          readyStateQuietly() === stateBefore
        ) {
          isAbortOwed = true;
        }

        settleAborted(answeredAtHeaders);
      };

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
       * Settled by the time it returns, whatever the XHR's `abort()` does (see
       * `abortQuietly`).
       */
      const stopCancelledSend = (): void => {
        try {
          captureAnswer();
        } catch {
          // Nothing more was read to carry out.
        }

        // A malformed status ended the send, by that read or before it: settled, the XHR
        // stopped with it.
        if (didEndOnMalformedStatus) {
          return;
        }

        // An XHR whose state cannot be read is stopped as any other.
        if (readyStateQuietly() === 4) {
          settleAborted(answeredAtHeaders);
          return;
        }

        abortQuietly();
      };

      /**
       * The URL that answered, which a `Location` resolves against and the page's origin is
       * compared with: `dispatchedURL`, or its `https:` form once the answer shows the
       * browser upgraded it (see `compareResponseURL`).
       */
      let answeringURL = dispatchedURL;

      /**
       * The answer as the XHR has it now, its URL taken as `answeringURL`: the one read the
       * adapter acts on, so none resolves a `Location` against a URL the browser upgraded.
       * A redirect the browser followed is told by its URL alone, whatever the status
       * reads, which is all it is reported by: its headers are the final page's, so they
       * are not read, and one that cannot be read does not lose the redirect. Any other
       * answer is held to the status rule first (see `endOnMalformedStatus`): `undefined`
       * when that ended the send.
       */
      const takeAnswer = (status: number): AnsweredHeaders | undefined => {
        // A string or none: an XHR outside a browser may have no `responseURL` at all, which
        // says nothing of a redirect.
        const reportedURL: unknown = xhr.responseURL;
        const responseURL = typeof reportedURL === 'string' ? reportedURL : '';

        // Where the browser followed a redirect to, if it did. An upgrade the browser
        // made itself is not one: the `https:` form is what answered.
        const comparison =
          responseURL === ''
            ? undefined
            : compareResponseURL(responseURL, dispatchedURL);
        const redirectURL =
          comparison?.kind === 'redirected' ? responseURL : undefined;
        answeringURL =
          comparison?.kind === 'upgraded'
            ? comparison.upgradedURL
            : dispatchedURL;

        if (redirectURL === undefined && endOnMalformedStatus(status)) {
          return undefined;
        }

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

      /**
       * Whether `status` is one no server may send - an XHR outside a browser may report
       * one - and so ends the send where it is first read, before the headers or body are
       * read or any of it reported (see `malformedStatusAnswer`), the XHR stopped - or, for
       * a send the caller has cancelled, as that cancel. Settled once, whichever reads it.
       * Asked by `takeAnswer` alone, once it has seen no redirect the browser followed.
       */
      const endOnMalformedStatus = (status: number): boolean => {
        if (status === 0 || !isMalformedServerStatus(status)) {
          return false;
        }

        didEndOnMalformedStatus = true;

        if (isSignalAbortedQuietly(signal)) {
          settleAborted(undefined);
        } else {
          // The server answered, so the upload ended, as with any answer; a cancel from
          // that callback stays the cancel.
          emitFinalUpload();

          if (isSignalAbortedQuietly(signal)) {
            settleAborted(undefined);
          } else {
            resolve(malformedStatusAnswer(status));
          }
        }

        abortQuietly();

        return true;
      };

      /**
       * The answer, read the first time there is one (see `takeAnswer`). Read no more once
       * a malformed status ended the send, so its rule runs once.
       */
      const captureAnswer = (): AnsweredHeaders | undefined => {
        if (
          answeredAtHeaders === undefined &&
          !didEndOnMalformedStatus &&
          xhr.readyState >= 2
        ) {
          const status = xhr.status;

          if (status !== 0) {
            answeredAtHeaders = takeAnswer(status);
          }
        }

        return answeredAtHeaders;
      };

      /**
       * The answer a listener acts on: `captured`, as it read it, or the answer read now
       * for an XHR that showed none before (one outside a browser may report progress or
       * `load` first). `undefined` once the send has ended, by that read or before it.
       */
      const answerToActOn = (
        captured: AnsweredHeaders | undefined,
      ): AnsweredHeaders | undefined => {
        if (didSettle) {
          return undefined;
        }

        return captured ?? takeAnswer(xhr.status);
      };

      /**
       * `answer`, or the redirect the browser followed where `responseURL` shows it only
       * now: an XHR outside a browser may report the URL it ended at only later - by
       * `load`, or partway through the download - after a status and headers read with
       * none. Such an answer is the followed redirect, as one seen at the headers is: the
       * final page's status and headers are not its own. Asked at `load`, and of a held
       * answer read with no URL each time the state and progress listeners read it again
       * (see `withRedirectShownSinceRead`).
       */
      const withRedirectSeenLater = (
        answer: AnsweredHeaders | undefined,
      ): AnsweredHeaders | undefined => {
        if (answer === undefined || answer.redirectURL !== undefined) {
          return answer;
        }

        const reportedURL: unknown = xhr.responseURL;
        const responseURL = typeof reportedURL === 'string' ? reportedURL : '';

        if (responseURL === '' || responseURL === answer.responseURL) {
          return answer;
        }

        const comparison = compareResponseURL(responseURL, dispatchedURL);

        // An upgrade the browser made itself, shown only now: the `https:` form is what
        // answered, so a `Location` resolves against it, as one seen at the headers does.
        if (comparison.kind === 'upgraded') {
          answeringURL = comparison.upgradedURL;
          return answer;
        }

        if (comparison.kind !== 'redirected') {
          return answer;
        }

        return {
          status: answer.status,
          headers: {},
          responseURL,
          redirectURL: responseURL,
        };
      };

      /**
       * `answer`, with the headers the XHR shows now where it showed none when the answer
       * was read: an XHR outside a browser may report a status as its headers arrive but
       * its headers only by `load`. A read that throws keeps `answer` as it was.
       */
      const withHeadersShownAtLoad = (
        answer: AnsweredHeaders,
      ): AnsweredHeaders => {
        if (
          answer.redirectURL !== undefined ||
          Object.keys(answer.headers).length > 0
        ) {
          return answer;
        }

        let headers: AnsweredHeaders['headers'];
        try {
          headers = parseXHRResponseHeaders(xhr.getAllResponseHeaders());
        } catch {
          return answer;
        }

        return Object.keys(headers).length === 0
          ? answer
          : { ...answer, headers };
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

          // Not sent yet - the 0% upload callback, or the caller's code while the request
          // was prepared, cancelled it: answered here, and never sent.
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

      // The size of a body that is not text, read once: `0` for none or an empty one,
      // `undefined` where it cannot be known up front (a `FormData`). Text with any
      // characters is at least a byte, so it is measured only by the final upload event,
      // and only when the browser reported nothing. Only when upload progress was asked
      // for: nothing else reads it.
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
      // one too, and however the upload ends: the bytes the browser reported, or the
      // body's own size where it reported none - `0` for an empty string, as FetchAdapter
      // reports it - not a stand-in `1`. Answers whether the send is still pending after
      // it: that callback may cancel, which ends it.
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
      const refusingOnThrow = <TEvent>(
        listener: (event: TEvent) => void,
        isOnAnswer: boolean,
      ): ((event: TEvent) => void) => {
        return (event) => {
          try {
            listener(event);
          } catch (error) {
            if (isOnAnswer) {
              emitFinalUpload();
            }

            refuse(error);
            abortQuietly();
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
        const upload: XMLHttpRequestUpload | null | undefined = hasBytesToSend
          ? xhr.upload
          : undefined;

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
       *
       * A cancel from the final upload or download callback ends it as the redirect too,
       * on every path that sees one - as a cancel over any other answer carries that
       * answer out - and the client reports the request cancelled. The redirect is fixed
       * before those callbacks run (see `followedRedirectURL`): their cancel may reach a
       * settle again, through `abort()` and its event, before this one resolves.
       */
      const settleFollowedRedirect = (redirectURL: string): void => {
        followedRedirectURL ??= redirectURL;

        emitFinalUpload();
        reportDownloadComplete(0);
        resolve(browserRedirectResponse(followedRedirectURL));
        // Whatever the page goes on to deliver is reported to no one.
        abortQuietly();
      };

      /**
       * The gate every exit over an answer passes first: a redirect the browser followed
       * ends the send as that redirect, whatever the exit was about to report, and any
       * other answer ends the upload (see `emitFinalUpload`). Answers whether the send is
       * still pending after it - a cancel from that final upload callback ends it, as the
       * cancel over the answer.
       */
      const endUploadWithAnswer = (answer: AnsweredHeaders): boolean => {
        if (answer.redirectURL !== undefined) {
          settleFollowedRedirect(answer.redirectURL);
          return false;
        }

        return emitFinalUpload();
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
        // A cancel from the final upload callback ends the send as the cancel over
        // `answer`, kept first for an XHR that showed it only to this read (one that
        // reports no change of state).
        answeredAtHeaders ??= answer;
        if (!endUploadWithAnswer(answer)) {
          return;
        }

        settle();
        // Whatever the answer goes on to deliver is reported to no one.
        abortQuietly();
      };

      /**
       * Fail a body past `maxResponseBytes` as a stream error with the real status and
       * headers of `answer`, and stop the download.
       */
      const refuseTooLargeBody = (answer: AnsweredHeaders): void => {
        endDownloadAt(answer, () => {
          resolve(
            tooLargeAnswer(
              answeringURL,
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
              answeringURL,
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
       * Act on the answer as it is first read: a redirect the browser followed ends the
       * send, and any other ends the upload - and the send too, for a body whose
       * `Content-Length` says up front it is past `maxResponseBytes`, as FetchAdapter
       * refuses one before reading it, so it is not downloaded first. Only where that
       * length counts the body itself (see `isKnownUncodedBody`), and only for an answer
       * with a body: a `HEAD`'s `Content-Length` is the `GET`'s.
       */
      const onAnswered = (answer: AnsweredHeaders): void => {
        if (
          !endUploadWithAnswer(answer) ||
          !Number.isFinite(maxResponseBytes) ||
          !hasResponseBody(method, answer.status)
        ) {
          return;
        }

        const declaredLength = declaredContentLength(answer.headers);

        if (
          declaredLength === undefined ||
          declaredLength <= maxResponseBytes
        ) {
          return;
        }

        // The same decision the download's bytes would come to (see `isBodyKnownUncoded`).
        isBodyKnownUncoded = isKnownUncodedBody(answer, answeringURL);

        if (isBodyKnownUncoded) {
          refuseTooLargeBody(answer);
        }
      };

      /**
       * `answer`, read with no URL, as the redirect the browser followed where the XHR
       * shows one now - partway through the download, say (see `withRedirectSeenLater`) -
       * kept as the answer and the send ended as that redirect (see `endUploadWithAnswer`),
       * before anything else is made of the download. An answer read with its URL is
       * judged by it; a read that throws leaves the answer as it was read. Asked by the
       * state and progress listeners (see `readAndActOnAnswer`) and at `load`, not where a
       * cancel, a timeout or a failure ends the send: a browser shows the URL with the
       * headers, and clears it on those.
       */
      const withRedirectShownSinceRead = (
        answer: AnsweredHeaders,
      ): AnsweredHeaders => {
        if (answer.responseURL !== '' || answer.redirectURL !== undefined) {
          return answer;
        }

        let seen: AnsweredHeaders;
        try {
          seen = withRedirectSeenLater(answer) ?? answer;
        } catch {
          return answer;
        }

        if (seen.redirectURL !== undefined) {
          answeredAtHeaders = seen;
          endUploadWithAnswer(seen);
        }

        return seen;
      };

      /**
       * The answer, read the first time there is one and acted on as it is (see
       * `onAnswered`), by every listener that reads it on its way in. A read that throws
       * captures nothing: the request ends as it would have.
       */
      const readAndActOnAnswer = (): AnsweredHeaders | undefined => {
        if (answeredAtHeaders !== undefined) {
          return withRedirectShownSinceRead(answeredAtHeaders);
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
            // Read and acted on again, not taken from `answeredSoFar`: an answer whose read
            // threw above may read now, and is then kept, so an `error` after it is the
            // stream error over it. Read uncached only where it still cannot be - an XHR
            // that reports progress before its state - and then held to the same status
            // rule, as `load` holds it.
            const answer = answerToActOn(readAndActOnAnswer());

            // Ended by the answer, read for the first time here.
            if (answer === undefined) {
              return;
            }

            // Told by its URL alone, whatever the status reads.
            if (answer.redirectURL !== undefined) {
              settleFollowedRedirect(answer.redirectURL);
              return;
            }

            if (isBodilessAnswer(answer.status)) {
              answerBodilessEarly(answer);
              return;
            }

            // Decided only on a real status: a `0` is an XHR that does not show the answer
            // yet (one outside a browser may report progress first), and its headers -
            // the `Content-Encoding` the decision reads - with it. Judged again on the
            // next event past the limit, and on `load`.
            if (answer.status !== 0) {
              isBodyKnownUncoded = isKnownUncodedBody(answer, answeringURL);

              if (isBodyKnownUncoded) {
                refuseTooLargeBody(answer);
                return;
              }
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
          // Read here for the first time by an XHR that showed no state before `load`.
          const seen = withRedirectSeenLater(answerToActOn(captureAnswer()));

          // Ended by the answer: a malformed status.
          if (seen === undefined) {
            return;
          }

          const answer = withHeadersShownAtLoad(seen);

          // A redirect is seen here only by an XHR that reported none of it before. The
          // final upload event fires before the body is read, so a refused body sees it
          // too. A cancel from that upload callback, which `onAbort` leaves to this
          // listener, ends the send as the cancel over the answer, as FetchAdapter and
          // MockAdapter end one, rather than answering as though nothing had cancelled it
          // - and before the body is copied for nothing.
          if (!endUploadWithAnswer(answer)) {
            return;
          }

          const { status, headers: responseHeaders } = answer;

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
                answeringURL,
                status,
                responseHeaders,
                'stream_response_error',
                new TypeError(
                  'XHRAdapter response body could not be read as bytes or text',
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
                answeringURL,
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
            ...derivedRedirectFields(answeringURL, status, responseHeaders),
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
          // The upload ended with the answer already, where it was acted on as it was
          // read: ended here as on every answered exit all the same.
          if (!endUploadWithAnswer(answeredAtHeaders)) {
            return;
          }

          resolve(
            streamErrorAnswer(
              answeringURL,
              answeredAtHeaders.status,
              answeredAtHeaders.headers,
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
       * leaving - the client sorts it: one the caller's cancel made stays cancelled, and
       * one no one asked for is the adapter's failure. `answer` is the one the
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

        // A redirect the send is already ending at, whether or not `answer` shows it.
        if (followedRedirectURL !== undefined) {
          settleFollowedRedirect(followedRedirectURL);
          return;
        }

        // An answer, as on `load`: the upload ended with it, wherever the download got to.
        // A cancel from that upload callback ended the send already.
        if (answer !== undefined && !endUploadWithAnswer(answer)) {
          return;
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
      // `InvalidStateError` or a body it cannot read (a buffer detached since it was
      // checked) - network failures arrive as events - and an XHR outside a browser may
      // throw for its own reasons; each fails the same way on every attempt, so it is
      // refused as non-retryable - unless the request was cancelled as it was handed
      // over, which stays the cancel, as FetchAdapter keeps one that lands while `fetch`
      // dispatches.
      try {
        didSend = true;
        isInsideSend = true;
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
      } finally {
        isInsideSend = false;
      }

      // A stop asked for while `send()` ran, whose `abort()` changed nothing there, came
      // before the XHR marked itself sent, so the request went out regardless: made again
      // now, once, unless the runtime completed the response within `send()`.
      if (isAbortOwed) {
        isAbortOwed = false;

        if (readyStateQuietly() !== 4) {
          abortQuietly();
        }
      } else if (isSignalAbortedQuietly(signal)) {
        // A cancel while `send()` ran with no stop owed - code an XHR outside a browser ran
        // inside it asked for none, or one asked for there took - stopped now, as `onAbort`
        // stops one (an `abort()` on an XHR already stopped does nothing), and ended as the
        // cancel it is. One the runtime completed within `send()` is done, and not aborted.
        stopCancelledSend();
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
  answeringURL: string,
): boolean {
  const contentEncoding = answer.headers['content-encoding'];

  if (contentEncoding !== undefined) {
    return isIdentityContentEncoding(contentEncoding);
  }

  const pageOrigin = readPageOrigin();

  return (
    pageOrigin !== undefined &&
    !isCrossOrigin(pageOrigin, answeringURL) &&
    !isCrossOrigin(pageOrigin, answer.responseURL || answeringURL)
  );
}

/**
 * The origin of the page or worker running the request, which a browser holds a response
 * to for CORS. Its `location`'s, which a page's script cannot replace, except where the
 * global's own `origin` is the one that differs by right: `'null'` in a sandboxed frame,
 * which matches none, or the creator's origin in a document whose URL names none
 * (`about:blank`, `about:srcdoc`), whose `location` reads `'null'`. Any other `origin`
 * that differs from the `location`'s is not taken: the global's `origin` is
 * replaceable, so a classic script's `var origin = '…'` rewrites it, and read as the
 * page's it would make an `http:` page look `https:` (see `isOnHTTPSPage`). A `location`
 * that names no origin, as a shim's may not, leaves the global's.
 *
 * The page is the scope whose `location` a relative request URL falls back to when the
 * document has no base URL of its own (see `findBrowserPage`); a `<base href>` can
 * resolve the URL elsewhere, but the origin is still that page's. `undefined` where there
 * is no page, or it names no origin, as outside a browser.
 */
function readPageOrigin(
  page: BrowserPage | undefined = findBrowserPage(),
): string | undefined {
  if (page === undefined) {
    return undefined;
  }

  const scopeOrigin = readUnknownMember(page.scope, 'origin');
  const locationOrigin = readUnknownMember(page.location, 'origin');

  if (typeof locationOrigin !== 'string') {
    return typeof scopeOrigin === 'string' ? scopeOrigin : undefined;
  }

  return typeof scopeOrigin === 'string' &&
    (scopeOrigin === 'null' || locationOrigin === 'null')
    ? scopeOrigin
    : locationOrigin;
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
  // back a buffer made in another realm (see `arrayBufferKindOf`).
  const response: unknown = xhr.response;
  if (typeof response === 'object' && response !== null) {
    // Which buffer it is, if one, told once through the intrinsic getters.
    const bufferKind = arrayBufferKindOf(response);
    const isView = bufferKind === undefined && ArrayBuffer.isView(response);

    // Measured once, before any copy (through the intrinsic getters), so a body past the
    // limit is refused without being held twice - and a copy takes no more than these
    // bytes: a growable `SharedArrayBuffer` another thread grows after this is still
    // copied at the size that passed.
    const byteLength =
      bufferKind !== undefined || isView
        ? readBinaryByteLength(response)
        : null;
    if (byteLength !== null && byteLength > maxResponseBytes) {
      return RESPONSE_TOO_LARGE;
    }
    const measured = byteLength ?? undefined;

    // Bytes over a detached buffer, or a view past the end of a shrunk resizable one,
    // cannot be read: unreadable, as FetchAdapter fails such a body, rather than an empty
    // body delivered as a success - the getters read either as empty.
    try {
      // Wrapped as it is when it is a fixed `ArrayBuffer`, which the XHR hands over and
      // no one else writes; copied when it is shared or resizable, as the other adapters
      // copy a chunk over one, so no other code can change or resize the body once it is
      // read.
      if (bufferKind !== undefined) {
        const bytes = new Uint8Array(response as ArrayBuffer);
        return fixedUnsharedByteLength(response) !== null
          ? bytes
          : bytes.slice(0, measured);
      }

      // A view rather than the buffer itself - happy-dom answers `responseType =
      // 'arraybuffer'` with a `Uint8Array`, and a shim may hand over a Node `Buffer` -
      // from any realm (`ArrayBuffer.isView` reads the internal slot). Copied: a `Buffer`
      // may be a slice of a pooled slab, whose other bytes are not this body's. A typed
      // array is checked in bounds first, as a `DataView`'s getters check themselves.
      if (isView) {
        if (typedArrayNameOf(response) !== undefined) {
          assertTypedArrayInBounds(response);
        }

        return plainBytesView(response).slice(0, measured);
      }
    } catch {
      return RESPONSE_UNREADABLE;
    }
  }

  // An XHR outside a browser may not honor `responseType`: a string `response`, or none at
  // all and the body in `responseText` (the `xmlhttprequest` package has no `response`),
  // is taken as UTF-8 bytes, as FetchAdapter takes a polyfilled body's. Only where
  // `response` is `undefined`: a browser reads it as `null` when it could not allocate the
  // buffer, and throws for `responseText` under `'arraybuffer'`.
  const text: unknown = response === undefined ? xhr.responseText : response;
  if (typeof text === 'string') {
    return isAnsweredBodyOverLimit(text, maxResponseBytes)
      ? RESPONSE_TOO_LARGE
      : new TextEncoder().encode(text);
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
 * browser joins it, except one that holds a single value (see
 * `SINGLE_VALUE_RESPONSE_HEADERS`; `Content-Length` aside), which keeps its first
 * line, as Node keeps it: lines of their own are known to be separate values, which
 * joining them would make ambiguous. A repeated `Location` keeps its
 * first value that is not empty: the first such line's, whole, when the XHR gives
 * each on a line of its own (the first line when all are empty), and otherwise the
 * first of one the XHR joined, as FetchAdapter keeps it.
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
  const locations: string[] = [];
  // The first `Location` line's value with its end as it came, CR aside: a line the XHR
  // joined from repeats ends in `, ` when the last was empty, which trimming would turn
  // into a `,` that reads as part of the URL.
  let firstLocationLine: string | undefined;
  const setCookies: string[] = [];

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
      // Each Set-Cookie directive arrives as its own line — collected below into an
      // array so callers never need to split on commas (which are valid inside
      // cookie values). Guarded by the XHR spec in standard browsers, but kept
      // for correctness in legacy environments or platforms with non-standard
      // XHR implementations.
      setCookies.push(value);
    } else if (key === 'location') {
      // Kept below: lines of their own are repeats, and not joined.
      if (locations.length === 0) {
        firstLocationLine = line
          .slice(colonIndex + 1)
          .replace(/^[\t\n\r ]+/, '')
          .replace(/\r$/, '');
      }

      locations.push(value);
    } else {
      const existing = Object.hasOwn(result, key) ? result[key] : undefined;

      // A header that holds one value keeps its first line, as Node's `http` keeps it:
      // lines of their own are known to be separate values, which joining would make
      // ambiguous - an asctime `Retry-After` joined with a second line reads as a date
      // with a zone it does not know, and is not waited for. Not `Content-Length`: its
      // lines are joined, so lengths that disagree are read as no declared length and
      // the body is measured instead.
      if (
        existing !== undefined &&
        key !== 'content-length' &&
        SINGLE_VALUE_RESPONSE_HEADERS.has(key)
      ) {
        continue;
      }

      // Defined, not assigned, as every other adapter does: a `__proto__` header
      // would otherwise hit the prototype setter and vanish.
      defineEntry(
        result,
        key,
        existing === undefined ? value : `${existing as string}, ${value}`,
      );
    }
  }

  // An XHR that gives `Set-Cookie` on lines of their own joins none of them, so each is
  // one whole cookie, a comma before another `name=value` included. A lone line may be
  // several such an XHR joined, and one that may be is dropped, as FetchAdapter drops
  // one (see `isAmbiguousSetCookieLine`).
  if (
    setCookies.length > 1 ||
    (setCookies.length === 1 && !isAmbiguousSetCookieLine(setCookies[0]))
  ) {
    result['set-cookie'] = setCookies;
  }

  // A `Location` on one line may be one the XHR joined from repeats (a browser joins
  // them): its first value is kept, rather than standing as the one mangled URL
  // `a,%20b` that an XHR outside a browser would follow and `detectedRedirectURL` would
  // report. Of lines of their own, the first that is not empty is kept whole, as
  // browsers follow it, or the first when all are.
  if (firstLocationLine !== undefined) {
    // Its bytes read as UTF-8, as the browser follows it (see `locationText`).
    result['location'] = locationText(
      locations.length === 1
        ? trimHTTPWhitespace(firstJoinedLocation(firstLocationLine))
        : (firstNonEmptyValue(locations) ?? locations[0]),
    );
  }

  return result;
}

/**
 * How `responseURL` stands to `dispatchedURL`, the absolute URL `send` opened, compared
 * as browsers evaluate request destinations:
 * - userinfo (omitted by `responseURL`) and hash fragments (not sent over HTTP) are
 *   stripped
 * - URL normalization makes equivalent forms equal (default ports, dot segments,
 *   encoding normalization, etc.)
 *
 * The same URL is `'same'`. On an `https:` page, an `http:` URL answered from its own
 * `https:` form - the scheme changed, a default port staying the default and any other
 * kept - is `'upgraded'`, with that form as `upgradedURL`: a browser blocks a plain
 * `http:` request from such a page as mixed content, so one that was answered there was
 * upgraded before it was sent - by the page's `upgrade-insecure-requests` policy, or
 * HSTS - and no server redirected it, as FetchAdapter's `fetch` reports it. Not for a
 * host of this machine's (see `isLoopbackHost`), which a browser lets through over
 * `http:`, so a local proxy's redirect to the same URL over `https:` - a `301` that
 * turned a `POST` into a `GET` among them - is not mistaken for an upgrade. On an
 * `http:` page an upgrade looks exactly like a server's redirect to `https:`, and is
 * reported as one. Anything else is `'redirected'`, a `responseURL` that does not parse
 * among them, since it cannot name `dispatchedURL`.
 */
function compareResponseURL(
  responseURL: string,
  dispatchedURL: string,
): { kind: 'same' | 'redirected' } | { kind: 'upgraded'; upgradedURL: string } {
  const normalizedResponse = safeParseURL(responseURL);

  if (normalizedResponse === null) {
    return { kind: 'redirected' };
  }

  normalizedResponse.hash = '';
  const responseHref = stripURLCredentials(normalizedResponse.href);

  const request = parseURL(dispatchedURL);
  // Taken from the serialized URL, not `hash`, which reads `''` for an empty fragment
  // (`/a#`) as for none: a `Location` inherits an empty one too, as Fetch has it.
  const fragmentIndex = request.href.indexOf('#');
  const fragment =
    fragmentIndex === -1 ? '' : request.href.slice(fragmentIndex);
  request.hash = '';

  if (responseHref === stripURLCredentials(request.href)) {
    return { kind: 'same' };
  }

  if (
    request.protocol !== 'http:' ||
    isLoopbackHost(request.hostname) ||
    !isOnHTTPSPage()
  ) {
    return { kind: 'redirected' };
  }

  request.protocol = 'https:';

  if (responseHref !== stripURLCredentials(request.href)) {
    return { kind: 'redirected' };
  }

  return { kind: 'upgraded', upgradedURL: `${request.href}${fragment}` };
}

/**
 * Whether the page or worker running the request is an `https:` one, whose `http:`
 * requests a browser blocks as mixed content: its origin (see `readPageOrigin`), or - for
 * a page whose origin is `'null'`, as a sandboxed frame's is - its `location`.
 */
function isOnHTTPSPage(): boolean {
  const page = findBrowserPage();

  return (
    page !== undefined &&
    (readPageOrigin(page)?.startsWith('https:') === true ||
      page.href.startsWith('https:'))
  );
}
