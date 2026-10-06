import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { NodeAdapter } from './adapters/node-adapter';
import { MockAdapter } from './adapters/mock-adapter';
import { HTTPClient } from './http-client';
import type {
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  HTTPAdapter,
  WritableLike,
} from './types';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../internal/console-test-utils';

// Misbehaving caller code - a sink that fails on its own, an `'abort'` listener that
// throws, a request object whose getters change their answer - must never take the
// host process down. These tests record both process-level channels explicitly, and
// claim the `'error'` channel the library reports on instead.

let cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
  cleanups = [];
  restoreConsoleError();
});

/** Everything that escaped as an uncaught exception or an unhandled rejection. */
function watchUncaught(): unknown[] {
  const escaped: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    escaped.push(error);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  cleanups.push(() => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
  });
  return escaped;
}

/** Reports on the standard `'error'` channel, claimed so they do not print. */
function claimReports(): unknown[] {
  const reports: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  cleanups.push(() => {
    globalThis.removeEventListener('error', onError);
  });
  return reports;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A server that sends `200` headers and a little body, then either hangs or resets the
 * connection after `resetAfterMS`.
 */
async function startServer(
  resetAfterMS?: number,
): Promise<{ url: string; requests: () => number }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    req.resume();
    res.writeHead(200, { 'content-length': '100000' });
    res.write('x'.repeat(100));
    if (resetAfterMS !== undefined) {
      setTimeout(() => req.socket.destroy(), resetAfterMS);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No test address');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests: () => count,
  };
}

/** A path inside a directory that does not exist, so opening it fails asynchronously. */
function missingDirectoryPath(): string {
  return path.join(
    os.tmpdir(),
    `lifecycleion-missing-${String(process.pid)}-${String(Date.now())}`,
    'out.bin',
  );
}

function errorMessages(values: unknown[]): string[] {
  return values.map((value) =>
    value instanceof Error ? value.message : String(value),
  );
}

describe('NodeAdapter: a sink returned after its request was torn down', () => {
  // The factory's `await` is the window: the request is cancelled, times out or loses
  // its socket, and the factory then hands back a `fs.WriteStream` whose open is still
  // in flight. The adapter destroys it, but `destroy()` does not suppress an error the
  // stream is already on its way to emitting - and with no `'error'` listener on it,
  // that was an uncaught exception.
  const lateMissingFile = async (): Promise<WritableLike> => {
    await sleep(80);
    return fs.createWriteStream(missingDirectoryPath());
  };

  test('cancelled by the caller during the factory', async () => {
    muteConsoleError();
    const escaped = watchUncaught();
    const reports = claimReports();
    const { url } = await startServer();
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: url,
    });

    const builder = client.get('/').streamResponse(lateMissingFile);
    const pending = builder.send();
    setTimeout(() => builder.cancel('bye'), 20);
    const response = await pending;
    await sleep(300);

    expect(response.isCancelled).toBe(true);
    expect(escaped).toEqual([]);
    // Nowhere else to go: the request had already settled when the sink failed.
    expect(reports.length).toBe(1);
    expect((reports[0] as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  test('timed out during the factory', async () => {
    muteConsoleError();
    const escaped = watchUncaught();
    claimReports();
    const { url } = await startServer();
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: url,
    });

    const response = await client
      .get('/', { timeout: 30 })
      .streamResponse(lateMissingFile)
      .send();
    await sleep(300);

    expect(response.isTimeout).toBe(true);
    expect(escaped).toEqual([]);
  });

  test('peer reset during the factory', async () => {
    muteConsoleError();
    const escaped = watchUncaught();
    claimReports();
    const { url } = await startServer(10);
    const client = new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: url,
    });

    const response = await client
      .get('/')
      .streamResponse(lateMissingFile)
      .send();
    await sleep(300);

    expect(response.isStreamError).toBe(true);
    expect(escaped).toEqual([]);
  });

  test('a healthy late sink is still destroyed and nothing is reported', async () => {
    const escaped = watchUncaught();
    const reports = claimReports();
    const { url } = await startServer(10);
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const response = await new HTTPClient({
      adapter: new NodeAdapter(),
      baseURL: url,
    })
      .get('/')
      .streamResponse(async () => {
        await sleep(80);
        return sink;
      })
      .send();
    await sleep(100);

    expect(response.isStreamError).toBe(true);
    expect(sink.destroyed).toBe(true);
    expect(escaped).toEqual([]);
    expect(reports).toEqual([]);
  });
});

// How a factory or adapter attaches a listener that fails when its signal aborts.
const FAILING_LISTENERS: [
  string,
  (signal: AbortSignal, thrown: Error) => void,
][] = [
  [
    'addEventListener function',
    (signal, thrown) => {
      signal.addEventListener('abort', () => {
        throw thrown;
      });
    },
  ],
  [
    'handleEvent object',
    (signal, thrown) => {
      signal.addEventListener('abort', {
        handleEvent: () => {
          throw thrown;
        },
      });
    },
  ],
  [
    'onabort handler',
    (signal, thrown) => {
      signal.onabort = () => {
        throw thrown;
      };
    },
  ],
];

describe('the streamResponse factory signal', () => {
  for (const [kind, attach] of FAILING_LISTENERS) {
    test(`a failing abort listener (${kind}) is reported, not uncaught`, async () => {
      muteConsoleError();
      const escaped = watchUncaught();
      const reports = claimReports();
      const { url } = await startServer();
      const thrown = new Error(`${kind} failed`);
      const order: string[] = [];
      const client = new HTTPClient({
        adapter: new NodeAdapter(),
        baseURL: url,
      });

      const builder = client.get('/').streamResponse((_info, { signal }) => {
        signal.addEventListener('abort', () => order.push('before'));
        attach(signal, thrown);
        signal.addEventListener('abort', () => order.push('after'));
        setTimeout(() => builder.cancel('bye'), 10);
        return new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
      });
      const response = await builder.send();
      await sleep(50);

      expect(response.isCancelled).toBe(true);
      expect(escaped).toEqual([]);
      expect(order).toEqual(['before', 'after']);
      expect(errorMessages(reports)).toContain(
        'Error in a callback NodeAdapter streamResponse abort listener',
      );
      expect(
        reports.some(
          (report) => report instanceof Error && report.cause === thrown,
        ),
      ).toBe(true);
    });
  }
});

describe('the attempt signal handed to an adapter', () => {
  /** An adapter that listens on its signal with a failing listener, then waits for it. */
  class ListeningAdapter implements HTTPAdapter {
    constructor(
      private readonly attach: (signal: AbortSignal, thrown: Error) => void,
      private readonly thrown: Error,
    ) {}

    public getType(): AdapterType {
      return 'node';
    }

    public send(request: AdapterRequest): Promise<AdapterResponse> {
      const signal = request.signal;
      if (!signal) {
        throw new Error('expected a signal');
      }
      this.attach(signal, this.thrown);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
  }

  for (const [kind, attach] of FAILING_LISTENERS) {
    for (const trigger of ['cancel', 'timeout'] as const) {
      test(`a failing abort listener (${kind}) on ${trigger} is reported, not uncaught`, async () => {
        muteConsoleError();
        const escaped = watchUncaught();
        const reports = claimReports();
        const thrown = new Error(`${kind} failed`);
        const client = new HTTPClient({
          adapter: new ListeningAdapter(attach, thrown),
          baseURL: 'http://adapter.test',
        });

        const builder = client.get('/', {
          timeout: trigger === 'timeout' ? 20 : 0,
        });
        const pending = builder.send();
        if (trigger === 'cancel') {
          setTimeout(() => builder.cancel('bye'), 10);
        }
        const response = await pending;
        await sleep(20);

        expect(
          trigger === 'cancel' ? response.isCancelled : response.isTimeout,
        ).toBe(true);
        expect(escaped).toEqual([]);
        expect(
          reports.some(
            (report) => report instanceof Error && report.cause === thrown,
          ),
        ).toBe(true);
      });
    }
  }
});

describe('NodeAdapter.send() reads the request once', () => {
  const startOK = async (): Promise<string> => {
    const instance = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-length': '2' });
      res.end('ok');
    });
    await new Promise<void>((resolve) =>
      instance.listen(0, '127.0.0.1', resolve),
    );
    cleanups.push(async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    });
    const address = instance.address();
    if (!address || typeof address === 'string') {
      throw new Error('No test address');
    }
    return `http://127.0.0.1:${String(address.port)}/x`;
  };

  /** A request whose `member` getter answers once and throws on every later read. */
  function readsOnce(
    base: AdapterRequest,
    member: 'headers' | 'requestURL' | 'signal',
  ): { request: AdapterRequest; reads: () => number } {
    let reads = 0;
    const value = base[member];
    const request = { ...base };
    Object.defineProperty(request, member, {
      enumerable: true,
      get() {
        reads++;
        if (reads > 1) {
          throw new Error(`${member} getter read again`);
        }
        return value;
      },
    });
    return { request, reads: () => reads };
  }

  for (const member of ['headers', 'requestURL', 'signal'] as const) {
    test(`a ${member} getter is read once and the response settles`, async () => {
      const escaped = watchUncaught();
      const url = await startOK();
      const controller = new AbortController();
      const { request, reads } = readsOnce(
        {
          requestURL: url,
          method: 'GET',
          headers: { accept: '*/*' },
          body: null,
          signal: controller.signal,
        },
        member,
      );

      const response = await new NodeAdapter().send(request);
      await sleep(20);

      expect(response.status).toBe(200);
      expect(response.effectiveRequestHeaders?.accept).toBe('*/*');
      expect(reads()).toBe(1);
      expect(escaped).toEqual([]);
    });
  }

  test('an abort after a request getter starts throwing still settles the send', async () => {
    const escaped = watchUncaught();
    const hanging = http.createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) =>
      hanging.listen(0, '127.0.0.1', resolve),
    );
    cleanups.push(async () => {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    });
    const address = hanging.address();
    if (!address || typeof address === 'string') {
      throw new Error('No test address');
    }
    const controller = new AbortController();
    const { request } = readsOnce(
      {
        requestURL: `http://127.0.0.1:${String(address.port)}/`,
        method: 'GET',
        headers: {},
        body: null,
        signal: controller.signal,
      },
      'headers',
    );

    const pending = new NodeAdapter().send(request).then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    );
    setTimeout(() => controller.abort(), 20);

    expect(await pending).toBe('AbortError');
    expect(escaped).toEqual([]);
  });

  test('a signal whose aborted read throws in the transport error handler fails the send', async () => {
    const escaped = watchUncaught();
    const refusal = new Error('aborted unreadable');
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads++;
        // The setup check reads it once; the transport `'error'` handler is next.
        if (reads > 1) {
          throw refusal;
        }
        return false;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;

    const outcome = await new NodeAdapter()
      .send({
        // Nothing listens on port 1, so the request fails with a transport error.
        requestURL: 'http://127.0.0.1:1/',
        method: 'GET',
        headers: {},
        body: null,
        signal,
      })
      .then(
        () => 'resolved',
        (error: unknown) => error,
      );
    await sleep(20);

    expect(outcome).toBe(refusal);
    expect(escaped).toEqual([]);
  });

  test('a getter that throws on its first read fails the send', async () => {
    const escaped = watchUncaught();
    const request = {
      requestURL: 'http://127.0.0.1:1/',
      method: 'GET',
      body: null,
      get headers(): Record<string, string> {
        throw new Error('headers unreadable');
      },
    } as AdapterRequest;

    const outcome = await new NodeAdapter().send(request).then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    );

    expect(outcome).toBe('headers unreadable');
    expect(escaped).toEqual([]);
  });
});

describe('MockAdapter with a signal that refuses listeners', () => {
  test('a rejecting handler is still observed', async () => {
    const escaped = watchUncaught();
    muteConsoleError();
    claimReports();
    const adapter = new MockAdapter();
    adapter.routes.get('/fail', async () => {
      await Promise.resolve();
      throw new Error('handler failed');
    });
    const signal = {
      aborted: false,
      addEventListener() {
        throw new Error('addEventListener refused');
      },
      removeEventListener() {
        throw new Error('removeEventListener refused');
      },
    } as unknown as AbortSignal;

    const outcome = await adapter
      .send({
        requestURL: 'http://mock.test/fail',
        method: 'GET',
        headers: {},
        body: null,
        signal,
      })
      .then(
        (response) => response.status,
        (error: unknown) => (error as Error).message,
      );
    await sleep(20);

    expect(outcome).toBe(500);
    expect(escaped).toEqual([]);
  });

  test('a signal whose removeEventListener throws does not strand the wait', async () => {
    const escaped = watchUncaught();
    const adapter = new MockAdapter();
    adapter.routes.get('/ok', async () => {
      await Promise.resolve();
      return { status: 200, body: 'ok' };
    });
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        throw new Error('removeEventListener refused');
      },
    } as unknown as AbortSignal;

    const response = await adapter.send({
      requestURL: 'http://mock.test/ok',
      method: 'GET',
      headers: {},
      body: null,
      signal,
    });
    await sleep(20);

    expect(response.status).toBe(200);
    expect(escaped).toEqual([]);
  });
});
