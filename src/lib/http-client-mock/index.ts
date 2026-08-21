export { MockAdapter } from '../http-client/adapters/mock-adapter';
export type {
  MockAdapterConfig,
  MockAdapterRoutes,
  MockRequest,
  MockResponse,
  MockRouteHandler,
  MockFormData,
  MockCookieOptions,
} from '../http-client/adapters/mock-adapter';

/**
 * Adapter contract types, re-exported so code driving an adapter directly —
 * building AdapterRequest objects and calling send() rather than going through
 * HTTPClient — does not have to import types from 'lifecycleion/http-client',
 * the module it is specifically not using. Type-only, so nothing is added to
 * the runtime bundle.
 */
export type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  AdapterProgressEvent,
  HTTPMethod,
} from '../http-client/types';
