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
  setRequestID: (id: string) => void;
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
  private _timeout?: number;
  private _signal?: AbortSignal;
  private _retryPolicy?: RetryPolicyOptions | null;
  private _label?: string;
  private _onUploadProgress?: (event: HTTPProgressEvent) => void;
  private _onDownloadProgress?: (event: HTTPProgressEvent) => void;
  private _onAttemptStart?: (event: AttemptStartEvent) => void;
  private _onAttemptEnd?: (event: AttemptEndEvent) => void;
  private _streamResponse?: StreamResponseFactory;

  private _sendFn: SendFn<T>;
  private _sent = false;

  // Post-send state (public read-only after send)
  private _requestID: string | null = null;
  private _state: RequestState = 'pending';
  private _response: HTTPResponse<T> | null = null;
  private _error: HTTPClientError | null = null;
  private _attemptCount: number | null = null;
  private _nextRetryDelayMS: number | null = null;
  private _nextRetryAt: number | null = null;
  private _startedAt: number | null = null;
  private _completedAt: number | null = null;
  private _cancelFn: ((reason?: string) => void) | null = null;

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
    Object.assign(this._headers, headers);
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

  public timeout(ms: number): this {
    this._assertNotSent('timeout');
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

  public retryPolicy(options: RetryPolicyOptions | null): this {
    this._assertNotSent('retryPolicy');
    this._retryPolicy = options;
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
    if (!this._requestID) {
      throw new Error(
        'requestID is not available until after .send() is called',
      );
    }

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
      throw new Error(
        'HTTPRequestBuilder.send() cannot be called after cancel() has been called.',
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
      options: {
        headers: this._headers,
        params: this._params,
        body: this._body,
        timeout: this._timeout,
        signal: this._signal,
        retryPolicy: this._retryPolicy,
        label: this._label,
        onUploadProgress: this._onUploadProgress,
        onDownloadProgress: this._onDownloadProgress,
        onAttemptStart: this._onAttemptStart,
        onAttemptEnd: this._onAttemptEnd,
        streamResponse: this._streamResponse,
      },
      callbacks: {
        setRequestID: (id) => {
          this._requestID = id;
        },
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
    // Request headers merged on top of any defaults
    if (opts.headers) {
      this.headers(opts.headers);
    }

    // URL query params
    if (opts.params) {
      this.params(opts.params);
    }

    // Body — type determines serialization (FormData → multipart, string → text/plain, object → JSON).
    // A custom content-type header overrides the auto-detected one.
    if (opts.body !== undefined) {
      this.body(opts.body);
    }

    // Request-level timeout in ms
    if (opts.timeout !== undefined) {
      this.timeout(opts.timeout);
    }

    // External abort signal — merged with the internal one so both can cancel
    if (opts.signal) {
      this.signal(opts.signal);
    }

    // Retry behavior — null explicitly disables retrying
    if (opts.retryPolicy !== undefined) {
      this.retryPolicy(opts.retryPolicy);
    }

    // Tracking label for cancel/list filtering
    if (opts.label !== undefined) {
      this.label(opts.label);
    }

    // Progress callbacks - upload
    if (opts.onUploadProgress) {
      this.onUploadProgress(opts.onUploadProgress);
    }

    // Progress callbacks - download
    if (opts.onDownloadProgress) {
      this.onDownloadProgress(opts.onDownloadProgress);
    }

    // Called before each attempt (including retries)
    if (opts.onAttemptStart) {
      this.onAttemptStart(opts.onAttemptStart);
    }

    // Called after each attempt (including retries)
    if (opts.onAttemptEnd) {
      this.onAttemptEnd(opts.onAttemptEnd);
    }

    // NodeAdapter response streaming factory
    if (opts.streamResponse) {
      this.streamResponse(opts.streamResponse);
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
