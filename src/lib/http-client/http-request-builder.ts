import { isNullish } from '../internal/is-nullish';
import { readUnknownMember } from '../internal/read-member';
import { generateID } from '../id-helpers';
import { validateRequestTimeoutMS } from './consts';
import { snapshotRetryPolicyOptions } from './internal/retry-policy-options';
import { defineEntry } from '../internal/define-entry';
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
  CancelResult,
  HTTPClientError,
  StreamResponseFactory,
  RequestHeadersInput,
} from './types';
import type { RetryPolicyOptions } from '../retry-utils';

export interface BuilderCallbacks<T> {
  setState: (state: RequestState) => void;
  setResponse: (response: HTTPResponse<T>) => void;
  setError: (error: HTTPClientError) => void;
  setAttemptCount: (count: number) => void;
  setNextRetryDelayMS: (delayMS: number | null) => void;
  setNextRetryAt: (timestampMS: number | null) => void;
  setStartedAt: (timestampMS: number) => void;
  setCancelFn: (fn: (reason?: string) => CancelResult) => void;
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

type SendFn<T> = (context: BuilderSendContext<T>) => Promise<HTTPResponse<T>>;

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
  private _signal?: AbortSignal;
  private _retryPolicy?: RetryPolicyOptions | null;
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
  private _cancelFn: ((reason?: string) => CancelResult) | null = null;
  /** A cancel made after `send()` began but before the request could be cancelled. */
  private _setupCancel: { reason: string | undefined } | null = null;
  /** Set once `send()`'s synchronous setup has returned; see `_sendRequest`. */
  private _isSetupDone = false;
  private _preSendCancelReason: string | undefined = undefined;

  constructor(
    method: HTTPMethod,
    path: string,
    sendFn: SendFn<T>,
    options?: HTTPRequestOptions,
  ) {
    this._method = method;
    this._path = path;
    this._sendFn = sendFn;

    if (options) {
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
    // them, so a later call replaces an earlier one whatever either's capitalization.
    for (const [key, value] of Object.entries(headers)) {
      defineEntry(this._headers, key.toLowerCase(), value);
    }
    return this;
  }

  public params(params: Record<string, unknown>): this {
    this._assertNotSent('params');
    // A plain object, as for headers: a `URLSearchParams` or `Map` keeps its entries off
    // its own properties, so it was sent as no query at all, and a string as `0=a&1=b`.
    if (!isPlainRecord(params)) {
      throw new TypeError(
        'HTTPRequestBuilder params must be a plain object of query names to values (not a URLSearchParams, Map or string)',
      );
    }
    this._params = params;
    return this;
  }

  /**
   * An object or array body, sent as JSON. The same as `.body(data)`: serialization is
   * decided by the value's type when the request is sent, so a string here is sent as
   * `text/plain` and a number is refused - see the Body Types table in the docs for
   * sending a JSON primitive.
   */
  public json(data: unknown): this {
    this._assertNotSent('json');
    this._body = data;
    return this;
  }

  public formData(data: FormData): this {
    this._assertNotSent('formData');
    this._body = data;
    return this;
  }

  public text(data: string): this {
    this._assertNotSent('text');
    this._body = data;
    return this;
  }

  public body(data: unknown): this {
    this._assertNotSent('body');
    this._body = data;
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

  public signal(abortSignal: AbortSignal): this {
    this._assertNotSent('signal');
    // Refused now when it plainly is not one: it is composed with the client's own signal,
    // which needs an `AbortSignal`. Checked by its built-in tag rather than `instanceof`,
    // so another realm's (an iframe's) signal is accepted, as composing it accepts it. A
    // value that only claims the tag rejects `send()` instead, at setup.
    const candidate: unknown = abortSignal;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Object.prototype.toString.call(candidate) !== '[object AbortSignal]'
    ) {
      throw new TypeError(
        `HTTPRequestBuilder signal must be an AbortSignal (got ${candidate === null ? 'null' : typeof candidate})`,
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
        `HTTPRequestBuilder label must be a string (got ${candidate === null ? 'null' : typeof candidate})`,
      );
    }

    if (label.trim().length === 0) {
      throw new Error(
        'HTTPRequestBuilder.label() requires a non-empty, non-whitespace label.',
      );
    }

    this._label = label;
    return this;
  }

  public retryPolicy(options: RetryPolicyOptions | null | undefined): this {
    this._assertNotSent('retryPolicy');
    this._retryPolicy = isNullish(options)
      ? options
      : snapshotRetryPolicyOptions(options);
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
        `HTTPRequestBuilder retryNonIdempotentMethods must be a boolean (got ${candidate === null ? 'null' : typeof candidate})`,
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
   * NodeAdapter only. Called after response headers arrive on a 200 response,
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
   * Cancels the request, and says what that did (see {@link CancelResult}):
   * `'cancelled'` when this call cancelled it, `'already_cancelled'` when something else
   * had, and `'already_settled'` when it had already completed or failed.
   *
   * Calling cancel() before send() marks the builder as cancelled so that
   * send() throws instead of dispatching the request.
   */
  public cancel(reason?: string): CancelResult {
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
    if (
      this._setupCancel ||
      readUnknownMember(this._signal, 'aborted') === true
    ) {
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
    const response = await pending;

    return response as unknown as HTTPResponse<U>;
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

    // Body — type determines serialization (FormData → multipart, string → text/plain, object → JSON).
    // A custom content-type header overrides the auto-detected one.
    const body = opts.body;
    if (body !== undefined) {
      this.body(body);
    }

    // Request-level timeout in ms
    const timeout = opts.timeout;
    if (timeout !== undefined) {
      this.timeout(timeout);
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
      `HTTPRequestBuilder ${name} must be a function (got ${fn === null ? 'null' : typeof fn})`,
    );
  }
}
