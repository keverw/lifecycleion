import { generateID } from '../id-helpers';
import { deepClone } from '../deep-clone';
import { RetryPolicy } from '../retry-utils';
import { FetchAdapter } from './adapters/fetch-adapter';
import { assertNoBrowserRestrictedHeaders } from './internal/header-utils';
import { RequestTracker } from './request-tracker';
import type { RequestInfo } from './request-tracker';
import { HTTPRequestBuilder } from './http-request-builder';
import { RequestInterceptorManager } from './interceptors';
import { ResponseObserverManager, ErrorObserverManager } from './observers';
import {
  assertSupportedAdapterRuntimeAndConfig,
  assertSupportedRequestBody,
  buildURL,
  isBrowserEnvironment,
  mergeObservedHeaders,
  mergeHeaders,
  normalizeAdapterResponseHeaders,
  parseContentType,
  resolveAbsoluteURL,
  resolveAbsoluteURLForRuntime,
  scalarHeader,
  serializeBody,
} from './utils';
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_REQUEST_ID_HEADER,
  DEFAULT_REQUEST_ATTEMPT_HEADER,
  DEFAULT_USER_AGENT,
  NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_FACTORY_CANCEL_KEY,
  STREAM_FACTORY_ERROR_FLAG,
  XHR_BROWSER_TIMEOUT_FLAG,
  RETRYABLE_STATUS_CODES,
  REDIRECT_STATUS_CODES,
  DEFAULT_MAX_REDIRECTS,
} from './consts';
import type {
  HTTPClientConfig,
  HTTPMethod,
  HTTPResponse,
  HTTPClientError,
  InterceptedRequest,
  AttemptRequest,
  RequestInterceptorFilter,
  RequestInterceptor,
  ResponseObserver,
  ResponseObserverFilter,
  ErrorObserver,
  ErrorObserverFilter,
  AdapterType,
  AdapterResponse,
  HTTPRequestOptions,
  RedirectHopInfo,
  InterceptorCancel,
  RequestInterceptorContext,
  SubClientConfig,
  InterceptorPhase,
  ResponseObserverPhase,
  ErrorObserverPhase,
} from './types';
import type {
  BuilderCallbacks,
  ResolvedBuilderOptions,
  BuilderSendContext,
} from './http-request-builder';
import type { RetryPolicyOptions } from '../retry-utils';
import type { CookieJar } from './cookie-jar';

type RemoveFn = () => void;

interface InternalClientState {
  tracker?: RequestTracker;
  parentClient?: BaseHTTPClient | null;
}

export class BaseHTTPClient {
  protected _clientID: string;
  protected _config: Required<
    Pick<
      HTTPClientConfig,
      | 'timeout'
      | 'includeRequestID'
      | 'includeAttemptHeader'
      | 'followRedirects'
      | 'maxRedirects'
    >
  > &
    HTTPClientConfig;

  protected _adapter: NonNullable<HTTPClientConfig['adapter']>;
  protected _tracker: RequestTracker;
  protected _parentClient: BaseHTTPClient | null;
  protected _isBrowserRuntime: boolean;

  private _requestInterceptors: RequestInterceptorManager;
  private _responseObservers: ResponseObserverManager;
  private _errorObservers: ErrorObserverManager;

  private _disabled = false;

  constructor(
    config: HTTPClientConfig = {},
    internal: InternalClientState = {},
  ) {
    this._clientID = generateID('ulid');
    this._adapter = config.adapter ?? new FetchAdapter();
    this._isBrowserRuntime = isBrowserEnvironment();
    assertSupportedAdapterRuntimeAndConfig(
      config,
      this._adapter.getType(),
      this._isBrowserRuntime,
    );
    this._tracker = internal.tracker ?? new RequestTracker();
    this._parentClient = internal.parentClient ?? null;

    this._config = {
      adapter: this._adapter,
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders ?? {},
      timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
      cookieJar: config.cookieJar,
      retryPolicy: config.retryPolicy,
      includeRequestID: config.includeRequestID ?? false,
      includeAttemptHeader: config.includeAttemptHeader ?? false,
      userAgent: config.userAgent,
      followRedirects: config.followRedirects ?? false,
      maxRedirects: config.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    };

    this._requestInterceptors = new RequestInterceptorManager();
    this._responseObservers = new ResponseObserverManager();
    this._errorObservers = new ErrorObserverManager();
  }

  // --- Client metadata ---

  public get clientID(): string {
    return this._clientID;
  }

  public get adapterType(): AdapterType {
    return this._adapter.getType();
  }

  // --- Interceptors ---

  public addRequestInterceptor(
    fn: RequestInterceptor,
    filter?: RequestInterceptorFilter,
  ): RemoveFn {
    return this._requestInterceptors.add(fn, filter);
  }

  public addResponseObserver(
    fn: ResponseObserver,
    filter?: ResponseObserverFilter,
  ): RemoveFn {
    return this._responseObservers.add(fn, filter);
  }

  public addErrorObserver(
    fn: ErrorObserver,
    filter?: ErrorObserverFilter,
  ): RemoveFn {
    return this._errorObservers.add(fn, filter);
  }

  // --- Request methods ---

  /**
   * Start a request. `path` is usually **relative** to {@link HTTPClientConfig.baseURL}
   * when `baseURL` is set (e.g. `/v1/users`, `v1/users`).
   *
   * You may also pass a full **`http:` / `https:`** URL or a **protocol-relative**
   * `//host/...` string; those are **not** concatenated onto `baseURL`, so one
   * client can occasionally target another origin without a sub-client. The
   * final string is still run through `resolveAbsoluteURL` with `baseURL` so
   * `//…` picks up the right scheme. See `buildURL` in `./utils`.
   */
  public request<T = unknown>(
    method: HTTPMethod,
    path: string,
    options?: HTTPRequestOptions,
  ): HTTPRequestBuilder<T> {
    return new HTTPRequestBuilder<T>(
      method,
      path,
      (ctx) => this._execute(ctx),
      options,
    );
  }

  public get<T = unknown>(
    path: string,
    options?: HTTPRequestOptions,
  ): HTTPRequestBuilder<T> {
    return this.request<T>('GET', path, options);
  }

  public post<T = unknown>(
    path: string,
    options?: HTTPRequestOptions,
  ): HTTPRequestBuilder<T> {
    return this.request<T>('POST', path, options);
  }

  public put<T = unknown>(
    path: string,
    options?: HTTPRequestOptions,
  ): HTTPRequestBuilder<T> {
    return this.request<T>('PUT', path, options);
  }

  public patch<T = unknown>(
    path: string,
    options?: HTTPRequestOptions,
  ): HTTPRequestBuilder<T> {
    return this.request<T>('PATCH', path, options);
  }

  public delete<T = unknown>(
    path: string,
    options?: HTTPRequestOptions,
  ): HTTPRequestBuilder<T> {
    return this.request<T>('DELETE', path, options);
  }

  public head<T = unknown>(
    path: string,
    options?: HTTPRequestOptions,
  ): HTTPRequestBuilder<T> {
    return this.request<T>('HEAD', path, options);
  }

  // --- Cancellation ---

  public cancel(requestID: string, reason?: string): void {
    this._tracker.cancel(requestID, reason);
  }

  public cancelAll(reason?: string): void {
    this._tracker.cancelAll(reason);
  }

  public cancelOwn(reason?: string): void {
    this._tracker.cancelOwn(this._clientID, reason);
  }

  public cancelAllWithLabel(label: string, reason?: string): void {
    this._tracker.cancelAllWithLabel(label, reason);
  }

  public cancelOwnWithLabel(label: string, reason?: string): void {
    this._tracker.cancelOwnWithLabel(this._clientID, label, reason);
  }

  // --- Request inspection ---

  public listRequests(filter?: { scope?: 'own' | 'all'; label?: string }): {
    count: number;
    requests: RequestInfo[];
  } {
    const scope = filter?.scope ?? 'own';

    return this._tracker.list({
      clientID: scope === 'own' ? this._clientID : undefined,
      label: filter?.label,
    });
  }

  // --- Enable/disable ---

  public disable(): void {
    this._disabled = true;
  }

  public enable(): void {
    this._disabled = false;
  }

  public get isDisabled(): boolean {
    if (this._disabled) {
      return true;
    } else if (this._parentClient?.isDisabled) {
      return true;
    }

    return false;
  }

  // --- Sub-client configuration ---

  protected _buildSubClientConfig(
    overrides: SubClientConfig = {},
  ): HTTPClientConfig {
    const shouldFollowRedirects =
      overrides.followRedirects ?? this._config.followRedirects;
    const defaultHeaders =
      overrides.defaultHeadersStrategy === 'merge'
        ? mergeHeaders(this._config.defaultHeaders, overrides.defaultHeaders)
        : (overrides.defaultHeaders ?? this._config.defaultHeaders);

    const config: HTTPClientConfig = {
      ...this._config,
      ...overrides,
      defaultHeaders,
      followRedirects: shouldFollowRedirects,
      adapter: overrides.adapter ?? this._adapter,
      cookieJar:
        overrides.cookieJar !== undefined
          ? overrides.cookieJar
          : this._config.cookieJar,
    };

    if (
      shouldFollowRedirects === false &&
      overrides.maxRedirects === undefined
    ) {
      delete config.maxRedirects;
    }

    return config;
  }

  // --- Core execution ---

  private async _execute<T>(
    ctx: BuilderSendContext<T>,
  ): Promise<HTTPResponse<T>> {
    // Main request orchestration:
    //  1. Build URL, merge headers, apply user-agent
    //  2. Check pre-aborted signal → early cancel
    //  3. Create AbortController + wire builder.cancel()
    //  4. Run request interceptor chain
    //  5. Apply cookie jar
    //  6. Serialize body
    //  7. Create shared RetryPolicy instance
    //  8. _dispatchRequestAttempts → retry loop (sends via adapter)
    //  9. If redirect status → follow redirect (iterative loop, shares retry budget)
    // 10. Build final response, run observers, freeze timing
    if (this.isDisabled) {
      throw new Error(
        'HTTPClient is disabled. Call .enable() before sending requests.',
      );
    }

    const { method, path, requestID, options, callbacks } = ctx;

    // Wire up builder state
    callbacks.setState('sending');

    // buildURL: relative path + baseURL, OR absolute http(s) / //host path unchanged
    const url = resolveAbsoluteURLForRuntime(
      buildURL(this._config.baseURL, path, options.params),
      this._config.baseURL,
      this._isBrowserRuntime,
    );
    const timeout = options.timeout ?? this._config.timeout;

    // Merge headers
    const baseHeaders = mergeHeaders(
      this._config.defaultHeaders,
      options.headers,
    );

    if (this._config.includeRequestID) {
      baseHeaders[DEFAULT_REQUEST_ID_HEADER] = requestID;
    }

    const adapterType = this._adapter.getType();

    if (
      this._config.userAgent &&
      (adapterType === 'node' ||
        adapterType === 'fetch' ||
        adapterType === 'mock')
    ) {
      baseHeaders['user-agent'] = this._config.userAgent;
    } else if (
      adapterType === 'node' ||
      adapterType === 'mock' ||
      (adapterType === 'fetch' && !this._isBrowserRuntime)
    ) {
      baseHeaders['user-agent'] = DEFAULT_USER_AGENT;
    }

    // Build intercepted request context
    const interceptedRequest: InterceptedRequest = {
      requestURL: url,
      method,
      headers: baseHeaders,
      body: options.body,
    };

    // Short-circuit already-aborted external signals so we do not run
    // interceptors, tracking, retries, or adapter dispatch at all.
    if (options.signal?.aborted) {
      callbacks.setAttemptCount(0);
      callbacks.setNextRetryDelayMS(null);
      callbacks.setNextRetryAt(null);

      const response = this._buildResponse<T>({
        adapterResponse: null,
        requestID,
        wasCancelled: true,
        wasTimeout: false,
        adapterType: this._adapter.getType(),
        initialURL: interceptedRequest.requestURL,
        requestURL: interceptedRequest.requestURL,
        redirectHistory: [],
      });

      const error = this._makeError(
        response,
        requestID,
        false,
        undefined,
        undefined,
        options.signal ? getSignalCancelReason(options.signal) : undefined,
      );
      callbacks.setError(error);
      callbacks.setState('cancelled');
      await this._runErrorObservers(
        error,
        this._bestEffortAttemptRequestFromPending(
          interceptedRequest,
          timeout,
          requestID,
        ),
        {
          type: 'final',
        },
      );
      callbacks.setResponse(response);
      return response;
    }

    // Setup AbortController + tracker
    const abortController = new AbortController();
    this._tracker.add({
      requestID,
      clientID: this._clientID,
      label: options.label,
      state: 'sending',
      abortController,
    });

    const trackedCallbacks: BuilderCallbacks<T> = {
      ...callbacks,
      setState: (state) => {
        callbacks.setState(state);
        this._tracker.updateState(requestID, state);
      },
    };

    // Wire builder.cancel() to our abort controller
    trackedCallbacks.setCancelFn((reason?: string) => {
      abortController.abort(reason);
    });

    // Compose user signal with our internal abort controller
    let cancelSignal: AbortSignal = abortController.signal;

    if (options.signal) {
      cancelSignal = this._composeSignals(
        options.signal,
        abortController.signal,
      );
    }

    try {
      let finalRequest = interceptedRequest;
      let response: HTTPResponse<T>;
      let observerRequest = this._bestEffortAttemptRequestFromPending(
        interceptedRequest,
        timeout,
        requestID,
      );
      let errorCode: HTTPClientError['code'] | undefined;
      let adapterCause: Error | undefined;
      let cancelReason: string | undefined;
      let isRetriesExhausted = false;
      let completedAttemptCount = 0;

      try {
        // streamResponse is NodeAdapter-only. Validate it inside the normal
        // request setup flow so builder/error observer state is updated the same
        // way as every other request_setup_error.
        if (options.streamResponse && this._adapter.getType() !== 'node') {
          throw new Error(
            `[HTTPClient] .streamResponse() requires NodeAdapter. Current adapter: ${this._adapter.getType()}`,
          );
        }

        // Validate the resolved URL is a proper http(s) URL. Protocol-relative
        // //host paths without a baseURL to supply the scheme stay unresolved and
        // must fail here as a request_setup_error rather than reaching the adapter.
        if (!this._isSupportedRequestURL(url)) {
          throw new Error(
            `[HTTPClient] Request URL could not be resolved to an absolute http(s) URL: "${url}". ` +
              `Set a baseURL with an http(s) scheme or pass an absolute URL.`,
          );
        }

        this._assertRequestIsSupported(interceptedRequest);

        // Run interceptors (initial phase)
        const initialPhase: InterceptorPhase = { type: 'initial' };
        let interceptResult: InterceptedRequest | InterceptorCancel;
        let initialRequestCandidate: InterceptedRequest = finalRequest;

        try {
          interceptResult = await this._runInterceptors(
            finalRequest,
            initialPhase,
            {
              initialURL: url,
              redirectHistory: [],
              requestID,
              attemptNumber: 1,
            },
          );

          if (!('cancel' in interceptResult)) {
            initialRequestCandidate = interceptResult;
            this._assertRequestIsSupported(interceptResult);
            this._assertInterceptorResolvedURL(interceptResult.requestURL);
          }
        } catch (error) {
          const response = this._buildResponse<T>({
            adapterResponse: null,
            requestID,
            wasCancelled: false,
            wasTimeout: false,
            adapterType: this._adapter.getType(),
            initialURL: url,
            requestURL: initialRequestCandidate.requestURL,
            redirectHistory: [],
            isNetworkErrorOverride: false,
          });

          const normalizedError = this._makeError(
            response,
            requestID,
            false,
            'interceptor_error',
            error instanceof Error ? error : new Error(String(error)),
          );

          callbacks.setError(normalizedError);
          trackedCallbacks.setState('failed');
          callbacks.setResponse(response);

          await this._runErrorObservers(
            normalizedError,
            this._bestEffortAttemptRequestFromPending(
              initialRequestCandidate,
              timeout,
              requestID,
            ),
            {
              type: 'final',
            },
          );

          return response;
        }

        if ('cancel' in interceptResult) {
          const cancelledResponse = this._buildResponse<T>({
            adapterResponse: null,
            requestID,
            wasCancelled: true,
            wasTimeout: false,
            adapterType: this._adapter.getType(),
            initialURL: url,
            requestURL: url,
            redirectHistory: [],
          });

          const error = this._makeError(
            cancelledResponse,
            requestID,
            false,
            undefined,
            undefined,
            interceptResult.reason,
          );
          callbacks.setError(error);
          trackedCallbacks.setState('cancelled');

          await this._runErrorObservers(
            error,
            this._bestEffortAttemptRequestFromPending(
              finalRequest,
              timeout,
              requestID,
            ),
            {
              type: 'final',
            },
          );

          callbacks.setResponse(cancelledResponse);
          return cancelledResponse;
        }

        finalRequest = interceptResult;

        // Cookie header is not merged here: _dispatchRequestAttempts applies the jar on
        // every adapter attempt (first try and retries) after internal + interceptor headers.
        const jar = this._config.cookieJar;

        // Determine effective retry policy — one shared instance used by both
        // the main dispatch loop AND any redirect hops (shared budget).
        const retryPolicyOptions: RetryPolicyOptions | undefined | null =
          options.retryPolicy !== undefined
            ? options.retryPolicy
            : this._config.retryPolicy;
        const retryPolicy = retryPolicyOptions
          ? new RetryPolicy(retryPolicyOptions)
          : null;

        // --- Main request + redirect loop ---
        //
        // Redirect following is handled here as an iterative loop rather than
        // in a separate recursive method. Each iteration either sends the
        // initial request or follows a redirect hop. Retries within each hop
        // are handled by _dispatchRequestAttempts, which shares the same
        // RetryPolicy instance across all hops so retries on redirect targets
        // eat into the same budget as retries on the initial request.
        //
        // On a redirect response (301, 302, 303, 307, 308), the loop:
        //  1. Resolves the Location header into an absolute URL
        //  2. Rewrites the method per HTTP spec (303 → GET; 301/302 + POST → GET)
        //  3. Strips non-safelisted headers on cross-origin redirects
        //  4. Seeds Cookie from the jar for the redirect URL (dispatch re-merges from the jar
        //     on each attempt of that hop, so this stays in sync with Set-Cookie from prior responses)
        //  5. Runs redirect-phase interceptors and observers
        //  6. Continues the loop with the updated request state
        let currentInterceptedRequest: InterceptedRequest = finalRequest;
        let redirectHistory: string[] = [];
        let hopCount = 0;
        // Tracks the last global attempt number across all hops and retries,
        // so the next hop's attempts continue the sequence (e.g. 1,2,3 on
        // initial request → 4,5 on first redirect hop → 6 on second hop).
        let lastAttemptNumber = 0;
        let currentHopInfo: RedirectHopInfo | undefined;

        while (true) {
          // Send request through the adapter with retry support. Each hop gets
          // its own call; the shared retryPolicy tracks budget across all hops.
          const attemptResult = await this._dispatchRequestAttempts({
            request: currentInterceptedRequest,
            timeout,
            cancelSignal,
            retryPolicy,
            requestID,
            options,
            callbacks: trackedCallbacks,
            initialURL: finalRequest.requestURL,
            startAttemptNumber: lastAttemptNumber + 1,
            redirectHistory,
            hopContext: currentHopInfo
              ? { hopNumber: hopCount, redirect: currentHopInfo }
              : undefined,
            cookieJar: jar ?? undefined,
          });

          const { adapterResponse, wasCancelled, wasTimeout } = attemptResult;
          lastAttemptNumber = attemptResult.attemptCount;
          isRetriesExhausted = attemptResult.isRetriesExhausted;
          completedAttemptCount = attemptResult.attemptCount;

          // If adapter threw, capture the error code and cause
          if (attemptResult.errorCode) {
            errorCode = attemptResult.errorCode;
          }

          if (attemptResult.adapterCause) {
            adapterCause = attemptResult.adapterCause;
          }

          if (attemptResult.cancelReason !== undefined) {
            cancelReason = attemptResult.cancelReason;
          }

          callbacks.setAttemptCount(attemptResult.attemptCount);
          observerRequest = attemptResult.sentRequest;

          if (
            !this._config.followRedirects &&
            adapterResponse &&
            REDIRECT_STATUS_CODES.has(adapterResponse.status)
          ) {
            response = this._buildResponse<T>({
              // Pass a synthetic status-0 response so wasRedirectDetected is
              // preserved — null would lose the flag since _buildResponse
              // computes it as `adapterResponse?.wasRedirectDetected ?? false`.
              adapterResponse: {
                status: 0,
                wasRedirectDetected: true,
                detectedRedirectURL: adapterResponse.detectedRedirectURL,
                headers: {},
                body: null,
              },
              requestID,
              wasCancelled: false,
              wasTimeout: false,
              adapterType: this._adapter.getType(),
              initialURL: finalRequest.requestURL,
              requestURL: attemptResult.sentRequest.requestURL,
              redirectHistory,
              isNetworkErrorOverride: false,
            });
            errorCode = 'redirect_disabled';
            break;
          }

          // --- Follow redirects (301, 302, 303, 307, 308) ---
          if (
            this._config.followRedirects &&
            adapterResponse &&
            REDIRECT_STATUS_CODES.has(adapterResponse.status)
          ) {
            hopCount++;

            // Guard against infinite redirect chains
            if (hopCount > this._config.maxRedirects) {
              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapter.getType(),
                initialURL: finalRequest.requestURL,
                requestURL: attemptResult.sentRequest.requestURL,
                redirectHistory,
              });
              errorCode = 'redirect_loop';
              break;
            }

            // Resolve the Location header into an absolute URL.
            // Relative paths (e.g. "/new-path") resolve against the current request URL.
            const location = scalarHeader(adapterResponse.headers, 'location');

            if (!location) {
              // Redirect status but no Location header — treat as final response
              response = this._buildResponse<T>({
                adapterResponse,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapter.getType(),
                initialURL: finalRequest.requestURL,
                requestURL: attemptResult.sentRequest.requestURL,
                redirectHistory,
              });

              break;
            }

            let redirectURL: string;

            try {
              redirectURL = new URL(
                location,
                attemptResult.sentRequest.requestURL,
              ).toString();
            } catch {
              redirectURL = location;
            }

            redirectURL = resolveAbsoluteURL(redirectURL, this._config.baseURL);

            // Method rewriting per HTTP spec (matches browser/fetch behavior):
            //  - 303 (See Other) always becomes GET
            //  - 301 (Moved Permanently) / 302 (Found) rewrite POST to GET
            //  - 307 (Temporary Redirect) / 308 (Permanent Redirect) preserve method/body
            let redirectMethod: HTTPMethod = currentInterceptedRequest.method;

            if (
              adapterResponse.status === 303 ||
              ((adapterResponse.status === 301 ||
                adapterResponse.status === 302) &&
                currentInterceptedRequest.method === 'POST')
            ) {
              redirectMethod = 'GET';
            }

            const hopInfo: RedirectHopInfo = {
              hop: hopCount,
              from: attemptResult.sentRequest.requestURL,
              to: redirectURL,
              statusCode: adapterResponse.status,
            };

            // Notify redirect-phase response observers (after Set-Cookie from
            // this response is applied). Same hop/from/to/statusCode as the
            // redirect-phase request interceptors that run below.
            await this._runResponseObservers(
              this._buildResponse({
                adapterResponse,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapter.getType(),
                initialURL: finalRequest.requestURL,
                requestURL: attemptResult.sentRequest.requestURL,
                redirectHistory,
              }),
              attemptResult.sentRequest,
              { type: 'redirect', ...hopInfo },
            );

            // Cross-origin safety: strip ALL headers except CORS-safelisted ones
            // when the redirect crosses origins (scheme + host + port). Matches
            // Chromium/fetch behavior — Authorization, X-API-Key, etc. must not
            // leak to a different host. Cookies and internal headers (request ID)
            // are re-attached below as needed.
            const nextRedirectHistory = [...redirectHistory, redirectURL];

            const redirectRequest = this._sanitizeRedirectRequest(
              {
                ...currentInterceptedRequest,
                requestURL: redirectURL,
                method: redirectMethod,
                body:
                  redirectMethod === 'GET'
                    ? undefined
                    : currentInterceptedRequest.body,
              },
              {
                fromURL: attemptResult.sentRequest.requestURL,
                cookieJar: jar ?? undefined,
              },
            );

            // Run redirect-phase request interceptors so they can update headers
            // for the new target (e.g. refresh auth tokens). Retry-phase
            // interceptors run inside _dispatchRequestAttempts if the hop itself
            // needs retrying.
            let redirectIntercept: InterceptedRequest | InterceptorCancel;
            let failedRedirectRequest: InterceptedRequest = redirectRequest;

            try {
              redirectIntercept = await this._runInterceptors(
                redirectRequest,
                { type: 'redirect', ...hopInfo },
                {
                  initialURL: finalRequest.requestURL,
                  redirectHistory: nextRedirectHistory,
                  requestID,
                  attemptNumber: lastAttemptNumber + 1,
                },
              );
              if (!('cancel' in redirectIntercept)) {
                failedRedirectRequest = redirectIntercept;
                this._assertRequestIsSupported(redirectIntercept);
                this._assertInterceptorResolvedURL(
                  redirectIntercept.requestURL,
                );
              }
            } catch (error) {
              observerRequest = this._bestEffortAttemptRequestFromPending(
                failedRedirectRequest,
                timeout,
                requestID,
              );
              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapter.getType(),
                initialURL: finalRequest.requestURL,
                requestURL: failedRedirectRequest.requestURL,
                redirectHistory: nextRedirectHistory,
                isNetworkErrorOverride: false,
              });

              errorCode = 'interceptor_error';
              adapterCause =
                error instanceof Error ? error : new Error(String(error));

              break;
            }

            if ('cancel' in redirectIntercept) {
              const cancelledRequestURL = redirectRequest.requestURL;
              observerRequest = this._bestEffortAttemptRequestFromPending(
                redirectRequest,
                timeout,
                requestID,
              );
              if (redirectIntercept.reason !== undefined) {
                cancelReason = redirectIntercept.reason;
              }

              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: true,
                wasTimeout: false,
                adapterType: this._adapter.getType(),
                initialURL: finalRequest.requestURL,
                requestURL: cancelledRequestURL,
                redirectHistory: [...redirectHistory, cancelledRequestURL],
              });

              break;
            }

            const sanitizedRedirectRequest = this._sanitizeRedirectRequest(
              redirectIntercept,
              {
                // fromURL is the redirect target URL (what the interceptor received).
                // This sanitize only strips headers if the interceptor rewrote the
                // URL to a third host — in that case from=redirectTarget, to=thirdHost
                // is cross-origin and the strip fires correctly.

                // If the interceptor kept the URL (normal case), from and to are the
                // same origin and nothing is stripped, preserving any headers the
                // interceptor added (e.g. Authorization for the redirect target).
                fromURL: redirectRequest.requestURL,
                cookieJar: jar ?? undefined,
              },
            );

            const redirectedRequestURL = sanitizedRedirectRequest.requestURL;

            // Update loop state for the next redirect hop
            currentInterceptedRequest = sanitizedRedirectRequest;
            redirectHistory = [...redirectHistory, redirectedRequestURL];
            currentHopInfo = {
              ...hopInfo,
              to: redirectedRequestURL,
            };

            continue;
          }

          // Non-redirect: build final HTTPResponse
          response = this._buildResponse<T>({
            adapterResponse,
            requestID,
            wasCancelled,
            wasTimeout,
            adapterType: this._adapter.getType(),
            initialURL: finalRequest.requestURL,
            requestURL: attemptResult.sentRequest.requestURL,
            redirectHistory,
            ...(attemptResult.errorCode === 'interceptor_error' ||
            attemptResult.errorCode === 'stream_setup_error' ||
            attemptResult.errorCode === 'redirect_disabled'
              ? { isNetworkErrorOverride: false }
              : {}),
          });

          break;
        }
      } catch (error) {
        response = this._buildResponse<T>({
          adapterResponse: null,
          requestID,
          wasCancelled: false,
          wasTimeout: false,
          adapterType: this._adapter.getType(),
          initialURL: interceptedRequest.requestURL,
          requestURL: interceptedRequest.requestURL,
          redirectHistory: [],
          isNetworkErrorOverride: false,
        });

        const normalizedError = this._makeError(
          response,
          requestID,
          false,
          'request_setup_error',
          error instanceof Error ? error : new Error(String(error)),
        );

        callbacks.setAttemptCount(completedAttemptCount);
        callbacks.setNextRetryDelayMS(null);
        callbacks.setNextRetryAt(null);
        callbacks.setError(normalizedError);
        trackedCallbacks.setState('failed');
        callbacks.setResponse(response);
        await this._runErrorObservers(
          normalizedError,
          this._bestEffortAttemptRequestFromPending(
            interceptedRequest,
            timeout,
            requestID,
          ),
          {
            type: 'final',
          },
        );
        return response;
      }

      // Run response or error observers. Phase `final` means this `send()` has finished.
      // Observers with `phases: ['retry']` already ran inside _dispatchRequestAttempts
      // for each retryable outcome before the retry delay; `redirect` phase response
      // observers ran inside the redirect loop for each redirect response. Network and
      // retryable HTTP failures may have been retried before we get here; interceptor
      // throw/cancel never retries and reaches this block immediately.
      const finalResponse = response;

      if (response.isFailed) {
        const error = this._makeError(
          response,
          requestID,
          isRetriesExhausted,
          // Set for adapter_error, interceptor_error, redirect_loop, etc.; otherwise network_error.
          // Streamed-body failures after headers also terminate here, but preserve
          // their real HTTP status on the response object.
          errorCode ??
            (response.isStreamError ? 'stream_write_error' : undefined),
          adapterCause,
          cancelReason,
        );

        callbacks.setError(error);
        callbacks.setNextRetryDelayMS(null);
        callbacks.setNextRetryAt(null);
        trackedCallbacks.setState(
          response.isCancelled ? 'cancelled' : 'failed',
        );
        await this._runErrorObservers(error, observerRequest, {
          type: 'final',
        });
      } else {
        callbacks.setNextRetryDelayMS(null);
        callbacks.setNextRetryAt(null);
        trackedCallbacks.setState('completed');
        await this._runResponseObservers(response, observerRequest, {
          type: 'final',
        });
      }

      callbacks.setResponse(finalResponse);
      return finalResponse;
    } finally {
      this._tracker.remove(requestID);
    }
  }

  private _sanitizeRedirectRequest(
    request: InterceptedRequest,
    params: {
      fromURL: string;
      cookieJar?: CookieJar | null;
    },
  ): InterceptedRequest {
    const { fromURL, cookieJar } = params;
    const isCrossOrigin = this._isCrossOriginRedirect(
      fromURL,
      request.requestURL,
    );

    let headers: Record<string, string | string[]>;

    if (isCrossOrigin) {
      const safeHeaders: Record<string, string | string[]> = {};
      // Cross-origin safety: strip ALL headers except CORS-safelisted ones
      // when the redirect crosses origins (scheme + host + port). Matches
      // Chromium/fetch behavior — Authorization, X-API-Key, etc. must not
      // leak to a different host. Cookies and internal headers are re-attached
      // later as needed.
      const safelisted = new Set([
        'accept',
        'accept-language',
        'content-language',
        'content-type',
        'user-agent',
      ]);

      for (const [key, value] of Object.entries(request.headers)) {
        const lower = key.toLowerCase();

        if (safelisted.has(lower)) {
          safeHeaders[lower] = value;
        }
      }

      headers = safeHeaders;
    } else {
      // Same-origin: keep the headers from the request that just ran.
      // If a cookie jar is configured, the next attempt rebuilds `Cookie`
      // from the jar during request materialization, making the jar authoritative.
      headers = { ...request.headers };
    }

    if (request.method === 'GET') {
      // Drop body-related headers when method was rewritten to GET.
      delete headers['content-type'];
      delete headers['content-length'];
    }

    if (cookieJar) {
      // Cookie for the new URL before the next hop is dispatched; each send on
      // this hop still refreshes from the jar inside _dispatchRequestAttempts.
      const cookieStr = cookieJar.getCookieHeaderString(request.requestURL);

      if (cookieStr) {
        headers.cookie = cookieStr;
      } else {
        delete headers.cookie;
      }
    } else if (isCrossOrigin) {
      // Without a jar, never let a caller-supplied Cookie header survive a
      // cross-origin redirect or redirect-interceptor rewrite.
      delete headers.cookie;
    }

    return {
      ...request,
      headers,
    };
  }

  private _isCrossOriginRedirect(fromURL: string, toURL: string): boolean {
    try {
      const from = new URL(fromURL);
      const to = new URL(toURL);
      return from.origin !== to.origin;
    } catch {
      return true;
    }
  }

  /**
   * Core retry loop — sends the request through the adapter and retries on
   * retryable status codes (503, 429, etc.) or network errors, up to the
   * policy's max attempts. Each attempt gets its own independent timeout.
   *
   * Cancellation (via cancelSignal) is checked after every retry delay so
   * the caller doesn't have to wait for the full delay to finish.
   *
   * The same RetryPolicy instance is shared across the redirect loop in
   * _execute, so retries during redirect hops eat into the same budget.
   */
  private async _dispatchRequestAttempts<T>(params: {
    request: InterceptedRequest;
    /** Per-attempt timeout in ms. Each attempt gets its own independent timer — NOT a total deadline across all retries. */
    timeout: number;
    /** Cancellation signal from user cancel / cancelAll / external AbortSignal — NOT timeout. Also used to abort retry delays. */
    cancelSignal: AbortSignal;
    retryPolicy: RetryPolicy | null;
    requestID: string;
    options: ResolvedBuilderOptions;
    callbacks: BuilderCallbacks<T>;
    /** The original URL before any redirects — used in callbacks so consumers can correlate attempts across hops. */
    initialURL: string;
    /** First attempt number for this dispatch (continues from previous hops). Defaults to 1. */
    startAttemptNumber?: number;
    /** Accumulated redirect history — passed to interceptor context. */
    redirectHistory?: string[];
    /** When dispatching a redirect hop, carries the hop number and redirect info for callbacks and observer phases. */
    hopContext?: { hopNumber: number; redirect: RedirectHopInfo };
    /**
     * If set: each adapter response updates the jar from `Set-Cookie` before retry/backoff,
     * and each outbound attempt rebuilds the `Cookie` header from the jar for `attemptTarget`.
     */
    cookieJar?: CookieJar | null;
  }): Promise<{
    adapterResponse: AdapterResponse | null;
    sentRequest: AttemptRequest;
    attemptCount: number;
    wasCancelled: boolean;
    wasTimeout: boolean;
    isRetriesExhausted: boolean;
    errorCode?: HTTPClientError['code'];
    adapterCause?: Error;
    cancelReason?: string;
  }> {
    const {
      request: baseRequest,
      timeout,
      cancelSignal,
      retryPolicy: policy,
      requestID,
      options,
      callbacks,
      initialURL,
      hopContext,
    } = params;
    const startAttempt = params.startAttemptNumber ?? 1;
    const redirectHistory = params.redirectHistory ?? [];
    const cookieJar = params.cookieJar ?? null;
    let attemptNumber = startAttempt - 1;
    let isRetriesExhausted = false;

    while (true) {
      attemptNumber++;
      const isRetry = attemptNumber > startAttempt;

      // Only set the start timestamp on the very first attempt of the entire
      // request (attempt 1). Redirect hops reuse the original start time.
      if (attemptNumber === 1) {
        callbacks.setStartedAt(Date.now());
      } else {
        callbacks.setState('sending');
      }

      callbacks.setAttemptCount(attemptNumber);
      callbacks.setNextRetryDelayMS(null);
      callbacks.setNextRetryAt(null);
      options.onAttemptStart?.({
        attemptNumber,
        isRetry,
        requestID,
        initialURL,
        ...(hopContext
          ? { hopNumber: hopContext.hopNumber, redirect: hopContext.redirect }
          : {}),
      });

      // RetryPolicy only tracks exhaustion after the initial try is registered (retry-utils).
      if (attemptNumber === 1 && policy) {
        policy.shouldDoFirstTry();
      }

      // Per-attempt wall-clock timeout — separate from the cancel signal.
      // This covers the full attempt lifetime, including response body
      // streaming, and is NOT reset by upload/download progress or chunk
      // activity. Set timeout <= 0 to disable the per-attempt timer.
      const timeoutController = new AbortController();
      let isTimedOut = false;
      let timeoutID: ReturnType<typeof setTimeout> | undefined;

      if (timeout > 0) {
        timeoutID = setTimeout(() => {
          isTimedOut = true;
          timeoutController.abort();
        }, timeout);
      }

      // Final signal: cancel OR timeout
      const attemptSignal = this._composeSignals(
        cancelSignal,
        timeoutController.signal,
      );

      // Set internal headers unconditionally on every attempt — this is
      // simpler than relying on them surviving cross-origin header stripping
      // during redirects. Both are always re-applied here so the redirect
      // loop doesn't need to worry about re-attaching them.
      let attemptRequest: InterceptedRequest = baseRequest;

      // Run retry-phase interceptors before each reattempt so they can refresh
      // headers or rewrite the request. On redirect hops, the phase includes
      // redirect context so interceptors know which hop is being retried.
      if (isRetry) {
        const retryPhase: InterceptorPhase = {
          type: 'retry',
          attempt: attemptNumber,
          maxAttempts: policy ? policy.maxRetryAttempts + 1 : attemptNumber,
          ...(hopContext?.redirect ? { redirect: hopContext.redirect } : {}),
        };
        let retryIntercept: InterceptedRequest | InterceptorCancel;
        let failedRetryRequest: InterceptedRequest = baseRequest;

        try {
          retryIntercept = await this._runInterceptors(
            {
              ...baseRequest,
              headers: this._withInternalRequestHeaders(
                baseRequest.headers,
                requestID,
                attemptNumber,
              ),
            },
            retryPhase,
            { initialURL, redirectHistory, requestID, attemptNumber },
          );
          if (!('cancel' in retryIntercept)) {
            failedRetryRequest = retryIntercept;
            this._assertRequestIsSupported(retryIntercept);
            this._assertInterceptorResolvedURL(retryIntercept.requestURL);
          }
        } catch (error) {
          clearTimeout(timeoutID);

          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          // Terminal failure — no further attempts. _execute notifies error observers
          // with phase `final` (same as all settled errors), not `retry`.
          return {
            adapterResponse: null,
            sentRequest: this._bestEffortAttemptRequestFromPending(
              failedRetryRequest,
              timeout,
              requestID,
            ),
            attemptCount: attemptNumber,
            wasCancelled: false,
            wasTimeout: false,
            isRetriesExhausted: false,
            errorCode: 'interceptor_error',
            adapterCause:
              error instanceof Error ? error : new Error(String(error)),
          };
        }

        if ('cancel' in retryIntercept) {
          clearTimeout(timeoutID);

          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          return {
            adapterResponse: null,
            sentRequest: this._bestEffortAttemptRequestFromPending(
              baseRequest,
              timeout,
              requestID,
            ),
            attemptCount: attemptNumber,
            wasCancelled: true,
            wasTimeout: false,
            isRetriesExhausted: false,
            ...(retryIntercept.reason !== undefined
              ? { cancelReason: retryIntercept.reason }
              : {}),
          };
        }

        attemptRequest = retryIntercept;
      }

      const sentRequest = this._buildAttemptRequest(attemptRequest, {
        requestID,
        timeout,
        attemptNumber,
        cookieJar,
      });

      const onUploadProgress = options.onUploadProgress;
      const onDownloadProgress = options.onDownloadProgress;

      let observedSentRequest: AttemptRequest = sentRequest;

      try {
        const rawAdapterResponse = await this._adapter.send({
          requestURL: sentRequest.requestURL,
          method: sentRequest.method,
          headers: { ...sentRequest.headers },
          body: sentRequest.body ?? null,
          signal: attemptSignal,
          // Forward the builder's streaming factory to each adapter attempt.
          // NodeAdapter invokes it only for a 200 response, letting the caller
          // create attempt-local writable state when a retry happens.
          streamResponse: options.streamResponse,
          // attemptNumber and requestID are passed so NodeAdapter can populate
          // StreamResponseInfo without the adapter needing to track attempt state
          // itself.
          attemptNumber,
          requestID: requestID,
          onUploadProgress: onUploadProgress
            ? (e) =>
                onUploadProgress({
                  ...e,
                  attemptNumber,
                  ...(hopContext ? { hopNumber: hopContext.hopNumber } : {}),
                })
            : undefined,
          onDownloadProgress: onDownloadProgress
            ? (e) =>
                onDownloadProgress({
                  ...e,
                  attemptNumber,
                  ...(hopContext ? { hopNumber: hopContext.hopNumber } : {}),
                })
            : undefined,
        });

        const adapterResponse: AdapterResponse = {
          ...rawAdapterResponse,
          headers: normalizeAdapterResponseHeaders(rawAdapterResponse.headers),
        };

        observedSentRequest = rawAdapterResponse.effectiveRequestHeaders
          ? {
              ...sentRequest,
              headers: mergeObservedHeaders(
                sentRequest.headers,
                rawAdapterResponse.effectiveRequestHeaders,
              ),
            }
          : sentRequest;

        clearTimeout(timeoutID);

        // Store Set-Cookie before retry/backoff so the next attempt matches browsers
        // and curl (cookies from error responses apply to follow-up requests).
        if (cookieJar) {
          cookieJar.processResponseHeaders(
            adapterResponse.headers,
            sentRequest.requestURL,
          );
        }

        // Browser-only path: adapter returned status 0 but flagged a redirect
        // (FetchAdapter opaque redirect or XHR auto-follow).
        //
        // Status 0 means no Location header is available, so the normal
        // REDIRECT_STATUS_CODES check in the outer loop can't handle it.
        //
        // When redirects are disabled this is redirect_disabled.
        // When enabled, the status-0 response falls
        // through to the transport error path (nowhere to redirect to).
        //
        // Real 3xx responses (NodeAdapter, MockAdapter) do NOT reach this path
        // because their status != 0. They fall through to onAttemptEnd with
        // the correct status, and the outer redirect loop handles follow/disable.
        if (
          adapterResponse.wasRedirectDetected &&
          adapterResponse.status === 0 &&
          !this._config.followRedirects
        ) {
          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          return {
            adapterResponse,
            sentRequest: observedSentRequest,
            attemptCount: attemptNumber,
            wasCancelled: false,
            wasTimeout: false,
            isRetriesExhausted: false,
            errorCode: 'redirect_disabled',
          };
        }

        // Check if should retry based on status code.
        // Stream failures are terminal even when status is retryable (e.g. 0).
        if (
          policy &&
          adapterResponse.isRetryable !== false &&
          !adapterResponse.isStreamError &&
          RETRYABLE_STATUS_CODES.has(adapterResponse.status) &&
          !cancelSignal.aborted
        ) {
          const { shouldRetry, delayMS } = policy.shouldRetry(
            new Error(`HTTP ${adapterResponse.status}`),
          );
          const nextRetryAt = shouldRetry ? Date.now() + delayMS : undefined;

          if (shouldRetry) {
            callbacks.setNextRetryDelayMS(delayMS);
            callbacks.setNextRetryAt(nextRetryAt ?? null);
            callbacks.setState('waiting_for_retry');
          }

          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: shouldRetry,
            nextRetryDelayMS: shouldRetry ? delayMS : undefined,
            nextRetryAt,
            status: adapterResponse.status,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          if (shouldRetry) {
            const retryHTTPResponse = this._buildResponse({
              adapterResponse,
              requestID,
              wasCancelled: false,
              wasTimeout: false,
              adapterType: this._adapter.getType(),
              initialURL,
              requestURL: sentRequest.requestURL,
              redirectHistory,
            });

            await this._runResponseObservers(
              retryHTTPResponse,
              observedSentRequest,
              this._retryOutcomePhase(
                policy,
                attemptNumber,
                hopContext?.redirect,
              ),
            );

            await this._cancellableDelay(delayMS, cancelSignal);

            if (cancelSignal.aborted) {
              const signalReason = getSignalCancelReason(cancelSignal);
              return {
                adapterResponse: null,
                sentRequest: observedSentRequest,
                attemptCount: attemptNumber,
                wasCancelled: true,
                wasTimeout: false,
                isRetriesExhausted: false,
                ...(signalReason !== undefined
                  ? { cancelReason: signalReason }
                  : {}),
              };
            }

            continue;
          }

          isRetriesExhausted = true;
        } else {
          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: adapterResponse.status,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });
        }

        const responseCause: Error | undefined =
          adapterResponse.errorCause instanceof Error
            ? adapterResponse.errorCause
            : undefined;

        const streamErrorCode = adapterResponse.isStreamError
          ? (adapterResponse.streamErrorCode ?? 'stream_write_error')
          : undefined;

        return {
          adapterResponse,
          sentRequest: observedSentRequest,
          attemptCount: attemptNumber,
          wasCancelled: false,
          wasTimeout: false,
          isRetriesExhausted,
          errorCode: streamErrorCode,
          adapterCause: responseCause,
        };
      } catch (error) {
        clearTimeout(timeoutID);

        // When abort(string) is called, fetch() rejects with the string itself (per Fetch spec),
        // not an AbortError. Check cancelSignal.aborted first so string-reason cancels are caught.
        if (cancelSignal.aborted && !isAbortError(error)) {
          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          const signalReason = getSignalCancelReason(cancelSignal);

          return {
            adapterResponse: null,
            sentRequest,
            attemptCount: attemptNumber,
            wasCancelled: true,
            wasTimeout: isTimedOut,
            isRetriesExhausted: false,
            ...(signalReason !== undefined
              ? { cancelReason: signalReason }
              : {}),
          };
        }

        if (isAbortError(error) && isResponseStreamAbortError(error)) {
          if (cancelSignal.aborted) {
            options.onAttemptEnd?.({
              attemptNumber,
              isRetry,
              willRetry: false,
              nextRetryDelayMS: undefined,
              nextRetryAt: undefined,
              status: 0,
              requestID,
              initialURL,
              ...(hopContext
                ? {
                    hopNumber: hopContext.hopNumber,
                    redirect: hopContext.redirect,
                  }
                : {}),
            });

            const signalReason = getSignalCancelReason(cancelSignal);
            return {
              adapterResponse: null,
              sentRequest: sentRequestForObservedAdapterError(
                sentRequest,
                error,
                observedSentRequest,
              ),
              attemptCount: attemptNumber,
              wasCancelled: true,
              wasTimeout: isTimedOut,
              isRetriesExhausted: false,
              ...(signalReason !== undefined
                ? { cancelReason: signalReason }
                : {}),
            };
          }

          const streamedAbort = getResponseStreamAbortInfo(error);

          if (isTimedOut && streamedAbort) {
            options.onAttemptEnd?.({
              attemptNumber,
              isRetry,
              willRetry: false,
              nextRetryDelayMS: undefined,
              nextRetryAt: undefined,
              status: streamedAbort.status,
              requestID,
              initialURL,
              ...(hopContext
                ? {
                    hopNumber: hopContext.hopNumber,
                    redirect: hopContext.redirect,
                  }
                : {}),
            });

            return {
              adapterResponse: {
                status: streamedAbort.status,
                headers: streamedAbort.headers,
                body: null,
                isStreamError: true,
                streamErrorCode: 'stream_response_error',
                errorCause: error,
                effectiveRequestHeaders:
                  getEffectiveRequestHeadersFromError(error),
              },
              sentRequest: sentRequestForObservedAdapterError(
                sentRequest,
                error,
                observedSentRequest,
              ),
              attemptCount: attemptNumber,
              wasCancelled: false,
              wasTimeout: true,
              isRetriesExhausted: false,
              errorCode: 'stream_response_error',
              adapterCause: error,
            };
          }

          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: streamedAbort?.status ?? 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          return {
            adapterResponse: {
              status: streamedAbort?.status ?? 0,
              headers: streamedAbort?.headers ?? {},
              body: null,
              isStreamError: true,
              streamErrorCode: 'stream_response_error',
              errorCause: error,
              effectiveRequestHeaders:
                getEffectiveRequestHeadersFromError(error),
            },
            sentRequest: sentRequestForObservedAdapterError(
              sentRequest,
              error,
              observedSentRequest,
            ),
            attemptCount: attemptNumber,
            wasCancelled: false,
            wasTimeout: isTimedOut,
            isRetriesExhausted: false,
            errorCode: 'stream_response_error',
            adapterCause: error,
          };
        }

        if (isAbortError(error)) {
          // User/parent cancellation — never retry (even if a timeout fired in the same window).
          if (cancelSignal.aborted) {
            options.onAttemptEnd?.({
              attemptNumber,
              isRetry,
              willRetry: false,
              nextRetryDelayMS: undefined,
              nextRetryAt: undefined,
              status: 0,
              requestID,
              initialURL,
              ...(hopContext
                ? {
                    hopNumber: hopContext.hopNumber,
                    redirect: hopContext.redirect,
                  }
                : {}),
            });

            const signalReason = getSignalCancelReason(cancelSignal);
            return {
              adapterResponse: null,
              sentRequest,
              attemptCount: attemptNumber,
              wasCancelled: true,
              wasTimeout: isTimedOut,
              isRetriesExhausted: false,
              ...(signalReason !== undefined
                ? { cancelReason: signalReason }
                : {}),
            };
          }

          // Per-attempt timeout — fall through and reuse the same retry path as network errors.
          if (!isTimedOut) {
            // Check for a browser-fired XHR timeout (xhr.timeout = 0 but the browser
            // has its own hard limit). Treat it the same as our own timeout so it gets
            // retried and classified as isTimeout rather than isCancelled.
            if (isXHRBrowserTimeout(error)) {
              isTimedOut = true;
              // Fall through to the normal timeout retry path below.
            } else {
              // AbortError without our timeout flag — treat as non-retryable cancel.
              // This path includes StreamResponseFactory returning null / { cancel: true }.
              const factoryCancelValue =
                error !== null &&
                typeof error === 'object' &&
                STREAM_FACTORY_CANCEL_KEY in error
                  ? (error as Record<string, unknown>)[
                      STREAM_FACTORY_CANCEL_KEY
                    ]
                  : undefined;
              const factoryCancelReason =
                typeof factoryCancelValue === 'string'
                  ? factoryCancelValue
                  : undefined;

              options.onAttemptEnd?.({
                attemptNumber,
                isRetry,
                willRetry: false,
                nextRetryDelayMS: undefined,
                nextRetryAt: undefined,
                status: 0,
                requestID,
                initialURL,
                ...(hopContext
                  ? {
                      hopNumber: hopContext.hopNumber,
                      redirect: hopContext.redirect,
                    }
                  : {}),
              });

              return {
                adapterResponse: null,
                sentRequest,
                attemptCount: attemptNumber,
                wasCancelled: true,
                wasTimeout: false,
                isRetriesExhausted: false,
                ...(factoryCancelReason !== undefined
                  ? { cancelReason: factoryCancelReason }
                  : {}),
              };
            }
          }
        }

        const didTimeoutThisAttempt = isAbortError(error) && isTimedOut;
        const isNonRetryableClientCallbackFailure =
          isNonRetryableClientCallbackError(error);

        if (isNonRetryableClientCallbackFailure) {
          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          const isStreamFactoryError =
            isStreamFactoryClientCallbackError(error);

          return {
            adapterResponse: null,
            sentRequest: sentRequestForNonRetryableAdapterCallbackError(
              sentRequest,
              error,
              observedSentRequest,
            ),
            attemptCount: attemptNumber,
            wasCancelled: false,
            wasTimeout: didTimeoutThisAttempt,
            isRetriesExhausted: false,
            errorCode: isStreamFactoryError
              ? 'stream_setup_error'
              : 'interceptor_error',
            adapterCause:
              error instanceof Error ? error : new Error(String(error)),
          };
        }

        // Network / adapter / per-attempt timeout — retry if policy allows
        if (policy && !cancelSignal.aborted) {
          const { shouldRetry, delayMS } = policy.shouldRetry(
            error instanceof Error ? error : new Error(String(error)),
          );
          const nextRetryAt = shouldRetry ? Date.now() + delayMS : undefined;

          if (shouldRetry) {
            callbacks.setNextRetryDelayMS(delayMS);
            callbacks.setNextRetryAt(nextRetryAt ?? null);
            callbacks.setState('waiting_for_retry');
          }

          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: shouldRetry,
            nextRetryDelayMS: shouldRetry ? delayMS : undefined,
            nextRetryAt,
            status: 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });

          if (shouldRetry) {
            const failedAttemptResponse = this._buildResponse({
              adapterResponse: null,
              requestID,
              wasCancelled: false,
              wasTimeout: didTimeoutThisAttempt,
              adapterType: this._adapter.getType(),
              initialURL,
              requestURL: sentRequest.requestURL,
              redirectHistory,
              isNetworkErrorOverride: false,
            });

            const retryError = this._makeError(
              failedAttemptResponse,
              requestID,
              false,
              'adapter_error',
              error instanceof Error ? error : new Error(String(error)),
            );

            await this._runErrorObservers(
              retryError,
              sentRequest,
              this._retryOutcomePhase(
                policy,
                attemptNumber,
                hopContext?.redirect,
              ),
            );

            await this._cancellableDelay(delayMS, cancelSignal);

            if (cancelSignal.aborted) {
              const signalReason = getSignalCancelReason(cancelSignal);
              return {
                adapterResponse: null,
                sentRequest,
                attemptCount: attemptNumber,
                wasCancelled: true,
                wasTimeout: false,
                isRetriesExhausted: false,
                ...(signalReason !== undefined
                  ? { cancelReason: signalReason }
                  : {}),
              };
            }

            continue;
          }

          isRetriesExhausted = true;
        } else {
          options.onAttemptEnd?.({
            attemptNumber,
            isRetry,
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
            requestID,
            initialURL,
            ...(hopContext
              ? {
                  hopNumber: hopContext.hopNumber,
                  redirect: hopContext.redirect,
                }
              : {}),
          });
        }

        return {
          adapterResponse: null,
          sentRequest,
          attemptCount: attemptNumber,
          wasCancelled: false,
          wasTimeout: didTimeoutThisAttempt,
          isRetriesExhausted,
          errorCode: 'adapter_error',
          adapterCause:
            error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  }

  /**
   * Delay that resolves early when the cancel signal fires.
   * Only wired to cancelSignal (user cancel / cancelAll) — the per-attempt
   * timeout does NOT cancel retry delays.
   * Cleans up both the timer and the abort listener to avoid leaks.
   */
  private _cancellableDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(id);
        resolve();
      };

      const id = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private _buildResponse<T>(params: {
    adapterResponse: AdapterResponse | null;
    requestID: string;
    wasCancelled: boolean;
    wasTimeout: boolean;
    adapterType: AdapterType;
    initialURL: string;
    requestURL: string;
    redirectHistory: string[];
    isNetworkErrorOverride?: boolean;
  }): HTTPResponse<T> {
    const {
      adapterResponse,
      requestID,
      wasCancelled,
      wasTimeout,
      adapterType,
      initialURL,
      requestURL,
      redirectHistory,
      isNetworkErrorOverride,
    } = params;

    const wasRedirectFollowed = redirectHistory.length > 0;
    const wasRedirectDetected =
      wasRedirectFollowed || (adapterResponse?.wasRedirectDetected ?? false);
    const detectedRedirectURL = adapterResponse?.detectedRedirectURL;

    if (!adapterResponse) {
      return {
        status: 0,
        headers: {},
        body: null as unknown as T,
        contentType: 'binary',
        isJSON: false,
        isText: false,
        isCancelled: wasCancelled,
        isTimeout: wasTimeout,
        isNetworkError:
          isNetworkErrorOverride ?? (!wasCancelled && !wasTimeout),
        isFailed: true,
        isParseError: false,
        isStreamed: false,
        isStreamError: false,
        initialURL,
        requestURL,
        wasRedirectDetected,
        wasRedirectFollowed,
        detectedRedirectURL,
        redirectHistory,
        requestID,
        adapterType,
      };
    }

    if (
      (adapterResponse.isTransportError || adapterResponse.status === 0) &&
      !adapterResponse.isStreamError
    ) {
      return {
        status: adapterResponse.status,
        headers: adapterResponse.headers,
        body: null as unknown as T,
        contentType: 'binary',
        isJSON: false,
        isText: false,
        isCancelled: false,
        isTimeout: false,
        isNetworkError: isNetworkErrorOverride ?? true,
        isFailed: true,
        isParseError: false,
        isStreamed: false,
        isStreamError: false,
        initialURL,
        requestURL,
        wasRedirectDetected,
        wasRedirectFollowed,
        detectedRedirectURL,
        redirectHistory,
        requestID,
        adapterType,
      };
    }

    // Response-body failure after headers: the server returned a real HTTP
    // response, so we
    // preserve its status and headers on HTTPResponse, but the request must
    // still follow the failed/error path because the body could not be fully
    // delivered to the caller's sink. Callers should treat isStreamError /
    // builder.error as authoritative for success, not the preserved status.
    if (adapterResponse.isStreamError) {
      return {
        status: adapterResponse.status,
        headers: adapterResponse.headers,
        body: null as unknown as T,
        contentType: 'binary',
        isJSON: false,
        isText: false,
        isCancelled: false,
        isTimeout: wasTimeout,
        isNetworkError: false,
        isFailed: true,
        isParseError: false,
        isStreamed: false,
        isStreamError: true,
        initialURL,
        requestURL,
        wasRedirectDetected,
        wasRedirectFollowed,
        detectedRedirectURL,
        redirectHistory,
        requestID,
        adapterType,
      };
    }

    // Successful stream: body was piped to the caller's writable. Nothing to
    // parse — body is null. Status and headers are still fully populated.
    // `contentType` stays `binary` intentionally here: in this client it tracks
    // how the response body was materialized for callers, and streamed bodies
    // are never decoded into text/JSON at this layer.
    if (adapterResponse.isStreamed) {
      return {
        status: adapterResponse.status,
        headers: adapterResponse.headers,
        body: null as unknown as T,
        contentType: 'binary',
        isJSON: false,
        isText: false,
        isCancelled: false,
        isTimeout: false,
        isNetworkError: false,
        isFailed: false,
        isParseError: false,
        isStreamed: true,
        isStreamError: false,
        initialURL,
        requestURL,
        wasRedirectDetected,
        wasRedirectFollowed,
        detectedRedirectURL,
        redirectHistory,
        requestID,
        adapterType,
      };
    }

    const contentTypeHeader = scalarHeader(
      adapterResponse.headers,
      'content-type',
    );
    const contentType = parseContentType(contentTypeHeader);

    let body: unknown = adapterResponse.body;
    let isJSON = false;
    let isText = false;
    let isParseError = false;
    let decodedTextBody: string | null = null;

    if (
      (contentType === 'json' || contentType === 'text') &&
      adapterResponse.body
    ) {
      decodedTextBody = new TextDecoder().decode(adapterResponse.body);
    }

    if (contentType === 'json' && decodedTextBody !== null) {
      try {
        body = JSON.parse(decodedTextBody);
        isJSON = true;
      } catch {
        isParseError = true;
        body = decodedTextBody;
      }
    } else if (contentType === 'text') {
      isText = true;
      body = decodedTextBody;
    }

    return {
      status: adapterResponse.status,
      headers: adapterResponse.headers,
      body: body as T,
      contentType,
      isJSON,
      isText,
      isCancelled: false,
      isTimeout: false,
      isNetworkError: false,
      isFailed: false,
      isParseError,
      isStreamed: false,
      isStreamError: false,
      initialURL,
      requestURL,
      wasRedirectDetected,
      wasRedirectFollowed,
      detectedRedirectURL,
      redirectHistory,
      requestID,
      adapterType,
    };
  }

  /**
   * Build an HTTPClientError from a failed response.
   *
   * Error code priority:
   * 1. Explicit codeOverride (redirect_disabled, redirect_loop, request_setup_error, adapter_error, stream_write_error, stream_response_error, stream_setup_error)
   * 2. Response flags (isCancelled → cancelled, isTimeout → timeout),
   *    except streamed-body failures preserve their specific stream_* code while
   *    still surfacing `isTimeout: true`
   * 3. Default fallback → network_error
   *
   * Key distinction:
   * - `adapter_error`: Adapter threw an exception (DNS failure, connection refused, etc.)
   *   The adapter failed to handle the error gracefully.
   * - `network_error`: Adapter reported a transport-level failure cleanly via
   *   `isTransportError`, or returned `status: 0` to indicate a transport
   *   failure.
   *
   * Well-behaved adapters should catch their own transport failures and return
   * an AdapterResponse instead of throwing. Prefer `isTransportError: true`
   * when reporting adapter-originated transport failures. If an adapter
   * throws, that's an adapter implementation problem.
   */
  private _makeError(
    response: HTTPResponse,
    requestID: string,
    isRetriesExhausted: boolean,
    codeOverride?: HTTPClientError['code'],
    cause?: Error,
    cancelReason?: string,
  ): HTTPClientError {
    let code: HTTPClientError['code'] = codeOverride ?? 'network_error';
    let message = 'Network error';

    const isSpecificStreamCodePreserved =
      code === 'stream_write_error' ||
      code === 'stream_response_error' ||
      code === 'stream_setup_error';

    if (response.isCancelled) {
      code = 'cancelled';
      message = 'Request was cancelled';
    } else if (response.isTimeout && !isSpecificStreamCodePreserved) {
      code = 'timeout';
      message = 'Request timed out';
    } else if (code === 'redirect_disabled') {
      message = 'Redirect encountered while redirects are disabled';
    } else if (code === 'redirect_loop') {
      message = 'Redirect limit exceeded';
    } else if (code === 'request_setup_error') {
      message = 'Request setup failed';
    } else if (code === 'adapter_error') {
      message = 'Adapter error';
    } else if (code === 'interceptor_error') {
      message = 'Interceptor error';
    } else if (code === 'stream_write_error') {
      message = 'Response stream write failed';
    } else if (code === 'stream_response_error') {
      message = 'Response download stream failed';
    } else if (code === 'stream_setup_error') {
      message = 'Stream response setup failed';
    }

    return {
      code,
      message,
      cause,
      initialURL: response.initialURL,
      requestURL: response.requestURL,
      wasRedirectDetected: response.wasRedirectDetected,
      wasRedirectFollowed: response.wasRedirectFollowed,
      detectedRedirectURL: response.detectedRedirectURL,
      redirectHistory: response.redirectHistory,
      requestID,
      isTimeout: response.isTimeout,
      isRetriesExhausted,
      ...(cancelReason !== undefined ? { cancelReason } : {}),
    };
  }

  /**
   * Runs parent + own interceptor chains in order.
   * Returns the (possibly modified) request, or an InterceptorCancel signal.
   */
  private async _runInterceptors(
    request: InterceptedRequest,
    phase: InterceptorPhase,
    context: RequestInterceptorContext,
  ): Promise<InterceptedRequest | InterceptorCancel> {
    let current: InterceptedRequest | InterceptorCancel = request;

    if (this._parentClient) {
      current = await this._parentClient._requestInterceptors.run(
        request,
        phase,
        context,
      );

      if ('cancel' in current) {
        return current;
      }
    }

    return this._requestInterceptors.run(current, phase, context);
  }

  /**
   * Phase for an attempt outcome that will be retried (before the retry delay).
   * `attempt` matches `onAttemptEnd.attemptNumber` for that outcome.
   */
  private _retryOutcomePhase(
    policy: RetryPolicy | null,
    completedAttemptNumber: number,
    redirect?: RedirectHopInfo,
  ): Extract<ResponseObserverPhase, { type: 'retry' }> {
    const maxAttempts = policy
      ? policy.maxRetryAttempts + 1
      : completedAttemptNumber;

    return redirect !== undefined
      ? {
          type: 'retry',
          attempt: completedAttemptNumber,
          maxAttempts,
          redirect,
        }
      : {
          type: 'retry',
          attempt: completedAttemptNumber,
          maxAttempts,
        };
  }

  private _withInternalRequestHeaders(
    headers: Record<string, string | string[]>,
    requestID: string,
    attemptNumber?: number,
  ): Record<string, string | string[]> {
    const nextHeaders = mergeHeaders(headers);

    if (this._config.includeRequestID) {
      nextHeaders[DEFAULT_REQUEST_ID_HEADER] = requestID;
    }

    if (attemptNumber !== undefined && this._config.includeAttemptHeader) {
      nextHeaders[DEFAULT_REQUEST_ATTEMPT_HEADER] = String(attemptNumber);
    }

    return nextHeaders;
  }

  private _buildAttemptRequest(
    request: InterceptedRequest,
    params: {
      requestID: string;
      timeout: number;
      attemptNumber?: number;
      cookieJar?: CookieJar | null;
    },
  ): AttemptRequest {
    const { requestID, timeout, attemptNumber, cookieJar } = params;

    // Build the finalized attempt snapshot before adapter-specific transport
    // materialization. Header names are normalized to lowercase here, and adapters
    // may further materialize repeated header values at send time.
    const observedBodies = buildObservedAttemptBodies(request.body);
    const { contentType } = observedBodies;
    const headers = this._withInternalRequestHeaders(
      request.headers,
      requestID,
      attemptNumber,
    );

    // Preserve an explicit content-type from interceptors/callers; otherwise
    // infer one from the serialized body shape.
    if (contentType && headers['content-type'] === undefined) {
      headers['content-type'] = contentType;
    }

    // When a jar is present it is authoritative for outbound cookies on every
    // attempt, including redirects and retries.
    if (cookieJar) {
      const cookieStr = cookieJar.getCookieHeaderString(request.requestURL);

      if (cookieStr) {
        headers.cookie = cookieStr;
      } else {
        delete headers.cookie;
      }
    }

    return {
      requestURL: request.requestURL,
      method: request.method,
      headers,
      body: observedBodies.body,
      rawBody: observedBodies.rawBody,
      timeout,
      attemptNumber,
      requestID,
    };
  }

  private _bestEffortAttemptRequestFromPending(
    request: InterceptedRequest,
    timeout: number,
    requestID: string,
  ): AttemptRequest {
    // Best-effort snapshot for observers when a request fails before any adapter
    // attempt is dispatched (interceptor throw, pre-send cancel, setup error, etc.).
    // Jar cookies and internal headers (x-local-client-request-id, x-local-client-request-attempt) are omitted
    // intentionally — they are applied at dispatch time, and since no attempt ever
    // went out, including them would be misleading. Unsupported body types are caught
    // and swallowed here; the real error is reported via request_setup_error instead.
    const headers = mergeHeaders(request.headers);
    let clonedBodies: Pick<AttemptRequest, 'body' | 'rawBody'>;

    try {
      clonedBodies = buildObservedAttemptBodies(request.body);
    } catch {
      clonedBodies = {
        body: null,
        rawBody: request.body,
      };
    }

    return {
      requestURL: request.requestURL,
      method: request.method,
      headers,
      body: clonedBodies.body,
      rawBody: clonedBodies.rawBody,
      timeout,
      requestID,
    };
  }

  private async _runResponseObservers(
    response: HTTPResponse,
    request: AttemptRequest,
    phase: ResponseObserverPhase,
  ): Promise<void> {
    if (this._parentClient) {
      await this._parentClient._responseObservers.run(response, request, phase);
    }

    await this._responseObservers.run(response, request, phase);
  }

  private async _runErrorObservers(
    error: HTTPClientError,
    request: AttemptRequest,
    phase: ErrorObserverPhase,
  ): Promise<void> {
    if (this._parentClient) {
      await this._parentClient._errorObservers.run(error, request, phase);
    }

    await this._errorObservers.run(error, request, phase);
  }

  private _composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([a, b]);
    }

    const controller = new AbortController();
    const abort = (signal: AbortSignal) => controller.abort(signal.reason);

    if (a.aborted) {
      abort(a);
    } else if (b.aborted) {
      abort(b);
    } else {
      a.addEventListener('abort', () => abort(a), { once: true });
      b.addEventListener('abort', () => abort(b), { once: true });
    }

    return controller.signal;
  }

  private _assertRequestIsSupported(request: InterceptedRequest): void {
    assertSupportedRequestBody(request.body);

    if (
      this._isBrowserRuntime &&
      (this._adapter.getType() === 'fetch' || this._adapter.getType() === 'xhr')
    ) {
      assertNoBrowserRestrictedHeaders(
        request.headers,
        this._adapter.getType() === 'fetch' ? 'FetchAdapter' : 'XHR adapter',
      );
    }
  }

  private _assertInterceptorResolvedURL(requestURL: string): void {
    if (this._isSupportedRequestURL(requestURL)) {
      return;
    }

    throw new Error(
      `[HTTPClient] Interceptor rewrote requestURL to a value that could not be resolved to an absolute http(s) URL: "${requestURL}".`,
    );
  }

  private _isSupportedRequestURL(requestURL: string): boolean {
    try {
      const url = new URL(requestURL);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return this._adapter.getType() === 'mock' && !requestURL.startsWith('//');
    }
  }
}

export class HTTPClient extends BaseHTTPClient {
  constructor(config: HTTPClientConfig = {}) {
    super(config);
  }

  /**
   * Creates a sub-client that inherits this client's config, request tracker,
   * and interceptor/observer chain integration.
   *
   * `defaultHeaders` use `'replace'` behavior by default. Set
   * `defaultHeadersStrategy: 'merge'` to preserve inherited defaults and
   * layer new headers on top.
   *
   * If no new `defaultHeaders` are provided, `'merge'` keeps the inherited defaults as-is,
   * which is useful for sub-clients that only swap adapters or other non-header config.
   */
  public createSubClient(overrides: SubClientConfig = {}): BaseHTTPClient {
    return new BaseHTTPClient(this._buildSubClientConfig(overrides), {
      tracker: this._tracker,
      parentClient: this,
    });
  }
}

function buildObservedAttemptBodies(
  rawBody: unknown,
): Pick<AttemptRequest, 'body' | 'rawBody'> & { contentType: string | null } {
  // Validate before cloning so unsupported object-like values (URLSearchParams,
  // Blob, etc.) fail explicitly instead of being deep-cloned into `{}`.
  assertSupportedRequestBody(rawBody);
  const rawBodySnapshot = cloneBodyValue(rawBody);
  const { body, contentType } = serializeBody(rawBodySnapshot);

  return {
    body,
    rawBody: rawBodySnapshot,
    contentType,
  };
}

function cloneBodyValue(body: unknown): unknown {
  if (body instanceof FormData) {
    const cloned = new FormData();

    for (const [key, value] of body.entries()) {
      cloned.append(key, value);
    }

    return cloned;
  } else if (body instanceof Uint8Array) {
    return new Uint8Array(body);
  } else if (
    Array.isArray(body) ||
    (body !== null &&
      typeof body === 'object' &&
      (Object.getPrototypeOf(body) === Object.prototype ||
        Object.getPrototypeOf(body) === null))
  ) {
    return deepClone(body);
  }

  return body;
}

function isAbortError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * When `adapter.send()` rejects before resolving (e.g. stream factory throw),
 * adapters may still attach `effectiveRequestHeaders` on the error so observers
 * see the same merged headers as on a successful `AdapterResponse`.
 */
function sentRequestForNonRetryableAdapterCallbackError(
  sentRequest: AttemptRequest,
  error: unknown,
  observedAfterAdapterResolve: AttemptRequest,
): AttemptRequest {
  return sentRequestForObservedAdapterError(
    sentRequest,
    error,
    observedAfterAdapterResolve,
  );
}

function isNonRetryableClientCallbackError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === 'object' &&
    NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG in err &&
    (
      err as Record<
        typeof NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
        boolean | undefined
      >
    )[NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG] === true,
  );
}

function isStreamFactoryClientCallbackError(err: unknown): boolean {
  return (
    err !== null && typeof err === 'object' && STREAM_FACTORY_ERROR_FLAG in err
  );
}

function sentRequestForObservedAdapterError(
  sentRequest: AttemptRequest,
  error: unknown,
  observedAfterAdapterResolve: AttemptRequest,
): AttemptRequest {
  const eff = getEffectiveRequestHeadersFromError(error);

  if (!eff) {
    return observedAfterAdapterResolve;
  }

  return {
    ...sentRequest,
    headers: mergeObservedHeaders(sentRequest.headers, eff),
  };
}

function getEffectiveRequestHeadersFromError(
  error: unknown,
): Record<string, string | string[]> | undefined {
  if (
    error &&
    typeof error === 'object' &&
    'effectiveRequestHeaders' in error &&
    (error as { effectiveRequestHeaders?: unknown }).effectiveRequestHeaders
  ) {
    return (
      error as {
        effectiveRequestHeaders: Record<string, string | string[]>;
      }
    ).effectiveRequestHeaders;
  }

  return undefined;
}

function isResponseStreamAbortError(err: unknown): boolean {
  return (
    err !== null && typeof err === 'object' && RESPONSE_STREAM_ABORT_FLAG in err
  );
}

function isXHRBrowserTimeout(err: unknown): boolean {
  return (
    err !== null && typeof err === 'object' && XHR_BROWSER_TIMEOUT_FLAG in err
  );
}

function getResponseStreamAbortInfo(
  err: unknown,
): { status: number; headers: Record<string, string | string[]> } | undefined {
  if (
    !err ||
    typeof err !== 'object' ||
    !('streamAbortStatus' in err) ||
    !('streamAbortHeaders' in err)
  ) {
    return undefined;
  }

  const status = (err as { streamAbortStatus?: unknown }).streamAbortStatus;
  const headers = (err as { streamAbortHeaders?: unknown }).streamAbortHeaders;

  if (typeof status !== 'number' || !headers || typeof headers !== 'object') {
    return undefined;
  }

  return {
    status,
    headers: headers as Record<string, string | string[]>,
  };
}

/**
 * Returns the AbortSignal's reason as a string if the caller explicitly passed
 * one (e.g. `controller.abort('my reason')`). Returns undefined for the default
 * AbortError reason set by the runtime when no explicit reason is provided.
 */
function getSignalCancelReason(signal: AbortSignal): string | undefined {
  return typeof signal.reason === 'string' ? signal.reason : undefined;
}
