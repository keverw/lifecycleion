import { isSignalAbortedQuietly } from './internal/request-fields';
import { assertCancelReason } from './request-tracker';
import { isNullish } from '../internal/is-nullish';
import { hasOwnToStringTagInChain } from '../internal/binary-view';
import { describeValue } from '../internal/describe-value';
import { generateID } from '../id-helpers';
import { validateMaxResponseBytes, validateRequestTimeoutMS } from './consts';
import { snapshotRetryPolicyOptions } from './internal/retry-policy-options';
import { defineEntry } from '../internal/define-entry';
import {
  HEADER_VALUE_LABEL,
  lowerCaseHeaderName,
} from './internal/header-utils';
import { isBlankText } from '../internal/ascii-text';
import { copyRequestBody } from './internal/request-body-copy';
import { isFormData, isMethodlessFormData } from './internal/form-entries';
import {
  assertKnownFields,
  assertOptionsObject,
  fieldNames,
} from '../internal/known-fields';
import { copyParamArrayValue, inKeyOrder } from './internal/param-array-copy';
import { assertSerializableParams } from './internal/param-check';
import { copyArrayValue } from '../internal/array-copy';
import {
  assertOptionalHeaderRecord,
  isPlainRecord,
} from './internal/plain-record';
import type {
  HTTPMethod,
  HTTPResponse,
  HTTPRequestOptions,
  HTTPProgressEvent,
  AttemptStartEvent,
  AttemptEndEvent,
  RequestState,
  RequestCancelResult,
  HTTPClientError,
  StreamResponseFactory,
  RequestHeadersInput,
  HTTPRetryPolicyOptions,
} from './types';

export interface BuilderCallbacks<T> {
  setState: (state: RequestState) => void;
  setResponse: (response: HTTPResponse<T>) => void;
  setError: (error: HTTPClientError) => void;
  setAttemptCount: (count: number) => void;
  setNextRetryDelayMS: (delayMS: number | null) => void;
  setNextRetryAt: (timestampMS: number | null) => void;
  setStartedAt: (timestampMS: number) => void;
  /**
   * Wires the function `cancel()` forwards to while the request is in flight, which
   * answers what that did. A cancel held while `send()` set the request up is passed to
   * it as it is wired.
   */
  setCancelFn: (fn: (reason?: string) => RequestCancelResult) => void;
  /** A cancel the builder held while `send()` set the request up; see `cancel()`. */
  getSetupCancel: () => { reason: string | undefined } | null;
}

export interface BuilderSendContext<T = unknown> {
  method: HTTPMethod;
  path: string;
  requestID: string;
  options: ResolvedBuilderOptions;
  callbacks: BuilderCallbacks<T>;
}

export interface ResolvedBuilderOptions extends HTTPRequestOptions {
  headers: RequestHeadersInput;
}

export type SendFn<T> = (
  context: BuilderSendContext<T>,
) => Promise<HTTPResponse<T>>;

/** The fields an {@link HTTPRequestOptions} takes; any other is refused as misspelled. */
const REQUEST_OPTION_FIELDS = fieldNames<HTTPRequestOptions>({
  headers: true,
  params: true,
  body: true,
  timeout: true,
  maxResponseBytes: true,
  signal: true,
  retryPolicy: true,
  retryNonIdempotentMethods: true,
  label: true,
  onUploadProgress: true,
  onDownloadProgress: true,
  onAttemptStart: true,
  onAttemptEnd: true,
  streamResponse: true,
});

/**
 * Whether `value` is an `AbortSignal`: tagged as one, an instance of this realm's - a
 * polyfill installed as the global may define no tag - or one whose chain holds a
 * prototype tagged as one, a subclass with a tag of its own from any realm. A tag getter
 * or `Proxy` trap that throws answers no, so the caller is told what was expected.
 */
function isAbortSignal(value: object): boolean {
  try {
    if (
      Object.prototype.toString.call(value) === '[object AbortSignal]' ||
      (typeof AbortSignal === 'function' && value instanceof AbortSignal)
    ) {
      return true;
    }
  } catch {
    // Told by its chain below, which answers no for one that throws.
  }

  return hasOwnToStringTagInChain(value, 'AbortSignal');
}

/** What `createRequestBuilder` hands the constructor; see there. Never exported. */
const BUILDER_TOKEN = Symbol('HTTPRequestBuilder');

/**
 * A builder for `sendFn`, an `HTTPClient`'s own. The only way one is made: the class is
 * exported as a type alone, and its constructor, still reachable through a builder's
 * `constructor`, throws without the token this hands it.
 */
export function createRequestBuilder<T>(
  method: HTTPMethod,
  path: string,
  sendFn: SendFn<T>,
  options?: HTTPRequestOptions,
): HTTPRequestBuilder<T> {
  return new HTTPRequestBuilder<T>(
    BUILDER_TOKEN,
    method,
    path,
    sendFn,
    options,
  );
}

/**
 * Fluent, single-use request builder. Returned by HTTPClient methods.
 * Call .send() to execute the request.
 */
export class HTTPRequestBuilder<T = unknown> {
  private _method: HTTPMethod;
  private _path: string;
  private _headers: RequestHeadersInput = {};
  private _params?: Record<string, unknown>;
  private _body?: unknown;
  private _timeout?: number | null;
  private _maxResponseBytes?: number | null;
  private _signal?: AbortSignal;
  private _retryPolicy?: HTTPRetryPolicyOptions | null;
  private _retryNonIdempotentMethods?: boolean;
  private _label?: string;
  private _onUploadProgress?: (event: HTTPProgressEvent) => void;
  private _onDownloadProgress?: (event: HTTPProgressEvent) => void;
  private _onAttemptStart?: (event: AttemptStartEvent) => void;
  private _onAttemptEnd?: (event: AttemptEndEvent) => void;
  private _streamResponse?: StreamResponseFactory;

  private _sendFn: SendFn<T>;
  private _sent = false;

  // Post-send state (public read-only after send)
  private _requestID: string = generateID('ulid');
  private _state: RequestState = 'pending';
  private _response: HTTPResponse<T> | null = null;
  private _error: HTTPClientError | null = null;
  private _attemptCount: number | null = null;
  private _nextRetryDelayMS: number | null = null;
  private _nextRetryAt: number | null = null;
  private _startedAt: number | null = null;
  private _completedAt: number | null = null;
  private _cancelFn: ((reason?: string) => RequestCancelResult) | null = null;
  /** A cancel made after `send()` began but before the request could be cancelled. */
  private _setupCancel: { reason: string | undefined } | null = null;
  /** Set once the client's synchronous setup has returned; see `_sendRequest`. */
  private _isSetupDone = false;
  private _preSendCancelReason: string | undefined = undefined;

  constructor(
    token: typeof BUILDER_TOKEN,
    method: HTTPMethod,
    path: string,
    sendFn: SendFn<T>,
    options?: HTTPRequestOptions,
  ) {
    // Made only by a client (see `createRequestBuilder`): a send function of the caller's
    // would be handed request options it cannot read - a JSON body is an empty copy whose
    // text only the client can reach - so the request would go out wrong rather than not
    // at all.
    if (token !== BUILDER_TOKEN) {
      throw new TypeError(
        "HTTPRequestBuilder is made by an HTTPClient's request methods (client.get(), client.post() and the rest), not constructed directly",
      );
    }

    this._method = method;
    this._path = path;
    this._sendFn = sendFn;

    // Refused when it is not an object of known options: a misspelled `timout` would
    // leave the request on the client's timeout, and a non-object read as no options.
    assertOptionsObject(options, 'HTTPRequestOptions', true);
    if (!isNullish(options)) {
      assertKnownFields(options, REQUEST_OPTION_FIELDS, 'HTTPRequestOptions');
      this._applyOptions(options);
    }
  }

  // --- Fluent builder methods ---

  public headers(headers: RequestHeadersInput | null | undefined): this {
    this._assertNotSent('headers');
    // A nullish argument stays a no-op. Anything else must be a plain record: a
    // `Headers` or `Map` would otherwise send the request with every header dropped,
    // which an interceptor returning one is refused for too.
    assertOptionalHeaderRecord(headers, 'HTTPRequestBuilder headers');
    if (isNullish(headers)) {
      return this;
    }
    // Own keys, not `Object.assign`: a `__proto__` header would set the record's
    // prototype (an array value) or vanish (a string). Lowercased, as the request sends
    // them, so a later call replaces an earlier one whatever either's capitalization -
    // and within one record a later key replaces an earlier one that differs only by
    // case, as everywhere request headers are merged (see `mergeHeaders`).
    // An array value copied (see `copyArrayValue`), so an item added to the caller's
    // afterwards is not sent. Every value is copied before any is applied, so a call
    // whose value throws - an array's index getter, say - changes no header.
    const staged = Object.entries(headers).map(
      ([key, value]) =>
        [
          lowerCaseHeaderName(key),
          copyArrayValue(value, HEADER_VALUE_LABEL),
        ] as const,
    );
    for (const [name, value] of staged) {
      defineEntry(this._headers, name, value);
    }
    return this;
  }

  public params(params: Record<string, unknown> | null | undefined): this {
    this._assertNotSent('params');
    // A nullish argument clears them - `.params(options.query)` with no query set.
    if (isNullish(params)) {
      this._params = undefined;
      return this;
    }
    // A plain object, as for headers: a `URLSearchParams` or `Map` keeps its entries off
    // its own properties, so it would be sent as no query at all, and a string as
    // `0=a&1=b`.
    if (!isPlainRecord(params)) {
      throw new TypeError(
        'HTTPRequestBuilder params must be a plain object of query names to values (not a URLSearchParams, Map or string)',
      );
    }
    // Copied now, as `headers()` copies, so a change to the caller's object after this
    // call does not reach the request: each own entry read once, an array value copied
    // one level as `qs` reads it (see `copyParamArrayValue`) and any other value kept as
    // it is - a nested object is still the caller's. Own keys, so a `__proto__` name stays
    // a query name rather than a prototype. Listed in the order the caller's record lists
    // them (see `inKeyOrder`), so a `Proxy` that puts `2` after `mode` is sent so.
    // Read by `Object.entries`, which skips a key an earlier getter has deleted.
    const entries = Object.entries(params);
    const copied: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      defineEntry(copied, key, copyParamArrayValue(value));
    }
    const ordered = inKeyOrder(
      copied,
      entries.map(([key]) => key),
    );
    assertSerializableParams(ordered);
    this._params = ordered;
    return this;
  }

  /**
   * An object or array body, sent as JSON. The same as `.body(data)`: serialization is
   * decided by the value's type, so a string here is sent as `text/plain` and a number
   * is refused - see the Body Types table in the docs for sending a JSON primitive.
   */
  public json(data: unknown): this {
    this._assertNotSent('json');
    this._body = copyRequestBody(data);
    return this;
  }

  /**
   * A `FormData` body, or `null` / `undefined` for none; anything else - a plain object of
   * fields among them - is refused.
   */
  public formData(data: FormData): this {
    this._assertNotSent('formData');
    // Refused by type rather than sent as what it is: a plain object of fields given here
    // would go out as JSON, to a server reading multipart. A React Native form is refused
    // as the body is, in words that name the adapters that send one.
    const candidate: unknown = data;
    if (
      !isNullish(candidate) &&
      !isFormData(candidate) &&
      !isMethodlessFormData(candidate)
    ) {
      throw new TypeError(
        `HTTPRequestBuilder formData must be a FormData (got ${describeValue(candidate)})`,
      );
    }
    this._body = copyRequestBody(data);
    return this;
  }

  /**
   * A string body, sent as `text/plain`, or `null` / `undefined` for none; anything else
   * is refused.
   */
  public text(data: string): this {
    this._assertNotSent('text');
    const candidate: unknown = data;
    // As `formData()` is: an object given here would go out as JSON.
    if (!isNullish(candidate) && typeof candidate !== 'string') {
      throw new TypeError(
        `HTTPRequestBuilder text must be a string (got ${describeValue(candidate)})`,
      );
    }
    this._body = copyRequestBody(data);
    return this;
  }

  /**
   * The request body, copied now into one the client owns (see `copyRequestBody`), as
   * `headers()` and `params()` copy theirs: a change to the caller's value after this
   * call reaches nothing the request sends or reports, on any attempt, retry or
   * `307`/`308` replay. A JSON body is the data it serializes to, so interceptors see a
   * `Date` as its ISO string. Throws now on a body of an unsupported type, and on one
   * whose copy throws - a getter or `toJSON`, a `BigInt` or a circular reference.
   */
  public body(data: unknown): this {
    this._assertNotSent('body');
    this._body = copyRequestBody(data);
    return this;
  }

  public timeout(ms: number | null): this {
    this._assertNotSent('timeout');
    // Validated only: nullish inherits the client's timeout at dispatch, where the
    // value is resolved once.
    validateRequestTimeoutMS(ms);
    this._timeout = ms;
    return this;
  }

  /**
   * The most bytes of a buffered response body this request will hold, overriding the
   * client's `maxResponseBytes`. A positive integer, `Infinity` for no limit, or `null`
   * to inherit the client's value. A streamed response is not limited.
   */
  public maxResponseBytes(bytes: number | null): this {
    this._assertNotSent('maxResponseBytes');
    // Validated only, as `timeout()` is: nullish inherits the client's value at
    // dispatch, where the value is resolved once.
    validateMaxResponseBytes(bytes);
    this._maxResponseBytes = bytes;
    return this;
  }

  public signal(abortSignal: AbortSignal | null | undefined): this {
    this._assertNotSent('signal');
    // Nullish clears it, as the `signal` request option reads one, `headers()` reads
    // nullish, and `timeout(null)` and `maxResponseBytes(null)` inherit.
    if (isNullish(abortSignal)) {
      this._signal = undefined;
      return this;
    }
    // Refused now when it plainly is not one: it is composed with the client's own signal,
    // which needs an `AbortSignal`. Checked by its built-in tag rather than `instanceof`
    // alone, so another realm's (an iframe's) signal and a polyfill's are accepted, as
    // composing them accepts them - and a subclass with a tag of its own (a browser's
    // `TaskSignal`) by the `AbortSignal` prototype in its chain. A value that only claims
    // the tag rejects `send()` instead, at setup.
    const candidate: unknown = abortSignal;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !isAbortSignal(candidate)
    ) {
      throw new TypeError(
        `HTTPRequestBuilder signal must be an AbortSignal (got ${describeValue(candidate)})`,
      );
    }
    this._signal = abortSignal;
    return this;
  }

  public label(label: string): this {
    this._assertNotSent('label');

    const candidate: unknown = label;
    if (typeof candidate !== 'string') {
      throw new TypeError(
        `HTTPRequestBuilder label must be a string (got ${describeValue(candidate)})`,
      );
    }

    if (isBlankText(label)) {
      throw new TypeError(
        'HTTPRequestBuilder.label() requires a non-empty, non-whitespace label.',
      );
    }

    this._label = label;
    return this;
  }

  public retryPolicy(options: HTTPRetryPolicyOptions | null | undefined): this {
    this._assertNotSent('retryPolicy');
    this._retryPolicy = isNullish(options)
      ? options
      : snapshotRetryPolicyOptions(options, 'HTTPRequestBuilder retryPolicy');
    return this;
  }

  /**
   * Allow or forbid retrying this request when its method is not idempotent
   * (`POST`, `PATCH`, a custom method). Overrides the client config for this request only.
   */
  public retryNonIdempotentMethods(allow: boolean): this {
    this._assertNotSent('retryNonIdempotentMethods');
    // Checked by type, as the client option is: read by truthiness, `'false'` would
    // allow replaying a `POST`.
    const candidate: unknown = allow;
    if (typeof candidate !== 'boolean') {
      throw new TypeError(
        `HTTPRequestBuilder retryNonIdempotentMethods must be a boolean (got ${describeValue(candidate)})`,
      );
    }
    this._retryNonIdempotentMethods = allow;
    return this;
  }

  public onUploadProgress(fn: (event: HTTPProgressEvent) => void): this {
    this._assertNotSent('onUploadProgress');
    assertCallback(fn, 'onUploadProgress');
    this._onUploadProgress = fn;
    return this;
  }

  public onDownloadProgress(fn: (event: HTTPProgressEvent) => void): this {
    this._assertNotSent('onDownloadProgress');
    assertCallback(fn, 'onDownloadProgress');
    this._onDownloadProgress = fn;
    return this;
  }

  public onAttemptStart(fn: (event: AttemptStartEvent) => void): this {
    this._assertNotSent('onAttemptStart');
    assertCallback(fn, 'onAttemptStart');
    this._onAttemptStart = fn;
    return this;
  }

  public onAttemptEnd(fn: (event: AttemptEndEvent) => void): this {
    this._assertNotSent('onAttemptEnd');
    assertCallback(fn, 'onAttemptEnd');
    this._onAttemptEnd = fn;
    return this;
  }

  /**
   * NodeAdapter only. Called after response headers arrive on a 2xx response,
   * before any body bytes are read. Return a WritableLike to pipe the body into
   * it, or null to cancel the request entirely.
   *
   * The context provides an attempt-scoped AbortSignal that fires on cancel,
   * timeout, or stream write failure — useful for co-locating cleanup with setup:
   *
   *   .streamResponse((_info, { signal }) => {
   *     const stream = createWriteStream('/tmp/file.bin');
   *
   *     signal.addEventListener('abort', () => {
   *       stream.destroy();
   *       fs.unlinkSync('/tmp/file.bin'); // clean up partial file
   *     });
   *     return stream;
   *   })
   *
   * HTTPClient rejects non-node adapters before dispatch if this is set.
   */
  public streamResponse(fn: StreamResponseFactory): this {
    this._assertNotSent('streamResponse');
    assertCallback(fn, 'streamResponse');
    this._streamResponse = fn;
    return this;
  }

  // --- Post-send accessors ---

  public get requestID(): string {
    return this._requestID;
  }

  public get state(): RequestState {
    return this._state;
  }

  public get response(): HTTPResponse<T> | null {
    return this._response;
  }

  public get error(): HTTPClientError | null {
    return this._error;
  }

  public get attemptCount(): number | null {
    return this._attemptCount;
  }

  public get nextRetryDelayMS(): number | null {
    return this._nextRetryDelayMS;
  }

  public get nextRetryAt(): number | null {
    return this._nextRetryAt;
  }

  /** Epoch ms when the first attempt was dispatched. null before send(). */
  public get startedAt(): number | null {
    return this._startedAt;
  }

  /** Total wall-clock ms since the first attempt, including retry waits. null before send().
   * Freezes once the request completes.
   */
  public get elapsedMS(): number | null {
    if (this._startedAt === null) {
      return null;
    }

    const end = this._completedAt ?? Date.now();
    return end - this._startedAt;
  }

  /**
   * Cancels the request, and says what that did (see {@link RequestCancelResult}):
   * `'cancelled'` when this call cancelled it, `'already_cancelled'` when something else
   * had, and `'already_settled'` when it had already completed or failed.
   *
   * Calling cancel() before send() marks the builder as cancelled so that
   * send() rejects instead of dispatching the request.
   */
  public cancel(reason?: string): RequestCancelResult {
    assertCancelReason(reason, 'HTTPRequestBuilder.cancel()');
    if (this._state === 'completed' || this._state === 'failed') {
      return 'already_settled';
    }
    if (this._state === 'cancelled') {
      return 'already_cancelled';
    }

    // Pre-send cancel: mark as cancelled so send() is blocked
    if (!this._sent) {
      this._state = 'cancelled';
      this._preSendCancelReason = reason;
      return 'cancelled';
    }

    // Answered by the request itself while it is in flight: `'cancelled'` only when this
    // call is what cancelled it.
    if (this._cancelFn) {
      return this._cancelFn(reason);
    }

    // Setup is over and wired no cancel function: the request failed during setup (its
    // `send()` rejection is on its way), so there is nothing to cancel.
    if (this._isSetupDone) {
      // A cancel held during that setup still ends the builder cancelled; see `send()`.
      return this._setupCancel ? 'already_cancelled' : 'already_settled';
    }

    // `send()` is still setting the request up - caller code such as a header value's
    // `toString` runs before the request can be cancelled - so the cancel is held and
    // applied the moment it can be. Only the first is held; a later one finds it.
    // A caller signal that has aborted already ends the request as cancelled once setup
    // is done, so there is nothing left for this call to cancel.
    if (this._setupCancel || isSignalAbortedQuietly(this._signal)) {
      return 'already_cancelled';
    }
    this._setupCancel = { reason };
    return 'cancelled';
  }

  // --- Execute ---

  public async send<U = T>(): Promise<HTTPResponse<U>> {
    // Once-only first: a request that ended cancelled - by a signal, `client.cancel()` -
    // was sent, and a second send is refused for that, not for a `cancel()` never made.
    if (this._sent) {
      throw new Error(
        'HTTPRequestBuilder.send() can only be called once per builder instance.',
      );
    }

    if (this._state === 'cancelled') {
      const reasonSuffix =
        this._preSendCancelReason !== undefined
          ? ` (reason: '${this._preSendCancelReason}')`
          : '';
      throw new Error(
        `HTTPRequestBuilder.send() cannot be called after cancel() has been called.${reasonSuffix}`,
      );
    }

    this._sent = true;

    try {
      return await this._sendRequest<U>();
    } catch (error) {
      // `send()` rejects only when a value the caller supplied throws while the request is
      // set up, before it can become a response. The builder is not left `sending`, and
      // `cancel()` has nothing left to cancel.
      this._cancelFn = null;
      // Through the getter, read afresh: `_sendRequest` changes it through its callbacks.
      const { state } = this;
      if (
        state !== 'completed' &&
        state !== 'cancelled' &&
        state !== 'failed'
      ) {
        // A cancel held during setup answered `'cancelled'`, so the builder ends that way
        // even though setup then failed; `send()` still rejects with the setup's error.
        this._state = this._setupCancel ? 'cancelled' : 'failed';
        this._completedAt = Date.now();
      }
      throw error;
    }
  }

  private async _sendRequest<U>(): Promise<HTTPResponse<U>> {
    const pending = this._sendFn({
      method: this._method,
      path: this._path,
      requestID: this._requestID,
      options: {
        headers: this._headers,
        params: this._params,
        body: this._body,
        timeout: this._timeout,
        maxResponseBytes: this._maxResponseBytes,
        signal: this._signal,
        retryPolicy: this._retryPolicy,
        retryNonIdempotentMethods: this._retryNonIdempotentMethods,
        label: this._label,
        onUploadProgress: this._onUploadProgress,
        onDownloadProgress: this._onDownloadProgress,
        onAttemptStart: this._onAttemptStart,
        onAttemptEnd: this._onAttemptEnd,
        streamResponse: this._streamResponse,
      },
      callbacks: {
        setState: (state) => {
          this._state = state;

          if (
            state === 'completed' ||
            state === 'cancelled' ||
            state === 'failed'
          ) {
            this._completedAt = Date.now();
          }
        },
        setResponse: (res) => {
          this._response = res;
        },
        setError: (err) => {
          this._error = err;
        },
        setAttemptCount: (count) => {
          this._attemptCount = count;
        },
        setNextRetryDelayMS: (delayMS) => {
          this._nextRetryDelayMS = delayMS;
        },
        setNextRetryAt: (timestampMS) => {
          this._nextRetryAt = timestampMS;
        },
        setStartedAt: (timestampMS) => {
          this._startedAt = timestampMS;
        },
        getSetupCancel: () => this._setupCancel,
        setCancelFn: (fn) => {
          this._cancelFn = fn;
          // A cancel made while the request was being set up; see `cancel()`.
          if (this._setupCancel) {
            fn(this._setupCancel.reason);
          }
        },
      },
    });
    // The client's setup runs synchronously inside that call, up to wiring the request's
    // cancel function - so once it returns, a request with none has already failed (or
    // was cancelled), and `cancel()` holds nothing.
    this._isSetupDone = true;

    return (await pending) as unknown as HTTPResponse<U>;
  }

  // --- Private helpers ---

  private _applyOptions(opts: HTTPRequestOptions): void {
    // Options may be getters. Capture each value once, then apply it before reading
    // the next: validation failures must not run later getters as a side effect.
    // Request headers merged on top of any defaults
    // Every value but a nullish one is checked, a falsy `''` or `0` included.
    const headers = opts.headers;
    if (!isNullish(headers)) {
      this.headers(headers);
    }

    // URL query params
    const params = opts.params;
    if (!isNullish(params)) {
      this.params(params);
    }

    // Body — type determines serialization (FormData → multipart, string → text/plain,
    // object → JSON). A custom content-type header overrides the auto-detected one -
    // except for a FormData body, whose content-type carries the multipart boundary and
    // is always the client's.
    const body = opts.body;
    if (body !== undefined) {
      this.body(body);
    }

    // Request-level timeout in ms
    const timeout = opts.timeout;
    if (timeout !== undefined) {
      this.timeout(timeout);
    }

    // Request-level response size limit in bytes
    const maxResponseBytes = opts.maxResponseBytes;
    if (maxResponseBytes !== undefined) {
      this.maxResponseBytes(maxResponseBytes);
    }

    // External abort signal — merged with the internal one so both can cancel
    const signal = opts.signal;
    if (!isNullish(signal)) {
      this.signal(signal);
    }

    // Retry behavior — null explicitly disables retrying
    const retryPolicy = opts.retryPolicy;
    if (retryPolicy !== undefined) {
      this.retryPolicy(retryPolicy);
    }

    const allowRetryNonIdempotentMethods = opts.retryNonIdempotentMethods;
    if (!isNullish(allowRetryNonIdempotentMethods)) {
      this.retryNonIdempotentMethods(allowRetryNonIdempotentMethods);
    }

    // Tracking label for cancel/list filtering
    // `null` is unset, as for the other options.
    const label = opts.label;
    if (!isNullish(label)) {
      this.label(label);
    }

    // Progress callbacks - upload
    const onUploadProgress = opts.onUploadProgress;
    if (!isNullish(onUploadProgress)) {
      this.onUploadProgress(onUploadProgress);
    }

    // Progress callbacks - download
    const onDownloadProgress = opts.onDownloadProgress;
    if (!isNullish(onDownloadProgress)) {
      this.onDownloadProgress(onDownloadProgress);
    }

    // Called before each attempt (including retries)
    const onAttemptStart = opts.onAttemptStart;
    if (!isNullish(onAttemptStart)) {
      this.onAttemptStart(onAttemptStart);
    }

    // Called after each attempt (including retries)
    const onAttemptEnd = opts.onAttemptEnd;
    if (!isNullish(onAttemptEnd)) {
      this.onAttemptEnd(onAttemptEnd);
    }

    // NodeAdapter response streaming factory
    const streamResponse = opts.streamResponse;
    if (!isNullish(streamResponse)) {
      this.streamResponse(streamResponse);
    }
  }

  private _assertNotSent(method: string): void {
    if (this._sent) {
      throw new Error(
        `Cannot call .${method}() after .send() has been called. Builders are single-use.`,
      );
    }
  }
}

/** Refused when it is set, as an interceptor that is not a function is when it is added. */
function assertCallback(fn: unknown, name: string): void {
  if (typeof fn !== 'function') {
    throw new TypeError(
      `HTTPRequestBuilder ${name} must be a function (got ${describeValue(fn)})`,
    );
  }
}
