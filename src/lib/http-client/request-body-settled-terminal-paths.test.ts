import { expect, test } from 'bun:test';
import { HTTPClient } from './http-client';
import { REQUEST_BODY_SETTLED_KEY } from './consts';
import type {
  AdapterRequest,
  AdapterResponse,
  HTTPAdapter,
  HTTPClientConfig,
} from './types';

// One table over the ways `send()` can end a bodied request. Each ending runs on the hop
// that carried the body, which reports its own outcome, and - where the ending can follow
// a redirect - on a bodiless `GET` after a followed `302`, which has none: only the outcome
// carried from the bodied hop can answer there, and an ending that leaves it off answers
// `undefined`, the documented "the body went out" value.

type Shape = 'on the bodied hop' | 'after a followed 302';
type Builder = ReturnType<HTTPClient['post']>;
type Settled = Promise<Error | undefined> | undefined;

interface Ending {
  name: string;
  shapes: Shape[];
  /**
   * The hop that ends the request. `settled` is the upload outcome when this hop is the
   * bodied one, to put on the response or tag on the error it throws.
   */
  end: (
    request: AdapterRequest,
    settled: Settled,
    builder: Builder,
  ) => Promise<AdapterResponse>;
  /** The first hop's `Location` in the followed-`302` shape. */
  location?: string;
  config?: Partial<HTTPClientConfig>;
  configure?: (builder: Builder) => void;
  check: (
    response: Awaited<ReturnType<Builder['send']>>,
    builder: Builder,
  ) => void;
}

const bothShapes: Shape[] = ['on the bodied hop', 'after a followed 302'];

function withSettled(settled: Settled): Partial<AdapterResponse> {
  return settled ? { requestBodySettled: settled } : {};
}

function tagged(error: Error, settled: Settled): Error {
  if (settled) {
    Object.assign(error, { [REQUEST_BODY_SETTLED_KEY]: settled });
  }

  return error;
}

function abortError(settled: Settled): Error {
  const error = new Error('Request aborted');

  error.name = 'AbortError';

  return tagged(error, settled);
}

function rejectOnAbort(
  request: AdapterRequest,
  settled: Settled,
): Promise<AdapterResponse> {
  return new Promise((_resolve, reject) => {
    request.signal?.addEventListener('abort', () => {
      reject(abortError(settled));
    });
  });
}

const endings: Ending[] = [
  {
    name: 'success',
    shapes: bothShapes,
    end: (_request, settled) =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode('{"ok":true}'),
        ...withSettled(settled),
      }),
    check: (response, builder) => {
      expect(response.isFailed).toBe(false);
      expect(builder.error).toBeNull();
    },
  },
  {
    name: 'cancel',
    shapes: bothShapes,
    end: (request, settled, builder) => {
      const pending = rejectOnAbort(request, settled);

      builder.cancel();

      return pending;
    },
    check: (response) => {
      expect(response.isCancelled).toBe(true);
    },
  },
  {
    name: 'timeout',
    shapes: bothShapes,
    end: rejectOnAbort,
    config: { timeout: 20 },
    check: (response) => {
      expect(response.isTimeout).toBe(true);
    },
  },
  {
    name: 'adapter_error',
    shapes: bothShapes,
    // A JSON body that is not bytes cannot be decoded: the adapter's malformed answer.
    end: (_request, settled) =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: 12345 as unknown as Uint8Array,
        ...withSettled(settled),
      }),
    check: (response, builder) => {
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('adapter_error');
    },
  },
  {
    name: 'network_error',
    shapes: bothShapes,
    end: (_request, settled) =>
      Promise.reject(tagged(new Error('socket hang up'), settled)),
    check: (response) => {
      expect(response.isNetworkError).toBe(true);
    },
  },
  {
    name: 'stream error',
    shapes: bothShapes,
    end: (_request, settled) =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: null,
        isStreamError: true,
        streamErrorCode: 'stream_response_error',
        errorCause: new Error('terminated'),
        ...withSettled(settled),
      }),
    check: (response, builder) => {
      expect(response.isStreamError).toBe(true);
      expect(builder.error?.code).toBe('stream_response_error');
    },
  },
  {
    name: 'cancel after the answer arrived',
    shapes: bothShapes,
    end: (_request, settled) =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: null,
        ...withSettled(settled),
      }),
    configure: (builder) => {
      builder.onAttemptEnd((event) => {
        if (event.status === 200) {
          builder.cancel();
        }
      });
    },
    check: (response) => {
      expect(response.isCancelled).toBe(true);
      expect(response.status).toBe(0);
    },
  },
  {
    name: 'redirect refusal',
    shapes: ['on the bodied hop'],
    end: (_request, settled) =>
      Promise.resolve({
        status: 302,
        headers: { location: '/elsewhere' },
        body: null,
        ...withSettled(settled),
      }),
    config: { followRedirects: false },
    check: (response, builder) => {
      expect(response.wasRedirectDetected).toBe(true);
      expect(builder.error?.code).toBe('redirect_disabled');
    },
  },
  {
    name: 'redirect loop',
    shapes: ['after a followed 302'],
    end: () =>
      Promise.resolve({
        status: 302,
        headers: { location: '/again' },
        body: null,
      }),
    config: { maxRedirects: 1 },
    check: (response, builder) => {
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('redirect_loop');
    },
  },
  {
    name: 'cancel between hops',
    shapes: ['after a followed 302'],
    // Never reached: the request is cancelled before the next hop is dispatched.
    end: () => Promise.reject(new Error('dispatched after cancel')),
    configure: (builder) => {
      builder.onAttemptEnd((event) => {
        if (event.status === 302) {
          builder.cancel();
        }
      });
    },
    check: (response) => {
      expect(response.isCancelled).toBe(true);
      expect(response.wasRedirectDetected).toBe(true);
    },
  },
  {
    name: 'unusable redirect Location',
    shapes: ['after a followed 302'],
    location: 'file:///etc/passwd',
    // Never reached: the hop is refused before it is dispatched.
    end: () => Promise.reject(new Error('dispatched to a bad Location')),
    check: (response, builder) => {
      expect(response.isFailed).toBe(true);
      expect(builder.error?.code).toBe('request_setup_error');
    },
  },
];

for (const ending of endings) {
  for (const shape of ending.shapes) {
    test(`requestBodySettled survives ${ending.name}, ${shape}`, async () => {
      const uploadFailure = new Error(`upload cut short: ${ending.name}`);
      const sent: Array<{ method: string; hasBody: boolean }> = [];
      const adapter: HTTPAdapter = {
        getType: () => 'node',
        send: (request: AdapterRequest): Promise<AdapterResponse> => {
          sent.push({
            method: request.method,
            hasBody: request.body !== undefined && request.body !== null,
          });

          if (shape === 'on the bodied hop') {
            return ending.end(request, Promise.resolve(uploadFailure), builder);
          }

          if (sent.length === 1) {
            return Promise.resolve({
              status: 302,
              headers: { location: ending.location ?? '/next' },
              body: null,
              requestBodySettled: Promise.resolve(uploadFailure),
            });
          }

          return ending.end(request, undefined, builder);
        },
      };

      // Read by the adapter only once `send()` runs, after it is initialised.
      const builder = new HTTPClient({
        adapter,
        baseURL: 'http://example.test',
        followRedirects: true,
        ...ending.config,
      })
        .post('/upload')
        .json({ a: 1 });
      ending.configure?.(builder);

      const response = await builder.send();

      ending.check(response, builder);
      expect(sent[0]).toEqual({ method: 'POST', hasBody: true });

      // Every later hop is the `GET` the `302` rewrote the `POST` to, with no body and
      // so nothing of its own to report.
      for (const hop of sent.slice(1)) {
        expect(hop).toEqual({ method: 'GET', hasBody: false });
      }

      expect(response.requestBodySettled).toBeDefined();
      expect((await response.requestBodySettled)?.cause).toBe(uploadFailure);
    });
  }
}
