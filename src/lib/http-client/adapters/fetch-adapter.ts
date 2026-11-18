import {
  isMalformedServerStatus,
  malformedStatusAnswer,
} from '../internal/status-code';
import {
  describeRefusedHeader,
  dropTransportFramedHeaders,
  materializeRequestHeaders,
  requestHeaderPairs,
} from '../internal/header-utils';
import { defineEntry } from '../../internal/define-entry';
import { BodyBytes } from '../internal/body-bytes';
import { isHighSurrogate } from '../internal/utf8-length';
import {
  isSignalAborted,
  isSignalAbortedQuietly,
  readAdapterRequestFields,
} from '../internal/request-fields';
import {
  connectRefusal,
  isAbortError,
  makeAbortError,
  markResponseStreamAbort,
  nonRetryableRefusal,
  nonRetryableAdapterErrorFrom,
  unsendableBrowserBodyRefusal,
} from '../internal/adapter-error';
import {
  extractFetchHeaders,
  derivedRedirectFields,
  resolveBrowserDispatchURL,
} from '../utils';
import {
  knownBodyByteLength,
  completeProgressEvent,
} from '../internal/progress';
import { isTLSCertificateError } from '../internal/tls-error-utils';
import {
  RESPONSE_TOO_LARGE,
  hasResponseBody,
  isIdentityContentEncoding,
  tooLargeAnswer,
  streamErrorAnswer,
  parseContentLength,
} from '../internal/response-limit';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
} from '../types';
import { markBuiltInNetworkAdapter } from '../internal/built-in-adapter';
// Shared error normalization preserves Error instances and wraps other thrown values.
// Non-Error values receive a "Non-error value thrown: <description>" message, with the
// original value retained on cause for consumers of the normalized error.
import { toError as normalizeError } from '../../to-error';
// Members of a body or a thrown error read guarded, for the same reason adapter marker
// reads are.
import { readUnknownMember } from '../../internal/read-member';
import { callQuietly } from '../../internal/call-quietly';
import { adoptPromise } from '../../internal/adopt-promise';
import {
  readBinaryByteLength,
  isUint8ArrayValue,
} from '../../internal/binary-view';
import { asciiLowercase, asciiUppercase } from '../../internal/ascii-text';
import {
  blockedPortMessage,
  bodyOnBodilessMethodMessage,
  fetchBlockedPort,
  fetchRefusedHeader,
  fetchRefusedHeaderMessage,
  forbiddenMethodMessage,
  isBodilessMethod,
  isForbiddenBrowserMethod,
} from '../internal/transport-refusal';
import { RESPONSE_DECODE_ERROR_KEY } from '../consts';

export class FetchAdapter implements HTTPAdapter {
  constructor() {
    // Its class's `send`, so the client hands it the request body uncopied while that is
    // the `send` called (see `isBuiltInNetworkSend`).
    markBuiltInNetworkAdapter(
      this,
      Reflect.get(FetchAdapter.prototype, 'send'),
    );
  }

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
    // A relative URL is resolved as `fetch` resolves it, against the document's base URL
    // or the worker's `location`, with credentials withheld for another origin than the
    // initial URL's; one that does not resolve, or is not http(s), is refused as the
    // non-retryable `adapter_error` it is (see `resolveBrowserDispatchURL`). Unresolved,
    // `fetch` would throw an invalid URL error retried as a network failure to no end. The
    // URL sent, and what a `Location` resolves against.
    const dispatchedURL = resolveBrowserDispatchURL(
      requestURL,
      initialURL,
      'FetchAdapter',
    );

    if (typeof dispatchedURL !== 'string') {
      throw dispatchedURL;
    }

    // A port the Fetch Standard blocks is refused by Node's and every browser's `fetch`
    // on every attempt - a browser's as an opaque `TypeError`, retried as a network
    // failure with nothing sent - and sent by Bun's: refused here, on every runtime, as
    // part of the URL, before the body, the method and the headers are checked and
    // before anything is reported.
    const blockedPort = fetchBlockedPort(dispatchedURL);
    if (blockedPort !== undefined) {
      throw nonRetryableRefusal(
        TypeError,
        blockedPortMessage('FetchAdapter', blockedPort),
      );
    }

    // `fetch` sends a plain object as `[object Object]` and a number as its text, and on
    // Node fails a `ReadableStream` on every attempt as a network error: refused, as every
    // adapter refuses a body it does not send. A React Native form is one its `fetch`
    // sends (see `unsendableBrowserBodyRefusal`).
    const bodyRefusal = unsendableBrowserBodyRefusal('FetchAdapter', body);
    if (bodyRefusal !== undefined) {
      throw bodyRefusal;
    }

    // Refused by name, before the method, in the order NodeAdapter refuses its own; and
    // here, on every runtime, before the 0% upload event, rather than left to the runtime:
    // Node's `fetch` refuses one only once it dispatches, and Bun's sends it (see
    // `fetchRefusedHeader`).
    const refusedHeader = fetchRefusedHeader(headers);
    if (refusedHeader !== undefined) {
      throw nonRetryableRefusal(
        TypeError,
        fetchRefusedHeaderMessage('FetchAdapter', refusedHeader),
      );
    }

    // The Fetch Standard forbids these, but Bun's `fetch` sends a `CONNECT` or `TRACE`, so
    // they are refused here, on every runtime, rather than left to it - a `CONNECT` as
    // every adapter refuses one.
    if (isForbiddenBrowserMethod(method)) {
      if (asciiUppercase(method) === 'CONNECT') {
        throw connectRefusal('FetchAdapter');
      }
      throw nonRetryableRefusal(
        Error,
        forbiddenMethodMessage('FetchAdapter', method),
      );
    }

    dropTransportFramedHeaders(headers, body);

    // `fetch` refuses a GET or HEAD with any body that is not `null`, an empty string
    // included, on every attempt - a `TypeError` with no code, which would be retried as a
    // network failure to no end. The probe below is built without the body, so it is
    // checked here. `HTTPClient` refuses one before this, and hands a JSON body that
    // serializes to nothing over as `null`.
    if (isBodilessMethod(method) && body !== null && body !== undefined) {
      throw nonRetryableRefusal(
        Error,
        bodyOnBodilessMethodMessage('fetch', method),
      );
    }

    // Checked before it is sent, so a request fetch refuses to build - Node's fetch refuses
    // a URL carrying credentials, on every attempt - fails once as the non-retryable
    // `adapter_error` it is, rather than as a network error retried to no end. Built
    // without the body or signal, which `fetch` below takes, so nothing is consumed. A
    // header value or method `fetch` refuses is caught here too, rather than coming back
    // from `fetch` as its `TypeError` and retried the same way.
    //
    // Only where it can be: a runtime with `Request` - a test setup that polyfills only
    // `fetch` has none. There the headers are still checked, by `Headers` where it exists,
    // so a value it refuses is not retried either.
    //
    // Refused in its own words, and without the runtime's error: that quotes what it
    // refused - Bun a header value, Node a URL with its userinfo and query - and a
    // carrier's message and `cause` reach logs.
    //
    // The headers are materialized once, here, and kept for `fetch` below.
    let fetchHeaders: HeadersInit;
    try {
      fetchHeaders = materializeFetchHeaders(headers);
      if (typeof Request !== 'function' && typeof Headers === 'function') {
        new Headers(fetchHeaders);
      }
    } catch {
      throw refusedRequestBuild(headers);
    }

    if (typeof Request === 'function') {
      let builtMethod: string;
      try {
        builtMethod = new Request(dispatchedURL, {
          method,
          headers: fetchHeaders,
          redirect: 'manual',
        }).method;
      } catch {
        throw refusedRequestBuild(headers);
      }

      // A runtime that rewrites the method - Bun's fetch reads one it does not know as
      // `GET` - would send a different request than the caller's, and report its answer
      // as a success: a state-changing custom verb landing on a GET handler. Refused.
      // Compared exactly: a standard method is already uppercase (see
      // `readAdapterMethod`), and any other is case-sensitive - a `fetch` that
      // uppercases `purge` sends a different method, which a server may route apart.
      if (builtMethod !== method) {
        throw nonRetryableRefusal(
          Error,
          `[FetchAdapter] This runtime's fetch would send the ${method} request as ${builtMethod}. Use NodeAdapter for it.`,
        );
      }
    }

    // Read through the guarded accessor before anything is dispatched, as the other
    // adapters read it: `fetch` reads the signal's internal state, not the getter, so a
    // signal whose `aborted` throws would otherwise go out unrefused. An aborted one is
    // `fetch`'s to reject, with its reason. The failure paths below read it quietly.
    const wasAbortedAtDispatch = isSignalAborted(signal);

    // Fire 0% upload progress - once every refusal above has passed, so a request refused
    // before anything is sent, an aborted one included, reports no upload start. One that
    // cancels here aborts the signal `fetch` is handed, which rejects with it.
    if (!wasAbortedAtDispatch) {
      guardedUploadProgress?.({ loaded: 0, total: 0, progress: 0 });
    }

    let response: Response;

    try {
      response = await fetch(dispatchedURL, {
        method,
        headers: fetchHeaders,
        body: body as BodyInit | null,
        signal: signal ?? null,
        redirect: 'manual',
      });
    } catch (error) {
      // Re-throw AbortErrors and any error thrown when the signal is already
      // aborted. When abort(string) is called, fetch rejects with the string
      // itself (not an AbortError), so checking signal.aborted covers that case.
      if (isAbortError(error) || isSignalAbortedQuietly(signal)) {
        throw error; // preserve cancellation / timeout classification
      }

      const normalizedError = normalizeError(error);

      // A request Node's undici refuses at dispatch rather than at `new Request` - a header
      // or a port it refuses that `fetchRefusedHeader` and `fetchBlockedPort` above do not
      // know of - is refused the same way on every attempt, so it fails once as the
      // non-retryable `adapter_error` it is, as the `new Request` refusals above do,
      // rather than as a network error retried to no end with nothing sent. Told by
      // undici's error code, not by header name, so one a later Node refuses is caught.
      if (isFetchDispatchRefusal(normalizedError)) {
        throw nonRetryableAdapterErrorFrom(normalizedError);
      }

      // A signal that is not this runtime's own AbortSignal - from a polyfill or jsdom's
      // `AbortController`, which `fetch` cannot read - is refused the same way too. Asked
      // only of what `fetch` threw, so a stubbed `fetch` that takes one still gets it, and
      // a network failure with one stays a network failure.
      if (isSignalRefusal(normalizedError, dispatchedURL, signal)) {
        throw nonRetryableAdapterErrorFrom(
          new TypeError(
            "FetchAdapter request could not be sent: this runtime's fetch refused its signal, which is not a native AbortSignal",
          ),
        );
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

    // Each read once and guarded, as a polyfill's or test double's response may carry any
    // getter. One that throws fails the same way on every attempt, so it is refused as
    // non-retryable rather than repeating a request the server answered, and its body let go.
    let responseType: unknown;
    let isOpaqueRedirect: boolean;
    let status = 0;
    let responseHeadersForBody: Record<string, string | string[]> = {};

    try {
      responseType = response.type;
      isOpaqueRedirect = responseType === 'opaqueredirect';

      if (!isOpaqueRedirect) {
        status = response.status;
        responseHeadersForBody = extractFetchHeaders(response.headers);
      }
    } catch (error) {
      cancelBodyQuietly(readUnknownMember(response, 'body'));
      // The server answered, so the upload ended, as on every other answered path.
      guardedUploadProgress?.(completeProgressEvent(knownBodyByteLength(body)));

      // A cancellation stays a cancellation, as on the body read below.
      if (isAbortError(error) || isSignalAbortedQuietly(signal)) {
        throw isAbortError(error) ? error : makeAbortError();
      }

      throw nonRetryableAdapterErrorFrom(error);
    }

    // Browser-only: `redirect: 'manual'` in a browser context yields an opaque
    // redirect response (status 0, no accessible Location header) due to CORS
    // security constraints. In server runtimes (Bun, Node) `redirect: 'manual'`
    // returns the real 3xx with a Location header, so this branch is never hit
    // there — the real status falls through to the normal return path below and
    // HTTPClient's redirect loop handles it as usual.
    if (isOpaqueRedirect) {
      // Even though the client will classify this as redirect_disabled, the
      // browser completed the fetch operation. Emit terminal progress so the
      // browser adapters match the server/mock adapters' completion semantics.
      guardedUploadProgress?.(completeProgressEvent(knownBodyByteLength(body)));

      // Not for a request that callback cancelled, which reports no completion, as a
      // cancelled download never does: the client sorts the redirect from the cancel.
      if (!isSignalAbortedQuietly(signal)) {
        guardedDownloadProgress?.(completeProgressEvent(0));
      }

      return {
        status: 0,
        wasRedirectDetected: true,
        headers: {},
        body: null,
      };
    }

    // A status no server may send, which a runtime's `fetch` may hand on (Bun's passes
    // `099` as `99` and `000` as `0`, where Node's refuses the response): answered as one a
    // runtime could not read at all is (see `malformedStatusAnswer`), its body let go. Not
    // a browser's opaque response, whose `0` hides the real status. The server answered,
    // so the upload ended, as on every other answered path.
    if (isMalformedServerStatus(status) && responseType !== 'opaque') {
      cancelBodyQuietly(readUnknownMember(response, 'body'));
      guardedUploadProgress?.(completeProgressEvent(knownBodyByteLength(body)));

      // A cancellation stays a cancellation, as on the reads above.
      if (isSignalAbortedQuietly(signal)) {
        throw makeAbortError();
      }

      return malformedStatusAnswer(status);
    }

    // Fire 100% upload progress (fetch has no real per-chunk progress). Download progress
    // fires once the body has been read and passed the limit, below.
    guardedUploadProgress?.(completeProgressEvent(knownBodyByteLength(body)));

    // A cancel from that callback ends the request as a cancel over the answer, as the
    // body read below ends one, and as NodeAdapter ends it: a bodiless answer has no read
    // to stop, and would otherwise resolve as though it had not been cancelled.
    // The body is let go of, as on every abort once the headers are in: a polyfill's Node
    // `Readable` would hold its socket until the server closed it.
    if (isSignalAbortedQuietly(signal)) {
      cancelBodyQuietly(readUnknownMember(response, 'body'));
      throw markResponseStreamAbort(
        makeAbortError(),
        status,
        responseHeadersForBody,
      );
    }

    let rawBody: Uint8Array | null | typeof RESPONSE_TOO_LARGE;

    try {
      rawBody = await readResponseBody(
        method,
        response,
        { status, headers: responseHeadersForBody, type: responseType },
        maxResponseBytes,
        signal,
      );
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
      if (isAbortError(error) || isSignalAbortedQuietly(signal)) {
        throw markResponseStreamAbort(error, status, responseHeadersForBody);
      }

      // Redirect detection is reported the same way as on the success path: the
      // headers arrived, so a 3xx here still knows where it was pointing, and a
      // truncated body must not lose the target an intact one would report.
      //
      // The body is only collected here, never written out, so there is no local write to
      // fail: what reaches here is a failed transfer or a chunk `readBodyWithin` refused.
      return streamErrorAnswer(
        dispatchedURL,
        status,
        responseHeadersForBody,
        'stream_response_error',
        isRuntimeDecodeFailure(error, responseHeadersForBody)
          ? decodeFailure(error)
          : normalizeError(error),
      );
    }

    // A body over the limit fails as a stream error with the real status, as a body that
    // failed in transit does just above: the server answered, and what failed is taking
    // delivery. No terminal progress, for the reason a failed read reports none.
    if (rawBody === RESPONSE_TOO_LARGE) {
      return tooLargeAnswer(
        dispatchedURL,
        status,
        responseHeadersForBody,
        maxResponseBytes,
      );
    }

    guardedDownloadProgress?.(completeProgressEvent(rawBody?.length ?? 0));

    return {
      status,
      // Server/runtime manual redirects reach this path as real 3xx responses.
      // Browser opaque redirects returned above never reach this branch.
      ...derivedRedirectFields(dispatchedURL, status, responseHeadersForBody),
      headers: responseHeadersForBody,
      body: rawBody,
    };
  }
}

/** How many empty chunks a body read takes between the waits that let timers run. */
const EMPTY_CHUNKS_PER_YIELD = 64;

/** What a body read waiting on its next chunk is answered with by an abort. */
const ABORTED_READ = Symbol('aborted read');

/**
 * The response body's bytes, `null` for a response that carries none, or
 * {@link RESPONSE_TOO_LARGE} once the body passes `maxResponseBytes`.
 *
 * With a limit, the body is read chunk by chunk and counted as it arrives, so a body over
 * it is cancelled - the rest neither downloaded nor held - rather than buffered whole by
 * `arrayBuffer()` and refused afterwards. Without one, or without a `body` that is a web
 * stream or async-iterable (a test double, an XHR-based polyfill), it is read whole through
 * `arrayBuffer()`, and checked after where there is a limit.
 */
async function readResponseBody(
  method: string,
  response: Response,
  answered: {
    status: number;
    headers: Record<string, string | string[]>;
    type: unknown;
  },
  maxResponseBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | null | typeof RESPONSE_TOO_LARGE> {
  // `body`, and its `getReader` and `Symbol.asyncIterator`, each read once and guarded, as
  // a polyfill's or test double's response may carry any getter: one that throws reads as
  // absent. `arrayBuffer()` is the read of last resort; a failure there fails the send.
  const body = readUnknownMember(response, 'body');

  if (!hasResponseBody(method, answered.status)) {
    // Native `fetch` hands over no body here, but a polyfill's Node `Readable` would hold
    // its socket until the server closed it.
    cancelBodyQuietly(body);
    return null;
  }

  if (maxResponseBytes === Number.POSITIVE_INFINITY) {
    return await readWholeBody(response, body, signal);
  }

  // Refused before reading when the body says up front it is over the limit - only where
  // its `Content-Length` counts what `fetch` hands over, which is the decoded body: so
  // not when a coding is applied, nor when one may be hidden. A browser exposes
  // `Content-Encoding` on a cross-origin (`cors`) response only when the server lists it
  // in `Access-Control-Expose-Headers`, so its absence there proves nothing.
  const contentEncoding = answered.headers['content-encoding'];
  const isIdentityEncoded =
    contentEncoding === undefined
      ? answered.type !== 'cors'
      : isIdentityContentEncoding(contentEncoding);
  const declaredLength = isIdentityEncoded
    ? parseContentLength(answered.headers['content-length'])
    : undefined;

  if (declaredLength !== undefined && declaredLength > maxResponseBytes) {
    cancelBodyQuietly(body);
    return RESPONSE_TOO_LARGE;
  }

  // Read through a reader only where the body is a web stream. A polyfilled `fetch`
  // (node-fetch, cross-fetch) hands over a Node `Readable`, which has no `getReader`, and
  // a test double may hand over anything: those that are not async-iterable either are
  // read whole and checked after.
  const getReader = readUnknownMember(body, 'getReader');

  if (typeof getReader !== 'function') {
    // A Node `Readable` is async-iterable: read it a chunk at a time as well, so a body
    // over the limit is neither read whole first nor left holding its socket. Iterated
    // through the method read here, not read again by `for await`.
    const iterate = readUnknownMember(body, Symbol.asyncIterator);

    if (typeof iterate === 'function') {
      const iterable: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: () =>
          Reflect.apply(iterate, body, []) as AsyncIterator<unknown>,
      };
      // Text taken as well, as its UTF-8 bytes: a `Readable` given an encoding yields
      // strings, which node-fetch 3's own `arrayBuffer()` joins and encodes as UTF-8.
      return await readBodyWithin(
        iterable,
        maxResponseBytes,
        () => {
          cancelBodyQuietly(body);
        },
        true,
        signal,
      );
    }

    const bytes = await readWholeBody(response, body, signal);
    return bytes.length > maxResponseBytes ? RESPONSE_TOO_LARGE : bytes;
  }

  const reader = Reflect.apply(
    getReader,
    body,
    [],
  ) as ReadableStreamDefaultReader<unknown>;

  // Cancelled, not awaited: the cancel settles once the stream has let go, and the
  // answer here does not depend on when that is.
  return await readBodyWithin(
    readerChunks(reader),
    maxResponseBytes,
    () => {
      cancelBodyQuietly(reader);
    },
    false,
    signal,
  );
}

/**
 * The body through `arrayBuffer()`, with `body` (as already read) let go of on an abort.
 * That reaches a polyfill's Node `Readable`, which `arrayBuffer()` does not lock. A web
 * stream it has locked refuses the cancel: native `fetch` ends that read through its own
 * signal, and a polyfill that does not heed it reads on.
 */
async function readWholeBody(
  response: Response,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const stopWatching = letGoOnAbort(signal, () => {
    cancelBodyQuietly(body);
  });

  try {
    const buffer = await response.arrayBuffer();

    // A cancel can end the read as if finished; what it read is not the whole body.
    if (isSignalAbortedQuietly(signal)) {
      throw makeAbortError();
    }

    return new Uint8Array(buffer);
  } finally {
    stopWatching();
  }
}

/** A web stream reader's chunks, as an async iterable. */
async function* readerChunks(
  reader: ReadableStreamDefaultReader<unknown>,
): AsyncGenerator<unknown> {
  while (true) {
    const { done: isDone, value } = await reader.read();

    if (isDone) {
      return;
    }

    yield value;
  }
}

/**
 * Runs `letGo` on an abort, at once if the signal has aborted already, until the returned
 * function is called. For a body being read: a polyfill's stream need not heed the signal,
 * and would otherwise hold its socket with a read stalled, or go on being read after the
 * request had ended. A signal that cannot be listened on, or refuses the removal, is
 * ignored: `once` bounds the listener to one call.
 */
function letGoOnAbort(
  signal: AbortSignal | undefined,
  letGo: () => void,
): () => void {
  if (isSignalAbortedQuietly(signal)) {
    letGo();
    return () => {};
  }

  try {
    signal?.addEventListener('abort', letGo, { once: true });
  } catch {
    // Nothing to remove, and nothing more to do for that signal.
  }

  return () => {
    try {
      signal?.removeEventListener('abort', letGo);
    } catch {
      // The listener stays.
    }
  };
}

/**
 * A body read a chunk at a time - a web stream's, through its reader, or a polyfilled
 * `fetch`'s async-iterable Node `Readable` - counted as it comes, and let go through
 * `cancel` the moment it passes the limit: counted before the chunk is kept, so a body
 * over the limit is never held whole.
 *
 * Each chunk must be a `Uint8Array`, from any realm, told and measured by its internal
 * slot rather than by the `byteLength` it reports - or, where `isTextChunkAccepted`, a
 * string, taken as its UTF-8 bytes. Anything else is refused with the `TypeError` the
 * Fetch standard's `arrayBuffer()` rejects with for the same stream, and the body let go:
 * an `ArrayBuffer` or `DataView` chunk would be counted but joined as zeros, and one with
 * no `byteLength` would turn the count to `NaN`, which no limit is under.
 */
async function readBodyWithin(
  source: AsyncIterable<unknown>,
  maxResponseBytes: number,
  cancel: () => void,
  isTextChunkAccepted: boolean,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | typeof RESPONSE_TOO_LARGE> {
  // Kept as read, a small chunk copied (see `BodyBytes`).
  const body = new BodyBytes(maxResponseBytes);
  let loadedBytes = 0;
  let emptyChunks = 0;
  let encoder: TextEncoder | undefined;
  // A string chunk's last UTF-16 unit, held for the next chunk when it is the first half
  // of a surrogate pair, so a pair split across two is encoded as the one character it is,
  // as the text joined and then encoded would be. One left with nothing after it to pair
  // with is encoded alone, as U+FFFD.
  let heldUnit = '';
  const encodeText = (text: string): Uint8Array =>
    (encoder ??= new TextEncoder()).encode(text);

  /**
   * Counts and keeps one chunk: `RESPONSE_TOO_LARGE` once the body passes the limit, the
   * body let go.
   */
  const take = async (
    chunk: unknown,
  ): Promise<typeof RESPONSE_TOO_LARGE | undefined> => {
    const byteLength = isUint8ArrayValue(chunk)
      ? readBinaryByteLength(chunk)
      : null;

    if (byteLength === null) {
      letGo();
      throw new TypeError(
        'FetchAdapter response body yielded a chunk that is not a Uint8Array',
      );
    }

    // No bytes to count or keep, and no limit they could reach: a stream that keeps
    // answering with them from microtasks alone would otherwise starve every timer, the
    // attempt timeout's included. `setTimeout`, as this adapter also runs in browsers -
    // once every so many of them, counted over the whole body so bytes between them do
    // not put the wait off, as a browser holds a timer set from a timer's callback to at
    // least 4 ms past a few levels, which a wait after each one would add up. Chunks
    // with bytes need none: the limit bounds them (a body with no limit is read whole, not
    // here), and ones that all come from microtasks are a body already in memory, whose
    // read is work as parsing it would be. A wait on every so many of a real download's
    // would hold it on a timer a hidden tab throttles to a second or more.
    if (byteLength === 0) {
      emptyChunks += 1;

      if (emptyChunks % EMPTY_CHUNKS_PER_YIELD === 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }

      return undefined;
    }

    loadedBytes += byteLength;

    if (loadedBytes > maxResponseBytes) {
      letGo();
      return RESPONSE_TOO_LARGE;
    }

    body.append(chunk as Uint8Array, byteLength);
    return undefined;
  };

  // The body is let go of on an abort, not only when a chunk next arrives: a polyfill's
  // stream need not heed the signal, and would otherwise hold its socket with a read
  // stalled, or go on being read and kept after the request had ended.
  let didLetGo = false;
  const letGo = (): void => {
    if (!didLetGo) {
      didLetGo = true;
      cancel();
    }
  };
  const throwIfAborted = (): void => {
    if (isSignalAbortedQuietly(signal)) {
      letGo();
      throw makeAbortError();
    }
  };

  throwIfAborted();

  // Ends the wait on the chunk being read, so a read the body has stalled on - its
  // `cancel` missing, or not ending the read - is waited on no longer, and the iterator
  // is asked to `return()`. One per wait, dropped once it is over, so a long body holds
  // nothing per chunk it has read.
  let wakeOnAbort: (() => void) | undefined;
  const stopWatching = letGoOnAbort(signal, () => {
    letGo();
    wakeOnAbort?.();
  });
  // Driven by hand rather than by `for await`, which leaving early waits on the iterator's
  // `return()`: a polyfill's iterator may never settle it, and the answer here - past the
  // limit, aborted, a chunk refused - does not depend on when it lets go. Called, not
  // awaited, its rejection observed, as `cancel` is.
  let iterator: AsyncIterator<unknown> | undefined;
  // Set once the iterator has ended itself - done, or a `next()` that failed - so it is
  // not asked to `return()`, as `for await` does not ask one.
  let isIteratorEnded = false;

  try {
    // In the `try`, so an iterator that cannot be had still lets the signal go.
    iterator = source[Symbol.asyncIterator]();

    for (;;) {
      let value: unknown;
      let settled: { value: unknown } | typeof ABORTED_READ;

      // An abort while no chunk was awaited - during a wait for timers - finds none to
      // end.
      throwIfAborted();

      try {
        // The wake set before `next()` is called, so an abort from within it ends the wait
        // too. Adopted, and handed both outcomes, so a `next()` left behind by an abort
        // that later rejects is observed; one that throws rejects the wait.
        const readingIterator = iterator;
        settled = await new Promise<{ value: unknown } | typeof ABORTED_READ>(
          (resolve, reject) => {
            wakeOnAbort = () => resolve(ABORTED_READ);
            adoptPromise(readingIterator.next()).then(resolve, reject);
          },
        );
      } catch (error) {
        isIteratorEnded = true;
        throw error;
      } finally {
        wakeOnAbort = undefined;
      }

      // Left waiting: the iterator is asked to `return()` below.
      if (settled === ABORTED_READ) {
        throw makeAbortError();
      }

      try {
        const step = settled.value;

        if (typeof step !== 'object' || step === null) {
          throw new TypeError(
            'FetchAdapter response body iterator answered with a non-object',
          );
        }

        const result = step as IteratorResult<unknown>;

        // Read as `for await` reads it: any truthy `done` ends the body.
        if (result.done) {
          isIteratorEnded = true;
          break;
        }

        value = result.value;
      } catch (error) {
        isIteratorEnded = true;
        throw error;
      }

      throwIfAborted();

      let chunks: unknown[];

      if (isTextChunkAccepted && typeof value === 'string') {
        let text = heldUnit + value;
        heldUnit = '';

        if (isHighSurrogate(text.charCodeAt(text.length - 1))) {
          heldUnit = text.slice(-1);
          text = text.slice(0, -1);
        }

        chunks = [encodeText(text)];
      } else if (heldUnit !== '') {
        chunks = [encodeText(heldUnit), value];
        heldUnit = '';
      } else {
        chunks = [value];
      }

      for (const chunk of chunks) {
        if ((await take(chunk)) === RESPONSE_TOO_LARGE) {
          return RESPONSE_TOO_LARGE;
        }
      }
    }

    if (
      heldUnit !== '' &&
      (await take(encodeText(heldUnit))) === RESPONSE_TOO_LARGE
    ) {
      return RESPONSE_TOO_LARGE;
    }

    // A cancel can end the stream as if finished; what it read is not the whole body.
    throwIfAborted();

    return body.bytes();
  } catch (error) {
    // Every failure lets the body go - an iterator that failed or answered with what is
    // no step included - so a polyfill's stream does not hold its socket.
    letGo();
    throw error;
  } finally {
    if (iterator !== undefined && !isIteratorEnded) {
      endIteratorQuietly(iterator);
    }

    stopWatching();
  }
}

/** Asks an iterator left early to `return()`, without waiting on it or minding a refusal. */
function endIteratorQuietly(iterator: AsyncIterator<unknown>): void {
  callQuietly(readUnknownMember(iterator, 'return'), iterator);
}

/**
 * Let go of a body that will not be read, ignoring one that refuses: a web stream, or the
 * reader it is locked to, is cancelled, and a polyfilled `fetch`'s Node `Readable` - which
 * has no `cancel` - is destroyed, so its socket is not held with the body unread.
 */
function cancelBodyQuietly(body: unknown): void {
  if (!body) {
    return;
  }

  // The body is being discarded: a locked or already-cancelled stream, or a cancel that
  // throws or rejects, has nothing to add (see `callQuietly`).
  const cancel = readUnknownMember(body, 'cancel');

  if (typeof cancel === 'function') {
    callQuietly(cancel, body);
    return;
  }

  callQuietly(readUnknownMember(body, 'destroy'), body);
}

/**
 * The request headers as `fetch` takes them, each value read once: a fresh record, or a
 * `Headers` when a name repeats and the runtime has one. Never the caller's own object,
 * which the build check and `fetch` would each read again - a getter could answer one
 * and send the other.
 */
function materializeFetchHeaders(
  headers: Record<string, string | string[]>,
): HeadersInit {
  // A runtime with no `Headers` (a test setup that polyfills only `fetch`) gets a record
  // holding each name once, in any case, under its first spelling: values that repeat
  // joined with `, `, the one field a `Headers` would send them as, and `Cookie` joined
  // by the same rule - as NodeAdapter sends them.
  if (typeof Headers !== 'function') {
    return materializeRequestHeaders(headers);
  }

  // The `Cookie` field built by NodeAdapter's rule (see `requestHeaderPairs`), so whether
  // it is sent, and how, does not turn on how the other headers are given. Every choice
  // below is made from these pairs alone.
  const pairs = requestHeaderPairs(headers);

  // A record holds each name once, so a name that repeats - an array value of more than
  // one item - takes a `Headers`, which sends every value under it.
  const record: Record<string, string> = {};
  for (const [name, value] of pairs) {
    if (Object.hasOwn(record, name)) {
      const materialized = new Headers();
      for (const [pairName, pairValue] of pairs) {
        materialized.append(pairName, pairValue);
      }

      return materialized;
    }

    defineEntry(record, name, value);
  }

  return record;
}

/**
 * The non-retryable refusal of a request the runtime will not build, naming what it refused
 * by kind: the first header `Headers` will not take - its name, never its value - or else
 * the URL or method.
 */
function refusedRequestBuild(
  headers: Record<string, string | string[]>,
): Error {
  return nonRetryableAdapterErrorFrom(
    new TypeError(
      `FetchAdapter request could not be built: the runtime refused ${describeFetchRefusal(headers)}`,
    ),
  );
}

function describeFetchRefusal(
  headers: Record<string, string | string[]>,
): string {
  if (typeof Headers !== 'function') {
    return 'its URL, method or headers';
  }

  for (const [name, value] of requestHeaderPairs(headers)) {
    try {
      new Headers().append(name, value);
    } catch {
      return describeRefusedHeader(
        name,
        isHeaderNameAccepted(name) ? 'value' : 'name',
      );
    }
  }

  return 'its URL or method';
}

/** Whether `Headers` takes `name` with a plain value: if so, it was the value it refused. */
function isHeaderNameAccepted(name: string): boolean {
  try {
    new Headers().append(name, 'x');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `error` is `fetch` refusing `signal`: it names `AbortSignal`, as Node's, Bun's and
 * browsers' refusals do, and this runtime's `Request` refuses the signal too. The name
 * alone could come from a URL quoted in some other failure.
 */
function isSignalRefusal(
  error: Error,
  url: string,
  signal: AbortSignal | undefined,
): boolean {
  const message = readUnknownMember(error, 'message');

  if (
    signal === undefined ||
    typeof Request !== 'function' ||
    typeof message !== 'string' ||
    !message.includes('AbortSignal')
  ) {
    return false;
  }

  try {
    new Request(url, { signal });
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether `fetch` failed because the runtime refused to dispatch the request at all:
 * undici's invalid-argument and not-supported refusals, and the Fetch standard's blocked
 * ports - the backstop for a header or port a later Node refuses that the up-front
 * refusals (`fetchRefusedHeader`, `fetchBlockedPort`) do not know of. Read
 * off the `cause` Node hangs them on, guardedly; a browser's opaque `TypeError` is none.
 */
function isFetchDispatchRefusal(error: Error): boolean {
  const cause = readUnknownMember(error, 'cause');
  const code = readUnknownMember(cause, 'code');
  const message = readUnknownMember(cause, 'message');

  return (
    code === 'UND_ERR_INVALID_ARG' ||
    code === 'UND_ERR_NOT_SUPPORTED' ||
    (typeof message === 'string' && asciiLowercase(message) === 'bad port')
  );
}

/** The error codes a server runtime's `fetch` gives a body that failed to decode. */
const BUN_DECODE_ERROR_CODES = [
  'ZlibError',
  'BrotliDecompressionError',
  'ZstdDecompressionError',
];
/** Node's (undici's): its cause is the decoder's own error, coded by zlib, brotli or zstd. */
const NODE_DECODE_ERROR_CODE = /^(?:Z_|ERR__ERROR_|ZSTD_error_)/;

/**
 * Whether `error`, from reading a body whose `Content-Encoding` is not identity, is the
 * runtime's decoding failure rather than a failed transfer: in a server runtime `fetch`
 * decodes the body itself, and says so by the error's code (Bun) or its cause's (Node).
 * A browser's says nothing of why, so its failure is a transfer's.
 */
function isRuntimeDecodeFailure(
  error: unknown,
  headers: Record<string, string | string[]>,
): boolean {
  const encoding = headers['content-encoding'];
  if (encoding === undefined || isIdentityContentEncoding(encoding)) {
    return false;
  }

  const code = readUnknownMember(error, 'code');
  if (typeof code === 'string' && BUN_DECODE_ERROR_CODES.includes(code)) {
    return true;
  }

  const causeCode = readUnknownMember(
    readUnknownMember(error, 'cause'),
    'code',
  );
  return (
    typeof causeCode === 'string' && NODE_DECODE_ERROR_CODE.test(causeCode)
  );
}

/**
 * The runtime's decoding failure, reported as one (see `RESPONSE_DECODE_ERROR_KEY`): an
 * error of this adapter's own carries the tag, its message the runtime's and its cause the
 * runtime's error, which is not changed.
 */
function decodeFailure(error: unknown): Error {
  const reported = new Error(normalizeError(error).message, { cause: error });
  Object.defineProperty(reported, RESPONSE_DECODE_ERROR_KEY, { value: true });
  return reported;
}
