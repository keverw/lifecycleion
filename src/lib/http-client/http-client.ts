import { normalizeStandardMethod } from './internal/http-method';
import {
  asciiLowercase,
  asciiUppercase,
  isBlankText,
  trimEndWhere,
} from '../internal/ascii-text';
import { isSignalAbortedQuietly } from './internal/request-fields';
import { isAbortError } from './internal/adapter-error';
import { defineEntry } from '../internal/define-entry';
import { isNullish } from '../internal/is-nullish';
import { describeValue } from '../internal/describe-value';
import {
  assertOptionalHeaderRecord,
  isPlainRecord,
} from './internal/plain-record';
import { clampTimerDelayMS } from '../internal/timer-limits';
import { generateID } from '../id-helpers';
import { safeHandleCallback } from '../safe-handle-callback';
import { reportToHost } from '../internal/report-to-host';
import { guardAbortListeners } from '../internal/guarded-abort-signal';
import { RetryPolicy } from '../retry-utils';
import { FetchAdapter } from './adapters/fetch-adapter';
import {
  assertNoBrowserRestrictedHeaders,
  copyHeaderRecord,
  lowerCaseHeaderName,
  presentHeaderValue,
} from './internal/header-utils';
import {
  RequestTracker,
  cancelEntry,
  cancelTrackedRequest,
} from './request-tracker';
import type { RequestInfo, TrackedRequest } from './request-tracker';
import { HTTPRequestBuilder } from './http-request-builder';
import {
  RequestInterceptorManager,
  isInterceptorCancel,
  snapshotInterceptedRequest,
} from './interceptors';
import type { ResolvedRequest } from './interceptors';
import {
  ResponseObserverManager,
  ErrorObserverManager,
  runParentThenOwnObservers,
} from './observers';
import {
  assertSupportedAdapterRuntimeAndConfig,
  assertSupportedRequestBody,
  buildURL,
  extractHostname,
  isAbsoluteWebURL,
  isBrowserEnvironment,
  isCrossOrigin,
  mergeObservedHeaders,
  mergeHeaders,
  normalizeMergedHeaderValue,
  describeInvalidHTTPMethod,
  isRequestBodyBytes,
  normalizeAdapterResponseHeaders,
  isAdapterHeaderValue,
  parseContentType,
  resolveAbsoluteURLForRuntime,
  reportedRedirectTarget,
  derivedRedirectFields,
  detectedRedirectTarget,
  type AdapterRedirectFields,
  scalarHeader,
  serializeBody,
  stripURLCredentials,
} from './utils';
import {
  resolveRequestTimeoutMS,
  resolveMaxResponseBytes,
  ADAPTER_TYPES,
  DEFAULT_REQUEST_ID_HEADER,
  DEFAULT_REQUEST_ATTEMPT_HEADER,
  DEFAULT_USER_AGENT,
  MOCK_ADAPTER_DEFAULT_BASE_URL,
  BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES,
  NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
  EFFECTIVE_REQUEST_HEADERS_KEY,
  NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
  REQUEST_BODY_SETTLED_KEY,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_FACTORY_CANCEL_KEY,
  STREAM_ABORT_HEADERS_KEY,
  STREAM_ABORT_STATUS_KEY,
  STREAM_FACTORY_ERROR_FLAG,
  ADAPTER_ERROR_CARRIER_KEY,
  RESPONSE_DECODE_ERROR_KEY,
  XHR_BROWSER_TIMEOUT_FLAG,
  RETRYABLE_STATUS_CODES,
  IDEMPOTENT_METHODS,
  REDIRECT_STATUS_CODES,
  DEFAULT_MAX_REDIRECTS,
  UPLOAD_SOURCE_STALL_GRACE_MS,
} from './consts';
import type {
  AttemptEndEvent,
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
  AdapterRequest,
  AdapterResponse,
  HTTPAdapter,
  HTTPRequestOptions,
  RedirectHopInfo,
  InterceptorCancel,
  RequestInterceptorContext,
  SubClientConfig,
  InterceptorPhase,
  ResponseObserverPhase,
  ErrorObserverPhase,
  CancelResult,
} from './types';
import type {
  BuilderCallbacks,
  ResolvedBuilderOptions,
  BuilderSendContext,
} from './http-request-builder';
import type { RetryPolicyOptions } from '../retry-utils';
import type { CookieJar } from './cookie-jar';
// Shared error normalization preserves Error instances and wraps other thrown values.
// Non-Error values receive a "Non-error value thrown: <description>" message, with the
// original value retained on cause for consumers of the normalized error.
import { isErrorValue, toError as normalizeError } from '../to-error';
import { readUnknownMember as readObjectMember } from '../internal/read-member';
import {
  hasResponseBody,
  isAnsweredBodyOverLimit,
  makeResponseTooLargeError,
} from './internal/response-limit';
import { readBinaryByteLength } from '../internal/binary-view';
import { snapshotRetryPolicyOptions } from './internal/retry-policy-options';
import {
  cloneBodyValue,
  copiedJSONText,
  copyRequestBody,
  isCopySerializingToNothing,
  serializesToNothing,
} from './internal/request-body-copy';
import { isBuiltInNetworkSend } from './internal/built-in-adapter';
import { listenForUploadSourceWait } from './internal/upload-source-wait';
import { formEntries, isFormData } from './internal/form-entries';
import { assertKnownFields, fieldNames } from '../internal/known-fields';
import { copyArrayValue } from './internal/array-copy';
import {
  adoptPromise,
  adoptResult,
  UnreadableReturn,
} from '../internal/adopt-promise';
import {
  attachIntrinsicReactions,
  noop,
  observeRejection,
} from '../internal/promise-reactions';
import { isObjectLike } from '../internal/is-object-like';

type RemoveFn = () => void;

/** The response fields `_buildResponse` sets per branch; the rest are shared. */
type ResponseFields<T> = Pick<
  HTTPResponse<T>,
  | 'status'
  | 'headers'
  | 'body'
  | 'contentType'
  | 'isJSON'
  | 'isText'
  | 'isCancelled'
  | 'isTimeout'
  | 'isNetworkError'
  | 'isFailed'
  | 'isParseError'
  | 'isStreamed'
  | 'isStreamError'
>;

/** The refusals of a method the adapter cannot send (see `_assertRequestIsSupported`). */
const methodRefusals = new WeakSet<Error>();

/** Those of `methodRefusals` the GET and HEAD rule makes, which depend on the body too. */
const bodyMethodRefusals = new WeakSet<Error>();

function methodRefusal(message: string, isOfBody = false): Error {
  const error = new Error(message);
  methodRefusals.add(error);
  if (isOfBody) {
    bodyMethodRefusals.add(error);
  }
  return error;
}

/**
 * Whether a phase's failure is its body's, reported as `request_setup_error`, rather than
 * an interceptor's: a body the interceptors returned that could not be copied (see
 * `copyChainResultBody`) - unless the GET and HEAD rule refused it (see
 * `_copyChainResultBody`).
 */
function isBodyCopyFailure(copy: BodyCopyOutcome, error: unknown): boolean {
  return copy.didFail && !methodRefusals.has(error as Error);
}

/** How a phase's interceptor run ended; see `endInterceptorPhase`. */
type InterceptorPhaseEnd =
  | { isCancelled: false; request: ResolvedRequest }
  | { isCancelled: true; cancelReason: string | undefined };

/**
 * How a phase's interceptor run ends, read once the phase has its result: cancelled when
 * the chain answered a cancel or the request was cancelled - while the interceptors ran,
 * or while the phase copied and checked their result - and otherwise with the request to
 * send. `result` is `undefined` when that copy or check failed after the cancel landed,
 * which ends the phase as the cancel, not as the failure. Each phase reports a cancel
 * from the request it held before its interceptors ran. A `cancel()` made first - one
 * that answered `'cancelled'` - keeps its reason, or its lack of one, over an
 * interceptor's.
 */
function endInterceptorPhase(
  result: ResolvedRequest | InterceptorCancel | undefined,
  cancelSignal: AbortSignal,
): InterceptorPhaseEnd {
  if (cancelSignal.aborted) {
    return {
      isCancelled: true,
      cancelReason: getSignalCancelReason(cancelSignal),
    };
  }
  if (result === undefined || isInterceptorCancel(result)) {
    return { isCancelled: true, cancelReason: result?.reason };
  }
  return { isCancelled: false, request: result };
}

/** The headers carried across a cross-origin redirect (see `_sanitizeRedirectRequest`). */
const CROSS_ORIGIN_SAFE_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  // Not a credential, and with NodeAdapter's `decompress: false` the caller's own is what
  // asks for the encoding to save as sent; the adapter's own is never carried.
  'accept-encoding',
  'accept-language',
  'content-encoding',
  'content-language',
  'content-type',
  'user-agent',
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
]);

/**
 * The headers that describe a request body rather than the caller: dropped with the body
 * when a redirect hop drops it (see `_sanitizeRedirectRequest`), and restored with it
 * when a cross-origin hop's own body is (see `withoutAddedCrossOriginCredentials`).
 */
const BODY_DESCRIBING_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
]);

/** The `adapter_error` message when the caller's cookie jar threw on a response. */
const COOKIE_JAR_FAILURE_MESSAGE =
  'Cookie jar failed to process response headers';

/**
 * The upload outcome an attempt given up on with a body to send reports: the adapter that
 * ignored its abort never said what became of the body, so its fate is unknown.
 */
const ABANDONED_UPLOAD_MESSAGE =
  "The request body's upload outcome is unknown: the adapter did not settle after the attempt was aborted, and the client gave up on it";

/**
 * The adapter-answer fields read through the receiver when the answer does not own them
 * (a class instance's prototype getters). `headers`, `effectiveRequestHeaders` and
 * `requestBodySettled` are read on their own before these.
 */
const ADAPTER_RESPONSE_FIELDS = [
  'status',
  'body',
  'wasRedirectDetected',
  'detectedRedirectURL',
  'isTransportError',
  'isRetryable',
  'wasDefinitelyNotSent',
  'isStreamed',
  'isStreamError',
  'streamErrorCode',
  'errorCause',
] as const satisfies readonly (keyof AdapterResponse)[];

/** The adapter-answer flags typed `boolean`. */
const ADAPTER_RESPONSE_FLAGS = [
  'wasRedirectDetected',
  'isTransportError',
  'isRetryable',
  'wasDefinitelyNotSent',
  'isStreamed',
  'isStreamError',
] as const satisfies readonly (keyof AdapterResponse)[];

/** Status and headers of an answer whose reading then failed. */
interface AnsweredResponse extends AdapterRedirectFields {
  status: number;
  headers: Record<string, string | string[]>;
}

/**
 * The redirect fields of a response the adapter resolved, reported as the adapter gave
 * them - as for any healthy response, and every built-in adapter resolves them - whether
 * the response was then read, could not be decoded, or failed in the cookie jar.
 */
function adapterRedirectFields(
  adapterFields: AdapterRedirectFields,
): AdapterRedirectFields {
  const { wasRedirectDetected, detectedRedirectURL } = adapterFields;

  return {
    wasRedirectDetected: wasRedirectDetected ?? false,
    ...(detectedRedirectURL !== undefined ? { detectedRedirectURL } : {}),
  };
}

/**
 * The answer a request ends with at a redirect it does not follow (`redirect_disabled`,
 * `redirect_loop`): a synthetic status-0 response, so the redirect is still reported -
 * `wasRedirectDetected`, and `detectedRedirectURL` resolved from `Location` when the
 * adapter did not say (the field is optional for a custom adapter).
 */
function unfollowedRedirectAnswer(
  redirect: AdapterResponse,
  requestURL: string,
): AdapterResponse {
  return {
    status: 0,
    wasRedirectDetected: true,
    detectedRedirectURL:
      redirect.detectedRedirectURL ??
      derivedRedirectFields(requestURL, redirect.status, redirect.headers)
        .detectedRedirectURL,
    headers: {},
    body: null,
  };
}

interface InternalClientState {
  tracker?: RequestTracker;
  parentClient?: BaseHTTPClient | null;
  /**
   * The parent's adapter and the type it was checked as: a sub-client sharing that
   * adapter takes this type rather than reading `getType()` again, so parent and child
   * never treat one adapter as two types.
   */
  inheritedAdapter?: {
    adapter: NonNullable<HTTPClientConfig['adapter']>;
    type: AdapterType;
  };
}

export class BaseHTTPClient {
  protected _clientID: string;
  protected _config: Required<
    Pick<
      HTTPClientConfig,
      | 'timeout'
      | 'maxResponseBytes'
      | 'includeRequestID'
      | 'includeAttemptHeader'
      | 'followRedirects'
      | 'maxRedirects'
      | 'retryNonIdempotentMethods'
    >
  > &
    HTTPClientConfig & { timeout: number; maxResponseBytes: number };

  protected _adapter: NonNullable<HTTPClientConfig['adapter']>;
  /**
   * The adapter's `getType()`, read once, when the client is built: the type the config
   * was checked against is the one every request reads, and `adapterType` reports. A
   * custom adapter whose `getType` answers differently on each call could otherwise pass
   * the check as one type and dispatch as another, or disagree with itself mid-request.
   * A sub-client sharing its parent's adapter takes the parent's value instead
   * (`inheritedAdapter`), so the two never read that adapter as different types.
   */
  protected readonly _adapterType: AdapterType;
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
    // Read every documented field exactly once, then validate and keep that snapshot.
    // A getter can answer differently on each read, so validating one read and storing
    // another would let a value the checks never saw through - e.g. followRedirects: true
    // on the XHR adapter. See `snapshotClientConfigFields`.
    assertKnownFields(config, HTTP_CLIENT_CONFIG_FIELDS, 'HTTPClient config');
    const snapshot = snapshotClientConfigFields(config);
    assertOptionalHeaderRecord(
      snapshot.defaultHeaders,
      'HTTPClient defaultHeaders',
    );

    this._clientID = generateID('ulid');
    const adapterCandidate: unknown = snapshot.adapter;
    // An adapter by its two methods, said as the other options are, rather than as the
    // engine's `getType is not a function` from the call below or `send` on the first
    // request.
    if (
      !isNullish(adapterCandidate) &&
      (typeof adapterCandidate !== 'object' ||
        typeof readObjectMember(adapterCandidate, 'getType') !== 'function' ||
        typeof readObjectMember(adapterCandidate, 'send') !== 'function')
    ) {
      throw new TypeError(
        `HTTPClient adapter must be an object with getType() and send() methods (got ${describeValue(adapterCandidate)})`,
      );
    }
    this._adapter = snapshot.adapter ?? new FetchAdapter();
    const adapterType: unknown =
      internal.inheritedAdapter?.adapter === this._adapter
        ? internal.inheritedAdapter.type
        : this._adapter.getType();
    // One of the four, as the type has it: every adapter and runtime check below and per
    // request is keyed on it, so a custom adapter answering anything else - `'custom'`,
    // `undefined` - would otherwise be checked as none of them. Named by its type only:
    // the answer is the caller's.
    if (!ADAPTER_TYPES.has(adapterType as AdapterType)) {
      throw new TypeError(
        `HTTPClient adapter getType() must return 'fetch', 'xhr', 'node' or 'mock' (got ${describeValue(adapterType)})`,
      );
    }
    this._adapterType = adapterType as AdapterType;
    this._isBrowserRuntime = isBrowserEnvironment();
    assertSupportedAdapterRuntimeAndConfig(
      snapshot,
      this._adapterType,
      this._isBrowserRuntime,
    );
    this._tracker = internal.tracker ?? new RequestTracker();
    this._parentClient = internal.parentClient ?? null;
    const configuredRetryPolicy = snapshot.retryPolicy;

    this._config = {
      adapter: this._adapter,
      baseURL: snapshot.baseURL,
      // Copied, as `retryPolicy` is: names lowercased and unset values dropped, read
      // once here rather than on every request, so changing the object afterwards does
      // not reach this client - or its sub-clients, which would share it.
      defaultHeaders: mergeHeaders(snapshot.defaultHeaders ?? undefined),
      timeout: resolveRequestTimeoutMS(
        snapshot.timeout,
        undefined,
        'HTTPClient timeout',
      ),
      maxResponseBytes: resolveMaxResponseBytes(
        snapshot.maxResponseBytes,
        undefined,
        'HTTPClient maxResponseBytes',
      ),
      cookieJar: snapshot.cookieJar,
      retryPolicy: isNullish(configuredRetryPolicy)
        ? undefined
        : snapshotRetryPolicyOptions(configuredRetryPolicy),
      retryNonIdempotentMethods: snapshot.retryNonIdempotentMethods ?? false,
      includeRequestID: snapshot.includeRequestID ?? false,
      includeAttemptHeader: snapshot.includeAttemptHeader ?? false,
      userAgent: snapshot.userAgent,
      followRedirects: snapshot.followRedirects ?? false,
      maxRedirects: snapshot.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
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
    return this._adapterType;
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
    // Checked and normalized once, here, so a JS caller's `'post'` is the
    // non-idempotent `POST`, and a method no adapter would send is refused now, whether
    // or not an interceptor runs (which checks and normalizes what it returns too).
    const methodProblem = describeInvalidHTTPMethod(method);
    if (methodProblem !== undefined) {
      throw new TypeError(`HTTPClient request method ${methodProblem}`);
    }

    // A string, said here as every other request option says it: a `URL` object (which
    // `fetch` takes), a number or `undefined` would otherwise build a builder whose
    // `send()` rejects with an engine error from deep inside URL building.
    const pathValue: unknown = path;
    if (typeof pathValue !== 'string') {
      throw new TypeError(
        `HTTPClient request path must be a string (got ${describeRequestPath(pathValue)})`,
      );
    }

    return new HTTPRequestBuilder<T>(
      normalizeStandardMethod(method),
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

  /**
   * Cancel one in-flight request by id.
   *
   * @returns How many requests this call cancelled - `1`, or `0` when no request with
   *          that id was in flight or it was cancelled already, so a `cancel('typo')` that
   *          matched nothing is visible without calling `listRequests()` first.
   */
  public cancel(requestID: string, reason?: string): number {
    return this._tracker.cancel(requestID, reason);
  }

  /** @returns How many requests were cancelled. */
  public cancelAll(reason?: string): number {
    return this._tracker.cancelAll(reason);
  }

  /** @returns How many requests were cancelled. */
  public cancelOwn(reason?: string): number {
    return this._tracker.cancelOwn(this._clientID, reason);
  }

  /** @returns How many requests were cancelled. */
  public cancelAllWithLabel(label: string, reason?: string): number {
    assertLabelArgument(label, 'cancelAllWithLabel');
    return this._tracker.cancelAllWithLabel(label, reason);
  }

  /** @returns How many requests were cancelled. */
  public cancelOwnWithLabel(label: string, reason?: string): number {
    assertLabelArgument(label, 'cancelOwnWithLabel');
    return this._tracker.cancelOwnWithLabel(this._clientID, label, reason);
  }

  // --- Request inspection ---

  public listRequests(filter?: { scope?: 'own' | 'all'; label?: string }): {
    count: number;
    requests: RequestInfo[];
  } {
    // An object, as request options are: `listRequests('all')` would list only this
    // client's own. A misspelled field (`lable`, `scop`) would list every request it
    // meant to narrow.
    const candidate: unknown = filter;
    if (
      !isNullish(candidate) &&
      (typeof candidate !== 'object' || Array.isArray(candidate))
    ) {
      throw new TypeError(
        `HTTPClient.listRequests() filter must be an object (got ${Array.isArray(candidate) ? 'an array' : describeValue(candidate)})`,
      );
    }
    assertKnownFields(
      filter,
      ['scope', 'label'],
      'HTTPClient.listRequests() filter',
    );
    const scope = filter?.scope ?? 'own';

    // Refused rather than read loosely: any other `scope` - a typo such as `'mine'` -
    // would otherwise be read as `'all'` and list every client's requests.
    if (scope !== 'own' && scope !== 'all') {
      throw new TypeError(
        `HTTPClient.listRequests() scope must be 'own' or 'all' (got ${typeof scope === 'string' ? 'an unknown scope' : describeValue(scope)})`,
      );
    }

    // Read once, as `scope` is: a getter answering differently on each read could
    // otherwise be checked as one label and listed by another.
    const label = filter?.label;

    if (label !== undefined) {
      assertLabelArgument(label, 'listRequests');
    }

    return this._tracker.list({
      clientID: scope === 'own' ? this._clientID : undefined,
      label,
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
    // Undefined overrides inherit; explicit null retains each option's policy
    // (notably cookieJar: null disables the jar, while a null timeout or
    // maxResponseBytes inherits).
    // Capture every documented field through its original receiver, regardless of
    // enumerability or prototype placement. See `snapshotClientConfigFields`.
    assertKnownFields(
      overrides,
      SUB_CLIENT_CONFIG_FIELDS,
      'HTTPClient createSubClient config',
    );
    const snapshot = {
      ...snapshotClientConfigFields(overrides),
      defaultHeadersStrategy: overrides.defaultHeadersStrategy,
    } satisfies Record<keyof SubClientConfig, unknown>;
    const {
      followRedirects: shouldFollowRedirectsOverride,
      defaultHeadersStrategy,
      defaultHeaders: overrideHeaders,
      timeout,
      maxResponseBytes,
      adapter,
      cookieJar,
      maxRedirects,
    } = snapshot;
    // The strategy is how the headers below are built, not a client option.
    const definedOverrides = Object.fromEntries(
      Object.entries(snapshot).filter(
        ([field, value]) =>
          value !== undefined && field !== 'defaultHeadersStrategy',
      ),
    );
    const shouldFollowRedirects =
      shouldFollowRedirectsOverride ?? this._config.followRedirects;
    // Anything but the two strategies would silently mean `'replace'`, dropping the
    // inherited defaults - an `authorization` among them.
    if (
      !isNullish(defaultHeadersStrategy) &&
      defaultHeadersStrategy !== 'replace' &&
      defaultHeadersStrategy !== 'merge'
    ) {
      throw new TypeError(
        `HTTPClient sub-client defaultHeadersStrategy must be 'replace' or 'merge' (got ${typeof defaultHeadersStrategy === 'string' ? 'an unknown strategy' : describeValue(defaultHeadersStrategy)})`,
      );
    }
    assertOptionalHeaderRecord(
      overrideHeaders,
      'HTTPClient sub-client defaultHeaders',
    );
    const defaultHeaders =
      defaultHeadersStrategy === 'merge'
        ? mergeHeaders(this._config.defaultHeaders, overrideHeaders)
        : (overrideHeaders ?? this._config.defaultHeaders);

    const config: HTTPClientConfig = {
      ...this._config,
      ...definedOverrides,
      timeout: timeout ?? this._config.timeout,
      maxResponseBytes: maxResponseBytes ?? this._config.maxResponseBytes,
      defaultHeaders,
      followRedirects: shouldFollowRedirects,
      adapter: adapter ?? this._adapter,
      cookieJar: cookieJar !== undefined ? cookieJar : this._config.cookieJar,
    };

    if (shouldFollowRedirects === false && maxRedirects === undefined) {
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

    // buildURL: relative path + baseURL, OR absolute http(s) / //host path unchanged.
    // For MockAdapter only, synthesize a deterministic absolute base URL when
    // no baseURL is configured so interceptors and observers do not depend on
    // ambient browser location state:
    //   - true path-only inputs -> http://localhost/...
    //   - protocol-relative //host/... inputs -> http://host/...
    // Other non-HTTP absolute-like inputs still fail validation later.
    const effectiveBaseURL =
      this._config.baseURL ??
      (this._adapterType === 'mock'
        ? !/^[a-z][a-z0-9+\-.]*:/i.test(path)
          ? MOCK_ADAPTER_DEFAULT_BASE_URL
          : undefined
        : undefined);

    const url = resolveAbsoluteURLForRuntime(
      buildURL(effectiveBaseURL, path, options.params),
      effectiveBaseURL,
      this._isBrowserRuntime,
    );
    // Resolved here as well as in the constructor: nullish values inherit the client
    // value. Invalid numbers fail before dispatch; Infinity disables the timer.
    const timeout = resolveRequestTimeoutMS(
      options.timeout,
      this._config.timeout,
    );
    // Resolved once, as the timeout is, and handed to every attempt's adapter call: the
    // client's value when the request names none. `Infinity` is passed on as no limit.
    const maxResponseBytes = resolveMaxResponseBytes(
      options.maxResponseBytes,
      this._config.maxResponseBytes,
    );
    // The limits every observed attempt snapshot reports, built once for the snapshots
    // taken before or between dispatches.
    const attemptLimits: AttemptLimits = { timeout, maxResponseBytes };

    // When the request's upload last reported progress, across every hop and attempt.
    // Stamped by the upload-progress wrapper each attempt hands the adapter, and read by
    // the wait on `requestBodySettled` before the next dispatch: the bound on that wait
    // is a *stall* bound, not a deadline, so an upload that is still moving is never cut.
    const uploadActivity: UploadActivity = {
      at: performance.now(),
      sourceStallSince: undefined,
      sourceWaitEndedAt: undefined,
      dispatches: 0,
    };

    // Merge headers
    const baseHeaders = mergeHeaders(
      this._config.defaultHeaders,
      options.headers,
    );

    if (this._config.includeRequestID) {
      baseHeaders[DEFAULT_REQUEST_ID_HEADER] = requestID;
    }

    const adapterType = this._adapterType;

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

    // Build intercepted request context. The body is the builder's own copy, taken when
    // the caller handed it over (see `copyRequestBody`), so nothing the caller does to
    // their value from here on reaches an attempt.
    const interceptedRequest: ResolvedRequest = {
      requestURL: url,
      method,
      headers: baseHeaders,
      body: options.body,
    };

    // Short-circuit already-aborted external signals so we do not run
    // interceptors, tracking, retries, or adapter dispatch at all.
    // Read guarded: an `aborted` getter that throws is not aborted.
    if (isSignalAbortedQuietly(options.signal)) {
      callbacks.setAttemptCount(0);
      callbacks.setNextRetryDelayMS(null);
      callbacks.setNextRetryAt(null);

      const response = this._buildResponse<T>({
        adapterResponse: null,
        requestID,
        wasCancelled: true,
        wasTimeout: false,
        adapterType: this._adapterType,
        initialURL: interceptedRequest.requestURL,
        requestURL: interceptedRequest.requestURL,
        redirectHistory: [],
      });

      // A cancel the builder held during setup came first, so its reason stands; the
      // signal can only have aborted after it, or the builder would have refused to hold it.
      const setupCancel = callbacks.getSetupCancel();
      const error = this._makeError(
        response,
        requestID,
        false,
        undefined,
        undefined,
        setupCancel
          ? setupCancel.reason
          : options.signal
            ? getSignalCancelReason(options.signal)
            : undefined,
      );
      callbacks.setError(error);
      callbacks.setState('cancelled');
      callbacks.setResponse(response);
      await this._runErrorObservers(
        error,
        this._bestEffortAttemptRequestFromPending(
          interceptedRequest,
          attemptLimits,
          requestID,
        ),
        {
          type: 'final',
        },
      );
      return response;
    }

    // Setup AbortController + tracker
    const abortController = new AbortController();
    const trackedRequest: TrackedRequest = {
      requestID,
      clientID: this._clientID,
      label: options.label,
      state: 'sending',
      abortController,
      ...(options.signal ? { callerSignal: options.signal } : {}),
    };
    this._tracker.add(trackedRequest);

    const trackedCallbacks: BuilderCallbacks<T> = {
      ...callbacks,
      setState: (state) => {
        callbacks.setState(state);
        this._tracker.updateState(requestID, state);
      },
    };

    // Wire builder.cancel() to our abort controller. It answers whether this call is what
    // cancelled the request: not once it already is - by an earlier `cancel()`, a client
    // or tracker cancel of the same controller, or the caller's own signal.
    // Through the tracker's own cancel, so the tracked state reads `cancelled` at once,
    // as it does after `client.cancel()`.
    // The builder's own state turns `cancelled` when the request settles, with its
    // response and error, as for every other outcome.
    trackedCallbacks.setCancelFn((reason?: string): CancelResult =>
      cancelTrackedRequest(trackedRequest, reason),
    );

    // Compose user signal with our internal abort controller. Every composition made
    // for this request - this one and one per attempt - registers how to release its
    // listeners here, and the request's `finally` runs them; see `_composeSignals`.
    const signalReleasers: Array<() => void> = [];
    let cancelSignal: AbortSignal = abortController.signal;

    try {
      // Composed inside the `try`, so a caller's signal whose `addEventListener` throws
      // still reaches the `finally` that releases whatever was attached before the throw.
      // Composed before it, the release list would be built and never run.
      if (options.signal) {
        cancelSignal = this._composeSignals(
          options.signal,
          abortController.signal,
          signalReleasers,
        );
      }

      let finalRequest = interceptedRequest;
      let response: HTTPResponse<T>;
      /**
       * The request the `final` observers below are handed. Every path that reaches them
       * has been through `_dispatchRequestAttempts`, so it is that call's `sentRequest`,
       * replaced with a best-effort snapshot of the hop by the redirect branches that end
       * the request between hops. The paths that end before the redirect loop build
       * their own snapshot and return, so none is built up front.
       */
      let observerRequest: AttemptRequest;
      let errorCode: HTTPClientError['code'] | undefined;
      let adapterCause: Error | undefined;
      let errorMessage: string | undefined;
      let cancelReason: string | undefined;
      let isRetriesExhausted = false;
      let completedAttemptCount = 0;

      /**
       * The upload outcome the request reports so far, wherever it ended up: kept by the
       * attempt runner (see its `latestUpload` parameter) across the redirect loop below,
       * and attached to the response where `finalResponse` is taken - or, for a throw out
       * of the loop, in the `catch` around it - rather than by each terminal branch.
       * Declared here so both can see it, and read there rather than copied out after
       * each hop, so a throw out of the runner itself reports the attempt it got to.
       *
       * Kept by the runner rather than read off a hop's result: an attempt that *threw*
       * has no adapter response to carry it, and most terminal redirect branches below
       * build their `HTTPResponse` with `adapterResponse: null` - a redirect the caller
       * disabled, a loop, an interceptor that threw, a cancel between hops - so that
       * response has no field of its own to read. An early `3xx` mid-upload is exactly
       * the shape where it is not empty.
       */
      //
      // Carried across hops and attempts, not recomputed per hop: the latest attempt that
      // had a body is the answer. A followed `301`/`302`/`303` rewrites a `POST` to a
      // bodiless `GET`, so the final hop has no writer and nothing of its own to report -
      // and reading only that hop would answer `undefined`, the documented "the body went
      // out" value, for exactly the early-ack `POST` -> `302` -> `GET` shape this field
      // exists for. A `307`/`308` resends the body and its own outcome is the one that
      // reached the final response, while a bodiless hop or retry after it changes
      // nothing about what the upload did. A bodied attempt given up on with its adapter
      // still out reports that its upload's fate is unknown, and one that reported none -
      // a custom adapter's untagged throw - leaves none, rather than an earlier hop's
      // "the body went out" for an upload whose fate nobody knows.
      const latestUpload: {
        outcome: Promise<Error | undefined> | undefined;
      } = { outcome: undefined };

      /**
       * The request's URL as the initial-phase interceptors left it - `url` until they
       * have run. Declared out here so the `catch` around the whole of `send()` reports
       * the same `initialURL` every other terminal path does, rather than the URL from
       * before an interceptor rewrote it.
       */
      let initialRequestURL = url;

      /**
       * Where the redirect loop below has got to: the request of the hop being followed,
       * and the redirect history leading to it. Declared out here for the same reason, so
       * a throw between hops reports the hop it happened on, as every other terminal path
       * does, rather than presenting a failure on hop two as the first request.
       */
      let currentInterceptedRequest: ResolvedRequest | undefined;
      let redirectHistory: string[] = [];

      try {
        // streamResponse is NodeAdapter-only. Validate it inside the normal
        // request setup flow so builder/error observer state is updated the same
        // way as every other request_setup_error.
        if (options.streamResponse && this._adapterType !== 'node') {
          throw new Error(
            `[HTTPClient] .streamResponse() requires NodeAdapter. Current adapter: ${this._adapterType}`,
          );
        }

        // Validate the resolved URL is a proper http(s) URL. Protocol-relative
        // //host paths without a baseURL to supply the scheme stay unresolved and
        // must fail here as a request_setup_error rather than reaching the adapter.
        if (!isAbsoluteWebURL(url)) {
          throw new Error(
            `[HTTPClient] Request URL could not be resolved to an absolute http(s) URL. ` +
              `Set a baseURL with an http(s) scheme or pass an absolute URL.`,
          );
        }

        // The method checks wait for the interceptors' result when there are any: one may
        // rewrite a request the adapter refuses (a GET with a body, say) into one it takes.
        // If none did, the refusal is still the caller's own, reported as it would be with
        // no interceptor registered.
        let callerMethodRefusal: Error | undefined;
        // Read from the request the client built, of which the interceptors are handed a
        // copy - its own fields and header record, the same body (see
        // `handedRequestPreparer`).
        const callerMethod = interceptedRequest.method;
        const hasCallerBody = hasRequestBody(interceptedRequest.body);
        try {
          this._assertRequestIsSupported(interceptedRequest);
        } catch (error) {
          if (
            !methodRefusals.has(error as Error) ||
            !this._hasRequestInterceptors()
          ) {
            throw error;
          }
          callerMethodRefusal = error as Error;
        }

        // Run interceptors (initial phase)
        const initialPhase: InterceptorPhase = { type: 'initial' };
        // Left unset by a failure that a cancel made first turns into that cancel.
        let interceptResult: ResolvedRequest | InterceptorCancel | undefined;
        let initialRequestCandidate: InterceptedRequest = finalRequest;
        // The interceptors are handed a copy of the request with its own header record and
        // the same body (see `handedRequestPreparer`), so a cancel or a failure below
        // reports `finalRequest` with the URL, method and headers the client built, and the
        // body as an interceptor may have edited it in place.
        const initialBodyCopy: HandedBodyCopy = {
          isTaken: false,
          didFail: false,
        };

        try {
          const initialRun = await this._runInterceptors(
            finalRequest,
            initialPhase,
            {
              initialURL: url,
              redirectHistory: [],
              requestID,
              attemptNumber: 1,
            },
            () => cancelSignal.aborted,
            (failed) => {
              initialRequestCandidate = failed;
            },
            handedRequestPreparer(initialBodyCopy, {
              headers: true,
              body: false,
            }),
          );

          // Taken for the rest of the phase through `snapshotInterceptedRequest`. A
          // failure below reports from what the chain returned while the snapshot is
          // being taken - a getter that throws there is still reported best-effort -
          // and from the snapshot once it exists. With no interceptor registered there
          // is no caller object to copy; see `_runInterceptors`.
          // Two branches, not one `||`: only the first proves the result is the
          // already-resolved request the chain was given.
          if (!initialRun.isIntercepted) {
            interceptResult = initialRun.result;
          } else if (isInterceptorCancel(initialRun.result)) {
            interceptResult = initialRun.result;
          } else {
            initialRequestCandidate = initialRun.result;
            interceptResult = snapshotInterceptedRequest(initialRun.result);
          }

          if (!isInterceptorCancel(interceptResult)) {
            initialRequestCandidate = interceptResult;
            // The checks that do not read the body first, so a body the client cannot
            // send, a header or a method is the interceptor's failure before the body
            // is copied; the GET and HEAD rule once it is (see `copyChainResultBody`).
            this._assertRequestShapeIsSupported(interceptResult);
            initialRequestURL = interceptResult.requestURL;
            this._assertInterceptorResolvedURL(initialRequestURL);
            if (initialRun.isBodyHandedOut) {
              interceptResult = this._copyChainResultBody(
                interceptResult,
                initialBodyCopy,
              );
              initialRequestCandidate = interceptResult;
            }
            this._assertRequestBodyFitsMethod(interceptResult);
          }
        } catch (error) {
          // A cancel made before the failure - while the chain's result was copied, by a
          // getter that cancelled and then threw, say - told its caller it cancelled the
          // request, so it ends cancelled, as the cancel below ends it: reported from
          // `finalRequest`, not from what the interceptors returned. (The chain answers a
          // cancel itself for an interceptor that cancelled and then threw.)
          if (!cancelSignal.aborted) {
            const response = this._buildResponse<T>({
              adapterResponse: null,
              requestID,
              wasCancelled: false,
              wasTimeout: false,
              adapterType: this._adapterType,
              initialURL: url,
              // The interceptor's request may be what failed - a `requestURL` getter
              // that throws - so its URL is read best-effort, falling back to the
              // request's own, rather than turning this into a `request_setup_error`.
              requestURL: readStringMember(
                initialRequestCandidate,
                'requestURL',
                url,
              ),
              redirectHistory: [],
              isNetworkErrorOverride: false,
            });

            // A method refusal the caller's own request already had, which no
            // interceptor changed - same method, and for the GET and HEAD rule a body or
            // none as before; a CONNECT, TRACE or TRACK is refused whatever its body - is
            // the caller's mistake, reported as the `request_setup_error` it is with no
            // interceptor registered.
            const isCallersOwnRefusal =
              callerMethodRefusal !== undefined &&
              methodRefusals.has(error as Error) &&
              readStringMember(initialRequestCandidate, 'method', '') ===
                callerMethod &&
              (!bodyMethodRefusals.has(error as Error) ||
                hasRequestBody(
                  readObjectMember(initialRequestCandidate, 'body'),
                ) === hasCallerBody);
            // So is a body the interceptors returned that cannot be copied (see
            // `isBodyCopyFailure`).
            const isSetupError =
              isCallersOwnRefusal || isBodyCopyFailure(initialBodyCopy, error);
            const normalizedError = this._makeError(
              response,
              requestID,
              false,
              isSetupError ? 'request_setup_error' : 'interceptor_error',
              normalizeError(error),
            );

            // And counted as it is there: `0`, a setup error before any attempt, not the
            // `null` of a request the interceptors ended.
            if (isSetupError) {
              callbacks.setAttemptCount(0);
            }

            callbacks.setError(normalizedError);
            trackedCallbacks.setState('failed');
            callbacks.setResponse(response);

            await this._runErrorObservers(
              normalizedError,
              this._bestEffortAttemptRequestFromPending(
                initialRequestCandidate,
                attemptLimits,
                requestID,
                // The URL the response and error name, so a host filter agrees with
                // them.
                { fallbackURL: url },
                // A body that failed to copy is not read a second time; it is reported
                // as it came.
                initialBodyCopy.didFail ? 'unbuildable' : undefined,
              ),
              {
                type: 'final',
              },
            );

            return response;
          }
        }

        // A cancel that landed while the interceptors ran - `cancelAll()` during an
        // awaited token refresh, say - ends the request here as an interceptor's cancel
        // does: before any attempt begins.
        const initialEnd = endInterceptorPhase(interceptResult, cancelSignal);
        if (initialEnd.isCancelled) {
          const cancelledResponse = this._buildResponse<T>({
            adapterResponse: null,
            requestID,
            wasCancelled: true,
            wasTimeout: false,
            adapterType: this._adapterType,
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
            initialEnd.cancelReason,
          );
          callbacks.setError(error);
          trackedCallbacks.setState('cancelled');
          callbacks.setResponse(cancelledResponse);

          await this._runErrorObservers(
            error,
            this._bestEffortAttemptRequestFromPending(
              finalRequest,
              attemptLimits,
              requestID,
              // The URL the response names.
              { reportedURL: url },
            ),
            {
              type: 'final',
            },
          );

          return cancelledResponse;
        }

        finalRequest = initialEnd.request;

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
        const credentialScope = { url: initialRequestURL };
        currentInterceptedRequest = finalRequest;
        let hopCount = 0;
        // The request body each hop's last attempt sent, before serialization; see
        // `sentBody`.
        const sentBody: { value: unknown } = { value: undefined };
        // Tracks the last global attempt number across all hops and retries,
        // so the next hop's attempts continue the sequence (e.g. 1,2,3 on
        // initial request → 4,5 on first redirect hop → 6 on second hop).
        let lastAttemptNumber = 0;
        let currentHopInfo: RedirectHopInfo | undefined;
        // The last followed redirect's target as `detectedRedirectURL` reports it (see
        // `detectedRedirectTarget`), for a hop that then ends before it is dispatched: it
        // is reported detected, not followed. Set for each hop that reaches resolving its
        // `Location`, and `undefined` for one that does not resolve.
        let lastDetectedTargetURL: string | undefined;

        while (true) {
          // Send request through the adapter with retry support. Each hop gets
          // its own call; the shared retryPolicy tracks budget across all hops.
          const attemptResult = await this._dispatchRequestAttempts({
            request: currentInterceptedRequest,
            markCancelled: (reason) => {
              cancelEntry(trackedRequest, reason);
            },
            sentBody,
            latestUpload,
            credentialScope,
            timeout,
            maxResponseBytes,
            cancelSignal,
            signalReleasers,
            uploadActivity,
            retryPolicy,
            requestID,
            options,
            callbacks: trackedCallbacks,
            initialURL: initialRequestURL,
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

          // This hop's error code and cause, replacing the last hop's: otherwise a
          // followed hop that carried a cause (a custom adapter's `errorCause` on its
          // `302`) would hand it to the next hop's failure, which has none of its own.
          errorCode = attemptResult.errorCode;
          adapterCause = attemptResult.adapterCause;
          errorMessage = attemptResult.errorMessage;

          if (attemptResult.cancelReason !== undefined) {
            cancelReason = attemptResult.cancelReason;
          }

          callbacks.setAttemptCount(attemptResult.attemptCount);
          observerRequest = attemptResult.sentRequest;

          // A 3xx with no `Location` is no redirect to refuse - nothing to follow - so it
          // is delivered as the final response, as it is with redirects on.
          // Nor is a 3xx the adapter reports as a transport failure: it keeps its status
          // but fails as the network error it is, in this branch and the next.
          if (
            !this._config.followRedirects &&
            adapterResponse &&
            !adapterResponse.isTransportError &&
            REDIRECT_STATUS_CODES.has(adapterResponse.status) &&
            scalarHeader(adapterResponse.headers, 'location')
          ) {
            response = this._buildResponse<T>({
              // Pass a synthetic status-0 response so wasRedirectDetected is
              // preserved — null would lose the flag since _buildResponse
              // computes it as `adapterResponse?.wasRedirectDetected ?? false`.
              adapterResponse: unfollowedRedirectAnswer(
                adapterResponse,
                attemptResult.sentRequest.requestURL,
              ),
              requestID,
              // Provably false: a cancel settles with no adapter response, and
              // this branch is guarded on having one.
              wasCancelled: false,
              // Hardcoded even when a per-attempt timeout struck mid-body. The
              // request ends at the redirect either way, so `redirect_disabled`
              // is the outcome the caller acts on; surfacing the timeout would
              // reclassify the error code on whether the body happened to
              // finish. See docs/http-client.md.
              wasTimeout: false,
              adapterType: this._adapterType,
              initialURL: initialRequestURL,
              requestURL: attemptResult.sentRequest.requestURL,
              redirectHistory,
              isNetworkErrorOverride: false,
            });
            errorCode = 'redirect_disabled';
            // The redirect is the outcome, so nothing the hop's body did is its cause:
            // otherwise a 3xx whose body was cut short or too large would report
            // `redirect_disabled` with that stream error as its `cause`.
            adapterCause = undefined;
            errorMessage = undefined;
            break;
          }

          // --- Follow redirects (301, 302, 303, 307, 308) ---
          //
          // A stream failure is terminal, and that holds for a 3xx too: following
          // would make the failure vanish, since a healthy destination answers 200
          // and overwrites the failed attempt's `wasTimeout`. The terminal path
          // below builds from this response, so the real 3xx status,
          // `wasRedirectDetected` and `detectedRedirectURL` are all still reported.
          // A body that only failed to decode never gets here as one: the attempt reads it
          // as a bodiless 3xx (see `_dispatchRequestAttempts`).
          if (
            this._config.followRedirects &&
            adapterResponse &&
            !adapterResponse.isStreamError &&
            !adapterResponse.isTransportError &&
            REDIRECT_STATUS_CODES.has(adapterResponse.status)
          ) {
            // Resolve the Location header into an absolute URL. Read before the hop is
            // counted: a 3xx with nothing to follow is the final response, not a redirect
            // over the limit.
            // Relative paths (e.g. "/new-path") resolve against the current request URL.
            const location = scalarHeader(adapterResponse.headers, 'location');

            if (!location) {
              // Redirect status but no Location header — treat as final response
              const built = this._buildAnsweredResponse<T>({
                adapterResponse,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: attemptResult.sentRequest.requestURL,
                redirectHistory,
              });
              response = built.response;

              if (built.unreadableBody) {
                errorCode = 'adapter_error';
                adapterCause = built.unreadableBody;
              }

              break;
            }

            hopCount++;

            // Guard against infinite redirect chains
            if (hopCount > this._config.maxRedirects) {
              response = this._buildResponse<T>({
                // A synthetic status-0 response, as for `redirect_disabled`, so the
                // redirect this client did not follow is still reported: its
                // `wasRedirectDetected` and `detectedRedirectURL`.
                adapterResponse: unfollowedRedirectAnswer(
                  adapterResponse,
                  attemptResult.sentRequest.requestURL,
                ),
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: attemptResult.sentRequest.requestURL,
                redirectHistory,
                // The server answered every hop, so this is no network error.
                isNetworkErrorOverride: false,
              });
              errorCode = 'redirect_loop';
              // As for `redirect_disabled`: the limit is the outcome, not this hop's body.
              adapterCause = undefined;
              errorMessage = undefined;
              break;
            }

            // Resolved against the URL this hop was sent to, which is always an absolute
            // http(s) URL here: the initial, retry and redirect URLs are all refused before
            // dispatch otherwise. A `Location` that does not resolve against it is kept as
            // the raw string, recorded and handed to the interceptors below, and refused
            // as unsupported unless one rewrites it.
            let redirectURL: string;
            // Kept parsed for the cross-origin check below.
            let parsedRedirectURL: URL | undefined;

            try {
              parsedRedirectURL = new URL(
                location,
                attemptResult.sentRequest.requestURL,
              );
              redirectURL = parsedRedirectURL.toString();
            } catch {
              redirectURL = location;
            }

            // The target for `detectedRedirectURL` on the exits below that end before the
            // hop goes out: the server's, without this request's userinfo, and without the
            // server's own on a cross-origin target, as `redirectURL` is stripped below.
            // `redirect_disabled` and `redirect_loop` do not use it: they report the
            // adapter's own, or one resolved by this same rule where the adapter gave none
            // (`unfollowedRedirectAnswer`). None for a `Location` that does not resolve.
            // Nothing is sent to it.
            const detectedTargetURL = detectedRedirectTarget(
              location,
              attemptResult.sentRequest.requestURL,
            );
            lastDetectedTargetURL = detectedTargetURL;

            // Stripped here, before the hop is recorded, rather than only on the request:
            // `hopInfo`, `redirectHistory` and every observer and error built from them
            // carry this string, so a `Location` password left on it long enough to reach
            // `_sanitizeRedirectRequest` would already have been handed to the caller's
            // observers and written into the redirect history. See `stripURLCredentials`.
            if (
              isCrossOrigin(
                attemptResult.sentRequest.requestURL,
                parsedRedirectURL ?? redirectURL,
              )
            ) {
              redirectURL = stripURLCredentials(redirectURL);
            }

            // Method rewriting per HTTP spec (matches browser/fetch behavior):
            //  - 303 (See Other) becomes GET except for GET and HEAD
            //  - 301 (Moved Permanently) / 302 (Found) rewrite POST to GET
            //  - 307 (Temporary Redirect) / 308 (Permanent Redirect) preserve method/body
            let redirectMethod: HTTPMethod = attemptResult.sentRequest.method;

            if (
              (adapterResponse.status === 303 &&
                attemptResult.sentRequest.method !== 'GET' &&
                attemptResult.sentRequest.method !== 'HEAD') ||
              ((adapterResponse.status === 301 ||
                adapterResponse.status === 302) &&
                attemptResult.sentRequest.method === 'POST')
            ) {
              redirectMethod = 'GET';
            }

            // The URL this hop was sent to, read before any callback runs: the
            // cross-origin checks below compare against it, and observers and
            // interceptors are handed objects they could change.
            const hopFromURL = attemptResult.sentRequest.requestURL;
            // Whether this hop keeps its body, decided now for the same reason. A 303 is a
            // retrieval of another resource whatever the method (RFC 9110 15.4.4, curl):
            // a `GET` that carried a body does not send it to the See Other target.
            const isBodyDropped =
              redirectMethod !== attemptResult.sentRequest.method ||
              adapterResponse.status === 303;
            const hopInfo: RedirectHopInfo = {
              hop: hopCount,
              from: hopFromURL,
              to: redirectURL,
              statusCode: adapterResponse.status,
            };

            // Nothing more runs for a request already cancelled - from this hop's
            // `onAttemptEnd`, say: not the redirect-phase observers, nor the interceptors.
            if (cancelSignal.aborted) {
              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: true,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: hopFromURL,
                redirectHistory,
                // The redirect this hop answered with, detected and never followed.
                undispatchedRedirect: {
                  url: detectedTargetURL,
                  isRecorded: false,
                },
              });
              cancelReason = getSignalCancelReason(cancelSignal);

              break;
            }

            // Notify redirect-phase response observers (after Set-Cookie from
            // this response is applied). Same hop/from/to/statusCode as the
            // redirect-phase request interceptors that run below. They are handed the
            // response's body, so one that cannot be decoded ends the request here
            // rather than being followed.
            const redirectResponse = this._buildAnsweredResponse<T>({
              adapterResponse,
              requestID,
              wasCancelled: false,
              wasTimeout: false,
              adapterType: this._adapterType,
              initialURL: initialRequestURL,
              requestURL: attemptResult.sentRequest.requestURL,
              redirectHistory,
            });

            if (redirectResponse.unreadableBody) {
              response = redirectResponse.response;
              errorCode = 'adapter_error';
              adapterCause = redirectResponse.unreadableBody;

              break;
            }

            await this._runResponseObservers(
              redirectResponse.response,
              attemptResult.sentRequest,
              { type: 'redirect', ...hopInfo },
            );

            // Nor the interceptors, once one of those observers cancelled it.
            if (cancelSignal.aborted) {
              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: true,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: hopFromURL,
                redirectHistory,
                // The redirect this hop answered with, detected and never followed.
                undispatchedRedirect: {
                  url: detectedTargetURL,
                  isRecorded: false,
                },
              });
              cancelReason = getSignalCancelReason(cancelSignal);

              break;
            }

            // Cross-origin safety: strip every header outside a fixed allow-list when the
            // redirect crosses origins (scheme + host + port) - stricter than fetch, which
            // forwards everything but `Authorization`; see `_sanitizeRedirectRequest`.
            // Authorization, X-API-Key, etc. must not leak to a different host. Cookies
            // and internal headers (request ID) are re-attached below as needed.
            const nextRedirectHistory = [...redirectHistory, redirectURL];

            // Whether the *server's* `Location` was already unusable, remembered before
            // the interceptors run and answered after them.
            //
            // Both this and `_assertInterceptorResolvedURL` refuse the hop, so
            // `Location: file:///etc/passwd` never reaches an adapter either way - but
            // refused by that assertion it would be reported as `interceptor_error`, with
            // a message saying an interceptor rewrote the URL, on requests with no
            // redirect interceptors registered at all. A caller alerting on
            // `interceptor_error` would be paged for the remote server's `Location`, and
            // the code that names what actually happened is the one the same failure on
            // the initial URL already reports: `request_setup_error`.
            //
            // Asked here but acted on below the interceptor run, because *refusing early*
            // would take the hop away from the redirect-phase interceptors entirely - and
            // rewriting `requestURL` there is the documented way to steer or reject a hop,
            // which the scheme-downgrade guidance in the HTTP client docs points at by
            // name. An interceptor that rescues a bad `Location` still gets to; one that
            // only observes still sees the hop; a `cancel` still reports as a cancel. Only
            // a `Location` nobody fixed fails, and it fails as the server's fault.
            const wasLocationUnsupported = !isAbsoluteWebURL(redirectURL);

            // Only the fields a request interceptor is handed in the other phases: the
            // attempt that answered carries its own (`rawBody`, `timeout`, the attempt
            // header for the attempt that is over), which are rebuilt for the next one.
            const {
              [DEFAULT_REQUEST_ATTEMPT_HEADER]: _staleAttemptHeader,
              ...hopHeaders
            } =
              attemptResult.redirectRequestHeaders ??
              attemptResult.sentRequest.headers;
            // A cookie jar that throws while building the target's `Cookie` header fails
            // the hop as the other between-hop failures do, naming the redirect it was
            // building: left to the outer catch, it would be reported as the previous
            // hop, with no redirect seen.
            const pendingRedirectRequest: ResolvedRequest = {
              headers: hopHeaders,
              requestURL: redirectURL,
              method: redirectMethod,
              // Dropped when this hop rewrote the method or is a 303: a 307/308 replays a
              // GET's body as it replays any other method's.
              body: isBodyDropped ? undefined : sentBody.value,
            };
            let redirectRequest: ResolvedRequest;
            try {
              redirectRequest = this._sanitizeRedirectRequest(
                pendingRedirectRequest,
                {
                  fromURL: hopFromURL,
                  cookieJar: jar ?? undefined,
                },
              );
            } catch (error) {
              // The target, as the other failures before the hop went out report it - to
              // the error observers too, so a host filter agrees with the response.
              observerRequest = this._bestEffortAttemptRequestFromPending(
                pendingRedirectRequest,
                attemptLimits,
                requestID,
              );
              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: redirectURL,
                redirectHistory: nextRedirectHistory,
                undispatchedRedirect: {
                  url: detectedTargetURL,
                  isRecorded: true,
                },
                isNetworkErrorOverride: false,
              });
              errorCode = 'request_setup_error';
              adapterCause = normalizeError(error);

              break;
            }
            const redirectTargetURL = redirectRequest.requestURL;

            // Run redirect-phase request interceptors so they can update headers
            // for the new target (e.g. refresh auth tokens). Retry-phase
            // interceptors run inside _dispatchRequestAttempts if the hop itself
            // needs retrying.
            // Left unset by a failure that a cancel made first turns into that cancel.
            let redirectIntercept:
              ResolvedRequest | InterceptorCancel | undefined;
            let failedRedirectRequest: InterceptedRequest = redirectRequest;
            let redirectInterceptURL = redirectURL;
            // The interceptors are handed copies of the hop's headers and body (see
            // `handedRequestPreparer`): the hop's own is the request
            // the hop that answered was sent with, kept as it was for the reports a cancel
            // or a failure here makes, and a runtime's `fetch` may still hold its bytes.
            const redirectBodyCopy: HandedBodyCopy = {
              isTaken: false,
              didFail: false,
            };

            try {
              const {
                result: redirectRunResult,
                isBodyHandedOut: isRedirectBodyHandedOut,
              } = await this._runInterceptors(
                redirectRequest,
                { type: 'redirect', ...hopInfo },
                {
                  initialURL: initialRequestURL,
                  redirectHistory: nextRedirectHistory,
                  requestID,
                  attemptNumber: lastAttemptNumber + 1,
                },
                () => cancelSignal.aborted,
                (failed) => {
                  failedRedirectRequest = failed;
                },
                handedRequestPreparer(redirectBodyCopy, {
                  headers: true,
                  body: true,
                }),
              );
              if (isInterceptorCancel(redirectRunResult)) {
                redirectIntercept = redirectRunResult;
              } else {
                // Snapshotted as the initial phase does; see there. Even with no
                // interceptor registered: this request's headers come from the adapter's
                // record of what it sent, not from `mergeHeaders`, so the snapshot is
                // still what puts them in the shape the other phases' requests have.
                // The raw result first, so a snapshot that throws still reports it.
                failedRedirectRequest = redirectRunResult;
                redirectIntercept =
                  snapshotInterceptedRequest(redirectRunResult);
                failedRedirectRequest = redirectIntercept;
              }
              if (!isInterceptorCancel(redirectIntercept)) {
                // The GET and HEAD rule once the copy is taken; see the initial phase's.
                this._assertRequestShapeIsSupported(redirectIntercept);
                redirectInterceptURL = redirectIntercept.requestURL;

                // Skipped when the `Location` arrived unusable and is still unusable: the
                // assertion's message and its `interceptor_error` code both name an
                // interceptor, which is the wrong story for a URL no interceptor touched.
                // That case is answered below instead. An interceptor that rewrote a good
                // URL into a bad one is still this assertion's, and still its own fault.
                if (
                  !wasLocationUnsupported ||
                  redirectInterceptURL !== redirectURL
                ) {
                  this._assertInterceptorResolvedURL(redirectInterceptURL);
                }

                // The hop's body for every attempt and replay; see `copyChainResultBody`.
                if (isRedirectBodyHandedOut) {
                  redirectIntercept = this._copyChainResultBody(
                    redirectIntercept,
                    redirectBodyCopy,
                  );
                  failedRedirectRequest = redirectIntercept;
                }
                this._assertRequestBodyFitsMethod(redirectIntercept);
              }
            } catch (error) {
              // A cancel made before the failure ends the hop as the cancel below does,
              // as the initial phase's does; see there.
              if (!cancelSignal.aborted) {
                observerRequest = this._bestEffortAttemptRequestFromPending(
                  failedRedirectRequest,
                  attemptLimits,
                  requestID,
                  { fallbackURL: redirectURL },
                  // See the initial phase's.
                  redirectBodyCopy.didFail ? 'unbuildable' : undefined,
                );
                response = this._buildResponse<T>({
                  adapterResponse: null,
                  requestID,
                  wasCancelled: false,
                  wasTimeout: false,
                  adapterType: this._adapterType,
                  initialURL: initialRequestURL,
                  // The interceptor's request may be what failed; see the initial phase.
                  requestURL: readStringMember(
                    failedRedirectRequest,
                    'requestURL',
                    redirectURL,
                  ),
                  redirectHistory: nextRedirectHistory,
                  undispatchedRedirect: {
                    url: detectedTargetURL,
                    isRecorded: true,
                  },
                  isNetworkErrorOverride: false,
                });

                // A body that could not be copied is the body's failure; see
                // `isBodyCopyFailure`.
                errorCode = isBodyCopyFailure(redirectBodyCopy, error)
                  ? 'request_setup_error'
                  : 'interceptor_error';
                adapterCause = normalizeError(error);

                break;
              }
            }

            // A cancel that landed while they ran ends the hop as theirs does.
            const redirectEnd = endInterceptorPhase(
              redirectIntercept,
              cancelSignal,
            );
            if (redirectEnd.isCancelled) {
              // The target as it was before the interceptors ran, not re-read from what
              // they returned.
              const cancelledRequestURL = redirectTargetURL;
              observerRequest = this._bestEffortAttemptRequestFromPending(
                redirectRequest,
                attemptLimits,
                requestID,
                // See the initial phase's cancel.
                { reportedURL: redirectTargetURL },
              );
              const redirectCancelReason = redirectEnd.cancelReason;
              // Marked as the retry phase's interceptor cancel is, which also aborts the
              // hop that answered: an early 307 to a bodied PUT may still be uploading.
              cancelEntry(trackedRequest, redirectCancelReason);
              if (redirectCancelReason !== undefined) {
                cancelReason = redirectCancelReason;
              }

              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: true,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: cancelledRequestURL,
                redirectHistory: [...redirectHistory, cancelledRequestURL],
                undispatchedRedirect: {
                  url: detectedTargetURL,
                  isRecorded: true,
                },
              });

              break;
            }

            // The `Location` was unusable and no interceptor fixed it, so the hop fails
            // as the server's doing: `request_setup_error`, not `interceptor_error`. See
            // `wasLocationUnsupported` above. Nothing has been dispatched - the adapter
            // never sees a `file:` or `data:` URL either way.
            if (!isAbsoluteWebURL(redirectInterceptURL)) {
              observerRequest = this._bestEffortAttemptRequestFromPending(
                redirectEnd.request,
                attemptLimits,
                requestID,
              );
              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: redirectInterceptURL,
                redirectHistory: nextRedirectHistory,
                undispatchedRedirect: {
                  url: detectedTargetURL,
                  isRecorded: true,
                },
                isNetworkErrorOverride: false,
              });

              errorCode = 'request_setup_error';
              // Named by its scheme alone, as the adapters name a URL they refuse: an
              // OAuth redirect to an app's own scheme carries its authorization code in
              // the rest, and the response reports the target in full.
              let locationScheme: string | undefined;
              try {
                locationScheme = new URL(redirectInterceptURL).protocol;
              } catch {
                // Not a URL on its own: said so, without quoting it.
              }
              adapterCause = new Error(
                locationScheme === undefined
                  ? '[HTTPClient] Redirect Location could not be resolved to an absolute URL.'
                  : `[HTTPClient] Redirect Location could not be resolved to an absolute http(s) URL (got ${locationScheme}).`,
              );

              break;
            }

            // As for the target before the interceptors ran, above.
            let sanitizedRedirectRequest: ResolvedRequest;
            try {
              sanitizedRedirectRequest = this._sanitizeRedirectRequest(
                redirectEnd.request,
                {
                  // fromURL is the redirect target URL (what the interceptor received).
                  // This sanitize only strips headers if the interceptor rewrote the
                  // URL to a third host — in that case from=redirectTarget, to=thirdHost
                  // is cross-origin and the strip fires correctly.

                  // If the interceptor kept the URL (normal case), from and to are the
                  // same origin and nothing is stripped, preserving any headers the
                  // interceptor added (e.g. Authorization for the redirect target).
                  //
                  // The target as it was before the interceptors ran, from the hop's own
                  // request, of which they were handed a copy: compared with what they
                  // returned, never with itself.
                  fromURL: redirectTargetURL,
                  cookieJar: jar ?? undefined,
                },
              );
            } catch (error) {
              observerRequest = this._bestEffortAttemptRequestFromPending(
                redirectEnd.request,
                attemptLimits,
                requestID,
              );
              response = this._buildResponse<T>({
                adapterResponse: null,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL: initialRequestURL,
                requestURL: redirectInterceptURL,
                redirectHistory: nextRedirectHistory,
                undispatchedRedirect: {
                  url: detectedTargetURL,
                  isRecorded: true,
                },
                isNetworkErrorOverride: false,
              });
              errorCode = 'request_setup_error';
              adapterCause = normalizeError(error);

              break;
            }

            const redirectedRequestURL = sanitizedRedirectRequest.requestURL;

            // Update loop state for the next redirect hop
            currentInterceptedRequest = sanitizedRedirectRequest;
            redirectHistory = [...redirectHistory, redirectedRequestURL];
            currentHopInfo = {
              ...hopInfo,
              to: redirectedRequestURL,
            };

            // Followed only once this hop's upload has settled. `NodeAdapter.send()`
            // resolves when the response is consumed, and an early `3xx` arrives while
            // the writer is still running - so without this wait the next hop would be
            // dispatched with the previous one's body still going out on its own socket,
            // and a `307`/`308` would start a second upload of the same body beside the
            // first. The outcome never rejects and always settles (the adapter's stall
            // watchdog sees to that), so this is a wait, not a hazard; raced against the
            // cancel signal so a caller who gives up is not held for it. Only the
            // adapter's word is waited on: a hop that threw has no socket left to wait
            // for.
            if (adapterResponse.requestBodySettled !== undefined) {
              const wait = await settleUploadBeforeNextDispatch(
                adapterResponse.requestBodySettled,
                cancelSignal,
                timeout,
                () => lastUploadActivityAt(uploadActivity),
              );

              // A cancel that ended the wait ends the request here, before another hop
              // is dispatched, exactly as a redirect interceptor's cancel does above.
              // The caller's own reason is kept, as every other abort path keeps it.
              //
              // A deadline ends it the same way, as a timeout: the next hop would resend
              // the body beside an upload nobody can say has finished, which is the
              // double-send this wait exists to prevent, and a hop that cannot be
              // dispatched safely is a failed request rather than a risky one.
              if (wait !== 'settled') {
                if (wait === 'cancelled') {
                  const signalReason = getSignalCancelReason(cancelSignal);

                  if (signalReason !== undefined) {
                    cancelReason = signalReason;
                  }
                } else {
                  reportUploadSettleDeadline(
                    this._adapterType,
                    timeout,
                    'redirect',
                  );
                  // The hop whose upload was given up on is torn down with the request,
                  // as a per-attempt timeout tears one down. See `abortAttempt`.
                  attemptResult.abortAttempt?.();
                }

                observerRequest = this._bestEffortAttemptRequestFromPending(
                  sanitizedRedirectRequest,
                  attemptLimits,
                  requestID,
                );

                response = this._buildResponse<T>({
                  adapterResponse: null,
                  requestID,
                  wasCancelled: wait === 'cancelled',
                  wasTimeout: wait === 'deadline',
                  adapterType: this._adapterType,
                  initialURL: initialRequestURL,
                  requestURL: redirectedRequestURL,
                  redirectHistory,
                  undispatchedRedirect: {
                    url: detectedTargetURL,
                    isRecorded: true,
                  },
                });

                break;
              }
            }

            continue;
          }

          // Non-redirect: build final HTTPResponse
          const built = this._buildAnsweredResponse<T>({
            adapterResponse,
            requestID,
            wasCancelled,
            wasTimeout,
            adapterType: this._adapterType,
            initialURL: initialRequestURL,
            requestURL: attemptResult.sentRequest.requestURL,
            redirectHistory,
            // A redirect hop whose first attempt never went out - cancelled from
            // `onAttemptStart`, a body that failed on replay - was detected, not
            // followed, as a cancel between hops reports it.
            ...(currentHopInfo !== undefined &&
            attemptResult.isHopUndispatched === true
              ? {
                  undispatchedRedirect: {
                    url: lastDetectedTargetURL,
                    isRecorded: true,
                  },
                }
              : {}),
            ...(attemptResult.answeredResponse
              ? { answeredResponse: attemptResult.answeredResponse }
              : {}),
            ...(attemptResult.isNetworkErrorOverride === false ||
            attemptResult.errorCode === 'request_setup_error' ||
            attemptResult.errorCode === 'interceptor_error' ||
            attemptResult.errorCode === 'stream_setup_error' ||
            attemptResult.errorCode === 'redirect_disabled'
              ? { isNetworkErrorOverride: false }
              : {}),
          });
          response = built.response;

          if (built.unreadableBody) {
            errorCode = 'adapter_error';
            adapterCause = built.unreadableBody;
          }

          break;
        }
      } catch (error) {
        // As the initial phase's interceptor failure: a cancel made before it ends the
        // request cancelled.
        const isCancelled = cancelSignal.aborted;
        // The one exit that settles the request without reaching `finalResponse` below,
        // so it attaches the upload outcome itself: a throw *between* hops - a hostile
        // header read on a redirect, say - lands here after a hop that had a body.
        response = withRequestBodySettled(
          this._buildResponse<T>({
            adapterResponse: null,
            requestID,
            wasCancelled: isCancelled,
            wasTimeout: false,
            adapterType: this._adapterType,
            initialURL: initialRequestURL,
            requestURL:
              currentInterceptedRequest?.requestURL ?? initialRequestURL,
            redirectHistory,
            isNetworkErrorOverride: false,
          }),
          latestUpload.outcome,
        );

        const normalizedError = isCancelled
          ? this._makeError(
              response,
              requestID,
              false,
              undefined,
              undefined,
              getSignalCancelReason(cancelSignal),
            )
          : this._makeError(
              response,
              requestID,
              false,
              'request_setup_error',
              normalizeError(error),
            );

        callbacks.setAttemptCount(completedAttemptCount);
        callbacks.setNextRetryDelayMS(null);
        callbacks.setNextRetryAt(null);
        callbacks.setError(normalizedError);
        trackedCallbacks.setState(isCancelled ? 'cancelled' : 'failed');
        callbacks.setResponse(response);
        await this._runErrorObservers(
          normalizedError,
          // The current hop's request once there is one, matching the URLs above.
          this._bestEffortAttemptRequestFromPending(
            currentInterceptedRequest ?? finalRequest,
            attemptLimits,
            requestID,
          ),
          {
            type: 'final',
          },
        );
        return response;
      }

      // A cancel that landed after the answer arrived but before the request settled -
      // from the final `onAttemptEnd`, say - told its caller it cancelled the request, so
      // it does: the request ends cancelled rather than settling under that answer.
      if (cancelSignal.aborted && !response.isCancelled) {
        response = this._buildResponse<T>({
          adapterResponse: null,
          requestID,
          wasCancelled: true,
          wasTimeout: false,
          adapterType: this._adapterType,
          initialURL: initialRequestURL,
          requestURL: response.requestURL,
          // The response's own: a hop that failed after it was recorded carries it.
          redirectHistory: response.redirectHistory,
          // And the redirect it detected and did not follow (`redirect_disabled`, say),
          // which this rebuild would otherwise drop. Recorded exactly when the answer
          // counted it out of its own followed hops - a history with nothing followed is
          // that target - whether or not it has a URL to report: a recorded `Location`
          // that does not resolve has none, and is still no followed hop.
          ...(response.detectedRedirectURL !== undefined ||
          (!response.wasRedirectFollowed && response.redirectHistory.length > 0)
            ? {
                undispatchedRedirect: {
                  url: response.detectedRedirectURL,
                  isRecorded:
                    !response.wasRedirectFollowed &&
                    response.redirectHistory.length > 0,
                },
              }
            : // One detected with no target to name and nothing recorded - an opaque
              // redirect, a `3xx` with no `Location` - is kept too, flag alone.
              response.wasRedirectDetected
              ? { wasRedirectDetected: true }
              : {}),
        });
        // Whatever the answer was - a success, or a failure such as a final 500 - the
        // cancel is what ends the request, so the answer's own error goes with it.
        errorCode = undefined;
        adapterCause = undefined;
        errorMessage = undefined;
        isRetriesExhausted = false;
        cancelReason = getSignalCancelReason(cancelSignal);
      }

      // Run response or error observers. Phase `final` means this `send()` has finished.
      // Observers with `phases: ['retry']` already ran inside _dispatchRequestAttempts
      // for each retryable outcome before the retry delay; `redirect` phase response
      // observers ran inside the redirect loop for each redirect response. Network and
      // retryable HTTP failures may have been retried before we get here; interceptor
      // throw/cancel never retries and reaches this block immediately.
      //
      // The upload outcome goes on here, once, for every terminal branch above: see
      // `withRequestBodySettled`.
      response = withRequestBodySettled(response, latestUpload.outcome);
      const finalResponse = response;
      // Set before the final observers run, with the state and error: otherwise an
      // observer reading the builder would see a settled state and a `null` response.
      callbacks.setResponse(finalResponse);

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
          errorMessage,
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

      return finalResponse;
    } catch (error) {
      // Only a setup failure gets here - every outcome of the request itself is answered
      // above - and `send()` rejects with it. Marked settled at once, so a `cancel()` in
      // the moment before the builder hears of it answers `'already_settled'` rather
      // than cancelling a request that has already failed.
      // A request a held setup cancel already cancelled stays so.
      if (trackedRequest.state !== 'cancelled') {
        trackedRequest.state = 'failed';
      }
      throw error;
    } finally {
      this._tracker.remove(requestID);

      // Each guarded: a caller's signal whose `removeEventListener` throws would reject a
      // request that has already ended, and skip the releasers after it. The listener it
      // keeps is `once`, and inert now the request is over.
      for (const release of signalReleasers) {
        try {
          release();
        } catch {
          // Nothing more to do for that signal.
        }
      }
    }
  }

  private _sanitizeRedirectRequest(
    request: ResolvedRequest,
    params: {
      fromURL: string;
      cookieJar?: CookieJar | null;
    },
  ): ResolvedRequest {
    const { fromURL, cookieJar } = params;
    const isCrossOriginHop = isCrossOrigin(fromURL, request.requestURL);

    // Credentials in the target URL itself, stripped on the same rule `Authorization` is.
    //
    // `Location: https://admin:secret@other.host/` is the remote server's choice, not the
    // caller's, and `user:pass@` in a URL *is* an `Authorization: Basic` header by
    // another name - `NodeAdapter` copies it onto `options.auth`. So a hop that has the
    // caller's `Authorization` header stripped for crossing origins would otherwise get
    // credentials back, from the very response that redirected it, and authenticate to a
    // host the caller never named. Fetch treats the same shape as fatal (a cross-origin
    // `locationURL` that includes credentials is a network error); stripping rather than
    // failing the hop keeps the redirect followable and is the same answer this method
    // already gives every other credential on a cross-origin hop.
    //
    // Same-origin userinfo is left alone: it is the origin the caller addressed, which is
    // also the one that may already have been carrying it.
    const requestURL = isCrossOriginHop
      ? stripURLCredentials(request.requestURL)
      : request.requestURL;

    let headers: Record<string, string | string[]>;

    if (isCrossOriginHop) {
      const safeHeaders: Record<string, string | string[]> = {};
      // Cross-origin safety: strip every header outside a short allow-list when the
      // redirect crosses origins (scheme + host + port). Stricter than fetch, which
      // drops only `Authorization`: a caller's own credential header (`X-API-Key`) is
      // unknown to us, so nothing that could be one is carried to a host the caller did
      // not name. Cookies and internal headers are re-attached later as needed.
      //
      // `content-encoding` is kept with them: it describes the body a 307/308 replays,
      // not the caller, and that body arrives unreadable without it. It is dropped
      // below with the body when the hop does not carry one.
      //
      // `range` and the conditional headers are kept as well: they say which part or
      // version of the resource is wanted, not who is asking, and a resumed download sent
      // to a CDN without its `range` gets the whole body back.
      for (const [key, value] of Object.entries(request.headers)) {
        const lower = lowerCaseHeaderName(key);

        if (CROSS_ORIGIN_SAFE_HEADERS.has(lower)) {
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

    if (
      (request.method === 'GET' || request.method === 'HEAD') &&
      !hasRequestBody(request.body)
    ) {
      // Drop body-related headers when the hop dropped the body: a method rewritten to
      // GET, or a 303, which leaves a HEAD a HEAD. A 307/308 GET that replays its body
      // keeps them.
      for (const key of Object.keys(headers)) {
        if (BODY_DESCRIBING_HEADERS.has(lowerCaseHeaderName(key))) {
          delete headers[key];
        }
      }
    }

    if (cookieJar) {
      // Cookie for the new URL before the next hop is dispatched; each send on
      // this hop still refreshes from the jar inside _dispatchRequestAttempts.
      const cookieStr = cookieJar.getCookieHeaderString(requestURL);

      if (cookieStr) {
        headers.cookie = cookieStr;
      } else {
        delete headers.cookie;
      }
    } else if (isCrossOriginHop) {
      // Without a jar, never let a caller-supplied Cookie header survive a
      // cross-origin redirect or redirect-interceptor rewrite.
      delete headers.cookie;
    }

    return {
      ...request,
      requestURL,
      headers,
    };
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
    request: ResolvedRequest;
    /**
     * Mark the request cancelled, as `cancel()` would, when an interceptor or the stream
     * factory cancelled it: a later `cancel()` - from that attempt's `onAttemptEnd` - then
     * answers `'already_cancelled'` for a request it did not cancel.
     */
    markCancelled: (reason: string | undefined) => void;
    /**
     * Set to the request's body of each attempt as it is dispatched - the client's own
     * copy, which no caller holds (see `copyRequestBody`) - so a 307/308 replays that
     * value, serialized as the attempt's was, rather than the observers' copy, which is
     * theirs to change.
     */
    sentBody: { value: unknown };
    /**
     * The upload outcome the response reports: the latest attempt's that had a body, or
     * that reported one. Cleared when a bodied attempt is dispatched, so one that reports
     * none - a custom adapter's untagged throw - leaves none, never an earlier attempt's
     * or hop's; one given up on reports its upload's fate unknown, and a bodiless attempt
     * leaves it as it was.
     */
    latestUpload: { outcome: Promise<Error | undefined> | undefined };
    /** Latest destination explicitly selected by the caller or a retry interceptor. */
    credentialScope: { url: string };
    /** Per-attempt timeout in ms. Each attempt gets its own independent timer — NOT a total deadline across all retries. */
    timeout: number;
    /** The most bytes of a buffered response body each attempt's adapter reads; `Infinity` for no limit. */
    maxResponseBytes: number;
    /** Cancellation signal from user cancel / cancelAll / external AbortSignal — NOT timeout. Also used to abort retry delays. */
    cancelSignal: AbortSignal;
    /** Where each attempt's signal composition registers its release; see `_composeSignals`. */
    signalReleasers: Array<() => void>;
    retryPolicy: RetryPolicy | null;
    requestID: string;
    options: ResolvedBuilderOptions;
    callbacks: BuilderCallbacks<T>;
    /** The original URL before any redirects — used in callbacks so consumers can correlate attempts across hops. */
    initialURL: string;
    /** See the declaration in `_execute`: stamped on every upload-progress report. */
    uploadActivity: UploadActivity;
    /** First attempt number for this dispatch (continues from previous hops). Defaults to 1. */
    startAttemptNumber?: number;
    /** Accumulated redirect history — passed to interceptor context. */
    redirectHistory?: string[];
    /** When dispatching a redirect hop, carries the hop number and redirect info for callbacks and observer phases. */
    hopContext?: { hopNumber: number; redirect: RedirectHopInfo };
    /**
     * If set: each adapter response updates the jar from `Set-Cookie` before retry/backoff,
     * and each outbound attempt rebuilds the `Cookie` header from the jar for its target URL.
     */
    cookieJar?: CookieJar | null;
  }): Promise<{
    adapterResponse: AdapterResponse | null;
    sentRequest: AttemptRequest;
    /**
     * Set when the hop's first attempt ended before it was dispatched - cancelled from
     * `onAttemptStart`, a cookie jar that threw building its `Cookie` header: a redirect
     * hop that never went out, which is no followed redirect.
     */
    isHopUndispatched?: boolean;
    /** Headers for following a redirect, excluding adapter-generated origin headers. */
    redirectRequestHeaders?: Record<string, string | string[]>;
    attemptCount: number;
    wasCancelled: boolean;
    wasTimeout: boolean;
    isRetriesExhausted: boolean;
    errorCode?: HTTPClientError['code'];
    adapterCause?: Error;
    /**
     * Set for a non-retryable adapter failure. It shares `adapter_error` with transport
     * failures, so the code alone cannot say the request never failed on the network.
     */
    isNetworkErrorOverride?: boolean;
    /**
     * What a response that could not be read did carry, for the `adapter_error` that
     * ends an attempt whose `send()` had resolved. `adapterResponse` stays null - the
     * redirect and retry checks never act on an unreadable answer - and the final
     * response reports this status and headers, as `onAttemptEnd` reports the status.
     */
    answeredResponse?: AnsweredResponse;
    /** Replaces the code's generic message, for an `adapter_error` with a named source. */
    errorMessage?: string;
    cancelReason?: string;
    /**
     * Tears down the attempt that produced `adapterResponse`, as a per-attempt timeout
     * would have: fires the attempt's own abort signal, which `NodeAdapter` answers by
     * destroying the request and settling its upload outcome. For the redirect loop,
     * which gives up on that attempt's upload at the settle deadline - the per-attempt
     * timer is cleared once `send()` resolves, so nothing else would end an upload the
     * client has already reported as timed out.
     */
    abortAttempt?: () => void;
  }> {
    const {
      request: baseRequest,
      credentialScope,
      timeout,
      maxResponseBytes,
      cancelSignal,
      signalReleasers,
      uploadActivity,
      retryPolicy: policy,
      requestID,
      options,
      callbacks,
      initialURL,
      hopContext,
    } = params;
    const startAttempt = params.startAttemptNumber ?? 1;
    // Attempt numbers count every adapter dispatch, including redirect hops. Keep the
    // retry ceiling in that same global numbering space: on a hop beginning at attempt
    // 2 with one retry, the retry phase is attempt 2/3 followed by attempt 3/3, never
    // attempt 3/2.
    const retriesRemaining = policy
      ? Math.max(policy.maxRetryAttempts - policy.errors.length, 0)
      : 0;
    const maxAttemptNumber = startAttempt + retriesRemaining;
    const redirectHistory = params.redirectHistory ?? [];
    const cookieJar = params.cookieJar ?? null;
    /**
     * Whether the policy still has a retry left at this point.
     *
     * Counted from retries actually spent, not from the attempt number, which
     * also advances on redirect hops that spend no budget. `areAttemptsExhausted`
     * lags by one — it counts an attempt only once `shouldRetry` has reported its
     * error, and every suppressed path short-circuits before that call.
     */
    const isRetryAvailable = (): boolean =>
      policy !== null && policy.errors.length < policy.maxRetryAttempts;

    // Per-request wins over client config; unset means the safe default.
    const allowNonIdempotentRetry =
      options.retryNonIdempotentMethods ??
      this._config.retryNonIdempotentMethods;
    let attemptNumber = startAttempt - 1;
    let isRetriesExhausted = false;

    while (true) {
      attemptNumber++;
      const isRetry = attemptNumber > startAttempt;

      let didEmitAttemptEnd = false;

      /**
       * Emit the attempt-end event, filling in everything that is the same at
       * every exit. Callers pass only what differs between one ending and
       * another, so a new field cannot be missed at one of the fourteen exits.
       */
      const emitAttemptEnd = (outcome: {
        willRetry: boolean;
        status: number;
        nextRetryDelayMS?: number;
        nextRetryAt?: number;
        retrySuppressedReason?: AttemptEndEvent['retrySuppressedReason'];
      }): void => {
        // Once per attempt: an exit reached after the event already fired - a throw from
        // the retry path past its `willRetry: true` - must not report the attempt again.
        if (didEmitAttemptEnd) {
          return;
        }
        didEmitAttemptEnd = true;

        // Through `safeHandleCallback`, because this hook is purely observational and
        // must not be able to change the outcome it is describing. Called bare, a throw
        // from it would escape into the attempt loop and come back to the caller as
        // `status: 0` - a request killed by its own telemetry - with nothing reported
        // anywhere. It also covers a hook that returns a rejected promise, which no local
        // `try`/`catch` would.
        // Only when one was supplied - `null` is none, as in `guardProgressCallback` - since
        // `safeHandleCallback` reports a non-function on the global channel.
        if (isNullish(options.onAttemptEnd)) {
          return;
        }

        safeHandleCallback('onAttemptEnd', options.onAttemptEnd, {
          attemptNumber,
          isRetry,
          nextRetryDelayMS: undefined,
          nextRetryAt: undefined,
          ...outcome,
          requestID,
          initialURL,
          ...(hopContext
            ? {
                hopNumber: hopContext.hopNumber,
                // A copy per callback, as `redirectHistory` is copied: one that wrote to
                // it would otherwise change what every later callback of the hop is told.
                redirect: { ...hopContext.redirect },
              }
            : {}),
        });
      };

      // Only set the start timestamp on the very first attempt of the entire
      // request (attempt 1). Redirect hops reuse the original start time.
      if (attemptNumber === 1) {
        callbacks.setStartedAt(Date.now());
      } else if (!cancelSignal.aborted) {
        // Not over a cancel that landed between hops, which the check before dispatch
        // ends the request for: the state stays `cancelled` meanwhile.
        callbacks.setState('sending');
      }

      callbacks.setAttemptCount(attemptNumber);
      callbacks.setNextRetryDelayMS(null);
      callbacks.setNextRetryAt(null);
      // Observational only; see `onAttemptEnd` above for why it is guarded, and why an
      // absent hook is skipped rather than handed over.
      if (!isNullish(options.onAttemptStart)) {
        safeHandleCallback('onAttemptStart', options.onAttemptStart, {
          attemptNumber,
          isRetry,
          requestID,
          initialURL,
          ...(hopContext
            ? {
                hopNumber: hopContext.hopNumber,
                redirect: { ...hopContext.redirect },
              }
            : {}),
        });
      }

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

      // The settle deadline's teardown. Giving up on this attempt's upload at that
      // deadline fails the request as a timeout, and a timeout that left the upload
      // running would be only half of one: the per-attempt timer is cleared once `send()`
      // resolves, so a `NodeAdapter` writer parked on a slow source - given a minute by
      // its own watchdog - would go on putting bytes on a socket the caller had been told
      // was finished, and a custom adapter that ignores `requestBodySettled` would have
      // no end at all. Fired through the attempt's own controller, which `NodeAdapter`
      // answers by destroying the request and settling the outcome; the flag is not set,
      // since the attempt is already classified by the time this runs.
      const abortAttempt = (): void => {
        timeoutController.abort();
      };

      // Final signal: cancel OR timeout
      const attemptSignal = this._composeSignals(
        cancelSignal,
        timeoutController.signal,
        signalReleasers,
      );

      // Guarded before the adapter sees it. `HTTPAdapter` is a public extension point,
      // and an `'abort'` listener a custom adapter adds runs inside `builder.cancel()`,
      // `cancelAll()` or this attempt's timer - where, on an ordinary signal, a throw is
      // an uncaught exception rather than anything this client can catch. Always a
      // fresh signal (see `_composeSignals`), so nothing has listened on it yet.
      guardAbortListeners(attemptSignal, 'HTTPClient attempt abort listener');

      // End an attempt that never reached the adapter - a retry interceptor that
      // cancelled or threw, or request setup that failed. Its start event (and, once
      // armed, its timer) already belong to it, and the prior upload outcome carries over.
      const endBeforeDispatch = (
        pendingRequest: InterceptedRequest,
        outcome: {
          wasCancelled?: boolean;
          errorCode?: HTTPClientError['code'];
          adapterCause?: Error;
          cancelReason?: string;
        },
        knownBodies?: AttemptBodies | 'unbuildable',
        reportedURL?: string,
      ) => {
        clearTimeout(timeoutID);
        if (outcome.wasCancelled) {
          params.markCancelled(outcome.cancelReason);
        }
        emitAttemptEnd({ willRetry: false, status: 0 });

        return {
          adapterResponse: null,
          sentRequest: this._bestEffortAttemptRequestFromPending(
            pendingRequest,
            { timeout, maxResponseBytes },
            requestID,
            // The hop's own URL when the pending request's cannot be read, so the
            // response, the error and host-filtered observers name a real one.
            { fallbackURL: baseRequest.requestURL, reportedURL },
            knownBodies,
          ),
          attemptCount: attemptNumber,
          wasCancelled: false,
          wasTimeout: false,
          isRetriesExhausted: false,
          ...(attemptNumber === startAttempt
            ? { isHopUndispatched: true }
            : {}),
          ...outcome,
        };
      };

      // The request this attempt sends; a retry interceptor may replace it below. The
      // internal headers are applied to it per attempt, in `_buildAttemptRequest`, so they
      // need not survive a redirect's cross-origin header stripping.
      let attemptRequest: ResolvedRequest = baseRequest;

      // Run retry-phase interceptors before each reattempt so they can refresh
      // headers or rewrite the request. On redirect hops, the phase includes
      // redirect context so interceptors know which hop is being retried.
      if (isRetry) {
        const retryPhase: InterceptorPhase = {
          type: 'retry',
          attempt: attemptNumber,
          maxAttempts: maxAttemptNumber,
          ...(hopContext?.redirect
            ? { redirect: { ...hopContext.redirect } }
            : {}),
        };
        // Left unset by a failure that a cancel made first turns into that cancel.
        let retryIntercept: ResolvedRequest | InterceptorCancel | undefined;
        let failedRetryRequest: InterceptedRequest = baseRequest;
        // Whether the interceptors' request is held to the hop's own; see below.
        let isRetryHeld = false;
        const retryInputHeaders = this._withInternalRequestHeaders(
          baseRequest.headers,
          requestID,
          attemptNumber,
        );
        // The record the interceptors are handed as it is - built for this retry, it needs
        // no copy (see `handedRequestPreparer`) - so its names are taken before the chain
        // runs: an interceptor may write into it, which would otherwise make a header it
        // added look like one it was given.
        const retryInputHeaderNames = new Set(Object.keys(retryInputHeaders));
        // The interceptors are handed a copy of the hop's body (see `copyRequestBody`):
        // the hop's own is the body every attempt of the hop starts from, and an
        // interceptor that added a field to it in place -
        // `request.body.token = ...; return request` - would otherwise add it again on
        // every later retry, and on a hop to an origin the caller never chose send that
        // field to the host the server chose, past the check below, which compares
        // identities. Taken only once an interceptor's function is about to be called, so
        // the filters up to and including that interceptor's - the parent client's
        // chain's included - read the hop's own body; filters after it read the copy, or
        // whatever that interceptor returned. A retry no interceptor's function runs for
        // takes none.
        const retryBodyCopy: HandedBodyCopy = {
          isTaken: false,
          didFail: false,
        };
        const prepareRetryRequest = handedRequestPreparer(retryBodyCopy, {
          headers: false,
          body: true,
        });
        // Whether this hop is on an origin the caller never chose, where a retry-phase
        // request is held to the hop's own URL, body and headers (see below).
        const isHopOnUnchosenOrigin =
          hopContext !== undefined &&
          isCrossOrigin(credentialScope.url, baseRequest.requestURL);
        // Whether a retry-phase request with this URL is held to the hop's own request:
        // on a hop to an origin the caller never chose, one the interceptors left on the
        // hop's host and did not send back to the caller's own origin. A URL that is not
        // a string, or names no host, chose no destination.
        const isHeldToHop = (requestURL: unknown): boolean => {
          if (!isHopOnUnchosenOrigin) {
            return false;
          }

          if (typeof requestURL !== 'string') {
            return true;
          }

          const host = comparableHost(requestURL);
          return (
            (host === '' || host === comparableHost(baseRequest.requestURL)) &&
            isCrossOrigin(credentialScope.url, requestURL)
          );
        };

        try {
          const retryRun = await this._runInterceptors(
            {
              ...baseRequest,
              headers: retryInputHeaders,
            },
            retryPhase,
            { initialURL, redirectHistory, requestID, attemptNumber },
            () => cancelSignal.aborted,
            (failed) => {
              failedRetryRequest = failed;
            },
            prepareRetryRequest,
          );

          // Snapshotted as the initial phase in `_execute` does, and skipped on the
          // same condition; see there.
          if (!retryRun.isIntercepted) {
            retryIntercept = retryRun.result;
          } else if (isInterceptorCancel(retryRun.result)) {
            retryIntercept = retryRun.result;
          } else {
            failedRetryRequest = retryRun.result;
            retryIntercept = snapshotInterceptedRequest(retryRun.result);
          }

          if (!isInterceptorCancel(retryIntercept)) {
            failedRetryRequest = retryIntercept;
            // The GET and HEAD rule once the copy is taken; see the initial phase's in
            // `_execute`.
            this._assertRequestShapeIsSupported(retryIntercept);
            this._assertInterceptorResolvedURL(retryIntercept.requestURL);
            isRetryHeld =
              retryRun.isIntercepted && isHeldToHop(retryIntercept.requestURL);
            // The attempt's body, and a `307`/`308` replay's; see `copyChainResultBody`.
            // A request held to the hop's own sends the hop's body, never this one, which
            // is only asked whether it sends anything (see
            // `withoutAddedCrossOriginCredentials`), so it is not copied, and the GET and
            // HEAD rule reads the request as it is sent, below.
            if (!isRetryHeld) {
              if (retryRun.isBodyHandedOut) {
                retryIntercept = this._copyChainResultBody(
                  retryIntercept,
                  retryBodyCopy,
                );
                failedRetryRequest = retryIntercept;
              }
              this._assertRequestBodyFitsMethod(retryIntercept);
            }
          }
        } catch (error) {
          // A cancel made before the failure ends the attempt as the cancel below does,
          // as the initial phase's does; see there.
          if (!cancelSignal.aborted) {
            // Terminal failure — no further attempts. _execute notifies error observers
            // with phase `final` (same as all settled errors), not `retry`. A body that
            // could not be copied is the body's failure, as one that cannot be serialized
            // is, not an interceptor's, but on a GET or HEAD the rule refuses (see
            // `_copyChainResultBody`). On a hop held to its own request, reported as that
            // request, as a stripped attempt would have gone out: the interceptors' carries
            // what they added - a token in the URL or a header - and the response, the error
            // and host-filtered observers would name a credentialed request to the host the
            // server chose. The URL is read once and the one read is reported, so a getter
            // answering differently on a second read cannot name the hop with what the
            // interceptors added.
            const failedRetryURL = readObjectMember(
              failedRetryRequest,
              'requestURL',
            );
            const isHeld = isHeldToHop(failedRetryURL);

            return endBeforeDispatch(
              isHeld ? baseRequest : failedRetryRequest,
              {
                errorCode: isBodyCopyFailure(retryBodyCopy, error)
                  ? 'request_setup_error'
                  : 'interceptor_error',
                adapterCause: normalizeError(error),
              },
              // A body that failed to copy is reported as it came, not read again; the
              // hop's own is reported built.
              retryBodyCopy.didFail && !isHeld ? 'unbuildable' : undefined,
              !isHeld && typeof failedRetryURL === 'string'
                ? failedRetryURL
                : undefined,
            );
          }
        }

        // A cancel that landed while they ran, or while their result was copied, ends the
        // attempt as theirs does, reported as the hop's own request.
        const retryEnd = endInterceptorPhase(retryIntercept, cancelSignal);
        if (retryEnd.isCancelled) {
          const retryCancelReason = retryEnd.cancelReason;
          return endBeforeDispatch(baseRequest, {
            wasCancelled: true,
            ...(retryCancelReason !== undefined
              ? { cancelReason: retryCancelReason }
              : {}),
          });
        }

        // On a redirect hop to an origin the caller never chose, the retry-phase
        // interceptors - the parent client's included, which run in the same chain - may
        // not add a credential: the hop's own headers were already cut to the
        // cross-origin safelist, and a token interceptor registered for
        // `['initial', 'retry']` with no `hosts` filter would otherwise hand its token to
        // whatever host the server redirected to, the moment that host answers `503`. A
        // header the hop already carried keeps the value the interceptor gives it: a
        // redirect-phase interceptor added it for a target it trusts, and refreshing it
        // is that interceptor's business. Nor may they put one anywhere else that reaches
        // that host: the hop goes out with its own URL - an `?access_token=` added to it
        // would otherwise go along; only an upgrade to `https:` is kept - and its own
        // body, a field added to a `307`/`308` replay included. A host the interceptor
        // names itself is an explicit choice of destination, as the credential scope
        // reads it below, so it is left alone. So is a hop the server kept on the
        // caller's own origin, which is no origin the caller never chose, and a retry the
        // interceptor sends back to exactly that origin. Stripped silently, as
        // `_sanitizeRedirectRequest` strips the hop's own.
        if (isRetryHeld) {
          try {
            attemptRequest = withoutAddedCrossOriginCredentials(
              retryEnd.request,
              retryInputHeaderNames,
              baseRequest,
            );
          } catch (error) {
            // Telling whether the hop's body or the interceptors' sends nothing reads it -
            // the interceptors' is the value they returned, uncopied - and a body that
            // cannot be read fails here as it fails being built on any other hop: as the
            // request's setup, with the attempt it already started ended. Reported as
            // the hop's own request, as a stripped attempt would have gone out: the
            // interceptors' carries what they added - a token in the URL or a header - and
            // the response, the error and host-filtered observers would name a
            // credentialed request to the host the server chose.
            return endBeforeDispatch(baseRequest, {
              errorCode: 'request_setup_error',
              adapterCause: normalizeError(error),
            });
          }

          // Checked as it is sent: the hop's body, or none, with the interceptors' method
          // - a GET or HEAD refused for a body the hop sends, never for one of theirs that
          // is not. The hop's own request passed these checks, so a refusal is of what
          // they changed: their failure, reported as the hop's own request.
          try {
            this._assertRequestIsSupported(attemptRequest);
          } catch (error) {
            return endBeforeDispatch(baseRequest, {
              errorCode: 'interceptor_error',
              adapterCause: normalizeError(error),
            });
          }
        } else {
          attemptRequest = retryEnd.request;
        }
      }

      // A cancel that landed while the caller's own callbacks ran - an interceptor, a
      // redirect-phase observer - ends the request here, as the settle wait answers one
      // that landed during a backoff, rather than handing the adapter a signal it may
      // not check before it answers.
      if (cancelSignal.aborted) {
        const signalReason = getSignalCancelReason(cancelSignal);
        return endBeforeDispatch(attemptRequest, {
          wasCancelled: true,
          ...(signalReason !== undefined ? { cancelReason: signalReason } : {}),
        });
      }

      // Armed after the retry-phase interceptors, as the initial phase's run before any
      // attempt is timed: one that refreshes a token on a retry does not spend the
      // attempt's timeout, and cannot time the attempt out before it is sent.
      if (timeout > 0) {
        timeoutID = setTimeout(() => {
          isTimedOut = true;
          timeoutController.abort();
        }, timeout);
      }

      let sentRequest: AttemptRequest;
      // The body handed to the adapter: the client's own, not the observers' `body`.
      let sentBody: AttemptRequest['body'];
      // What the snapshot of a failed setup may reuse: the bodies once built, or
      // `unbuildable` while building them is what is under way.
      let knownBodies: AttemptBodies | 'unbuildable' | undefined;
      try {
        // Only a host change explicitly selects a new credential destination.
        // Editing a redirected URL's path, query or fragment must not authorize the
        // server-selected origin. Preserve this scope without changing observer URLs.
        // A change of scheme or port alone keeps the host the server chose - an "upgrade
        // to https on retry" interceptor - so it does not hand that host the identity
        // either; only a different host is the caller choosing a destination.
        // A URL that names no host chooses no destination, as `isHeldToHop` reads it, so
        // it leaves the scope where it was.
        const attemptHost = comparableHost(attemptRequest.requestURL);
        if (
          !hopContext ||
          (isRetry &&
            attemptHost !== '' &&
            comparableHost(baseRequest.requestURL) !== attemptHost)
        ) {
          credentialScope.url = attemptRequest.requestURL;
        }

        knownBodies = 'unbuildable';
        // The observers' bodies are built here, once, and only when an observer is
        // registered to be handed them: copying bytes or a form, or parsing JSON back,
        // for an attempt nothing looks at is waste.
        const attemptBodies = buildAttemptBodies(
          attemptRequest.body,
          this._hasAttemptRequestObservers(),
        );
        knownBodies = attemptBodies;
        sentBody = attemptBodies.sentBody;
        params.sentBody.value = attemptRequest.body;
        sentRequest = this._buildAttemptRequest(attemptRequest, attemptBodies, {
          requestID,
          timeout,
          maxResponseBytes,
          attemptNumber,
          cookieJar,
        });
      } catch (error) {
        // Serialization and cookie/header preparation precede adapter dispatch. The
        // snapshot reuses the bodies built here, or skips a build that already failed.
        return endBeforeDispatch(
          attemptRequest,
          {
            errorCode: 'request_setup_error',
            adapterCause: normalizeError(error),
          },
          knownBodies,
        );
      }

      // Whether this attempt has a body to send, read once; see `sendsRequestBody`.
      const isBodySent = sendsRequestBody(sentBody);
      // And it is the response's from here, whether or not it reports one: an upload
      // whose fate the adapter never told is not an earlier attempt's that it did.
      if (isBodySent) {
        params.latestUpload.outcome = undefined;
      }

      const onUploadProgress = options.onUploadProgress;
      const onDownloadProgress = options.onDownloadProgress;

      let observedSentRequest: AttemptRequest = sentRequest;
      let responseUploadOutcome: Promise<Error | undefined> | undefined;
      // Set once `send()` resolves. The server has answered by then, so a throw from
      // reading or normalizing that answer (a getter, a header value whose conversion
      // throws, a `Set-Cookie` the jar cannot take, a body that cannot be decoded) is the
      // adapter's malformed response, not a transport failure: the catch below reports it
      // without re-sending. The rest of the attempt after `send()` is the client's own
      // code, the caller's observers and attempt hooks being contained where they run,
      // with one exception: the cookie jar is the caller's, so a jar that throws on its
      // own account is reported here as an `adapter_error` too - the request was still
      // answered, which is what rules out re-sending it. So is one whose answer arrived
      // after the attempt's timer fired: only the timer's own `AbortError` surfacing while
      // the answer is read makes it a timeout, retried only where a timeout is.
      let didAdapterResolve = false;
      // Set when the caller's cookie jar is what threw, so the error says so.
      let didCookieJarFail = false;
      // The status that answer carried, so `onAttemptEnd` and the final response report
      // it rather than `0` when a throw after `send()` resolved ends the attempt, and its
      // headers once they have been normalized.
      let answeredStatus = 0;
      let answeredHeaders: Record<string, string | string[]> = {};
      // The adapter's own redirect fields, once its response has been copied.
      let answeredRedirectFields: AdapterRedirectFields | undefined;

      // Dispatch counts as activity, so the settle wait's stall clock starts from the
      // moment this attempt's upload could have begun rather than from a report on some
      // earlier hop - or, for an adapter that never reports progress, from the start of
      // the request. The wait checks the clock on entry (see
      // `settleUploadBeforeNextDispatch`), and without this stamp a progress-less
      // adapter's second hop would already be "quiet" for the whole of the first. A
      // source wait an earlier attempt's writer never came back from is not this
      // attempt's either. The number is this dispatch's, so a report from an earlier
      // attempt's writer - progress, or a source wait - still arriving once this one went
      // out is not taken for this attempt's.
      const dispatchNumber = noteUploadDispatch(uploadActivity);

      // Whether this attempt handed its body to the caller's stream: a stream error after
      // that is no whole answer - part of the body is in the caller's sink - whatever the
      // adapter reports, so it is never retried or followed as a failed decode.
      let didCallStreamFactory = false;
      // What the factory answered, so an attempt abandoned after it started a stream - a
      // sink, or one still on its way - is not retried either (see the catch below): a
      // retry would open a second sink for the request. A factory that threw, or answered
      // `null` or a cancel, at once or through its promise, started none. What an answer
      // is gets decided only once the attempt is abandoned (see
      // `tearDownStreamFactoryAnswer`), so an attempt that is not reads nothing of it
      // beside the adapter's own reads.
      let streamFactoryState: StreamFactoryState = 'none';
      let streamFactoryAnswer: object | undefined;
      // The status the adapter announced to the factory, for the stream error an
      // abandoned attempt ends as.
      let streamFactoryStatus = 0;
      // Set once the attempt has given up on the adapter (see `awaitAdapterSend`): the
      // hooks it was handed are dead from then on, so an adapter that calls them late
      // reaches none of the caller's, opens no sink beside a retry's, and does not make
      // the next attempt's upload look active to the settle wait.
      let isAbandoned = false;

      try {
        // Adopted, not awaited as it is: `HTTPAdapter` is a public extension point, and
        // an adapter answering with a native promise carrying its own `constructor` and
        // a no-op `then` would hang the request, its rejection unhandled. See
        // `adoptPromise()`.
        const streamResponse = options.streamResponse;
        const adapter = this._adapter;
        // Read once, before the request is built as a call reads it, and called as read:
        // whether the body is copied for it is decided by the function handed it.
        const send: unknown = Reflect.get(adapter, 'send');
        const adapterRequest: AdapterRequest = {
          requestURL: sentRequest.requestURL,
          method: sentRequest.method,
          // Its own copy, arrays too: an adapter that changes one in place reaches
          // neither the request observers are handed nor the next attempt.
          headers: copyHeaderRecord(sentRequest.headers),
          body: adapterRequestBody(adapter, send, sentBody),
          signal: attemptSignal,
          // Forward the builder's streaming factory to each adapter attempt.
          // NodeAdapter invokes it only for a 200 response with a body, letting the caller
          // create attempt-local writable state when a retry happens.
          // Called on the receiver the adapter calls it on, so a factory reading `this`
          // reads the receiver it would if the adapter called it directly.
          streamResponse:
            typeof streamResponse === 'function'
              ? function (
                  this: unknown,
                  ...args: Parameters<typeof streamResponse>
                ) {
                  // A cancel, as the factory's own `null` is: no sink is opened.
                  if (isAbandoned) {
                    return null;
                  }
                  didCallStreamFactory = true;
                  const announcedStatus = readObjectMember(args[0], 'status');
                  if (
                    typeof announcedStatus === 'number' &&
                    Number.isInteger(announcedStatus) &&
                    announcedStatus >= 100 &&
                    announcedStatus <= 999
                  ) {
                    streamFactoryStatus = announcedStatus;
                  }
                  const returned: unknown = Reflect.apply(
                    streamResponse,
                    this,
                    args,
                  );
                  const watched = watchStreamFactoryAnswer(
                    returned,
                    (answer) => {
                      // A promise's answer. Once the attempt is abandoned the state
                      // has been read, and a sink arriving then is torn down at once.
                      if (isAbandoned) {
                        if (answer !== undefined) {
                          tearDownStreamFactoryAnswer(answer);
                        }
                      } else if (answer === undefined) {
                        streamFactoryState = 'none';
                      } else {
                        streamFactoryState = 'answered';
                        streamFactoryAnswer = answer;
                      }
                    },
                  );
                  streamFactoryState = watched.state;
                  streamFactoryAnswer = watched.answer;
                  return returned as ReturnType<typeof streamResponse>;
                }
              : streamResponse,
          // attemptNumber and requestID are passed so NodeAdapter can populate
          // StreamResponseInfo without the adapter needing to track attempt state
          // itself.
          attemptNumber,
          requestID: requestID,
          // Every adapter stops reading a buffered body past it; a streamed one is
          // not held, so it is not limited. See `AdapterRequest.maxResponseBytes`.
          maxResponseBytes,
          // The origin the caller addressed, so an adapter can tell a redirect hop to
          // another host from the request it was configured for. See
          // `AdapterRequest.initialURL`.
          initialURL: credentialScope.url,
          // Handed over for a bodied request whether or not the caller asked for
          // progress: the stamp is what lets the wait on `requestBodySettled` tell an
          // upload that is still moving from one that has stalled. A bodiless request
          // has no upload to watch, so the adapter is told nothing it was not told before.
          // Nor is an `xhr` adapter, unless the caller asked: `XHRAdapter` reports no
          // `requestBodySettled` to wait on, and a hook makes it listen on
          // `xhr.upload`, which makes a browser preflight a cross-origin upload `fetch`
          // would send without one. A custom `xhr` adapter that does report one has
          // its wait bounded flat from dispatch.
          // The caller's hooks are guarded here, as `onAttemptStart`/`onAttemptEnd` are,
          // not left to the adapter: a custom adapter that calls them bare would have a
          // throwing hook fail - and retry - a request that succeeded.
          onUploadProgress:
            onUploadProgress ||
            ((sentBody ?? null) !== null && this._adapterType !== 'xhr')
              ? (e) => {
                  if (isAbandoned) {
                    return;
                  }

                  if (uploadActivity.dispatches === dispatchNumber) {
                    noteUploadProgress(uploadActivity);
                  }

                  if (onUploadProgress) {
                    safeHandleCallback('onUploadProgress', onUploadProgress, {
                      ...e,
                      attemptNumber,
                      ...(hopContext
                        ? { hopNumber: hopContext.hopNumber }
                        : {}),
                    });
                  }
                }
              : undefined,
          onDownloadProgress: onDownloadProgress
            ? (e) => {
                if (isAbandoned) {
                  return;
                }
                safeHandleCallback('onDownloadProgress', onDownloadProgress, {
                  ...e,
                  attemptNumber,
                  ...(hopContext ? { hopNumber: hopContext.hopNumber } : {}),
                });
              }
            : undefined,
        };
        // Told when the adapter's body writer parks on its source and when it comes back,
        // for the wait on this attempt's upload: a writer waiting on a slow
        // `Blob.stream()` read reports no progress, and is not stalled. Only for a form:
        // `NodeAdapter`'s multipart writer is the only one that reads a source as it
        // goes. See `listenForUploadSourceWait`, and `lastUploadActivityAt` for how long
        // the client takes the adapter's word. Dead once the attempt is abandoned, as the
        // progress hook is - the wait it was in is ended there - and once a later attempt
        // is dispatched: a writer still parked from an earlier one does not make that
        // attempt's upload look busy.
        if (isFormData(sentBody)) {
          listenForUploadSourceWait(adapterRequest, (isWaiting) => {
            if (!isAbandoned && uploadActivity.dispatches === dispatchNumber) {
              noteUploadSourceWait(uploadActivity, isWaiting);
            }
          });
        }
        const adapterPromise = adoptPromise(
          Reflect.apply(send as HTTPAdapter['send'], adapter, [adapterRequest]),
        );
        // Raced against the attempt's own abort, so a timeout or a cancel ends the
        // attempt even when the adapter ignores its signal and never settles: awaited
        // bare, neither would end it, and `send()` would hang for good. See
        // `awaitAdapterSend`.
        const { value: rawAdapterResponse } = await awaitAdapterSend(
          adapterPromise,
          attemptSignal,
          () =>
            cancelSignal.aborted
              ? readObjectMember(cancelSignal, 'reason')
              : timeoutController.signal.reason,
          () => {
            isAbandoned = true;
            // The listener is dead from here, so a source wait it was told of would never
            // be told to end: it ends now, as far as the wait on this upload goes.
            if (uploadActivity.dispatches === dispatchNumber) {
              noteUploadSourceWait(uploadActivity, false);
            }
            // The adapter that ignored the abort will not tear down the sink it was
            // writing to, as a well-behaved one does on a timeout or cancel, so the
            // client does - the caller's `'close'` and `'error'` listeners on it run -
            // after a timeout or a cancel alike.
            if (
              streamFactoryState === 'answered' &&
              streamFactoryAnswer !== undefined
            ) {
              streamFactoryState =
                tearDownStreamFactoryAnswer(streamFactoryAnswer);
              streamFactoryAnswer = undefined;
            }
            // A late answer's upload outcome, or one tagged on a late rejection, is
            // adopted only to observe it: nothing reads it, and a rejection of it is not
            // left unhandled. Both helpers read through guards and never throw.
            void adapterPromise.then(
              ({ value }) => {
                void adoptRequestBodySettled(
                  readObjectMember(value, 'requestBodySettled'),
                );
              },
              (error: unknown) => {
                void getRequestBodySettled(error);
              },
            );
          },
        );
        didAdapterResolve = true;

        // Observe the upload before any other response getter or normalization can
        // throw. Keep it outside this try so failures still expose the upload outcome.
        // Advisory metadata: an accessor that throws is treated as absent, as an
        // unreadable return is, rather than failing (and retrying) an answered request.
        const rawUploadOutcome = readObjectMember(
          rawAdapterResponse,
          'requestBodySettled',
        );
        if (rawUploadOutcome !== undefined) {
          responseUploadOutcome = adoptRequestBodySettled(rawUploadOutcome);
          params.latestUpload.outcome = responseUploadOutcome;
        }
        const headers = rawAdapterResponse.headers;
        // Advisory as well, and read under the same rule: it only feeds observers (see
        // `snapshotHeaderRecord` below), so a throwing accessor means absent.
        const effectiveRequestHeaders = readObjectMember(
          rawAdapterResponse,
          'effectiveRequestHeaders',
        );
        // Copy enumerable fields with their original receiver, excluding the three
        // fields already read. A spread would invoke the upload getter twice.
        const adapterResponse = {
          headers,
          ...(effectiveRequestHeaders !== undefined
            ? { effectiveRequestHeaders }
            : {}),
          ...(responseUploadOutcome
            ? { requestBodySettled: responseUploadOutcome }
            : {}),
        } as AdapterResponse;
        for (const key of Reflect.ownKeys(rawAdapterResponse)) {
          if (
            key === 'requestBodySettled' ||
            key === 'headers' ||
            key === 'effectiveRequestHeaders'
          ) {
            continue;
          }
          if (
            Object.getOwnPropertyDescriptor(rawAdapterResponse, key)?.enumerable
          ) {
            defineEntry(
              adapterResponse as unknown as Record<string, unknown>,
              key,
              Reflect.get(rawAdapterResponse, key),
            );
          }
        }
        // The other answer fields are read through the receiver when they are not own
        // fields, as `headers` is: a class-instance answer whose fields are prototype
        // getters is read whole - its status, and its error flags with it - rather than
        // as a status-less or error-free success.
        for (const key of ADAPTER_RESPONSE_FIELDS) {
          if (!Object.hasOwn(adapterResponse, key)) {
            const value: unknown = Reflect.get(rawAdapterResponse, key);
            if (value !== undefined) {
              defineEntry(
                adapterResponse as unknown as Record<string, unknown>,
                key,
                value,
              );
            }
          }
        }
        // Refused as the adapter's malformed answer - the answered request's non-retryable
        // adapter_error - rather than delivered as a success with no real status.
        const candidateStatus: unknown = adapterResponse.status;
        if (
          typeof candidateStatus !== 'number' ||
          !Number.isInteger(candidateStatus) ||
          candidateStatus < 0 ||
          candidateStatus > 999
        ) {
          throw new TypeError(
            `HTTPClient adapter answered with an invalid status (got ${typeof candidateStatus === 'number' ? String(candidateStatus) : typeof candidateStatus})`,
          );
        }
        answeredStatus = candidateStatus;
        // The answer's flags are booleans, and read as booleans from here on: anything
        // else from a plain-JS adapter - a `'false'` string, a `1` - is dropped as unset
        // rather than read by truthiness, where
        // `{ status: 0, wasRedirectDetected: 'false' }` would end as a non-retryable
        // `redirect_disabled` reporting the string.
        for (const flag of ADAPTER_RESPONSE_FLAGS) {
          if (
            Object.hasOwn(adapterResponse, flag) &&
            typeof adapterResponse[flag] !== 'boolean'
          ) {
            delete adapterResponse[flag];
          }
        }
        // An adapter's own redirect target is held to the rule the built-in adapters
        // resolve one by (`reportedRedirectTarget`): no userinfo on a target of another
        // origin than the URL it answered, nor that URL's own userinfo. Anything but a
        // string - a `URL` object from a plain-JS adapter - is dropped rather than handed
        // on unchecked; the target is then derived from `Location`, as for an adapter
        // that names none.
        if (typeof adapterResponse.detectedRedirectURL === 'string') {
          adapterResponse.detectedRedirectURL = reportedRedirectTarget(
            adapterResponse.detectedRedirectURL,
            sentRequest.requestURL,
          );
        } else if (adapterResponse.detectedRedirectURL !== undefined) {
          delete adapterResponse.detectedRedirectURL;
        }
        answeredRedirectFields = adapterResponse;
        if (didCallStreamFactory && adapterResponse.isStreamError === true) {
          adapterResponse.isStreamed = true;
        }
        adapterResponse.headers = normalizeAdapterResponseHeaders(headers);
        answeredHeaders = adapterResponse.headers;

        // Held to `maxResponseBytes` here as well as in the adapter: the built-in ones stop
        // reading at the limit, but a custom adapter may hand over a body of any size, and
        // the limit is the client's promise, not only theirs.
        const answeredBody: unknown = adapterResponse.body;
        // A bodiless answer (a `HEAD`, a `204`) has no body, as no adapter hands one
        // over: a custom adapter's stray one there is dropped rather than delivered -
        // and decoded - past the limit.
        if (
          adapterResponse.isStreamed !== true &&
          answeredBody !== null &&
          answeredBody !== undefined &&
          !hasResponseBody(sentRequest.method, adapterResponse.status)
        ) {
          adapterResponse.body = null;
        } else if (
          adapterResponse.isStreamError !== true &&
          adapterResponse.isStreamed !== true &&
          // A plain `ArrayBuffer` or a string too: outside the type, but `_buildResponse`
          // delivers either, so they are bodies the limit must see.
          isAnsweredBodyOverLimit(answeredBody, maxResponseBytes)
        ) {
          adapterResponse.body = null;
          adapterResponse.isStreamError = true;
          adapterResponse.streamErrorCode = 'response_too_large';
          adapterResponse.errorCause = makeResponseTooLargeError(
            maxResponseBytes,
            false,
          );
        }

        // A redirect about to be followed whose body only failed to decode - a server that
        // labels its small "Moved" page `gzip` and sends it plain - or was past
        // `maxResponseBytes` - a "Moved" page larger than the limit - is the redirect it
        // says it is: a browser never reads a body it is about to leave, so neither can
        // fail it. Read as a bodiless 3xx from here on, so nothing of the failure reaches
        // the observers, the hop's error code, or a later hop's.
        if (
          this._config.followRedirects &&
          adapterResponse.isTransportError !== true &&
          REDIRECT_STATUS_CODES.has(adapterResponse.status) &&
          scalarHeader(adapterResponse.headers, 'location') &&
          isStatusOnlyStreamError(adapterResponse)
        ) {
          adapterResponse.body = null;
          delete adapterResponse.isStreamError;
          delete adapterResponse.streamErrorCode;
          delete adapterResponse.errorCause;
        }

        // Copied through the same guard the throw path uses: the record only feeds
        // observers, so a malformed or unreadable one is treated as absent.
        const observedEffectiveHeaders = snapshotHeaderRecord(
          effectiveRequestHeaders,
        );

        observedSentRequest = observedEffectiveHeaders
          ? {
              ...sentRequest,
              headers: mergeObservedHeaders(
                sentRequest.headers,
                observedEffectiveHeaders,
              ),
            }
          : sentRequest;

        // A transport failure answered once the attempt's timer had fired is that timer's
        // abort, as a rejection then is (below): a custom adapter may resolve
        // `isTransportError` for it rather than reject, which would otherwise be retried
        // and reported as a network_error with `isTimeout: false`. Raised as the timer's
        // own abort so the catch reads it as the timeout. An adapter veto stays its own.
        // A bare `status: 0` too, wherever the client reads one as a transport failure
        // whether or not `isTransportError` says so: not a stream error, which
        // `_buildResponse` reads as one, nor a browser's opaque redirect where redirects
        // are off, which is the answer `redirect_disabled` reports. With redirects on,
        // that redirect has nowhere to go and is the transport failure below.
        const isLateTransportFailure =
          isTimedOut &&
          (adapterResponse.isTransportError === true ||
            (adapterResponse.status === 0 &&
              adapterResponse.isStreamError !== true &&
              (adapterResponse.wasRedirectDetected !== true ||
                this._config.followRedirects))) &&
          adapterResponse.isRetryable !== false;

        // Store Set-Cookie before retry/backoff so the next attempt matches browsers
        // and curl (cookies from error responses apply to follow-up requests). A late
        // transport failure's too: the adapter did answer, within the grace an attempt
        // waits for it after the timer, and the answer's `Set-Cookie` is stored as an
        // in-time one's is. Only an abandoned attempt's answer is ignored, and that one
        // never reaches here.
        if (cookieJar) {
          try {
            cookieJar.processResponseHeaders(
              adapterResponse.headers,
              sentRequest.requestURL,
            );
          } catch (jarError) {
            // The timeout wins, as it does over a jar failure on a stream the timer
            // cut: the attempt is reported as the timeout it is.
            if (!isLateTransportFailure) {
              // Still the answered response's adapter_error below, named for the jar.
              didCookieJarFail = true;
              throw jarError;
            }
          }
        }

        if (isLateTransportFailure) {
          throw timeoutController.signal.reason;
        }

        clearTimeout(timeoutID);

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
          emitAttemptEnd({
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
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

        // A non-idempotent method may only be replayed on a transport outcome
        // where the adapter proves no request bytes reached the server. The proof
        // is `wasDefinitelyNotSent`, not `isRetryable` — that flag only ever
        // defined `false`, so `true` claims nothing about delivery. On a real
        // response delivery is settled the other way: the server answered, so the
        // handler may have committed. Silence is treated as unsafe.
        // Only an explicit `isTransportError`: a bare `status: 0` is reported as a network
        // error, but the proof that unlocks a replay is not read off it - withholding a
        // retry is the safe side of that doubt.
        const isTransportOutcome = adapterResponse.isTransportError === true;

        const isMethodReplayable =
          allowNonIdempotentRetry ||
          IDEMPOTENT_METHODS.has(sentRequest.method) ||
          (isTransportOutcome && adapterResponse.wasDefinitelyNotSent === true);

        // Why a retry did not happen, for observers. Only meaningful when the
        // status alone would have allowed one — otherwise nothing was
        // suppressed and there is nothing to explain.
        const retrySuppressedReason =
          isRetryAvailable() &&
          RETRYABLE_STATUS_CODES.has(adapterResponse.status) &&
          !cancelSignal.aborted
            ? adapterResponse.isRetryable === false
              ? ('adapter_veto' as const)
              : adapterResponse.isStreamError &&
                  !isStatusOnlyStreamError(adapterResponse)
                ? ('stream_error' as const)
                : !isMethodReplayable
                  ? ('non_idempotent_method' as const)
                  : undefined
            : undefined;

        // Check if should retry based on status code.
        // Stream failures are terminal even when status is retryable (e.g. 0). Except
        // where only the body failed and none of it reached the caller - see
        // `isStatusOnlyStreamError` - so its status asks for a retry as it would with a
        // readable body.
        if (
          policy &&
          adapterResponse.isRetryable !== false &&
          (!adapterResponse.isStreamError ||
            isStatusOnlyStreamError(adapterResponse)) &&
          isMethodReplayable &&
          RETRYABLE_STATUS_CODES.has(adapterResponse.status) &&
          !cancelSignal.aborted
        ) {
          const { shouldRetry, delayMS } = policy.shouldRetry(
            new Error(`HTTP ${adapterResponse.status}`),
          );
          const nextRetryAt = shouldRetry ? Date.now() + delayMS : undefined;
          // The delay's start on the monotonic clock: what is left of it after the
          // retry-phase observers is measured here, so a wall-clock step cannot stretch
          // or skip it.
          const retryDelayStartedAt = performance.now();

          // Built before the retry is committed or announced: building decodes the body,
          // and a body that cannot be decoded ends this attempt in the catch below as an
          // adapter_error, reported to `onAttemptEnd` once with `willRetry: false`.
          const retryHTTPResponse = shouldRetry
            ? this._buildResponse({
                adapterResponse,
                requestID,
                wasCancelled: false,
                wasTimeout: false,
                adapterType: this._adapterType,
                initialURL,
                requestURL: sentRequest.requestURL,
                redirectHistory,
              })
            : undefined;

          if (shouldRetry) {
            callbacks.setNextRetryDelayMS(delayMS);
            callbacks.setNextRetryAt(nextRetryAt ?? null);
            callbacks.setState('waiting_for_retry');
          }

          emitAttemptEnd({
            willRetry: shouldRetry,
            nextRetryDelayMS: shouldRetry ? delayMS : undefined,
            nextRetryAt,
            status: adapterResponse.status,
          });

          if (retryHTTPResponse) {
            // Not for a retry a cancel from that `onAttemptEnd` has already called off;
            // the delay below answers the cancel.
            if (!cancelSignal.aborted) {
              await this._runResponseObservers(
                retryHTTPResponse,
                observedSentRequest,
                this._retryOutcomePhase(
                  maxAttemptNumber,
                  attemptNumber,
                  hopContext?.redirect,
                ),
              );
            }

            // What is left of the delay once the observers are done: `nextRetryAt` was
            // published to `onAttemptEnd` and the builder before they ran, and waiting
            // the whole delay after them would start the retry late by however long they
            // took.
            await this._cancellableDelay(
              Math.max(0, delayMS - (performance.now() - retryDelayStartedAt)),
              cancelSignal,
            );

            // Retried only once this attempt's upload has settled, for the reason the
            // redirect loop waits before its next hop: `NodeAdapter.send()` resolves when
            // the response is consumed, and an early `503` to a bodied `PUT` arrives
            // while the writer is still running. Without this, once the backoff elapsed
            // attempt two would be dispatched with attempt one's body still going out on
            // its own socket - a second upload of the same body beside the first, the
            // double-send the redirect wait exists to prevent. The outcome never rejects,
            // and it settles on every path the adapter can take: the writer's own end,
            // the stall watchdog once a response has arrived, and - for a request that
            // failed before any response, where no watchdog is ever armed - the
            // transport-error handler, which answers it rather than leaving a parked
            // writer to. The wait is also raced against the cancel signal, so a caller
            // who gives up during it is not held. After the delay rather than before it,
            // since an upload that finishes during the backoff costs nothing extra to
            // wait for.
            const wait = await settleUploadBeforeNextDispatch(
              adapterResponse.requestBodySettled,
              cancelSignal,
              timeout,
              () => lastUploadActivityAt(uploadActivity),
            );

            // A deadline fails the request as a timeout, for the reason the redirect
            // path gives: the retry would put the body on the wire beside an upload
            // nobody can say has finished.
            if (wait !== 'settled') {
              const signalReason =
                wait === 'cancelled'
                  ? getSignalCancelReason(cancelSignal)
                  : undefined;

              if (wait === 'deadline') {
                reportUploadSettleDeadline(this._adapterType, timeout, 'retry');
                abortAttempt();
              }

              return {
                adapterResponse: null,
                sentRequest: observedSentRequest,
                attemptCount: attemptNumber,
                wasCancelled: wait === 'cancelled',
                wasTimeout: wait === 'deadline',
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
          emitAttemptEnd({
            willRetry: false,
            ...(retrySuppressedReason ? { retrySuppressedReason } : {}),
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: adapterResponse.status,
          });
        }

        // Only for the failures it is documented for - a transport failure resolved
        // rather than thrown (`status: 0` included), a stream error. On an answer that
        // succeeded it is no failure's cause, and carried as one it would become the
        // cause of whatever ended the request next: a cancel or timeout between hops,
        // after the `302` that carried it.
        const responseCauseValue =
          adapterResponse.isStreamError === true ||
          adapterResponse.isTransportError === true ||
          // `status: 0`, which the client reads as a transport failure whether or not
          // `isTransportError` says so.
          adapterResponse.status === 0
            ? adapterResponse.errorCause
            : undefined;
        const responseCause: Error | undefined = isErrorValue(
          responseCauseValue,
        )
          ? responseCauseValue
          : undefined;

        // Only a stream code an adapter may report: anything else from a custom adapter -
        // another code's name (`cancelled`), a typo, a non-string - would otherwise
        // become `HTTPClientError.code` as given, and a caller branching on it would
        // misread the failure. Read as the default instead.
        const answeredStreamCode: unknown = adapterResponse.streamErrorCode;
        const streamErrorCode = adapterResponse.isStreamError
          ? answeredStreamCode === 'stream_response_error' ||
            answeredStreamCode === 'response_too_large' ||
            answeredStreamCode === 'stream_write_error'
            ? answeredStreamCode
            : 'stream_write_error'
          : undefined;

        // Observers retain the wire snapshot, but Node-generated Host and URL
        // Basic auth must not become caller headers on the next hop. The adapter
        // will regenerate them for that hop; explicit caller headers still carry
        // through same-origin redirects and caller-directed failover retries. Arrays
        // copied: taken before the redirect-phase observers are handed the attempt's
        // request, so an item one of them changes in place does not reach the next hop.
        const redirectRequestHeaders = copyHeaderRecord(
          observedSentRequest.headers,
        );
        // `accept-encoding` with them: NodeAdapter adds its own, and carried forward as a
        // caller's it would stand in the way of the `identity` a later hop's `Range` asks
        // for.
        for (const key of ['host', 'authorization', 'accept-encoding']) {
          if (Object.hasOwn(sentRequest.headers, key)) {
            redirectRequestHeaders[key] = copyArrayValue(
              sentRequest.headers[key],
            );
          } else {
            delete redirectRequestHeaders[key];
          }
        }

        // Body headers inferred by the client or adapter describe this attempt's
        // body, which a redirect interceptor may replace or remove. Carry only
        // authored values forward and infer the rest again for the next body.
        // Use the latest intercepted request, before Content-Type inference.
        // Already normalized (a `ResolvedRequest`), and only read here.
        const authoredHeaders = attemptRequest.headers;
        for (const key of ['content-length', 'content-type']) {
          if (Object.hasOwn(authoredHeaders, key)) {
            redirectRequestHeaders[key] = copyArrayValue(authoredHeaders[key]);
          } else {
            delete redirectRequestHeaders[key];
          }
        }

        return {
          adapterResponse,
          sentRequest: observedSentRequest,
          redirectRequestHeaders,
          attemptCount: attemptNumber,
          wasCancelled: false,
          wasTimeout: false,
          isRetriesExhausted,
          errorCode: streamErrorCode,
          adapterCause: responseCause,
          abortAttempt,
        };
      } catch (error) {
        clearTimeout(timeoutID);
        /**
         * The upload's own outcome, carried on the throw.
         *
         * `requestBodySettled` rides on the response object on every path the adapter
         * resolves. A throw has no response object, so the adapter tags the error
         * instead, and the outcome read off it is kept in `latestUpload` for the
         * response - a cancel, a timeout and a transport failure are exactly when a
         * caller asks whether its body made it, and an absent field answers
         * `undefined`, which is what a *completed* upload resolves with.
         */
        //
        // An attempt given up on while it had a body to send reports that its fate is
        // unknown (see `ABANDONED_UPLOAD_MESSAGE`): the adapter that ignored its abort may
        // still be writing the body, and nothing tells the client when it stops. The
        // thrown value is the abort's own reason then, not the adapter's, so it carries
        // no outcome of the adapter's to read. It is not retried either; see below.
        const isUploadAbandoned = isAbandoned && isBodySent;
        const uploadOutcome = isUploadAbandoned
          ? Promise.resolve(new Error(ABANDONED_UPLOAD_MESSAGE))
          : (responseUploadOutcome ?? getRequestBodySettled(error));
        if (uploadOutcome !== undefined) {
          params.latestUpload.outcome = uploadOutcome;
        }

        // Before any classification: if the adapter attached the response it had
        // already received, the Set-Cookie on those headers belongs in the jar.
        // Placed ahead of the branches so no arm can return past it.
        //
        // The marker is required, not just the shape — any thrown error could
        // satisfy `getResponseStreamAbortInfo` by coincidence, and this writes to
        // the cookie jar. Same gate the branch below applies.
        const abortedResponse = isResponseStreamAbortError(error)
          ? getResponseStreamAbortInfo(error)
          : undefined;
        // A `streamResponse` factory that failed, declined or was cut off while setting up
        // its sink was called for an answer whose headers had arrived, and the adapter
        // carries that answer on the error: its `Set-Cookie` is stored as a cut stream's
        // is, and a setup failure reports its status. The tag alone is not the gate - the
        // factory's own markers are, as the stream-abort marker is above.
        const isFactoryCancel =
          readObjectMember(error, STREAM_FACTORY_CANCEL_KEY) !== undefined;
        const factoryAnsweredResponse =
          abortedResponse === undefined &&
          (isFactoryCancel ||
            hasAdapterMarker(error, STREAM_FACTORY_ERROR_FLAG))
            ? getResponseStreamAbortInfo(error)
            : undefined;
        const answeredBeforeFailure =
          abortedResponse ?? factoryAnsweredResponse;

        if (cookieJar && answeredBeforeFailure) {
          try {
            cookieJar.processResponseHeaders(
              answeredBeforeFailure.headers,
              sentRequest.requestURL,
            );
          } catch (jarError) {
            // A cancel or timeout wins: here the stream was cut, by the cancel or the
            // attempt's timer, so the branches below report that outcome and the jar's
            // failure is not reported. (On the resolved path a whole answer's jar failure
            // is the answered response's adapter_error, timer or not - except a transport
            // failure answered after the timer fired, which is the timeout there too.)
            // A factory's own cancel is a cancel too.
            if (!cancelSignal.aborted && !isTimedOut && !isFactoryCancel) {
              // The jar threw on headers the server did send, so this ends as the
              // answered response's adapter_error, named for the jar, as on the
              // resolved path - not as a stream error, and never re-sent.
              emitAttemptEnd({
                willRetry: false,
                nextRetryDelayMS: undefined,
                nextRetryAt: undefined,
                status: answeredBeforeFailure.status,
              });

              return {
                adapterResponse: null,
                sentRequest: sentRequestForObservedAdapterError(
                  sentRequest,
                  error,
                  observedSentRequest,
                ),
                attemptCount: attemptNumber,
                wasCancelled: false,
                wasTimeout: false,
                isRetriesExhausted: false,
                isNetworkErrorOverride: false,
                answeredResponse: {
                  ...answeredBeforeFailure,
                  ...derivedRedirectFields(
                    sentRequest.requestURL,
                    answeredBeforeFailure.status,
                    answeredBeforeFailure.headers,
                  ),
                },
                errorMessage: COOKIE_JAR_FAILURE_MESSAGE,
                errorCode: 'adapter_error',
                adapterCause: normalizeError(jarError),
              };
            }
          }
        }

        // Once the adapter has answered, an exit below reports what it said it sent - to
        // the retry phase's error observers, the final error and a cancel alike - and,
        // through `answeredStatus`, the status it answered with.
        const reportedSentRequest = didAdapterResolve
          ? sentRequestForObservedAdapterError(
              sentRequest,
              error,
              observedSentRequest,
            )
          : sentRequest;

        // When abort(string) is called, fetch() rejects with the string itself (per Fetch spec),
        // not an AbortError. Check cancelSignal.aborted first so string-reason cancels are caught.
        if (cancelSignal.aborted && !isAbortError(error)) {
          emitAttemptEnd({
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: answeredStatus,
          });

          const signalReason = getSignalCancelReason(cancelSignal);

          return {
            adapterResponse: null,
            sentRequest: reportedSentRequest,
            attemptCount: attemptNumber,
            wasCancelled: true,
            // A cancel is the outcome, as the docs say a timeout is "instead": not both.
            wasTimeout: false,
            isRetriesExhausted: false,
            ...(signalReason !== undefined
              ? { cancelReason: signalReason }
              : {}),
          };
        }

        // An attempt given up on once its factory had started a stream is the cut stream
        // it left behind, not a timeout to retry: the answer's headers had arrived and
        // part of its body may be in the caller's sink, so a retry would open a second
        // sink for the same request. A sink still on its way counts, as it may yet open.
        // Ended as the stream error a well-behaved adapter reports when the timer cuts a
        // stream, with the status it announced to the factory. A cancel stays the cancel
        // it is, below.
        if (
          isAbandoned &&
          streamFactoryState !== 'none' &&
          !cancelSignal.aborted
        ) {
          const streamCause = normalizeError(error);

          emitAttemptEnd({
            willRetry: false,
            ...(isRetryAvailable() &&
            RETRYABLE_STATUS_CODES.has(streamFactoryStatus)
              ? { retrySuppressedReason: 'stream_error' as const }
              : {}),
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: streamFactoryStatus,
          });

          return {
            adapterResponse: {
              status: streamFactoryStatus,
              ...derivedRedirectFields(
                sentRequest.requestURL,
                streamFactoryStatus,
                {},
              ),
              headers: {},
              body: null,
              isStreamed: true,
              isStreamError: true,
              streamErrorCode: 'stream_response_error',
              errorCause: streamCause,
            },
            sentRequest,
            attemptCount: attemptNumber,
            wasCancelled: false,
            wasTimeout: isTimedOut,
            isRetriesExhausted: false,
            errorCode: 'stream_response_error',
            adapterCause: streamCause,
          };
        }

        if (isResponseStreamAbortError(error)) {
          // The marker is the gate, not the error's `name`: undici surfaces a timeout
          // during the body read as `TypeError: terminated`, and requiring the name would
          // drop the tagged status and headers, letting a post-header failure reach the
          // generic network path as a retryable `status: 0`.
          //
          // Normalized once for the cause slots below, since the tag, not the name, is
          // the gate, so it does not imply an `Error`.
          const streamCause = normalizeError(error);

          const streamSuppressionReason = (
            status: number,
          ): 'stream_error' | undefined =>
            isRetryAvailable() &&
            RETRYABLE_STATUS_CODES.has(status) &&
            !cancelSignal.aborted
              ? 'stream_error'
              : undefined;

          if (cancelSignal.aborted) {
            emitAttemptEnd({
              willRetry: false,
              nextRetryDelayMS: undefined,
              nextRetryAt: undefined,
              status: 0,
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
              // A cancel is the outcome, as the docs say a timeout is "instead": not both.
              wasTimeout: false,
              isRetriesExhausted: false,
              ...(signalReason !== undefined
                ? { cancelReason: signalReason }
                : {}),
            };
          }

          if (isTimedOut && abortedResponse) {
            const suppressedReason = streamSuppressionReason(
              abortedResponse.status,
            );

            emitAttemptEnd({
              willRetry: false,
              ...(suppressedReason
                ? { retrySuppressedReason: suppressedReason }
                : {}),
              nextRetryDelayMS: undefined,
              nextRetryAt: undefined,
              status: abortedResponse.status,
            });

            return {
              adapterResponse: {
                ...(uploadOutcome ? { requestBodySettled: uploadOutcome } : {}),
                status: abortedResponse.status,
                ...derivedRedirectFields(
                  sentRequest.requestURL,
                  abortedResponse.status,
                  abortedResponse.headers,
                ),
                headers: abortedResponse.headers,
                body: null,
                isStreamError: true,
                streamErrorCode: 'stream_response_error',
                errorCause: streamCause,
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
              adapterCause: streamCause,
            };
          }

          const fallbackSuppressedReason = streamSuppressionReason(
            abortedResponse?.status ?? 0,
          );

          emitAttemptEnd({
            willRetry: false,
            ...(fallbackSuppressedReason
              ? { retrySuppressedReason: fallbackSuppressedReason }
              : {}),
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: abortedResponse?.status ?? 0,
          });

          const fallbackStatus = abortedResponse?.status ?? 0;
          const fallbackHeaders = abortedResponse?.headers ?? {};

          return {
            adapterResponse: {
              ...(uploadOutcome ? { requestBodySettled: uploadOutcome } : {}),
              status: fallbackStatus,
              ...derivedRedirectFields(
                sentRequest.requestURL,
                fallbackStatus,
                fallbackHeaders,
              ),
              headers: fallbackHeaders,
              body: null,
              isStreamError: true,
              streamErrorCode: 'stream_response_error',
              errorCause: streamCause,
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
            adapterCause: streamCause,
          };
        }

        // An `AbortError` the stream factory threw of its own - one from the controller it
        // opens its sink with - is its failure, `stream_setup_error` below, not a cancel:
        // only a factory's `null` or `{ cancel: true }` carries the cancel tag.
        const isFactoryOwnAbort =
          hasAdapterMarker(error, STREAM_FACTORY_ERROR_FLAG) &&
          readObjectMember(error, STREAM_FACTORY_CANCEL_KEY) === undefined &&
          !cancelSignal.aborted &&
          !isTimedOut;

        // An adapter's flagged non-retryable failure is its own, whatever its name: a
        // caller's `throwIfAborted()` error it flagged is not a timeout, nor a cancel the
        // caller did not make. One the caller did make stays a cancel.
        const isFlaggedAdapterFailure = hasAdapterMarker(
          error,
          NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
        );

        if (
          isAbortError(error) &&
          !isFactoryOwnAbort &&
          (!isFlaggedAdapterFailure || cancelSignal.aborted)
        ) {
          // User/parent cancellation — never retry (even if a timeout fired in the same window).
          if (cancelSignal.aborted) {
            emitAttemptEnd({
              willRetry: false,
              nextRetryDelayMS: undefined,
              nextRetryAt: undefined,
              status: answeredStatus,
            });

            const signalReason = getSignalCancelReason(cancelSignal);
            return {
              adapterResponse: null,
              sentRequest: reportedSentRequest,
              attemptCount: attemptNumber,
              wasCancelled: true,
              // A cancel is the outcome, as the docs say a timeout is "instead": not both.
              wasTimeout: false,
              isRetriesExhausted: false,
              ...(signalReason !== undefined
                ? { cancelReason: signalReason }
                : {}),
            };
          }

          // A per-attempt timeout falls through to the timeout and network retry path
          // below, even once the adapter had answered: the attempt timed out. An
          // AbortError thrown while reading an answered response, with neither the
          // request cancelled nor the attempt timed out, is not a cancel either: it falls
          // through to the answered response's adapter_error below.
          if (!isTimedOut && !didAdapterResolve) {
            // Check for a browser-fired XHR timeout (xhr.timeout = 0 but the browser
            // has its own hard limit). Treat it the same as our own timeout so it gets
            // retried and classified as isTimeout rather than isCancelled.
            if (isXHRBrowserTimeout(error)) {
              isTimedOut = true;
              // Fall through to the normal timeout retry path below.
            } else {
              // AbortError without our timeout flag — treat as non-retryable cancel.
              // This path includes StreamResponseFactory returning null / { cancel: true }.
              const factoryCancelValue = readObjectMember(
                error,
                STREAM_FACTORY_CANCEL_KEY,
              );
              const factoryCancelReason =
                typeof factoryCancelValue === 'string'
                  ? factoryCancelValue
                  : undefined;
              params.markCancelled(factoryCancelReason);

              emitAttemptEnd({
                willRetry: false,
                nextRetryDelayMS: undefined,
                nextRetryAt: undefined,
                status: 0,
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

        // A timeout when the timer's own abort is what ended the attempt: the AbortError
        // it raised, even while an answer that arrived late was being read (a cancel
        // would already have returned above). Before any answer, whatever `send()`
        // rejects with once the timer has fired is the abort's doing: a custom adapter
        // may reject with its own error (`socket hang up`) rather than an AbortError,
        // which would otherwise be retried and reported as a plain adapter_error. A
        // flagged non-retryable failure and a callback's throw are still their own.
        // Otherwise an answer, late or not, decides: one that reads cleanly is delivered,
        // and one that cannot be read is the answered response's non-retryable
        // adapter_error below, so it is not sent again.
        const isNonRetryableClientCallbackFailure = hasAdapterMarker(
          error,
          NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
        );
        const didTimeoutThisAttempt =
          isTimedOut &&
          !isFlaggedAdapterFailure &&
          (isAbortError(error) ||
            (!didAdapterResolve && !isNonRetryableClientCallbackFailure));
        const isNonRetryableAdapterFailure =
          (didAdapterResolve && !didTimeoutThisAttempt) ||
          isFlaggedAdapterFailure;

        if (
          isNonRetryableClientCallbackFailure ||
          isNonRetryableAdapterFailure
        ) {
          emitAttemptEnd({
            willRetry: false,
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: factoryAnsweredResponse?.status ?? answeredStatus,
          });

          const isStreamFactoryError = hasAdapterMarker(
            error,
            STREAM_FACTORY_ERROR_FLAG,
          );

          return {
            adapterResponse: null,
            sentRequest: sentRequestForObservedAdapterError(
              sentRequest,
              error,
              observedSentRequest,
            ),
            attemptCount: attemptNumber,
            wasCancelled: false,
            wasTimeout: didTimeoutThisAttempt,
            isRetriesExhausted: false,
            // A flagged adapter failure is a local configuration error (for example
            // MockAdapter's invalid delay), not a transport failure.
            ...(isNonRetryableAdapterFailure
              ? { isNetworkErrorOverride: false }
              : {}),
            ...(didCookieJarFail
              ? { errorMessage: COOKIE_JAR_FAILURE_MESSAGE }
              : {}),
            ...(didAdapterResolve
              ? {
                  answeredResponse: {
                    status: answeredStatus,
                    headers: answeredHeaders,
                    ...(answeredRedirectFields
                      ? adapterRedirectFields(answeredRedirectFields)
                      : derivedRedirectFields(
                          sentRequest.requestURL,
                          answeredStatus,
                          answeredHeaders,
                        )),
                  },
                }
              : factoryAnsweredResponse
                ? {
                    answeredResponse: {
                      ...factoryAnsweredResponse,
                      ...derivedRedirectFields(
                        sentRequest.requestURL,
                        factoryAnsweredResponse.status,
                        factoryAnsweredResponse.headers,
                      ),
                    },
                  }
                : {}),
            errorCode: isNonRetryableAdapterFailure
              ? 'adapter_error'
              : isStreamFactoryError
                ? 'stream_setup_error'
                : 'interceptor_error',
            // A stream factory's failure arrives on a fresh carrier (see NodeAdapter's
            // `markStreamFactoryError`), and the caller's own error is its `cause`: that
            // is the one reported.
            // An adapter's carrier for what may be the caller's own error (see
            // `nonRetryableAdapterErrorFrom`) reports that error too.
            adapterCause: normalizeError(
              isStreamFactoryError ||
                readObjectMember(error, ADAPTER_ERROR_CARRIER_KEY) === true
                ? (readObjectMember(error, 'cause') ?? error)
                : error,
            ),
          };
        }

        // An attempt given up on while it had a body to send (`isUploadAbandoned`) is not
        // retried: the adapter that ignored its abort may still be writing that body, and
        // nothing tells the client when it stops - the settle wait has no outcome of the
        // adapter's to wait on - so a retry would send the body a second time beside it. A
        // bodiless one, an empty body included, has nothing left going out and is retried
        // as any timeout is.

        // Network / adapter / per-attempt timeout — retry if policy allows. A throw
        // carries no adapter response, so delivery is unproven - and a timed-out answer
        // (one that arrived after the timer fired) proves it but is still a timeout.
        // Either way a non-idempotent method is not retried.
        if (
          policy &&
          !cancelSignal.aborted &&
          !isUploadAbandoned &&
          (allowNonIdempotentRetry ||
            IDEMPOTENT_METHODS.has(sentRequest.method))
        ) {
          const { shouldRetry, delayMS } = policy.shouldRetry(
            normalizeError(error),
          );
          const nextRetryAt = shouldRetry ? Date.now() + delayMS : undefined;
          // The delay's start on the monotonic clock: what is left of it after the
          // retry-phase observers is measured here, so a wall-clock step cannot stretch
          // or skip it.
          const retryDelayStartedAt = performance.now();

          if (shouldRetry) {
            callbacks.setNextRetryDelayMS(delayMS);
            callbacks.setNextRetryAt(nextRetryAt ?? null);
            callbacks.setState('waiting_for_retry');
          }

          emitAttemptEnd({
            willRetry: shouldRetry,
            nextRetryDelayMS: shouldRetry ? delayMS : undefined,
            nextRetryAt,
            status: 0,
          });

          if (shouldRetry) {
            const failedAttemptResponse = this._buildResponse({
              adapterResponse: null,
              requestID,
              wasCancelled: false,
              wasTimeout: didTimeoutThisAttempt,
              adapterType: this._adapterType,
              initialURL,
              requestURL: sentRequest.requestURL,
              redirectHistory,
              isNetworkErrorOverride: false,
              ...(uploadOutcome ? { requestBodySettled: uploadOutcome } : {}),
            });

            const retryError = this._makeError(
              failedAttemptResponse,
              requestID,
              false,
              'adapter_error',
              normalizeError(error),
            );

            if (!cancelSignal.aborted) {
              await this._runErrorObservers(
                retryError,
                reportedSentRequest,
                this._retryOutcomePhase(
                  maxAttemptNumber,
                  attemptNumber,
                  hopContext?.redirect,
                ),
              );
            }

            // The rest of the delay after the observers, as on the resolve path above.
            await this._cancellableDelay(
              Math.max(0, delayMS - (performance.now() - retryDelayStartedAt)),
              cancelSignal,
            );

            // Waited on as the resolve path above waits, and for the same reason, though
            // the attempt threw. A hop that threw has no socket left with `NodeAdapter`,
            // which destroys the request on an abort or a per-attempt timeout and
            // settles the outcome at once, so the wait costs nothing there. A custom
            // adapter can reject `send()` while its upload is still going out, with the
            // outcome it tagged the error with still open: dispatching the next attempt
            // after the backoff alone would put it beside that upload - the double-send
            // the wait exists to prevent. Raced against the cancel signal, so a caller
            // who gives up during it is not held.
            const wait = await settleUploadBeforeNextDispatch(
              uploadOutcome,
              cancelSignal,
              timeout,
              () => lastUploadActivityAt(uploadActivity),
            );

            if (wait !== 'settled') {
              const signalReason =
                wait === 'cancelled'
                  ? getSignalCancelReason(cancelSignal)
                  : undefined;

              if (wait === 'deadline') {
                reportUploadSettleDeadline(this._adapterType, timeout, 'retry');
                abortAttempt();
              }

              return {
                adapterResponse: null,
                sentRequest: reportedSentRequest,
                attemptCount: attemptNumber,
                wasCancelled: wait === 'cancelled',
                wasTimeout: wait === 'deadline',
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
          // A throw (or a timed-out answer) leaves the method rule and an abandoned
          // upload as the only things that can have suppressed a policy-eligible retry
          // here. The method rule is named first: it would have stopped the retry anyway.
          const isRetrySuppressible =
            isRetryAvailable() && !cancelSignal.aborted;
          const isSuppressedByMethod =
            isRetrySuppressible &&
            !allowNonIdempotentRetry &&
            !IDEMPOTENT_METHODS.has(sentRequest.method);
          const retrySuppressedReason = isSuppressedByMethod
            ? ('non_idempotent_method' as const)
            : isRetrySuppressible && isUploadAbandoned
              ? ('upload_unsettled' as const)
              : undefined;

          emitAttemptEnd({
            willRetry: false,
            ...(retrySuppressedReason ? { retrySuppressedReason } : {}),
            nextRetryDelayMS: undefined,
            nextRetryAt: undefined,
            status: 0,
          });
        }

        return {
          adapterResponse: null,
          sentRequest: reportedSentRequest,
          attemptCount: attemptNumber,
          wasCancelled: false,
          wasTimeout: didTimeoutThisAttempt,
          isRetriesExhausted,
          errorCode: 'adapter_error',
          adapterCause: normalizeError(error),
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

      // Bound the delay or the timer would read a longer wait as 1ms and resolve at once,
      // which on the retry path is a retry storm rather than a long pause.
      const id = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, clampTimerDelayMS(ms));

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * {@link _buildResponse} for a response whose body the client reads.
   *
   * Decoding a JSON or text body throws when the adapter resolved one that is not bytes.
   * That is the adapter's malformed answer, reported the way the attempt runner reports
   * an answer it could not read: an `adapter_error` that keeps the status, headers and
   * redirect target, with the decoding failure as `unreadableBody` for the caller to
   * record as the error's cause. Decoded only where the body is used, so a response
   * whose body is discarded - a refused redirect, one past `maxRedirects` - never is. A
   * followed redirect's body is used, by the `redirect`-phase observers, and is decoded
   * whether or not any are registered, so the same answer fails the same way either way.
   */
  private _buildAnsweredResponse<T>(
    params: Parameters<BaseHTTPClient['_buildResponse']>[0],
  ): { response: HTTPResponse<T>; unreadableBody?: Error } {
    try {
      return { response: this._buildResponse<T>(params) };
    } catch (error) {
      const { adapterResponse } = params;

      if (!adapterResponse) {
        throw error;
      }

      const { status, headers } = adapterResponse;
      const settled =
        params.requestBodySettled ?? adapterResponse.requestBodySettled;

      return {
        response: this._buildResponse<T>({
          ...params,
          adapterResponse: null,
          wasCancelled: false,
          wasTimeout: false,
          isNetworkErrorOverride: false,
          ...(settled ? { requestBodySettled: settled } : {}),
          answeredResponse: {
            status,
            headers,
            ...adapterRedirectFields(adapterResponse),
          },
        }),
        unreadableBody: normalizeError(error),
      };
    }
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
    /**
     * The upload's outcome when there is no `adapterResponse` to carry it - a
     * cancel, a timeout, or any other attempt that threw. Read off the tagged
     * error by the attempt runner; see {@link REQUEST_BODY_SETTLED_KEY}.
     */
    requestBodySettled?: Promise<Error | undefined>;
    /**
     * Reported on the no-response branch when the adapter had answered but its answer
     * could not be read. See the attempt result's own `answeredResponse`.
     */
    answeredResponse?: AnsweredResponse;
    /**
     * A redirect target detected but never dispatched - refused, cancelled or failed
     * before its hop went out. It is the redirect detected and not followed: reported
     * as `detectedRedirectURL` (none, for a `Location` that did not resolve - the hop is
     * still a redirect detected), and - when the caller already recorded it as the last
     * `redirectHistory` entry (`isRecorded`) - not counted as a followed hop. Said by
     * the caller rather than inferred by comparing URLs: a hop that redirects to its own
     * URL makes the followed entry and the new target the same string.
     */
    undispatchedRedirect?: { url: string | undefined; isRecorded: boolean };
    /**
     * A redirect the answer being replaced had detected with no target to name - a
     * browser's opaque redirect, a `3xx` with no `Location` - kept when the response is
     * rebuilt (see the late cancel in `send`).
     */
    wasRedirectDetected?: boolean;
  }): HTTPResponse<T> {
    const {
      adapterResponse,
      requestID,
      wasCancelled,
      wasTimeout,
      adapterType,
      initialURL,
      requestURL,
      isNetworkErrorOverride,
      requestBodySettled,
      answeredResponse,
      undispatchedRedirect,
      wasRedirectDetected: isRedirectDetected,
    } = params;
    // Each response its own copy: the loop's history is the client's, and an observer
    // handed this response must not be able to rewrite the history of the request.
    const redirectHistory = [...params.redirectHistory];

    const wasRedirectFollowed =
      redirectHistory.length - (undispatchedRedirect?.isRecorded ? 1 : 0) > 0;
    const redirectFields: AdapterRedirectFields =
      undispatchedRedirect !== undefined
        ? {
            wasRedirectDetected: true,
            ...(undispatchedRedirect.url !== undefined
              ? { detectedRedirectURL: undispatchedRedirect.url }
              : {}),
          }
        : adapterResponse
          ? adapterRedirectFields(adapterResponse)
          : (answeredResponse ?? {});
    const wasRedirectDetected =
      wasRedirectFollowed ||
      isRedirectDetected === true ||
      (redirectFields.wasRedirectDetected ?? false);
    const detectedRedirectURL = redirectFields.detectedRedirectURL;

    // The caller's word first, on every branch below, over the adapter response's own
    // field, which is right for a single hop and wrong after a followed redirect: the
    // final hop's response is usually a bodiless `GET` with nothing on it, while the
    // parameter carries the outcome from the hop that actually uploaded. Every non-null
    // response here is the private attempt runner's snapshot or a synthetic response
    // carrying its outcome. The attempt runner adopts raw adapter metadata before
    // publication; getRequestBodySettled does the same for thrown outcomes. Keep those
    // owned promises intact here rather than re-adopting them and maintaining a separate
    // identity registry just to undo that work.
    const settled = requestBodySettled ?? adapterResponse?.requestBodySettled;

    // Every branch below reports the same keys in the same order: `respond` appends
    // the fields they all share, and each branch starts from `bodyless` - spread
    // first, so an override keeps its key's place - setting only what differs.
    const respond = (fields: ResponseFields<T>): HTTPResponse<T> => ({
      ...fields,
      initialURL,
      requestURL,
      wasRedirectDetected,
      wasRedirectFollowed,
      detectedRedirectURL,
      redirectHistory,
      requestID,
      adapterType,
      // Absent only when there was no body writer - and genuinely absent:
      // `requestBodySettled: settled` with `settled` undefined would put an own property
      // on a bodiless `GET`, so `'requestBodySettled' in response` would say an outcome
      // had been reported where the docs say absence means none was.
      ...(settled ? { requestBodySettled: settled } : {}),
    });
    const bodyless: Omit<ResponseFields<T>, 'status' | 'headers'> = {
      body: null as unknown as T,
      contentType: 'binary',
      isJSON: false,
      isText: false,
      isCancelled: false,
      isTimeout: false,
      isNetworkError: false,
      isFailed: true,
      isParseError: false,
      isStreamed: false,
      isStreamError: false,
    };

    if (!adapterResponse) {
      // No adapter response means the attempt threw, so the upload's promise arrives
      // separately rather than on a response object. Omitting it here would report the
      // documented *success* value - `await undefined` is `undefined` - for a cancelled
      // or timed-out upload, which is the one case where a caller most needs the real
      // answer.
      return respond({
        status: answeredResponse?.status ?? 0,
        headers: answeredResponse?.headers ?? {},
        ...bodyless,
        isCancelled: wasCancelled,
        isTimeout: wasTimeout,
        isNetworkError:
          isNetworkErrorOverride ?? (!wasCancelled && !wasTimeout),
      });
    }

    if (
      (adapterResponse.isTransportError || adapterResponse.status === 0) &&
      !adapterResponse.isStreamError
    ) {
      return respond({
        status: adapterResponse.status,
        headers: adapterResponse.headers,
        ...bodyless,
        isNetworkError: isNetworkErrorOverride ?? true,
      });
    }

    // Response-body failure after headers: the server returned a real HTTP
    // response, so we
    // preserve its status and headers on HTTPResponse, but the request must
    // still follow the failed/error path because the body could not be fully
    // delivered to the caller's sink. Callers should treat isStreamError /
    // builder.error as authoritative for success, not the preserved status.
    if (adapterResponse.isStreamError) {
      return respond({
        status: adapterResponse.status,
        headers: adapterResponse.headers,
        ...bodyless,
        isTimeout: wasTimeout,
        isStreamError: true,
      });
    }

    // Successful stream: body was piped to the caller's writable. Nothing to
    // parse — body is null. Status and headers are still fully populated.
    // `contentType` stays `binary` intentionally here: in this client it tracks
    // how the response body was materialized for callers, and streamed bodies
    // are never decoded into text/JSON at this layer.
    if (adapterResponse.isStreamed) {
      return respond({
        status: adapterResponse.status,
        headers: adapterResponse.headers,
        ...bodyless,
        isFailed: false,
        isStreamed: true,
      });
    }

    const contentTypeHeader = scalarHeader(
      adapterResponse.headers,
      'content-type',
    );
    const contentType = parseContentType(contentTypeHeader);

    // An empty body is no body, whichever adapter read it: NodeAdapter already answers
    // `null` for one, while FetchAdapter and XHRAdapter hand over an empty array, which a
    // JSON `Content-Type` would otherwise report as a parse error - a `200` with nothing
    // in it (a bodiless `204`-style answer) failing to parse. axios, got and ky read it
    // as empty too.
    // Nullish, not just `null`: a custom adapter that leaves `body` out would otherwise
    // answer with a `TypeError` here, failing a `200` it had delivered whole.
    // Measured by its slot, not the size it reports: otherwise a subclass that says `0`
    // for a body of bytes would be delivered as none.
    // An empty string is none too, as an empty array is.
    const answeredBody: Uint8Array | null | undefined = adapterResponse.body;
    const answered: unknown = answeredBody;
    const rawBody =
      answeredBody === null ||
      answeredBody === undefined ||
      answered === '' ||
      (typeof answeredBody === 'object' &&
        readBinaryByteLength(answeredBody) === 0)
        ? null
        : answeredBody;
    let body: unknown = rawBody;
    let isJSON = false;
    let isText = false;
    let isParseError = false;
    let decodedTextBody: string | null = null;

    if ((contentType === 'json' || contentType === 'text') && rawBody) {
      // A custom adapter's string body is already text: decoding it as bytes would throw.
      const answered: unknown = rawBody;
      decodedTextBody =
        typeof answered === 'string'
          ? answered
          : new TextDecoder().decode(rawBody);
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

    return respond({
      status: adapterResponse.status,
      headers: adapterResponse.headers,
      ...bodyless,
      body: body as T,
      contentType,
      isJSON,
      isText,
      isFailed: false,
      isParseError,
    });
  }

  /**
   * Build an HTTPClientError from a failed response.
   *
   * Error code priority:
   * 1. isCancelled → cancelled, whatever the override
   * 2. isTimeout → timeout, over every override but a stream code: a streamed-body
   *    failure keeps its stream_* code while still surfacing `isTimeout: true`
   * 3. Explicit codeOverride (redirect_disabled, redirect_loop, request_setup_error,
   *    adapter_error, stream_write_error, stream_response_error, stream_setup_error,
   *    response_too_large)
   * 4. Default fallback → network_error
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
    adapterErrorMessage?: string,
  ): HTTPClientError {
    let code: HTTPClientError['code'] = codeOverride ?? 'network_error';
    let message = 'Network error';

    const isSpecificStreamCodePreserved =
      code === 'stream_write_error' ||
      code === 'stream_response_error' ||
      code === 'stream_setup_error' ||
      code === 'response_too_large';

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
      message = adapterErrorMessage ?? 'Adapter error';
    } else if (code === 'interceptor_error') {
      message = 'Interceptor error';
    } else if (code === 'stream_write_error') {
      message = 'Response stream write failed';
    } else if (code === 'stream_response_error') {
      message = 'Response download stream failed';
    } else if (code === 'stream_setup_error') {
      message = 'Stream response setup failed';
    } else if (code === 'response_too_large') {
      message = 'Response body exceeded maxResponseBytes';
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
      // Its own copy, as each response has: an error observer changing it does not
      // change the response's.
      redirectHistory: [...response.redirectHistory],
      requestID,
      isTimeout: response.isTimeout,
      isRetriesExhausted,
      ...(cancelReason !== undefined ? { cancelReason } : {}),
    };
  }

  /**
   * Runs parent + own interceptor chains in order.
   * Returns the (possibly modified) request, or an InterceptorCancel signal, and whether
   * any interceptor was registered to touch it.
   *
   * Both chains are snapshotted before either runs: a parent interceptor that registers
   * one on the sub-client (or the reverse) affects the next dispatch, as documented,
   * rather than this one. The observer runners below do the same.
   *
   * With nothing registered on either, `result` is `request` itself and `isIntercepted` is
   * `false`. The initial and retry phases then skip `snapshotInterceptedRequest`: the
   * request they pass is one this client built, with its headers through `mergeHeaders`,
   * which normalizes them exactly as the snapshot would, so there is nothing caller-owned
   * to take a copy of. The redirect phase snapshots regardless; see there.
   *
   * `isBodyHandedOut` says whether any interceptor's function was called, and so was
   * handed the request's body and may still hold it: the phase then copies the body of
   * the chain's result (see `copyChainResultBody`), so one that changes the object it
   * returned later - from an observer, say - changes no later attempt or replay.
   */
  private async _runInterceptors<R extends InterceptedRequest>(
    request: R,
    phase: InterceptorPhase,
    context: RequestInterceptorContext,
    /**
     * Whether the request was cancelled, after which no further interceptor runs and a
     * chain that runs answers a cancel (see `InterceptorChainOptions.isCancelled`).
     */
    isCancelled: () => boolean,
    /**
     * Handed an interceptor's result that could not be copied for the next interceptor,
     * so the phase reports from it as from a chain result its own copy fails on.
     */
    onCopyFailure: (request: InterceptedRequest) => void,
    /** See `InterceptorChainOptions.prepareRequest`: shared by both chains, so it decides once. */
    prepareRequest?: (request: InterceptedRequest) => InterceptedRequest,
  ): Promise<
    | { result: R; isIntercepted: false; isBodyHandedOut: false }
    | {
        result: InterceptedRequest | InterceptorCancel;
        isIntercepted: true;
        isBodyHandedOut: boolean;
      }
  > {
    const parentManager = this._parentClient?._requestInterceptors;

    // Decided from the same registrations the chains below are taken from: nothing
    // between this check and the snapshots runs caller code.
    if (
      (parentManager === undefined || parentManager.isEmpty) &&
      this._requestInterceptors.isEmpty
    ) {
      return { result: request, isIntercepted: false, isBodyHandedOut: false };
    }

    // None for a parent with nothing registered: its chain would hand back the request
    // unread.
    const parentChain =
      parentManager === undefined || parentManager.isEmpty
        ? undefined
        : parentManager.snapshot();
    const ownChain = this._requestInterceptors.snapshot();
    let current: InterceptedRequest | InterceptorCancel = request;
    // The interceptors' own copy of the history, as each response has its own: an
    // interceptor that pushes to it does not change the request's.
    const chainContext: RequestInterceptorContext = {
      ...context,
      redirectHistory: [...context.redirectHistory],
    };

    // Whether the parent's chain called any interceptor's function this phase: with none
    // called, its result is `request` itself, untouched.
    let didParentCallInterceptor = false;
    // Whether either chain called any interceptor's function this phase.
    let isBodyHandedOut = false;

    if (parentChain) {
      current = await parentChain(request, phase, chainContext, {
        isCancelled,
        onCopyFailure,
        onInterceptorCalled: () => {
          didParentCallInterceptor = true;
          isBodyHandedOut = true;
        },
        ...(prepareRequest ? { prepareRequest } : {}),
      });

      // A cancel that lands after the parent's chain answers is the chain's below to
      // answer: it runs no interceptor once the request is cancelled.
      if (isInterceptorCancel(current)) {
        return { result: current, isIntercepted: true, isBodyHandedOut };
      }
    }

    return {
      // The parent's result is copied before an interceptor here reads it whenever one of
      // the parent's interceptors was called, whatever it returned: one that redefined
      // `requestURL` on the request it was handed and returned that same object handed
      // back the request itself, which identity cannot tell from one no interceptor
      // touched. With none called - every one filtered out, or registered for other
      // phases - it is the request the client built, with nothing to copy.
      result: await ownChain(current, phase, chainContext, {
        isCancelled,
        isInterceptorResult: didParentCallInterceptor,
        onCopyFailure,
        onInterceptorCalled: () => {
          isBodyHandedOut = true;
        },
        ...(prepareRequest ? { prepareRequest } : {}),
      }),
      isIntercepted: true,
      // Read once the chain has run, after the line above.
      isBodyHandedOut,
    };
  }

  /**
   * Phase for an attempt outcome that will be retried (before the retry delay).
   * `attempt` matches `onAttemptEnd.attemptNumber` for that outcome.
   */
  private _retryOutcomePhase(
    maxAttempts: number,
    completedAttemptNumber: number,
    redirect?: RedirectHopInfo,
  ): Extract<ResponseObserverPhase, { type: 'retry' }> {
    return redirect !== undefined
      ? {
          type: 'retry',
          attempt: completedAttemptNumber,
          maxAttempts,
          // A copy, for the reason the attempt callbacks get one.
          redirect: { ...redirect },
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
    // A copy, so the internal headers added below stay off the request the next attempt
    // starts from, its arrays too: the record goes on to observers and interceptors, and
    // an item one of them changes in place - a redaction, a pushed value - reaches neither
    // the next attempt nor the request an earlier attempt was reported as. Not normalized
    // again: only a `ResolvedRequest`'s headers reach here.
    const nextHeaders = copyHeaderRecord(headers);

    if (this._config.includeRequestID) {
      nextHeaders[DEFAULT_REQUEST_ID_HEADER] = requestID;
    }

    if (attemptNumber !== undefined && this._config.includeAttemptHeader) {
      nextHeaders[DEFAULT_REQUEST_ATTEMPT_HEADER] = String(attemptNumber);
    }

    return nextHeaders;
  }

  private _buildAttemptRequest(
    request: ResolvedRequest,
    bodies: AttemptBodies,
    params: {
      requestID: string;
      timeout: number;
      maxResponseBytes: number;
      attemptNumber?: number;
      cookieJar?: CookieJar | null;
    },
  ): AttemptRequest {
    const { requestID, timeout, maxResponseBytes, attemptNumber, cookieJar } =
      params;

    // Build the finalized attempt snapshot before adapter-specific transport
    // materialization. Header names are already lowercase (see `ResolvedRequest`), and
    // adapters may further materialize repeated header values at send time. The bodies are
    // built by the caller, so a setup failure's snapshot can reuse them.
    const { sentBody, contentType } = bodies;
    const headers = this._withInternalRequestHeaders(
      request.headers,
      requestID,
      attemptNumber,
    );

    // A native FormData body owns its Content-Type: Fetch/XHR install the multipart
    // boundary, and NodeAdapter replaces it with the boundary used by its serializer.
    if (isFormData(sentBody)) {
      delete headers['content-type'];
    } else if (contentType && headers['content-type'] === undefined) {
      // Preserve an explicit content-type for every other body; otherwise infer it.
      headers['content-type'] = contentType;
    }

    // No body, no `Content-Length`: every adapter drops a caller's then (browsers refuse to
    // send one, `NodeAdapter` takes it off), so it is not reported to observers as sent.
    if (sentBody === undefined || sentBody === null) {
      delete headers['content-length'];
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
      ...bodies.observed,
      timeout,
      maxResponseBytes,
      attemptNumber,
      requestID,
    };
  }

  /**
   * `knownBodies` is what the dispatch path already learned about this request's body:
   * the bodies it built, or `'unbuildable'` when building them is what failed. Either way
   * the snapshot does not build them again.
   */
  private _bestEffortAttemptRequestFromPending(
    request: InterceptedRequest,
    limits: AttemptLimits,
    requestID: string,
    urls: {
      /** The URL the response falls back to when `requestURL` cannot be read. */
      fallbackURL?: string;
      /**
       * The URL the response and error report, used in place of `requestURL`, so the
       * observers are handed the request the response names.
       */
      reportedURL?: string;
    } = {},
    knownBodies?: AttemptBodies | 'unbuildable',
  ): AttemptRequest {
    // Best-effort snapshot for observers when a request fails before any adapter
    // attempt is dispatched (interceptor throw, pre-send cancel, setup error, etc.).
    // Jar cookies and the attempt header (x-local-client-request-attempt) are not added
    // here - they are applied at dispatch time, and no attempt went out. The request ID
    // header and the default user-agent are already on it: they are set before the
    // interceptors run. A request that already carries them (a redirect
    // hop's, built from the previous hop's sent headers, or a retry interceptor's input)
    // keeps them, as it would have sent them. Unsupported body types are caught
    // and swallowed here; the real error is reported via request_setup_error instead.
    // Headers are merged one at a time for the same reason, rather than through
    // `mergeHeaders`, which fails as a whole: this runs inside failure handlers and
    // must not replace their result, so a value whose string conversion throws (or a
    // getter that does) drops only that entry, keeping the rest for diagnosis. The
    // header object is read once, so every entry comes from the same object.
    const headers: Record<string, string | string[]> = {};
    let sourceHeaders: Record<string, string | string[]> = {};
    let headerNames: string[] = [];

    try {
      const candidate: unknown = request.headers;

      // Only a non-array object is a header record. `Object.keys` on a string or an array
      // answers its indices, so an interceptor that returned `headers: 'abc'` would
      // report headers named `0`, `1` and `2`; anything else leaves the snapshot without
      // headers.
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        !Array.isArray(candidate)
      ) {
        sourceHeaders = candidate as Record<string, string | string[]>;
        headerNames = Object.keys(sourceHeaders);
      }
    } catch {
      // An unreadable header object leaves the snapshot without headers.
    }

    for (const name of headerNames) {
      try {
        // As `mergeHeaders` reads a record: an unset value removes the header, whatever
        // the capitalization of the entry that set it, as the request itself would.
        const value = normalizeMergedHeaderValue(sourceHeaders[name]);
        const lowerName = lowerCaseHeaderName(name);
        if (value === undefined) {
          delete headers[lowerName];
        } else {
          defineEntry(headers, lowerName, value);
        }
      } catch {
        // Skip only this entry.
      }
    }

    // The remaining fields follow the same rule: each is read once, and one that cannot
    // be read is left empty rather than failing the snapshot - a retry interceptor's
    // request with a throwing `body` getter would otherwise turn its `interceptor_error`
    // into a `request_setup_error` and drop the attempt it had already ended.
    let observed: ObservedBodies | undefined;

    if (knownBodies !== undefined && knownBodies !== 'unbuildable') {
      observed = knownBodies.observed;
    } else if (this._hasAttemptRequestObservers()) {
      const rawBody = readObjectMember(request, 'body');

      // A body the dispatch path already failed to build is not validated and cloned a
      // second time; it is reported as it came, as one that fails to build here is.
      if (knownBodies === undefined) {
        try {
          observed = buildAttemptBodies(rawBody, true).observed;
        } catch {
          // Reported as it came, below.
        }
      }

      observed ??= { body: null, rawBody };
    }

    return {
      requestURL:
        urls.reportedURL ??
        readStringMember(request, 'requestURL', urls.fallbackURL ?? ''),
      method: readStringMember(request, 'method', ''),
      headers,
      ...observed,
      timeout: limits.timeout,
      maxResponseBytes: limits.maxResponseBytes,
      requestID,
    };
  }

  /**
   * Whether an observer that is handed an attempt's request - a response or error
   * observer, on this client or its parent - is registered. Nothing else is handed one:
   * the attempt hooks are given events without it.
   */
  private _hasAttemptRequestObservers(): boolean {
    const parent = this._parentClient;

    return (
      !this._responseObservers.isEmpty ||
      !this._errorObservers.isEmpty ||
      (parent !== null &&
        (!parent._responseObservers.isEmpty || !parent._errorObservers.isEmpty))
    );
  }

  private _runResponseObservers(
    response: HTTPResponse,
    request: AttemptRequest,
    phase: ResponseObserverPhase,
  ): Promise<void> {
    return runParentThenOwnObservers(
      this._parentClient?._responseObservers,
      this._responseObservers,
      response,
      request,
      phase,
    );
  }

  private _runErrorObservers(
    error: HTTPClientError,
    request: AttemptRequest,
    phase: ErrorObserverPhase,
  ): Promise<void> {
    return runParentThenOwnObservers(
      this._parentClient?._errorObservers,
      this._errorObservers,
      error,
      request,
      phase,
    );
  }

  /**
   * Compose two abort signals into one that aborts when either does.
   *
   * On a runtime with `AbortSignal.any` that is all this is. The fallback for older
   * runtimes listens on both sources and mirrors the first abort, and the listeners it
   * adds are released through `releasers` - run by `_execute` once the request has
   * ended, since a listener on the caller's own signal, or on the request's cancel
   * signal, otherwise outlives the request it was added for: nothing ever aborts on the
   * success path, so a `{ once: true }` listener never fires and is never removed. A
   * caller's signal reused across requests would accumulate one listener per request
   * until the runtime warns of a leak.
   *
   * Released when the request ends rather than when the attempt does: an attempt's
   * signal stays in an adapter's hands after `send()` resolves - `NodeAdapter` listens
   * on it for the settle-deadline teardown of an early-ack upload - and the attempt loop
   * has several exits, where the request has one. What the fallback gives up by that is
   * only a cancel arriving *after* the response was handed back, which would no longer
   * reach an upload still trailing on that attempt's socket; the adapter's own stall
   * watchdog ends such an upload regardless.
   */
  private _composeSignals(
    a: AbortSignal,
    b: AbortSignal,
    releasers: Array<() => void>,
  ): AbortSignal {
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([a, b]);
    }

    const controller = new AbortController();

    /**
     * Mirror one source signal's abort onto the composed one.
     *
     * An unreadable reason degrades to `undefined`, which is already correct:
     * spec and runtimes normalize that to a fresh `AbortError` DOMException,
     * exactly what a bare `abort()` produces.
     */
    const abort = (signal: AbortSignal) =>
      controller.abort(readObjectMember(signal, 'reason'));

    // By the rule `send()` reads the caller's signal with: exactly `true`, and a getter
    // that throws as not aborted (see `isSignalAbortedQuietly`).
    if (isSignalAbortedQuietly(a)) {
      abort(a);
    } else if (isSignalAbortedQuietly(b)) {
      abort(b);
    } else {
      const onAbortA = () => abort(a);
      const onAbortB = () => abort(b);

      // Registered before either listener is attached, so a second `addEventListener`
      // that throws - a caller's own `AbortSignal` subclass, a `Proxy` - does not leave
      // the first listener attached with nothing recorded to remove it. Removing a
      // listener that was never added is a no-op. One releaser per signal, each run
      // guarded, so a `removeEventListener` that throws leaves only its own listener.
      releasers.push(
        () => a.removeEventListener('abort', onAbortA),
        () => b.removeEventListener('abort', onAbortB),
      );

      a.addEventListener('abort', onAbortA, { once: true });
      b.addEventListener('abort', onAbortB, { once: true });
    }

    return controller.signal;
  }

  private _hasRequestInterceptors(): boolean {
    const parentManager = this._parentClient?._requestInterceptors;
    return (
      (parentManager !== undefined && !parentManager.isEmpty) ||
      !this._requestInterceptors.isEmpty
    );
  }

  private _assertRequestIsSupported(request: InterceptedRequest): void {
    this._assertRequestShapeIsSupported(request);
    this._assertRequestBodyFitsMethod(request);
  }

  /**
   * The checks of `_assertRequestIsSupported` that do not read the body: its type, the
   * headers and the method. An interceptor phase runs them on what its interceptors
   * returned, before the body is copied, and the GET and HEAD rule on the copy.
   */
  private _assertRequestShapeIsSupported(request: InterceptedRequest): void {
    assertSupportedRequestBody(request.body);

    const adapterType = this._adapterType;
    const adapterName = adapterType === 'fetch' ? 'FetchAdapter' : 'XHRAdapter';
    if (
      this._isBrowserRuntime &&
      (adapterType === 'fetch' || adapterType === 'xhr')
    ) {
      assertNoBrowserRestrictedHeaders(request.headers, adapterName);
    }
    // Refused here, as the method-override headers that tunnel them are: `fetch` refuses
    // these methods on every runtime (the Fetch Standard forbids them), and XHR in a
    // browser does, on every attempt - letting one through only spends the retry budget
    // on a transport failure.
    if (
      (adapterType === 'fetch' ||
        (adapterType === 'xhr' && this._isBrowserRuntime)) &&
      BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES.has(
        asciiLowercase(request.method),
      )
    ) {
      throw methodRefusal(
        `[${adapterName}] Cannot send a ${request.method} request: fetch and browsers refuse the CONNECT, TRACE and TRACK methods.`,
      );
    }
  }

  /** The GET and HEAD rule of `_assertRequestIsSupported`, which reads the body. */
  private _assertRequestBodyFitsMethod(request: InterceptedRequest): void {
    const adapterType = this._adapterType;
    // `fetch` refuses a GET or HEAD with a body on every attempt, on every runtime, and
    // XHR drops it - the XHR standard sends a GET or HEAD bodiless - so the request would
    // go out without it and be answered as though it had been sent. Refused here for the
    // same reason as the CONNECT, TRACE and TRACK methods (see
    // `_assertRequestShapeIsSupported`).
    // XHR in a browser only, as the TRACE refusal there: a non-browser XHR (React Native,
    // a shim) may send the body.
    if (
      (adapterType === 'fetch' ||
        (adapterType === 'xhr' && this._isBrowserRuntime)) &&
      (asciiUppercase(request.method) === 'GET' ||
        asciiUppercase(request.method) === 'HEAD') &&
      hasRequestBody(request.body)
    ) {
      throw methodRefusal(
        adapterType === 'fetch'
          ? `[FetchAdapter] Cannot send a ${request.method} request with a body: fetch refuses one. Use NodeAdapter, or send the body with POST.`
          : `[XHRAdapter] Cannot send a ${request.method} request with a body: XMLHttpRequest drops it. Send the body with POST.`,
        true,
      );
    }
  }

  /**
   * `copyChainResultBody`, with a copy that fails on a GET or HEAD the adapter refuses a
   * body on reported as that refusal: a body that cannot be copied cannot serialize to
   * nothing, so the method is refused whatever it holds, and the interceptor's refused
   * method is not turned into the body's failure, as a CONNECT, TRACE or TRACK is not.
   * `outcome.didFail` is still set, so the body is not read a second time to report it.
   */
  private _copyChainResultBody(
    request: ResolvedRequest,
    outcome: BodyCopyOutcome,
  ): ResolvedRequest {
    try {
      return copyChainResultBody(request, outcome);
    } catch (error) {
      // The uncopied body is a body to `hasRequestBody`, so this throws wherever the
      // rule applies.
      this._assertRequestBodyFitsMethod(request);
      throw error;
    }
  }

  private _assertInterceptorResolvedURL(requestURL: string): void {
    if (isAbsoluteWebURL(requestURL)) {
      return;
    }

    throw new Error(
      '[HTTPClient] Interceptor rewrote requestURL to a value that could not be resolved to an absolute http(s) URL.',
    );
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
  public createSubClient(overrides: SubClientConfig = {}): HTTPSubClient {
    return new BaseHTTPClient(this._buildSubClientConfig(overrides), {
      tracker: this._tracker,
      parentClient: this,
      inheritedAdapter: { adapter: this._adapter, type: this._adapterType },
    });
  }
}

/**
 * Public type for sub-clients returned by {@link HTTPClient.createSubClient}.
 *
 * Identical to {@link HTTPClient} except `createSubClient` is not available —
 * sub-clients share the parent's tracker and observer chain but cannot spawn
 * further sub-clients.
 */
export type HTTPSubClient = Omit<HTTPClient, 'createSubClient'>;

/** The per-request limits an observed attempt snapshot reports. */
type AttemptLimits = Required<
  Pick<AttemptRequest, 'timeout' | 'maxResponseBytes'>
>;

type AttemptBodies = {
  /** The body handed to the adapter, never to an observer. */
  sentBody: AttemptRequest['body'];
  contentType: string | null;
  /**
   * The observers' `body` and `rawBody`, built with the rest when something that is handed
   * the attempt's request is registered (see `_hasAttemptRequestObservers`), and absent
   * otherwise.
   */
  observed: ObservedBodies | undefined;
};

type ObservedBodies = Pick<AttemptRequest, 'body' | 'rawBody'>;

/**
 * Read one string field of a caller-supplied request for a best-effort snapshot, through
 * the shared guarded read, answering `fallback` when the read throws or the field is not
 * a string.
 */
function readStringMember(
  source: unknown,
  key: 'requestURL' | 'method',
  fallback: string,
): string {
  const value = readObjectMember(source, key);

  return typeof value === 'string' ? value : fallback;
}

/** The fields an {@link HTTPClientConfig} takes; any other is refused as misspelled. */
const HTTP_CLIENT_CONFIG_FIELDS = fieldNames<HTTPClientConfig>({
  adapter: true,
  baseURL: true,
  defaultHeaders: true,
  timeout: true,
  maxResponseBytes: true,
  cookieJar: true,
  retryPolicy: true,
  retryNonIdempotentMethods: true,
  includeRequestID: true,
  includeAttemptHeader: true,
  userAgent: true,
  followRedirects: true,
  maxRedirects: true,
});

/** The fields a {@link SubClientConfig} takes: the client's, and `defaultHeadersStrategy`. */
const SUB_CLIENT_CONFIG_FIELDS = fieldNames<SubClientConfig>({
  ...(Object.fromEntries(
    HTTP_CLIENT_CONFIG_FIELDS.map((field) => [field, true]),
  ) as Record<keyof HTTPClientConfig, true>),
  defaultHeadersStrategy: true,
});

/**
 * Read every documented {@link HTTPClientConfig} field once, through its original
 * receiver, regardless of enumerability or prototype placement. Shared by the
 * constructor and `_buildSubClientConfig`; the `satisfies` keeps it exhaustive as
 * options grow.
 */
// A sub-client's config is the wider of the two (its `retryPolicy` may be `null`).
function snapshotClientConfigFields(config: SubClientConfig) {
  return {
    adapter: config.adapter,
    baseURL: config.baseURL,
    defaultHeaders: config.defaultHeaders,
    timeout: config.timeout,
    maxResponseBytes: config.maxResponseBytes,
    cookieJar: config.cookieJar,
    retryPolicy: config.retryPolicy,
    retryNonIdempotentMethods: config.retryNonIdempotentMethods,
    includeRequestID: config.includeRequestID,
    includeAttemptHeader: config.includeAttemptHeader,
    userAgent: config.userAgent,
    followRedirects: config.followRedirects,
    maxRedirects: config.maxRedirects,
  } satisfies Record<keyof HTTPClientConfig, unknown>;
}

/**
 * The bodies of one attempt, built from the request's body before the adapter is handed
 * any: the one sent, and, when `isObserved`, the observers' own, so nothing an observer
 * does to theirs reaches the adapter or a later attempt. On an attempt the request's body
 * is the client's own copy (see `copyRequestBody`), which no caller holds; a best-effort
 * snapshot of a request that failed before one existed may be handed any value.
 *
 * Bytes and form data are sent as the request's own body: copied for the adapter, where
 * it may change them, by `adapterRequestBody`.
 */
function buildAttemptBodies(
  rawBody: unknown,
  isObserved: boolean,
): AttemptBodies {
  // Validate first so unsupported object-like values (URLSearchParams, Blob, etc.) fail
  // explicitly instead of being stringified into `{}`.
  assertSupportedRequestBody(rawBody);

  // A JSON body is serialized once, by `JSON.stringify` - or not at all: the client's
  // copy is sent as the text it was read back from (see `copiedJSONText`) - and the
  // observers' copy is parsed back from the bytes sent, so `rawBody` is exactly what went
  // out. Parsed for each attempt, so an observer that changes it changes no other
  // attempt's - every observer of one attempt shares the one copy.
  if (Array.isArray(rawBody) || isPlainRecord(rawBody)) {
    const { body, contentType } = serializeBody(
      rawBody,
      copiedJSONText(rawBody),
    );

    return {
      sentBody: body,
      contentType,
      observed: isObserved
        ? {
            // A string, which no observer can change in place.
            body,
            // A top-level `toJSON` that answers `undefined` serializes to nothing.
            rawBody:
              typeof body === 'string'
                ? (JSON.parse(body) as unknown)
                : undefined,
          }
        : undefined,
    };
  }

  // No observer is handed the bytes or form sent: their `body` and `rawBody` are one copy
  // of it, taken now - before the adapter can change or transfer it. NodeAdapter writes a
  // FormData's parts as it walks them, so a redirect- or retry-phase observer changing
  // the one being sent, while its upload is still under way, would change parts not yet
  // written.
  const { body, contentType } = serializeBody(rawBody);
  let observed: ObservedBodies | undefined;

  if (isObserved) {
    if (isRequestBodyBytes(body) || isFormData(body)) {
      const copy = cloneBodyValue(body) as typeof body;
      observed = { body: copy, rawBody: copy };
    } else {
      // A string, or nothing: `rawBody` is the request's body as it is, `undefined`
      // included.
      observed = { body, rawBody };
    }
  }

  return { sentBody: body, contentType, observed };
}

/**
 * The body an adapter is handed: a copy taken for this attempt, so an adapter that changes
 * or transfers what it was handed leaves the request's own body - the next attempt's, and
 * a replay's - alone. Bytes are the request's own when `send` is a built-in network
 * adapter's, which copies them as it is called (see `isBuiltInNetworkSend`); a form is
 * copied for every adapter, as NodeAdapter reads its entries while the upload runs.
 */
function adapterRequestBody(
  adapter: HTTPAdapter,
  send: unknown,
  body: AttemptRequest['body'],
): AdapterRequest['body'] {
  if (isRequestBodyBytes(body) && isBuiltInNetworkSend(adapter, send)) {
    return body;
  }

  return (cloneBodyValue(body) as AttemptRequest['body']) ?? null;
}

/**
 * A label argument held to the rule `builder.label()` holds a label to: a string with
 * something in it. A label method reading it loosely would do harm:
 * `cancelAllWithLabel(undefined)` - a feature's unset label - would match, and cancel,
 * every request that has no label.
 */
function assertLabelArgument(label: unknown, method: string): void {
  if (typeof label !== 'string') {
    throw new TypeError(
      `HTTPClient.${method}() label must be a string (got ${describeValue(label)})`,
    );
  }

  if (isBlankText(label)) {
    throw new Error(
      `HTTPClient.${method}() requires a non-empty, non-whitespace label.`,
    );
  }
}

/** A non-string request path, for the refusal: `instanceof` guarded, as the value is the caller's. */
function describeRequestPath(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  try {
    if (value instanceof URL) {
      return 'a URL object; pass url.href';
    }
  } catch {
    // A hostile prototype chain: described by its type alone.
  }

  return typeof value;
}

/**
 * Whether a stream-error response failed only in its body, none of which reached the
 * caller, so its status is the whole answer: a body that failed to decode, or one past
 * `maxResponseBytes` that the adapter stopped reading - a `503` with an oversized
 * maintenance page asks for a retry as one with a small page does.
 */
function isStatusOnlyStreamError(response: AdapterResponse): boolean {
  // A streamed body was already handed to the caller's stream, so it is no whole answer.
  if (response.isStreamError !== true || response.isStreamed === true) {
    return false;
  }

  return (
    response.streamErrorCode === 'response_too_large' ||
    isBodyDecodeFailure(response)
  );
}

/**
 * Whether a stream-error response failed only in decoding its body (see
 * `RESPONSE_DECODE_ERROR_KEY`): the tag is on the cause, or a cause of it, that the
 * adapter reported.
 */
function isBodyDecodeFailure(response: AdapterResponse): boolean {
  // The guard that it is a stream error none of which reached the caller is
  // `isStatusOnlyStreamError`'s, the one caller that must hold it.
  if (response.streamErrorCode !== 'stream_response_error') {
    return false;
  }

  let cause: unknown = response.errorCause;
  for (
    let depth = 0;
    depth < 4 && cause !== undefined && cause !== null;
    depth++
  ) {
    if (readObjectMember(cause, RESPONSE_DECODE_ERROR_KEY) === true) {
      return true;
    }

    cause = readObjectMember(cause, 'cause');
  }

  return false;
}

/**
 * When `adapter.send()` rejects before resolving (e.g. stream factory throw),
 * adapters may still attach `effectiveRequestHeaders` on the error so observers
 * see the same merged headers as on a successful `AdapterResponse`.
 */
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
  return snapshotHeaderRecord(
    readObjectMember(error, EFFECTIVE_REQUEST_HEADERS_KEY),
  );
}

/** A header value an adapter may report: see `isAdapterHeaderValue`, or unset. */
function isHeaderScalar(value: unknown): boolean {
  return isNullish(value) || isAdapterHeaderValue(value);
}

/**
 * Validate and copy an adapter-provided header record into a plain object.
 *
 * Copying is part of the safety boundary: checking the outer value alone would
 * leave later reads exposed to throwing getters. A malformed or unreadable record
 * is treated as absent.
 */
function snapshotHeaderRecord(
  value: unknown,
): Record<string, string | string[]> | undefined {
  try {
    // A plain record only: a `Headers` or `Map` keeps its entries off its own properties,
    // and read as one, every header - `Set-Cookie` too - would be silently gone. Inside
    // the `try`: a revoked `Proxy` throws from the prototype read itself.
    if (!isPlainRecord(value)) {
      return undefined;
    }

    const snapshot: Record<string, string | string[]> = {};

    for (const [name, headerValue] of Object.entries(value)) {
      // As `mergeObservedHeaders` reads a record: an unset value or item is skipped,
      // and a number - Node's `getHeaders()` answers `content-length` as one - is a
      // string. Any other kind of value makes the record malformed.
      if (
        !(Array.isArray(headerValue) ? headerValue : [headerValue]).every(
          isHeaderScalar,
        )
      ) {
        return undefined;
      }
      const present = presentHeaderValue(headerValue);
      if (present !== undefined) {
        defineEntry(snapshot, name, present);
      }
    }

    return snapshot;
  } catch {
    return undefined;
  }
}

/**
 * Whether an adapter explicitly tagged a thrown value with one of the client's
 * marker flags.
 *
 * Exactly `true`, not merely present: presence alone lets an error carrying the
 * flag as `false` reach a branch meant for a deliberate tag. Every adapter writes
 * the literal `true`. The read is guarded; unreadable is untagged.
 */
function hasAdapterMarker(err: unknown, flag: string): boolean {
  return readObjectMember(err, flag) === true;
}

/**
 * Whether an adapter tagged this throw as a response-stream abort.
 *
 * Gates both the terminal stream-error branch and writing that response's
 * `Set-Cookie` into the jar, so it is the strictest marker to get wrong.
 */
function isResponseStreamAbortError(err: unknown): boolean {
  return hasAdapterMarker(err, RESPONSE_STREAM_ABORT_FLAG);
}

/** Whether XHRAdapter tagged this throw as a browser-fired request timeout. */
function isXHRBrowserTimeout(err: unknown): boolean {
  return hasAdapterMarker(err, XHR_BROWSER_TIMEOUT_FLAG);
}

function getResponseStreamAbortInfo(
  err: unknown,
): { status: number; headers: Record<string, string | string[]> } | undefined {
  const status = readObjectMember(err, STREAM_ABORT_STATUS_KEY);

  // Held to the rule a resolved answer's status is: an integer from 0 to 999.
  if (
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 0 ||
    status > 999
  ) {
    return undefined;
  }

  const headers = snapshotHeaderRecord(
    readObjectMember(err, STREAM_ABORT_HEADERS_KEY),
  );

  if (headers === undefined) {
    return undefined;
  }

  // Normalized as a resolved answer's headers are, so `Location` and the rest are read
  // by their lowercase names like every other response's.
  // Read on a failure path, where a throw would replace the failure: a malformed answer
  // here (a `set-cookie` line that is not a string) leaves the error untagged instead.
  try {
    return {
      status,
      headers: normalizeAdapterResponseHeaders(headers),
    };
  } catch {
    return undefined;
  }
}

/**
 * The request body's settlement promise off an error an adapter threw.
 *
 * The mirror of `AdapterResponse.requestBodySettled` for the failure paths: the promise
 * lives in the adapter's closure, and a throw has no response object to hang it on, so it
 * arrives tagged on the error instead.
 *
 * Validated as a thenable rather than trusted. The tag is an ordinary property on an
 * object this client did not create - a caller's own `Error` subclass, or a rejection
 * value from a third-party adapter - and handing a non-promise to `await` downstream
 * resolves it to itself, which would report the tag's own value as the upload's outcome.
 */
function getRequestBodySettled(
  err: unknown,
): Promise<Error | undefined> | undefined {
  const settled = readObjectMember(err, REQUEST_BODY_SETTLED_KEY);

  // Adopted rather than handed over as it arrived. `readObjectMember` guards the read of
  // the tag, and `adoptRequestBodySettled` classifies what came back from a single
  // guarded read of its `then`: a tag whose `then` cannot be read, or that is not a
  // thenable at all, is treated as absent. `HTTPAdapter` is a public extension point, so
  // a custom adapter may tag `Promise.reject(...)` or a foreign thenable; either is
  // adopted onto a promise this client owns, and a rejection becomes the failure it
  // reports, because `HTTPResponse.requestBodySettled` is documented never to reject.
  return adoptRequestBodySettled(settled);
}

/**
 * The response `send()` settles with, carrying the upload outcome of the latest hop that
 * had a body.
 *
 * Applied where the request ends rather than by each terminal branch of the redirect
 * loop, so no branch can leave it off: those branches mostly build with
 * `adapterResponse: null`, and after a followed `POST` -> `302` -> `GET` the last hop has
 * no writer and nothing of its own to report, so a response missing it answers
 * `undefined` - the documented "the body went out" value - for an upload that may have
 * been cut short. The outcome replaces whatever the response was built with, as the
 * caller's word comes first in `_buildResponse`; with none, the response is returned as
 * it is, so a request with no body writer still has no `requestBodySettled` property.
 */
function withRequestBodySettled<T>(
  response: HTTPResponse<T>,
  uploadOutcome: Promise<Error | undefined> | undefined,
): HTTPResponse<T> {
  return uploadOutcome
    ? { ...response, requestBodySettled: uploadOutcome }
    : response;
}

/**
 * Adopt whatever an adapter put on `requestBodySettled` onto a promise this client owns.
 *
 * The same treatment on the resolve path as {@link getRequestBodySettled} gives the throw
 * path, because the hazard is the adapter and not which way it answered: `HTTPAdapter` is
 * a public extension point, and an adapter resolving with a rejecting promise - or with a
 * foreign thenable, or with something that is not a promise at all - would otherwise put
 * it straight onto a field documented never to reject. A caller following the docs and
 * awaiting it without a `try` would then throw, and one that ignores the field would get
 * an unhandled rejection.
 */
function adoptRequestBodySettled(
  settled: unknown,
): Promise<Error | undefined> | undefined {
  // Advisory metadata must not turn a successful request into failure. Classify
  // once, preserving the captured then function; an unreadable return is absent,
  // while a real async rejection becomes the upload's reported error.
  const pending = adoptResult(settled);
  if (pending === undefined || pending instanceof UnreadableReturn) {
    return undefined;
  }
  // Stabilized in the reaction that publishes the Error at this public API boundary,
  // so the adapter's value never settles a promise itself. Only a fulfilment may answer
  // `undefined` (the upload completed): a rejection is always a failure, so a rejection
  // reason of `undefined` is normalized to an Error like any other reason.
  return pending.then(
    ({ value }) => (value === undefined ? undefined : stableUploadError(value)),
    (error: unknown) => stableUploadError(error),
  );
}

/** The fields an upload Error's wrapper copies from it; see `stableUploadError`. */
const UPLOAD_ERROR_FIELDS = [
  'code',
  'errno',
  'syscall',
  'address',
  'port',
  'path',
] as const;

/**
 * Avoid invoking a caller Error's `then` while resolving the public outcome promise.
 *
 * A caller Error is always wrapped, with the original as `cause`: no check available on
 * every runtime can prove it is not a Proxy whose `then` lookup runs caller code, so the
 * outcome is the same whatever the runtime or the Error's class. Any other value is
 * normalized into an Error this client creates, which already carries it as `cause`.
 * Either way the promise resolves with a fresh Error whose `then` lookup reaches only
 * the built-in prototypes.
 */
function stableUploadError(value: unknown): Error {
  if (!isErrorValue(value)) {
    return normalizeError(value);
  }
  const error = value;
  const message = readObjectMember(error, 'message');
  const wrapped = new Error(
    typeof message === 'string' ? message : 'Upload failed',
    { cause: error },
  );
  const name = readObjectMember(error, 'name');
  if (typeof name === 'string') {
    Object.defineProperty(wrapped, 'name', {
      value: name,
      writable: true,
      configurable: true,
    });
  }
  // Wrapping is required for safe promise resolution, but the upload's diagnostic
  // fields and original stack still describe the failure better than this wrapper's
  // construction site. Snapshot only known fields - `code` and the rest of a Node system
  // error's (`errno`, `syscall`, `address`, `port`, `path`) - with guarded reads; copying
  // arbitrary properties would run unrelated getters and could copy `then` back in.
  // Define own data properties so inherited setters cannot intercept the copies.
  for (const field of UPLOAD_ERROR_FIELDS) {
    const fieldValue = readObjectMember(error, field);
    if (fieldValue !== undefined) {
      defineEntry(
        wrapped as unknown as Record<string, unknown>,
        field,
        fieldValue,
      );
    }
  }
  // Not `defineEntry`: `stack` stays non-enumerable, as a native Error's own is.
  const stack = readObjectMember(error, 'stack');
  if (typeof stack === 'string') {
    Object.defineProperty(wrapped, 'stack', {
      value: stack,
      writable: true,
      configurable: true,
    });
  }
  return wrapped;
}

/**
 * Where a `streamResponse` factory's answer stands: it started no stream (`none` - it threw,
 * or answered something other than an object, or its promise did, or rejected), its
 * answer is in hand (`answered`, not yet looked at), or it has not answered yet
 * (`pending` - a promise not yet settled, or a thenable the client does not follow).
 */
type StreamFactoryState = 'none' | 'pending' | 'answered';

/**
 * Watch a `streamResponse` factory's answer, reading nothing of it: the adapter reads it -
 * once, as a cancel or a sink - and a second read of a getter could answer otherwise. An
 * object returned as it is is the answer at once; a plain native promise - an `async`
 * factory's - is observed through the native `then`, and `onAnswer` is handed the object
 * it fulfills with, or `undefined` for anything else or a rejection. What is not a plain
 * native promise is classified only at abandonment (see `tearDownStreamFactoryAnswer`),
 * where a thenable the client does not follow is told apart: following it here too would
 * call its `then` twice.
 */
function watchStreamFactoryAnswer(
  returned: unknown,
  onAnswer: (answer: object | undefined) => void,
): { state: StreamFactoryState; answer?: object } {
  if (!isObjectLike(returned)) {
    return { state: 'none' };
  }

  let isPlainPromise: boolean;
  try {
    isPlainPromise =
      Reflect.getPrototypeOf(returned) === Promise.prototype &&
      !Object.hasOwn(returned, 'then') &&
      !Object.hasOwn(returned, 'constructor');
  } catch {
    // A proxy's trap threw: nothing here can tell what it is.
    return { state: 'pending' };
  }

  if (!isPlainPromise) {
    return { state: 'answered', answer: returned };
  }

  try {
    attachIntrinsicReactions<unknown>(
      returned,
      (value) => {
        onAnswer(isObjectLike(value) ? value : undefined);
      },
      // The adapter reports the factory's rejection; this only reads that it started
      // nothing.
      () => {
        onAnswer(undefined);
      },
    );
  } catch {
    // Not observable through the native `then`; the adapter follows it alone.
  }

  return { state: 'pending' };
}

/**
 * Tear down what a `streamResponse` factory answered an abandoned attempt with, as
 * `NodeAdapter` does to a sink when a request is cancelled or times out mid-stream:
 * `destroy()`, best-effort. A cancel (`{ cancel: true }`) opened no sink and started no
 * stream (`none`); a thenable the client does not follow is left alone, its sink unknown
 * (`pending`). Read only here, once the adapter that ignored the abort is given up on.
 */
function tearDownStreamFactoryAnswer(answer: object): StreamFactoryState {
  if (readObjectMember(answer, 'cancel') === true) {
    return 'none';
  }

  if (typeof readObjectMember(answer, 'then') === 'function') {
    return 'pending';
  }

  const destroy = readObjectMember(answer, 'destroy');
  if (typeof destroy === 'function') {
    try {
      const result: unknown = Reflect.apply(destroy, answer, []);
      // An async `destroy` that rejects is contained as one that throws is: left alone,
      // its rejection would be unhandled - fatal under Node's default.
      if (isObjectLike(result)) {
        observeRejection(adoptPromise(result), noop);
      }
    } catch {
      // Best-effort cleanup only; the attempt's own outcome is what is reported.
    }
  }

  return 'answered';
}

/** How a wait on the previous attempt's upload ended. */
type UploadSettleWait = 'settled' | 'cancelled' | 'deadline';

/** When a request's upload last showed activity - dispatched, or reported progress. One per request. */
interface UploadActivity {
  /** `performance.now()` of the last dispatch or progress report, so a wall-clock step cannot fake a stall or hide one. */
  at: number;
  /**
   * `performance.now()` of when the latest attempt's body writer first parked on its
   * source - a `Blob.stream()` read still outstanding - since the upload last reported
   * progress, as `NodeAdapter` reports it through `listenForUploadSourceWait`; `undefined`
   * when it has not. Kept across waits until progress arrives: a read that comes back with
   * nothing has moved nothing. See {@link lastUploadActivityAt}.
   */
  sourceStallSince: number | undefined;
  /** When the last of those waits ended, or `undefined` while one is under way. */
  sourceWaitEndedAt: number | undefined;
  /** How many attempts have been dispatched, so only the latest one's reports are heard. */
  dispatches: number;
}

/** Records a dispatch, which counts as activity and starts afresh; returns its number. */
function noteUploadDispatch(activity: UploadActivity): number {
  activity.at = performance.now();
  activity.sourceStallSince = undefined;
  activity.sourceWaitEndedAt = undefined;
  activity.dispatches++;

  return activity.dispatches;
}

/**
 * Records an upload-progress report: activity, always, and the end of a run of source
 * waits - or, reported while the writer is still waiting, the start of a new one.
 */
function noteUploadProgress(activity: UploadActivity): void {
  const now = performance.now();
  const isAwaitingSource =
    activity.sourceStallSince !== undefined &&
    activity.sourceWaitEndedAt === undefined;

  activity.at = now;
  activity.sourceStallSince = isAwaitingSource ? now : undefined;
}

/**
 * Records the writer parking on its source, or coming back from it. A wait that begins
 * keeps the start of the run it belongs to, however often it is reported; one that ends
 * is not progress, and starts nothing over.
 */
function noteUploadSourceWait(
  activity: UploadActivity,
  isWaiting: boolean,
): void {
  if (isWaiting) {
    activity.sourceStallSince ??= performance.now();
    activity.sourceWaitEndedAt = undefined;
  } else if (activity.sourceStallSince !== undefined) {
    activity.sourceWaitEndedAt ??= performance.now();
  }
}

/**
 * When a request's upload last showed activity, for the stall clock in
 * `settleUploadBeforeNextDispatch`: its last dispatch or progress report, or - when later
 * - the time its writer spent waiting on its source since then: now while it waits, the
 * last wait's end between waits. That time counts for no more than
 * {@link UPLOAD_SOURCE_STALL_GRACE_MS} from the first wait since the last progress.
 *
 * Such a writer makes no progress - no bytes are reaching the socket - but it has not
 * stalled: a multipart `File` on a slow disk can leave a read outstanding for longer than
 * a per-attempt timeout, and `NodeAdapter`'s own watchdog gives that wait a grace of its
 * own rather than the socket's. Counted as silence, it would fail as a timeout an upload
 * the adapter is still letting run.
 *
 * Capped at that same grace, counted the way the adapter counts it - from the first wait
 * since the upload last moved, so a source whose reads keep coming back with nothing has
 * one grace, not one per read. `NodeAdapter` settles the outcome itself when its grace
 * runs out, and the client's bound runs out later, by the stall bound past the cap, so a
 * `NodeAdapter` answering on its own response is settled first. The cap is there for
 * the rest: an adapter wrapping a `NodeAdapter` that answers with an outcome of its own,
 * which no watchdog settles, and any adapter that says it is waiting. Past the cap the
 * wait is silence, and the stall bound runs out on it as on any other. Progress always
 * counts.
 */
function lastUploadActivityAt(activity: UploadActivity): number {
  const sourceStallSince = activity.sourceStallSince;

  if (sourceStallSince === undefined) {
    return activity.at;
  }

  const sourceWaitAt = Math.min(
    activity.sourceWaitEndedAt ?? performance.now(),
    sourceStallSince + UPLOAD_SOURCE_STALL_GRACE_MS,
  );

  return Math.max(activity.at, sourceWaitAt);
}

/**
 * How long an attempt whose signal has aborted - its timer, or a cancel - still waits for
 * the adapter's `send()` to settle before ending without it. See {@link awaitAdapterSend}.
 */
const ADAPTER_ABORT_GRACE_MS = 1000;

/**
 * The adapter's `send()`, ended by the attempt's abort if the adapter does not end it.
 *
 * A well-behaved adapter answers its signal itself - `NodeAdapter` destroys the request
 * and rejects - and what it settles with is what the attempt reports: its upload outcome,
 * a body stream's status and headers, a late answer that reads cleanly. So the abort is
 * not raced at once, which would lose all of that to whichever reaction ran first; the
 * adapter gets {@link ADAPTER_ABORT_GRACE_MS} to settle. An adapter `HTTPAdapter` lets
 * anyone write may ignore the signal and never settle, and awaited bare it would hold the
 * request past its timeout and past a `cancel()` for good. Past the grace the attempt
 * rejects with `reason()` - the timer's `AbortError`, or the cancel's reason - and ends
 * as that timeout or cancel; an attempt with a body reports its upload's fate unknown,
 * since the adapter gave none (see `ABANDONED_UPLOAD_MESSAGE`).
 * The adapter's promise stays observed, so a later rejection is not unhandled; a later
 * answer is ignored. `onAbandon` runs first, so the caller can disarm what it handed
 * the adapter.
 */
function awaitAdapterSend<T>(
  adapterPromise: Promise<T>,
  signal: AbortSignal,
  reason: () => unknown,
  /** Called when the grace runs out, just before the attempt ends without the adapter. */
  onAbandon: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let graceID: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      graceID = setTimeout(() => {
        onAbandon();
        // The abort's own reason, a cancel's string included, as an adapter that honors
        // the signal would reject with it: the attempt reads it as that cancel or timeout.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(reason());
      }, ADAPTER_ABORT_GRACE_MS);
    };
    const release = (): void => {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(graceID);
    };

    adapterPromise.then(
      (value) => {
        release();
        resolve(value);
      },
      (error: unknown) => {
        release();
        // The adapter's rejection as it is, for the attempt to classify.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      },
    );

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Wait for an attempt's upload to settle before the next dispatch - the next redirect hop,
 * or the retry that replaces it.
 *
 * Never throws and never rejects, whatever the adapter handed over: adoption happens at
 * the attempt runner, and this wait observes the adopted outcome's settlement either way,
 * never its value. A cancel ends the wait, answering `'cancelled'`, and the caller ends
 * the request as cancelled rather than dispatching.
 *
 * Bounded by `stallMS`, the request's own per-attempt timeout, as a *stall* bound: the
 * clock restarts every time the upload reports progress, so what fails is an upload that
 * has gone silent for that long, never one that is still moving however long it takes.
 * A writer waiting on its source is not silent, for up to the grace `NodeAdapter` gives
 * such a wait itself, and the clock restarts when that wait ends (see
 * {@link lastUploadActivityAt}).
 * `requestBodySettled` is documented as settling in bounded time, and `NodeAdapter`'s
 * does - its stall watchdog sees to that - but `HTTPAdapter` is a public extension point,
 * and a custom adapter that sets the field and never settles it would otherwise hold
 * every followed redirect, or a retry, until the caller aborts: no timeout, no error,
 * nothing on any channel. An adapter that reports no progress at all gets the bound from
 * dispatch. `0` disables it exactly as it disables the per-attempt timer. What happens at
 * the bound is decided at each site - the request fails as a timeout rather than
 * dispatching a second upload beside one that may still be going out.
 */
async function settleUploadBeforeNextDispatch(
  settled: Promise<Error | undefined> | undefined,
  cancelSignal: AbortSignal,
  stallMS: number,
  lastActivityAt: () => number,
): Promise<UploadSettleWait> {
  // The cancel is answered first, before there is any promise to wait on. Both retry
  // sites reach here straight after the backoff delay, and a cancel that landed during
  // that delay is read off this answer - a response with no upload outcome to wait on
  // still has to report it, or the cancel is missed and the next attempt is dispatched.
  if (cancelSignal.aborted) {
    return 'cancelled';
  }

  // All callers pass the attempt runner's already-adopted upload outcome. This
  // wait observes completion only; it must not normalize the public Error again.
  if (settled === undefined) {
    return 'settled';
  }

  let onAbort: (() => void) | undefined;
  let deadlineID: ReturnType<typeof setTimeout> | undefined;

  const cancelled = new Promise<UploadSettleWait>((resolve) => {
    onAbort = () => resolve('cancelled');
    cancelSignal.addEventListener('abort', onAbort, { once: true });
  });

  const expired = new Promise<UploadSettleWait>((resolve) => {
    if (stallMS <= 0) {
      return;
    }

    // Re-armed rather than reset on every report: a timer touched from inside a progress
    // callback would run on the adapter's cadence. When it fires, the question is only
    // whether anything moved since the wait was last armed - if so, the stall is
    // measured from that report, and the timer sleeps for the remainder.
    const arm = (sinceMS: number): void => {
      deadlineID = setTimeout(() => {
        const quietForMS = performance.now() - lastActivityAt();

        if (quietForMS >= stallMS) {
          resolve('deadline');

          return;
        }

        arm(stallMS - quietForMS);
      }, clampTimerDelayMS(sinceMS));
    };

    // Count silence before this wait, including retry backoff. Even an overdue check
    // runs through the timer: an already-completed upload must get its promise callbacks
    // processed before we declare it stalled. A pending upload is checked next tick,
    // without granting it another full stall window.
    const quietOnEntryMS = performance.now() - lastActivityAt();
    arm(stallMS - Math.max(0, quietOnEntryMS));
  });

  // Settlement, not outcome: a rejection counts as settled too. Every caller passes the
  // attempt runner's already-adopted outcome, which cannot reject, but the "never rejects"
  // guarantee above is this function's own and must not rest on that precondition.
  const uploadSettled = settled.then(
    (): UploadSettleWait => 'settled',
    (): UploadSettleWait => 'settled',
  );
  try {
    return await Promise.race([uploadSettled, cancelled, expired]);
  } finally {
    if (onAbort !== undefined) {
      cancelSignal.removeEventListener('abort', onAbort);
    }

    if (deadlineID !== undefined) {
      clearTimeout(deadlineID);
    }
  }
}

/**
 * Say, on the global `'error'` channel, why a request failed as a timeout between attempts
 * or hops: the previous attempt's upload made no progress for the whole wait. That is a
 * server that answered early and stopped reading the body as often as an adapter whose
 * `requestBodySettled` never settles, so the report names both rather than blaming the
 * adapter. The timeout error alone cannot say which wait it was.
 */
function reportUploadSettleDeadline(
  adapterType: AdapterType,
  deadlineMS: number,
  nextDispatch: 'redirect' | 'retry',
): void {
  reportToHost(
    new Error(
      `HTTPClient waited for the previous attempt's upload to settle before the next ${nextDispatch}, and it made no progress for ${String(deadlineMS)}ms without settling - the server may have stopped reading the body after answering, or the '${adapterType}' adapter's requestBodySettled does not settle. The request failed as a timeout rather than dispatching a second upload beside the first.`,
    ),
  );
}

/**
 * Returns the AbortSignal's reason as a string if the caller explicitly passed
 * one (e.g. `controller.abort('my reason')`). Returns undefined for the default
 * AbortError reason set by the runtime when no explicit reason is provided.
 */
function getSignalCancelReason(signal: AbortSignal): string | undefined {
  const reason = readObjectMember(signal, 'reason');

  return typeof reason === 'string' ? reason : undefined;
}

/**
 * A request URL's host as the credential-scope rule compares it: lowercased, and with
 * every trailing dot dropped, so `evil.example.` and `evil.example..` are the same host
 * as `evil.example` - in whichever of the hop's URL and the attempt's each spelling
 * appears. Looser than the `hosts` matcher, which reads `..` as naming no host: a
 * respelling must never read as the caller choosing a new host, and so taking the scope
 * to the one the server chose. `''` for a URL that names no host.
 *
 * The cookie jar keeps `api.example.` and `api.example` apart, as browsers keep hosts.
 * The two rules are meant to differ: this one decides whether credentials may follow,
 * where reading two spellings as one host is the safe answer, and the jar decides which
 * cookies a host was given.
 */
function comparableHost(url: string): string {
  return trimEndWhere(asciiLowercase(extractHostname(url)), isDot);
}

/** Whether `code` is `.`. */
function isDot(code: number): boolean {
  return code === 0x2e;
}

/** Whether a phase's copy of a body failed; see `copyChainResultBody`. */
interface BodyCopyOutcome {
  didFail: boolean;
}

/**
 * Whether a phase has prepared the request it hands its interceptors (see
 * `handedRequestPreparer`), and whether a copy of the body - that one, or the chain's
 * result's - failed.
 */
interface HandedBodyCopy extends BodyCopyOutcome {
  isTaken: boolean;
}

/**
 * A phase's `prepareRequest` (see `InterceptorChainOptions`): the request with a copy of
 * each part `copies` names, taken once per phase - a parent client's chain may have taken
 * it already - and a body copy that fails recorded in `copy`. A part it copies is one the
 * phase keeps - for the report a cancel or a failure makes, and in the redirect phase as
 * the request the hop that answered was sent with - so an interceptor that edits it in
 * place, `request.headers.authorization = ...`, edits only the request it returns:
 *
 * - The initial phase copies the header record alone. Its body is the builder's copy,
 *   handed over as it is, since copying it again for every request an interceptor runs
 *   for would cost as much as the first copy - a large JSON body parsed again, an upload's
 *   bytes held a third time - so a request that ends in that phase is reported with an
 *   interceptor's in-place edit of its body.
 * - The redirect phase copies both.
 * - The retry phase copies the body alone: its header record is built for each retry (see
 *   `_withInternalRequestHeaders`), and nothing else holds it.
 *
 * The record is the client's own - built through `mergeHeaders`, or the hop's - so copying
 * it reads no caller code.
 */
function handedRequestPreparer(
  copy: HandedBodyCopy,
  copies: { headers: boolean; body: boolean },
): (request: InterceptedRequest) => InterceptedRequest {
  return (request) => {
    if (copy.isTaken) {
      return request;
    }
    copy.isTaken = true;
    const prepared = { ...request };
    if (copies.headers) {
      prepared.headers = copyHeaderRecord(
        request.headers as Record<string, string | string[]>,
      );
    }
    if (copies.body) {
      try {
        prepared.body = copyRequestBody(request.body);
      } catch (error) {
        copy.didFail = true;
        throw error;
      }
    }
    return prepared;
  };
}

/**
 * A chain's result with its body as the client's own copy (see `copyRequestBody`), for a
 * phase whose interceptors were handed the request's body: one may keep the object it
 * returned - or the one it was handed - and change it later, from an observer or an
 * `onAttemptEnd`, which would otherwise reach a later attempt or a `307`/`308` replay.
 * Taken once the result has passed the phase's checks that do not read the body - its
 * type, the headers, the method, the URL (skipped in the redirect phase for a `Location`
 * that arrived unusable and is still unusable, which is answered after the phase) - so each
 * is still refused as the interceptor's before the body is serialized, and only for a
 * result whose body is sent: a retry held to a hop's own request sends the hop's body. The
 * GET and HEAD rule reads the copy (see `hasRequestBody`), so a body is judged by what it
 * serialized to when it was copied, which is what is sent. A body that cannot be copied -
 * a `toJSON` that throws, a `BigInt` - is the body's failure, as one that
 * cannot be serialized is, not an interceptor's: `outcome.didFail` is set before it
 * throws, and the phase reports it as `request_setup_error` - but on a GET or HEAD the
 * rule refuses, which `_copyChainResultBody` reports as that refusal.
 */
function copyChainResultBody(
  request: ResolvedRequest,
  outcome: BodyCopyOutcome,
): ResolvedRequest {
  let body: unknown;
  try {
    body = copyRequestBody(request.body);
  } catch (error) {
    outcome.didFail = true;
    throw error;
  }

  return { ...request, body };
}

/**
 * What a cross-origin hop sends for a retry-phase interceptor's body that sends nothing -
 * none, an empty string, no bytes, a form with no entries, or a JSON body that serializes
 * to nothing - as `{ body }`, or `undefined` for any other body. Bytes and a form are
 * answered as an empty one of the client's own, so what goes out is what was measured:
 * the bytes are measured through the intrinsic getters (see `readBinaryByteLength`),
 * which a subclass that reports a `byteLength` of `0` while holding a token cannot answer
 * for, and the form's entries through `FormData`'s own iterator rather than one the value
 * declares. A JSON body that serializes to nothing is answered as no body, told from its
 * top-level `toJSON` alone rather than by serializing it (see `serializesToNothing`): a
 * body only read here, as an interceptor's on a hop held to its own, is never serialized.
 * Throws on a body those reads refuse, as building it would.
 */
function emptyRequestBody(body: unknown): { body: unknown } | undefined {
  if (body === undefined || body === null || body === '') {
    return { body };
  }

  if (typeof body !== 'object') {
    return undefined;
  }

  if (isRequestBodyBytes(body)) {
    return readBinaryByteLength(body) === 0
      ? { body: new Uint8Array(0) }
      : undefined;
  }

  if (isFormData(body) && formEntries(body).next().done === true) {
    return { body: new FormData() };
  }

  if (Array.isArray(body) || isPlainRecord(body)) {
    // One whose `toJSON` throws is no body that sends nothing: on a hop held to its own
    // body, the hop's is sent in its place.
    try {
      return serializesToNothing(body) ? { body: undefined } : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Whether a request carries a body at all, as the GET and HEAD rules read one. None does
 * not, and nor does a JSON body copy the client made that serializes to nothing (see
 * `isCopySerializingToNothing`), which goes out with no body. Any other value is a body -
 * an empty string, bytes or form, which `fetch` refuses on a GET, and a body an
 * interceptor returned, which is not serialized here: its `toJSON` could answer nothing
 * now and a body when the copy that is sent is taken. So the GET and HEAD rule reads a
 * phase's request once its interceptors' body is copied (see `copyChainResultBody`).
 */
function hasRequestBody(body: unknown): boolean {
  return (
    body !== undefined && body !== null && !isCopySerializingToNothing(body)
  );
}

/**
 * Whether a body sends anything: by the rule `emptyRequestBody` reads a body by - none, an
 * empty string, no bytes, a form with no entries, or a JSON body that serializes to
 * nothing sends nothing. It is asked about an attempt's body as the client serialized it
 * (see `buildAttemptBodies`), and on a cross-origin hop (see
 * `withoutAddedCrossOriginCredentials`) about the hop's own body and the body the retry
 * interceptors returned, which on a hop held to its own is read uncopied, once; a caller
 * that is handed a throw fails the request as `request_setup_error`.
 */
function sendsRequestBody(body: unknown): boolean {
  return emptyRequestBody(body) === undefined;
}

/**
 * A retry-phase interceptor's request for a cross-origin redirect hop, without anything
 * the interceptor added that could carry a credential to the hop's host: every header
 * named neither on the request the chain was handed (`inputHeaderNames`, taken before it
 * ran) nor on the cross-origin safelist, and every change to the body and to the URL but
 * an upgrade to `https:`. A header the hop already carried keeps the value the
 * interceptor gave it.
 *
 * The URL is the hop's own (`hopRequest`): its path, query, fragment, port and userinfo
 * alike, since a token travels in a query string as readily as in a header and none of
 * them can be told apart from one. The one change kept is an upgrade from `http:` to
 * `https:` that leaves the port as it was - each scheme's default, or the same port
 * number - which carries nothing to the host and only protects what is sent (see
 * `upgradedHopURL`); a downgrade, or any other change of scheme or port, is not.
 *
 * The body is the hop's own value too, not the copy the interceptors were handed,
 * whatever they did to it - unless they removed it or left it empty, which sends
 * nothing (see `emptyRequestBody`). The hop's own body goes with the hop's own headers
 * that describe it (`BODY_DESCRIBING_HEADERS`), whether the interceptors replaced it,
 * edited their copy, or left it alone: theirs describe a body that is not sent. A body
 * they dropped goes with none of them, the hop's or the interceptors', as a hop
 * rewritten to `GET` drops them with its body. A hop with no body to send has nothing
 * to drop, so it goes as it was, its own headers included.
 */
function withoutAddedCrossOriginCredentials(
  request: ResolvedRequest,
  inputHeaderNames: ReadonlySet<string>,
  hopRequest: ResolvedRequest,
): ResolvedRequest {
  const droppedBody = sendsRequestBody(hopRequest.body)
    ? emptyRequestBody(request.body)
    : undefined;
  const isBodyDropped = droppedBody !== undefined;
  // Names are already lowercase: the result is a snapshot (see `snapshotInterceptedRequest`).
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (BODY_DESCRIBING_HEADERS.has(name)) {
      continue;
    }

    if (inputHeaderNames.has(name) || CROSS_ORIGIN_SAFE_HEADERS.has(name)) {
      defineEntry(headers, name, value);
    }
  }

  if (!isBodyDropped) {
    for (const name of BODY_DESCRIBING_HEADERS) {
      if (Object.hasOwn(hopRequest.headers, name)) {
        defineEntry(headers, name, hopRequest.headers[name]);
      }
    }
  }

  return {
    ...request,
    requestURL: upgradedHopURL(hopRequest.requestURL, request.requestURL),
    headers,
    body: droppedBody !== undefined ? droppedBody.body : hopRequest.body,
  };
}

/**
 * A cross-origin hop's own URL, upgraded to `https:` when a retry-phase interceptor asked
 * for exactly that: the hop is `http:`, the interceptor's URL is `https:` on the same host
 * (the caller has already compared them), and the port is unchanged - both each scheme's
 * default, or the same port number on both, however the URL writes it (`https://h:443` is
 * read as `https://h`, `http://h:80` as `http://h`). Everything else of the hop's URL -
 * path, query, userinfo - stays its own, as it does for any other change; so does a URL
 * that cannot be read.
 */
function upgradedHopURL(hopURL: string, interceptedURL: string): string {
  try {
    const hop = new URL(hopURL);
    const intercepted = new URL(interceptedURL);

    if (hop.protocol !== 'http:' || intercepted.protocol !== 'https:') {
      return hopURL;
    }

    const isDefaultPorts = hop.port === '' && intercepted.port === '';
    const hopPort = hop.port === '' ? '80' : hop.port;
    const interceptedPort = intercepted.port === '' ? '443' : intercepted.port;
    if (!isDefaultPorts && hopPort !== interceptedPort) {
      return hopURL;
    }

    hop.protocol = 'https:';
    // Set again: a scheme change drops a port that is the new scheme's default.
    hop.port = isDefaultPorts ? '' : hopPort;
    return hop.href;
  } catch {
    return hopURL;
  }
}
