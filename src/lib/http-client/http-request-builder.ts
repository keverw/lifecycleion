import { isNullish } from '../internal/is-nullish';
import { generateID } from '../id-helpers';
import { assertDurationMS } from '../internal/timer-limits';
import { snapshotRetryPolicyOptions } from './internal/retry-policy-options';
import { setOwnHeader } from './utils';
import type {
  HTTPMethod,
  HTTPResponse,
  HTTPRequestOptions,
  HTTPProgressEvent,
  AttemptStartEvent,
  AttemptEndEvent,
  RequestState,
  HTTPClientError,
  StreamResponseFactory,
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
  setCancelFn: (fn: (reason?: string) => void) => void;
}

export interface BuilderSendContext<T = unknown> {
  method: HTTPMethod;
  path: string;
  requestID: string;
  options: ResolvedBuilderOptions;
  callbacks: BuilderCallbacks<T>;
}

export interface ResolvedBuilderOptions extends HTTPRequestOptions {
  headers: Record<string, string | string[]>;
}

type SendFn<T> = (context: BuilderSendContext<T>) => Promise<HTTPResponse<T>>;

/**
 * Fluent, single-use request builder. Returned by HTTPClient methods.
 * Call .send() to execute the request.
 */
export class HTTPRequestBuilder<T = unknown> {
  private _method: HTTPMethod;
  private _path: string;
  private _headers: Record<string, string | string[]> = {};
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
  private _cancelFn: ((reason?: string) => void) | null = null;
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

  public headers(headers: Record<string, string | string[]>): this {
    this._assertNotSent('headers');
    // Own keys, not `Object.assign`: a `__proto__` header would set the record's
    // prototype (an array value) or vanish (a string). A nullish argument stays a
    // no-op, as `Object.assign` treated it.
    for (const [key, value] of Object.entries(headers ?? {})) {
      setOwnHeader(this._headers, key, value);
    }
    return this;
  }

  public params(params: Record<string, unknown>): this {
    this._assertNotSent('params');
    this._params = params;
    return this;
  }

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
    if (!isNullish(ms)) {
      assertDurationMS(ms, 'HTTP request timeout');
    }
    this._timeout = ms;
    return this;
  }

  public signal(abortSignal: AbortSignal): this {
    this._assertNotSent('signal');
    this._signal = abortSignal;
    return this;
  }

  public label(label: string): this {
    this._assertNotSent('label');

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
   * (`POST`, `PATCH`). Overrides the client config for this request only.
   */
  public retryNonIdempotentMethods(allow: boolean): this {
    this._assertNotSent('retryNonIdempotentMethods');
    this._retryNonIdempotentMethods = allow;
    return this;
  }

  public onUploadProgress(fn: (event: HTTPProgressEvent) => void): this {
    this._assertNotSent('onUploadProgress');
    this._onUploadProgress = fn;
    return this;
  }

  public onDownloadProgress(fn: (event: HTTPProgressEvent) => void): this {
    this._assertNotSent('onDownloadProgress');
    this._onDownloadProgress = fn;
    return this;
  }

  public onAttemptStart(fn: (event: AttemptStartEvent) => void): this {
    this._assertNotSent('onAttemptStart');
    this._onAttemptStart = fn;
    return this;
  }

  public onAttemptEnd(fn: (event: AttemptEndEvent) => void): this {
    this._assertNotSent('onAttemptEnd');
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
   * Cancels the request. Returns true if the cancel was applied, false if it
   * was a no-op (already completed, cancelled, or failed).
   *
   * Calling cancel() before send() marks the builder as cancelled so that
   * send() throws instead of dispatching the request.
   */
  public cancel(reason?: string): boolean {
    if (
      this._state === 'completed' ||
      this._state === 'cancelled' ||
      this._state === 'failed'
    ) {
      return false;
    }

    // Pre-send cancel: mark as cancelled so send() is blocked
    if (!this._sent) {
      this._state = 'cancelled';
      this._preSendCancelReason = reason;
      return true;
    }

    if (this._cancelFn) {
      this._cancelFn(reason);
      return true;
    }

    return false;
  }

  // --- Execute ---

  public async send<U = T>(): Promise<HTTPResponse<U>> {
    if (this._state === 'cancelled') {
      const reasonSuffix =
        this._preSendCancelReason !== undefined
          ? ` (reason: '${this._preSendCancelReason}')`
          : '';
      throw new Error(
        `HTTPRequestBuilder.send() cannot be called after cancel() has been called.${reasonSuffix}`,
      );
    }

    if (this._sent) {
      throw new Error(
        'HTTPRequestBuilder.send() can only be called once per builder instance.',
      );
    }

    this._sent = true;

    const response = await this._sendFn({
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
        setCancelFn: (fn) => {
          this._cancelFn = fn;
        },
      },
    });

    return response as unknown as HTTPResponse<U>;
  }

  // --- Private helpers ---

  private _applyOptions(opts: HTTPRequestOptions): void {
    // Options may be getters. Capture each value once, then apply it before reading
    // the next: validation failures must not run later getters as a side effect.
    // Request headers merged on top of any defaults
    const headers = opts.headers;
    if (headers) {
      this.headers(headers);
    }

    // URL query params
    const params = opts.params;
    if (params) {
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
    if (signal) {
      this.signal(signal);
    }

    // Retry behavior — null explicitly disables retrying
    const retryPolicy = opts.retryPolicy;
    if (retryPolicy !== undefined) {
      this.retryPolicy(retryPolicy);
    }

    const allowRetryNonIdempotentMethods = opts.retryNonIdempotentMethods;
    if (allowRetryNonIdempotentMethods !== undefined) {
      this.retryNonIdempotentMethods(allowRetryNonIdempotentMethods);
    }

    // Tracking label for cancel/list filtering
    const label = opts.label;
    if (label !== undefined) {
      this.label(label);
    }

    // Progress callbacks - upload
    const onUploadProgress = opts.onUploadProgress;
    if (onUploadProgress) {
      this.onUploadProgress(onUploadProgress);
    }

    // Progress callbacks - download
    const onDownloadProgress = opts.onDownloadProgress;
    if (onDownloadProgress) {
      this.onDownloadProgress(onDownloadProgress);
    }

    // Called before each attempt (including retries)
    const onAttemptStart = opts.onAttemptStart;
    if (onAttemptStart) {
      this.onAttemptStart(onAttemptStart);
    }

    // Called after each attempt (including retries)
    const onAttemptEnd = opts.onAttemptEnd;
    if (onAttemptEnd) {
      this.onAttemptEnd(onAttemptEnd);
    }

    // NodeAdapter response streaming factory
    const streamResponse = opts.streamResponse;
    if (streamResponse) {
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
