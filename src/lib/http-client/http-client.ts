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
  assertSupportedRequestBody,
  buildURL,
  isBrowserEnvironment,
  mergeHeaders,
  normalizeAdapterResponseHeaders,
  parseContentType,
  resolveAbsoluteURL,
  scalarHeader,
  serializeBody,
} from './utils';
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_REQUEST_ID_HEADER,
  DEFAULT_REQUEST_ATTEMPT_HEADER,
  DEFAULT_USER_AGENT,
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
      includeRequestID: config.includeRequestID ?? true,
      includeAttemptHeader: config.includeAttemptHeader ?? false,
      userAgent: config.userAgent,
      followRedirects: config.followRedirects ?? false,
      maxRedirects: config.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    };

    this._requestInterceptors = new RequestInterceptorManager();
    this._responseObservers = new ResponseObserverManager();
    this._errorObservers = new ErrorObserverManager();
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

  public cancel(requestID: string): void {
    this._tracker.cancel(requestID);
  }

  public cancelAll(): void {
    this._tracker.cancelAll();
  }

  public cancelOwn(): void {
    this._tracker.cancelOwn(this._clientID);
  }

  public cancelAllWithLabel(label: string): void {
    this._tracker.cancelAllWithLabel(label);
  }

  public cancelOwnWithLabel(label: string): void {
    this._tracker.cancelOwnWithLabel(this._clientID, label);
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

    const { method, path, options, callbacks } = ctx;
    const requestID = generateID('ulid');

    // Wire up builder state
    callbacks.setRequestID(requestID);
    callbacks.setState('sending');

    // buildURL: relative path + baseURL, OR absolute http(s) / //host path unchanged
    const url = resolveAbsoluteURL(
      buildURL(this._config.baseURL, path, options.params),
      this._config.baseURL,
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
    } else if (adapterType === 'node' || adapterType === 'mock') {
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

      const error = this._makeError(response, requestID, false);
      callbacks.setError(error);
      callbacks.setState('cancelled');
      await this._runErrorObservers(
        error,
        this._bestEffortAttemptRequestFromPending(interceptedRequest, {
          timeout,
        }),
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
    trackedCallbacks.setCancelFn(() => {
      abortController.abort();
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
        {
          timeout,
        },
      );
      let errorCode: HTTPClientError['code'] | undefined;
      let adapterCause: Error | undefined;
      let isRetriesExhausted = false;
      let completedAttemptCount = 0;

      try {
        this._assertRequestIsSupported(interceptedRequest);

        // Run interceptors (initial phase)
        const initialPhase: InterceptorPhase = { type: 'initial' };
        let interceptResult: InterceptedRequest | InterceptorCancel;
        let initialRequestCandidate: InterceptedRequest = finalRequest;

        try {
          interceptResult = await this._runInterceptors(
            finalRequest,
            initialPhase,
            { initialURL: url, redirectHistory: [] },
          );

          if (!('cancel' in interceptResult)) {
            initialRequestCandidate = interceptResult;
            this._assertRequestIsSupported(interceptResult);
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
            this._bestEffortAttemptRequestFromPending(initialRequestCandidate, {
              timeout,
            }),
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

          const error = this._makeError(cancelledResponse, requestID, false);
          callbacks.setError(error);
          trackedCallbacks.setState('cancelled');

          await this._runErrorObservers(
            error,
            this._bestEffortAttemptRequestFromPending(finalRequest, {
              timeout,
            }),
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

          callbacks.setAttemptCount(attemptResult.attemptCount);
          observerRequest = attemptResult.sentRequest;

          if (
            !this._config.followRedirects &&
            adapterResponse &&
            REDIRECT_STATUS_CODES.has(adapterResponse.status)
          ) {
            response = this._buildResponse<T>({
              adapterResponse: null,
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

            // Method rewriting per HTTP spec (matches browser/fetch behaviour):
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
            // Chromium/fetch behaviour — Authorization, X-API-Key, etc. must not
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
                },
              );
              if (!('cancel' in redirectIntercept)) {
                failedRedirectRequest = redirectIntercept;
                this._assertRequestIsSupported(redirectIntercept);
              }
            } catch (error) {
              observerRequest = this._bestEffortAttemptRequestFromPending(
                failedRedirectRequest,
                { timeout },
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
                { timeout },
              );
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
                fromURL: attemptResult.sentRequest.requestURL,
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
          this._bestEffortAttemptRequestFromPending(interceptedRequest, {
            timeout,
          }),
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

      if (response.status === 0) {
        const error = this._makeError(
          response,
          requestID,
          isRetriesExhausted,
          // Set for adapter_error, interceptor_error, redirect_loop, etc.; otherwise network_error
          errorCode,
          adapterCause,
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

    let headers: Record<string, string>;

    if (isCrossOrigin) {
      const safeHeaders: Record<string, string> = {};
      // Cross-origin safety: strip ALL headers except CORS-safelisted ones
      // when the redirect crosses origins (scheme + host + port). Matches
      // Chromium/fetch behaviour — Authorization, X-API-Key, etc. must not
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

      // Per-attempt timeout controller — separate from the cancel signal
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
            { initialURL, redirectHistory },
          );
          if (!('cancel' in retryIntercept)) {
            failedRetryRequest = retryIntercept;
            this._assertRequestIsSupported(retryIntercept);
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
              {
                timeout,
              },
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
              {
                timeout,
              },
            ),
            attemptCount: attemptNumber,
            wasCancelled: true,
            wasTimeout: false,
            isRetriesExhausted: false,
          };
        }

        attemptRequest = retryIntercept;
      }

      const sentRequest = this._buildAttemptRequest(attemptRequest, {
        requestID,
        attemptNumber,
        cookieJar,
        timeout,
      });

      const onUploadProgress = options.onUploadProgress;
      const onDownloadProgress = options.onDownloadProgress;

      try {
        const rawAdapterResponse = await this._adapter.send({
          requestURL: sentRequest.requestURL,
          method: sentRequest.method,
          headers: { ...sentRequest.headers },
          body: sentRequest.body ?? null,
          timeout: 0, // timeout is managed at this level, not by the adapter
          signal: attemptSignal,
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

        clearTimeout(timeoutID);

        // Store Set-Cookie before retry/backoff so the next attempt matches browsers
        // and curl (cookies from error responses apply to follow-up requests).
        if (cookieJar) {
          cookieJar.processResponseHeaders(
            adapterResponse.headers,
            sentRequest.requestURL,
          );
        }

        if (adapterResponse.isOpaqueRedirect) {
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
            sentRequest,
            attemptCount: attemptNumber,
            wasCancelled: false,
            wasTimeout: false,
            isRetriesExhausted: false,
            errorCode: 'redirect_disabled',
          };
        }

        // Check if should retry based on status code
        if (
          policy &&
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
              sentRequest,
              this._retryOutcomePhase(
                policy,
                attemptNumber,
                hopContext?.redirect,
              ),
            );

            await this._cancellableDelay(delayMS, cancelSignal);

            if (cancelSignal.aborted) {
              return {
                adapterResponse: null,
                sentRequest,
                attemptCount: attemptNumber,
                wasCancelled: true,
                wasTimeout: false,
                isRetriesExhausted: false,
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

        return {
          adapterResponse,
          sentRequest,
          attemptCount: attemptNumber,
          wasCancelled: false,
          wasTimeout: false,
          isRetriesExhausted,
        };
      } catch (error) {
        clearTimeout(timeoutID);

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

            return {
              adapterResponse: null,
              sentRequest,
              attemptCount: attemptNumber,
              wasCancelled: true,
              wasTimeout: isTimedOut,
              isRetriesExhausted: false,
            };
          }

          // Per-attempt timeout — fall through and reuse the same retry path as network errors.
          if (!isTimedOut) {
            // AbortError without our timeout flag (unexpected) — treat as non-retryable cancel.
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
            };
          }
        }

        const didTimeoutThisAttempt = isAbortError(error) && isTimedOut;

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
              return {
                adapterResponse: null,
                sentRequest,
                attemptCount: attemptNumber,
                wasCancelled: true,
                wasTimeout: false,
                isRetriesExhausted: false,
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

    const isRedirected = redirectHistory.length > 0;

    if (!adapterResponse || adapterResponse.status === 0) {
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
        isParseError: false,
        initialURL,
        requestURL,
        redirected: isRedirected,
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
      isParseError,
      initialURL,
      requestURL,
      redirected: isRedirected,
      redirectHistory,
      requestID,
      adapterType,
    };
  }

  /**
   * Build an HTTPClientError from a failed response.
   *
   * Error code priority:
   * 1. Explicit codeOverride (redirect_disabled, redirect_loop, request_setup_error, adapter_error)
   * 2. Response flags (isCancelled → cancelled, isTimeout → timeout)
   * 3. Default fallback → network_error
   *
   * Key distinction:
   * - `adapter_error`: Adapter threw an exception (DNS failure, connection refused, etc.)
   *   The adapter failed to handle the error gracefully.
   * - `network_error`: Adapter returned status: 0 cleanly (network issue, but adapter
   *   handled it properly by returning a valid AdapterResponse).
   *
   * Well-behaved adapters should catch their own errors and return { status: 0 } for
   * network issues. If an adapter throws, that's an adapter implementation problem.
   */
  private _makeError(
    response: HTTPResponse,
    requestID: string,
    isRetriesExhausted: boolean,
    codeOverride?: HTTPClientError['code'],
    cause?: Error,
  ): HTTPClientError {
    let code: HTTPClientError['code'] = codeOverride ?? 'network_error';
    let message = 'Network error';

    if (response.isCancelled) {
      code = 'cancelled';
      message = 'Request was cancelled';
    } else if (response.isTimeout) {
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
    }

    return {
      code,
      message,
      cause,
      initialURL: response.initialURL,
      requestURL: response.requestURL,
      redirected: response.redirected,
      redirectHistory: response.redirectHistory,
      requestID,
      isTimeout: response.isTimeout,
      isRetriesExhausted,
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
    headers: Record<string, string>,
    requestID: string,
    attemptNumber?: number,
  ): Record<string, string> {
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

    // Build the finalized request for this attempt in the exact form the
    // adapter will send for this attempt. Header names are normalized to lowercase.
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
    };
  }

  private _bestEffortAttemptRequestFromPending(
    request: InterceptedRequest,
    params: {
      timeout: number;
    },
  ): AttemptRequest {
    const { timeout } = params;
    // Best-effort snapshot for observers on failures before dispatch. This uses
    // the same serialization rules, but skips internal request headers and jar cookies
    // because no concrete attempt was materialized. Unsupported body types should
    // not escape as uncaught errors here; they are reported by the main
    // request_setup_error path instead.
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
    const abort = () => controller.abort();

    if (a.aborted || b.aborted) {
      controller.abort();
    } else {
      a.addEventListener('abort', abort, { once: true });
      b.addEventListener('abort', abort, { once: true });
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function assertSupportedAdapterRuntimeAndConfig(
  config: HTTPClientConfig,
  adapterType: AdapterType,
  isBrowserRuntime: boolean,
): void {
  if (config.followRedirects === false && config.maxRedirects !== undefined) {
    throw new Error(
      'HTTPClient maxRedirects cannot be set when followRedirects is false.',
    );
  }

  if (
    config.followRedirects !== false &&
    config.maxRedirects !== undefined &&
    config.maxRedirects < 1
  ) {
    throw new Error(
      'HTTPClient maxRedirects must be greater than or equal to 1 when followRedirects is true.',
    );
  }

  if (!isBrowserRuntime) {
    return;
  }

  if (adapterType === 'node') {
    throw new Error(
      'HTTPClient Node adapter is not supported in browser environments.',
    );
  }

  if ((adapterType === 'fetch' || adapterType === 'xhr') && config.cookieJar) {
    throw new Error(
      `HTTPClient cookieJar is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHR adapter'} in browser environments. Browsers manage cookies automatically.`,
    );
  }

  if ((adapterType === 'fetch' || adapterType === 'xhr') && config.userAgent) {
    throw new Error(
      `HTTPClient userAgent is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHR adapter'} in browser environments. Browsers do not allow overriding the User-Agent header.`,
    );
  }

  if (
    (adapterType === 'fetch' || adapterType === 'xhr') &&
    config.followRedirects === true
  ) {
    throw new Error(
      `HTTPClient redirect handling is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHR adapter'} in browser environments. Set followRedirects: false or use a server runtime.`,
    );
  }
}
