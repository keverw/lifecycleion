export { HTTPClient } from './http-client';
export { HTTPRequestBuilder } from './http-request-builder';
export { CookieJar } from './cookie-jar';
export { FetchAdapter } from './adapters/fetch-adapter';
export { normalizeAdapterResponseHeaders, scalarHeader } from './utils';

export type {
  HTTPAdapter,
  AdapterType,
  AdapterRequest,
  AdapterResponse,
  HTTPMethod,
  ContentType,
  QueryValue,
  QueryObject,
  HTTPClientConfig,
  SubClientConfig,
  HTTPRequestOptions,
  HTTPResponse,
  HTTPClientError,
  HTTPProgressEvent,
  AttemptStartEvent,
  AttemptEndEvent,
  RequestInterceptorFilter,
  ErrorObserverFilter,
  ResponseObserverFilter,
  RequestInterceptor,
  RequestInterceptorContext,
  InterceptorCancel,
  ResponseObserver,
  ErrorObserver,
  InterceptedRequest,
  AttemptRequest,
  RequestPhase,
  RequestPhaseName,
  InterceptorPhaseName,
  ResponseObserverPhaseName,
  ErrorObserverPhaseName,
  InterceptorPhase,
  ResponseObserverPhase,
  ErrorObserverPhase,
  RedirectHopInfo,
  RequestState,
  // Streaming types — needed to type a StreamResponseFactory function
  WritableLike,
  StreamResponseInfo,
  StreamResponseContext,
  StreamResponseFactory,
} from './types';

export type { Cookie, CookieJarJSON } from './cookie-jar';
export type { RequestInfo } from './request-tracker';

export {
  RETRYABLE_STATUS_CODES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_REQUEST_ID_HEADER,
  DEFAULT_REQUEST_ATTEMPT_HEADER,
  DEFAULT_USER_AGENT,
  HTTP_METHODS,
  BROWSER_RESTRICTED_HEADERS,
  BROWSER_RESTRICTED_HEADER_PREFIXES,
  BROWSER_METHOD_OVERRIDE_HEADER_NAMES,
  BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES,
  DEFAULT_MAX_REDIRECTS,
  REDIRECT_STATUS_CODES,
} from './consts';
