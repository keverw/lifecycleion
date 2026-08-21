import { describe, expect, test } from 'bun:test';
import { NodeAdapter } from './index';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  AdapterProgressEvent,
  HTTPMethod,
  StreamResponseFactory,
  StreamResponseInfo,
  StreamResponseContext,
  StreamResponseCancel,
  WritableLike,
  NodeAdapterConfig,
} from './index';
import { MockAdapter } from '../http-client-mock';
import type {
  HTTPAdapter as MockBarrelHTTPAdapter,
  AdapterRequest as MockBarrelAdapterRequest,
} from '../http-client-mock';
import type {
  HTTPAdapter as XHRBarrelHTTPAdapter,
  AdapterRequest as XHRBarrelAdapterRequest,
} from '../http-client-xhr';

// The point of the re-exports: drive an adapter directly, importing every type
// you need from the adapter's own subpath rather than from
// 'lifecycleion/http-client', the module you are specifically not using.
describe('adapter barrels re-export the adapter contract types', () => {
  test('a direct consumer can type an adapter, request, and response from the node barrel', async () => {
    const config: NodeAdapterConfig = {};
    const adapter: HTTPAdapter = new NodeAdapter(config);
    const method: HTTPMethod = 'GET';
    const type: AdapterType = adapter.getType();

    const progress: AdapterProgressEvent[] = [];
    const request: AdapterRequest = {
      requestURL: 'http://127.0.0.1:1/unused',
      method,
      headers: {},
      onUploadProgress: (event: AdapterProgressEvent) => {
        progress.push(event);
      },
    };

    expect(type).toBe('node');
    expect(request.method).toBe('GET');

    // Nothing is listening on port 1 — this exists to prove the AdapterResponse
    // type is usable at the call site, not to exercise the network.
    let response: AdapterResponse | undefined;

    try {
      response = await adapter.send(request);
    } catch {
      // Connection refused is the expected outcome.
    }

    expect(response === undefined || typeof response.status === 'number').toBe(
      true,
    );
    expect(progress.length).toBeGreaterThan(0);
  });

  test('the node barrel carries the response-streaming types', () => {
    // NodeAdapter is the only adapter honouring streamResponse, so these ride
    // on this barrel alone.
    const info: StreamResponseInfo = {
      status: 200,
      headers: {},
      url: 'http://example.test/',
      attempt: 1,
      requestID: 'test',
    };
    const cancel: StreamResponseCancel = { cancel: true, reason: 'not needed' };
    const factory: StreamResponseFactory = (
      _info: StreamResponseInfo,
      _context: StreamResponseContext,
    ) => cancel;
    const sink: WritableLike | null = null;

    expect(factory(info, { signal: new AbortController().signal })).toBe(
      cancel,
    );
    expect(sink).toBeNull();
  });

  test('the mock and xhr barrels re-export the same contract', () => {
    const adapter: MockBarrelHTTPAdapter = new MockAdapter();
    const mockRequest: MockBarrelAdapterRequest = {
      requestURL: 'http://example.test/',
      method: 'GET',
      headers: {},
    };
    const xhrRequest: XHRBarrelAdapterRequest = mockRequest;
    const xhrAdapter: XHRBarrelHTTPAdapter = adapter;

    // Same underlying types, so values cross barrels without conversion.
    expect(adapter.getType()).toBe('mock');
    expect(xhrAdapter).toBe(adapter);
    expect(xhrRequest).toBe(mockRequest);
  });
});
