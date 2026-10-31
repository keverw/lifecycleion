import { describe, expect, test } from 'bun:test';
import { HTTPRequestBuilder } from './http-request-builder';
import type { BuilderSendContext } from './http-request-builder';
import type { HTTPRequestOptions, HTTPResponse } from './types';
import { HTTPClient } from './http-client';
import { MockAdapter } from './adapters/mock-adapter';
import { UNSUPPORTED_REQUEST_BODY_MESSAGE } from './utils';

// Captures the context passed to sendFn so tests can inspect it.
function makeSendFn(
  responseOverride?: Partial<HTTPResponse<unknown>>,
  sideEffect?: (ctx: BuilderSendContext<unknown>) => void,
) {
  let capturedContext: BuilderSendContext<unknown> | null = null;

  const response: HTTPResponse<unknown> = {
    status: 200,
    headers: {},
    body: null,
    contentType: 'binary',
    isJSON: false,
    isText: false,
    isCancelled: false,
    isTimeout: false,
    isNetworkError: false,
    isFailed: false,
    isParseError: false,
    initialURL: 'https://example.com/test',
    requestURL: 'https://example.com/test',
    wasRedirectDetected: false,
    wasRedirectFollowed: false,
    redirectHistory: [],
    requestID: '',
    adapterType: 'fetch',
    isStreamed: false,
    isStreamError: false,
    ...responseOverride,
  };

  response.isFailed =
    responseOverride?.isFailed ??
    (response.isCancelled ||
      response.isTimeout ||
      response.isNetworkError ||
      response.isStreamError);

  const sendFn = (
    ctx: BuilderSendContext<unknown>,
  ): Promise<HTTPResponse<unknown>> => {
    capturedContext = ctx;
    sideEffect?.(ctx);
    return Promise.resolve(response);
  };

  const requireContext = (): BuilderSendContext<unknown> => {
    if (capturedContext === null) {
      throw new Error('context was not captured');
    }

    return capturedContext;
  };

  return { sendFn, getContext: () => capturedContext, requireContext };
}

function makeBuilder<T = unknown>(
  responseOverride?: Partial<HTTPResponse<unknown>>,
  sideEffect?: (ctx: BuilderSendContext<unknown>) => void,
) {
  const { sendFn, getContext, requireContext } = makeSendFn(
    responseOverride,
    sideEffect,
  );

  const builder = new HTTPRequestBuilder<T>('GET', '/test', sendFn as any);
  return { builder, getContext, requireContext };
}

describe('HTTPRequestBuilder', () => {
  describe('initial state', () => {
    test('state starts as pending', () => {
      const { builder } = makeBuilder();
      expect(builder.state).toBe('pending');
    });

    test('response starts as null', () => {
      const { builder } = makeBuilder();
      expect(builder.response).toBeNull();
    });

    test('error starts as null', () => {
      const { builder } = makeBuilder();
      expect(builder.error).toBeNull();
    });

    test('attemptCount starts as null', () => {
      const { builder } = makeBuilder();
      expect(builder.attemptCount).toBeNull();
    });

    test('next retry fields start as null', () => {
      const { builder } = makeBuilder();
      expect(builder.nextRetryDelayMS).toBeNull();
      expect(builder.nextRetryAt).toBeNull();
    });

    test('startedAt starts as null', () => {
      const { builder } = makeBuilder();
      expect(builder.startedAt).toBeNull();
    });

    test('elapsedMS starts as null', () => {
      const { builder } = makeBuilder();
      expect(builder.elapsedMS).toBeNull();
    });

    test('requestID is available before send', () => {
      const { builder } = makeBuilder();
      expect(typeof builder.requestID).toBe('string');
      expect(builder.requestID.length).toBeGreaterThan(0);
    });
  });

  describe('fluent builder methods return this', () => {
    test('headers() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.headers({})).toBe(builder);
    });

    test('params() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.params({})).toBe(builder);
    });

    test('json() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.json({ a: 1 })).toBe(builder);
    });

    test('formData() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.formData(new FormData())).toBe(builder);
    });

    test('text() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.text('hello')).toBe(builder);
    });

    test('body() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.body('raw')).toBe(builder);
    });

    test('timeout() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.timeout(5000)).toBe(builder);
    });

    test('signal() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.signal(new AbortController().signal)).toBe(builder);
    });

    test('label() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.label('my-label')).toBe(builder);
    });

    test('label() rejects empty or whitespace-only labels', () => {
      const { builder } = makeBuilder();
      expect(() => builder.label('')).toThrow(/non-empty, non-whitespace/i);
      expect(() => builder.label('   ')).toThrow(/non-empty, non-whitespace/i);
    });

    test('retryPolicy() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.retryPolicy(null)).toBe(builder);
    });

    test('onUploadProgress() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.onUploadProgress(() => {})).toBe(builder);
    });

    test('onDownloadProgress() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.onDownloadProgress(() => {})).toBe(builder);
    });

    test('onAttemptStart() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.onAttemptStart(() => {})).toBe(builder);
    });

    test('onAttemptEnd() returns this', () => {
      const { builder } = makeBuilder();
      expect(builder.onAttemptEnd(() => {})).toBe(builder);
    });
  });

  describe('send() forwards context correctly', () => {
    test('forwards method and path', async () => {
      const { sendFn, requireContext } = makeSendFn();
      const builder = new HTTPRequestBuilder('POST', '/users', sendFn);
      await builder.send();
      expect(requireContext().method).toBe('POST');
      expect(requireContext().path).toBe('/users');
    });

    test('forwards headers merged via .headers()', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.headers({ 'x-custom': 'value' }).send();
      expect(requireContext().options.headers['x-custom']).toBe('value');
    });

    test('multiple .headers() calls merge additively', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.headers({ 'x-a': '1' }).headers({ 'x-b': '2' }).send();
      expect(requireContext().options.headers['x-a']).toBe('1');
      expect(requireContext().options.headers['x-b']).toBe('2');
    });

    test('.headers() keeps a __proto__ header as an own key', async () => {
      const { builder, requireContext } = makeBuilder();
      const source = JSON.parse('{"__proto__": ["a", "b"]}') as Record<
        string,
        string[]
      >;
      await builder.headers(source).send();
      const headers = requireContext().options.headers;
      expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
      expect(
        Object.getOwnPropertyDescriptor(headers, '__proto__')?.value,
      ).toEqual(['a', 'b']);
    });

    test('forwards params', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.params({ page: 1 }).send();
      expect(requireContext().options.params).toEqual({ page: 1 });
    });

    test('forwards body via .json()', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.json({ a: 1 }).send();
      expect(requireContext().options.body).toEqual({ a: 1 });
    });

    test('forwards body via .text()', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.text('hello').send();
      expect(requireContext().options.body).toBe('hello');
    });

    test('forwards timeout', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.timeout(3000).send();
      expect(requireContext().options.timeout).toBe(3000);
    });

    test('forwards signal', async () => {
      const { builder, requireContext } = makeBuilder();
      const signal = new AbortController().signal;
      await builder.signal(signal).send();
      expect(requireContext().options.signal).toBe(signal);
    });

    test('forwards label', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.label('search').send();
      expect(requireContext().options.label).toBe('search');
    });

    test('forwards retryPolicy', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.retryPolicy(null).send();
      expect(requireContext().options.retryPolicy).toBeNull();
    });

    test('forwards onUploadProgress', async () => {
      const { builder, requireContext } = makeBuilder();
      const fn = () => {};
      await builder.onUploadProgress(fn).send();
      expect(requireContext().options.onUploadProgress).toBe(fn);
    });

    test('forwards onDownloadProgress', async () => {
      const { builder, requireContext } = makeBuilder();
      const fn = () => {};
      await builder.onDownloadProgress(fn).send();
      expect(requireContext().options.onDownloadProgress).toBe(fn);
    });

    test('forwards onAttemptStart', async () => {
      const { builder, requireContext } = makeBuilder();
      const fn = () => {};
      await builder.onAttemptStart(fn).send();
      expect(requireContext().options.onAttemptStart).toBe(fn);
    });

    test('forwards onAttemptEnd', async () => {
      const { builder, requireContext } = makeBuilder();
      const fn = () => {};
      await builder.onAttemptEnd(fn).send();
      expect(requireContext().options.onAttemptEnd).toBe(fn);
    });
  });

  describe('constructor options', () => {
    const firstValues = {
      headers: { 'x-first': 'yes' },
      params: { page: 1 },
      body: { first: true },
      timeout: 1000,
      maxResponseBytes: 2048,
      signal: new AbortController().signal,
      retryPolicy: null,
      retryNonIdempotentMethods: false,
      label: 'first-label',
      onUploadProgress: () => {},
      onDownloadProgress: () => {},
      onAttemptStart: () => {},
      onAttemptEnd: () => {},
      streamResponse: () => null,
    } satisfies Required<HTTPRequestOptions>;

    test.each(Object.keys(firstValues) as (keyof typeof firstValues)[])(
      'captures the first value of the %s getter exactly once',
      async (key) => {
        const { sendFn, requireContext } = makeSendFn();
        let reads = 0;
        const options: HTTPRequestOptions = {};
        Object.defineProperty(options, key, {
          get() {
            reads += 1;
            return reads === 1 ? firstValues[key] : undefined;
          },
        });

        const builder = new HTTPRequestBuilder('GET', '/test', sendFn, options);
        await builder.send();

        expect(reads).toBe(1);
        expect(requireContext().options[key]).toEqual(firstValues[key]);
      },
    );

    test('applies each option before reading the next and stops on validation failure', () => {
      const { sendFn } = makeSendFn();
      const events: string[] = [];
      const options: HTTPRequestOptions = {
        get headers() {
          events.push('read headers');
          return {
            get 'x-first'() {
              events.push('apply headers');
              return 'yes';
            },
          };
        },
        get params() {
          events.push('read params');
          return undefined;
        },
        get body() {
          events.push('read body');
          return undefined;
        },
        get timeout() {
          events.push('read timeout');
          return Number.NaN;
        },
        get signal() {
          events.push('read signal');
          return undefined;
        },
      };

      expect(
        () => new HTTPRequestBuilder('GET', '/test', sendFn, options),
      ).toThrow();
      expect(events).toEqual([
        'read headers',
        'apply headers',
        'read params',
        'read body',
        'read timeout',
      ]);
    });

    test('applies options passed to constructor', async () => {
      const { sendFn, requireContext } = makeSendFn();
      const builder = new HTTPRequestBuilder('GET', '/test', sendFn, {
        headers: { 'x-init': 'yes' },
        timeout: 1000,
        label: 'init-label',
      });

      await builder.send();
      expect(requireContext().options.headers['x-init']).toBe('yes');
      expect(requireContext().options.timeout).toBe(1000);
      expect(requireContext().options.label).toBe('init-label');
    });

    test('constructor options reject empty or whitespace-only labels', () => {
      const { sendFn } = makeSendFn();

      expect(
        () =>
          new HTTPRequestBuilder('GET', '/test', sendFn as any, {
            label: '',
          }),
      ).toThrow(/non-empty, non-whitespace/i);

      expect(
        () =>
          new HTTPRequestBuilder('GET', '/test', sendFn as any, {
            label: '   ',
          }),
      ).toThrow(/non-empty, non-whitespace/i);
    });

    test('fluent headers() merge on top of constructor headers', async () => {
      const { sendFn, requireContext } = makeSendFn();
      const builder = new HTTPRequestBuilder('GET', '/test', sendFn, {
        headers: { 'x-init': 'yes' },
      });

      await builder.headers({ 'x-extra': 'also' }).send();
      expect(requireContext().options.headers['x-init']).toBe('yes');
      expect(requireContext().options.headers['x-extra']).toBe('also');
    });
  });

  describe('callbacks wire up post-send state', () => {
    test('requestID is available before send()', () => {
      const { builder } = makeBuilder();
      expect(typeof builder.requestID).toBe('string');
      expect(builder.requestID.length).toBeGreaterThan(0);
    });

    test('requestID is stable — same value before and after send()', async () => {
      const { builder } = makeBuilder();
      const idBeforeSend = builder.requestID;
      await builder.send();
      expect(builder.requestID).toBe(idBeforeSend);
    });

    test('sendFn receives the builder requestID in context', async () => {
      const { builder, requireContext } = makeBuilder();
      const idBeforeSend = builder.requestID;
      await builder.send();
      expect(requireContext().requestID).toBe(idBeforeSend);
    });

    test('setState updates state', async () => {
      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('completed');
      });

      await builder.send();
      expect(builder.state).toBe('completed');
    });

    test('setResponse updates response', async () => {
      const res: HTTPResponse<string> = {
        status: 200,
        headers: {},
        body: 'ok',
        contentType: 'text',
        isJSON: false,
        isText: true,
        isCancelled: false,
        isTimeout: false,
        isNetworkError: false,
        isFailed: false,
        isParseError: false,
        initialURL: 'https://example.com/test',
        requestURL: 'https://example.com/test',
        wasRedirectDetected: false,
        wasRedirectFollowed: false,
        redirectHistory: [],
        requestID: '',
        adapterType: 'fetch',
        isStreamed: false,
        isStreamError: false,
      };

      res.isFailed =
        res.isCancelled ||
        res.isTimeout ||
        res.isNetworkError ||
        res.isStreamError;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setResponse(res);
      });

      await builder.send();
      expect(builder.response).toBe(res);
    });

    test('setError updates error', async () => {
      const err = { code: 'NETWORK_ERROR', message: 'failed' } as any;
      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setError(err);
      });

      await builder.send();
      expect(builder.error).toBe(err);
    });

    test('setAttemptCount updates attemptCount', async () => {
      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setAttemptCount(3);
      });

      await builder.send();
      expect(builder.attemptCount).toBe(3);
    });

    test('setStartedAt updates startedAt', async () => {
      const now = Date.now();
      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setStartedAt(now);
      });

      await builder.send();
      expect(builder.startedAt).toBe(now);
    });

    test('elapsedMS returns non-null after setStartedAt', async () => {
      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setStartedAt(Date.now() - 100);
      });

      await builder.send();
      expect(builder.elapsedMS).toBeGreaterThanOrEqual(100);
    });

    test('setState waiting_for_retry is reflected', async () => {
      let snapshot: string | undefined;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('waiting_for_retry');
        snapshot = builder.state;
        ctx.callbacks.setState('completed');
      });

      await builder.send();
      expect(snapshot).toBe('waiting_for_retry');
    });

    test('retry timing callbacks update the builder state', async () => {
      const nextRetryAt = Date.now() + 250;
      let snapshot:
        | {
            attemptCount: number | null;
            nextRetryDelayMS: number | null;
            nextRetryAt: number | null;
          }
        | undefined;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setAttemptCount(2);
        ctx.callbacks.setNextRetryDelayMS(250);
        ctx.callbacks.setNextRetryAt(nextRetryAt);

        snapshot = {
          attemptCount: builder.attemptCount,
          nextRetryDelayMS: builder.nextRetryDelayMS,
          nextRetryAt: builder.nextRetryAt,
        };
      });

      await builder.send();

      expect(snapshot).toEqual({
        attemptCount: 2,
        nextRetryDelayMS: 250,
        nextRetryAt,
      });
      expect(builder.attemptCount).toBe(2);
      expect(builder.nextRetryDelayMS).toBe(250);
      expect(builder.nextRetryAt).toBe(nextRetryAt);
    });
  });

  describe('single-use enforcement', () => {
    test('send() throws if called twice', async () => {
      const { builder } = makeBuilder();
      await builder.send();

      expect(() => builder.send()).toThrow(/can only be called once/);
    });

    test('headers() throws after send', async () => {
      const { builder } = makeBuilder();
      await builder.send();

      expect(() => builder.headers({})).toThrow(/after .send\(\)/);
    });

    test('params() throws after send', async () => {
      const { builder } = makeBuilder();
      await builder.send();

      expect(() => builder.params({})).toThrow(/after .send\(\)/);
    });

    test('timeout() throws after send', async () => {
      const { builder } = makeBuilder();
      await builder.send();

      expect(() => builder.timeout(1000)).toThrow(/after .send\(\)/);
    });

    test('label() throws after send', async () => {
      const { builder } = makeBuilder();
      await builder.send();
      expect(() => builder.label('x')).toThrow(/after .send\(\)/);
    });
  });

  describe('cancel()', () => {
    test('calls cancelFn and returns its result when in-flight', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
          return 'cancelled';
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe('cancelled');
      expect(wasCancelCalled).toBe(true);
    });

    test('passes reason string to cancelFn', async () => {
      let capturedReason: string | undefined;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setCancelFn((reason) => {
          capturedReason = reason;
          return 'cancelled';
        });
      });

      await builder.send();
      builder.cancel('user_navigated_away');
      expect(capturedReason).toBe('user_navigated_away');
    });

    test('passes undefined to cancelFn when no reason given', async () => {
      let capturedReason: string | undefined = 'sentinel';

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setCancelFn((reason) => {
          capturedReason = reason;
          return 'cancelled';
        });
      });

      await builder.send();
      builder.cancel();
      expect(capturedReason).toBeUndefined();
    });

    test('before send: sets state to cancelled and returns cancelled', () => {
      const { builder } = makeBuilder();
      expect(builder.cancel()).toBe('cancelled');
      expect(builder.state).toBe('cancelled');
    });

    test('before send: blocks send() after cancel()', () => {
      const { builder } = makeBuilder();
      builder.cancel();
      expect(() => builder.send()).toThrow(/after cancel\(\)/);
    });

    test('before send: send() error includes reason when cancel() was called with one', () => {
      const { builder } = makeBuilder();
      builder.cancel('quota_exceeded');
      expect(() => builder.send()).toThrow(/after cancel\(\).*quota_exceeded/);
    });

    test('before send: send() error has no reason suffix when cancel() had no reason', () => {
      const { builder } = makeBuilder();
      builder.cancel();
      expect(() => builder.send()).toThrow(
        'HTTPRequestBuilder.send() cannot be called after cancel() has been called.',
      );
    });

    test('returns already_settled when state is completed', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('completed');
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
          return 'cancelled';
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe('already_settled');
      expect(wasCancelCalled).toBe(false);
    });

    test('returns already_cancelled when state is cancelled', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('cancelled');
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
          return 'cancelled';
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe('already_cancelled');
      expect(wasCancelCalled).toBe(false);
    });

    test('returns already_settled when state is failed', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('failed');
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
          return 'cancelled';
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe('already_settled');
      expect(wasCancelCalled).toBe(false);
    });
  });
});

test('headers() refuses a Headers, Map or array instead of dropping its entries', () => {
  for (const value of [
    new Headers({ authorization: 'Bearer t' }),
    new Map([['authorization', 'Bearer t']]),
    [['authorization', 'Bearer t']],
  ]) {
    const { sendFn } = makeSendFn();
    const builder = new HTTPRequestBuilder('GET', '/x', sendFn);
    expect(() => builder.headers(value as never)).toThrow(
      'HTTPRequestBuilder headers must be a plain object',
    );
  }

  // Nullish stays a no-op, and a null-prototype record is a plain record.
  const { sendFn } = makeSendFn();
  const builder = new HTTPRequestBuilder('GET', '/x', sendFn);
  expect(builder.headers(null)).toBe(builder);
  const record = Object.assign(Object.create(null) as object, { 'x-a': '1' });
  expect(builder.headers(record as Record<string, string>)).toBe(builder);
});

test('params are copied when given, so a later change to the object is not sent', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/search', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  const given: Record<string, unknown> = { q: 'a', page: '1' };
  const builder = client.get('/search').params(given);
  given.token = 'secret';
  given.q = 'b';
  delete given.page;
  const response = await builder.send();

  expect(response.requestURL).toBe('http://api.test/search?q=a&page=1');

  // The same through the request options.
  const optionParams: Record<string, unknown> = { q: 'a' };
  const optionBuilder = client.get('/search', { params: optionParams });
  optionParams.token = 'secret';
  const optionResponse = await optionBuilder.send();

  expect(optionResponse.requestURL).toBe('http://api.test/search?q=a');
});

test('an array in params or headers is copied when given, so an item added to it afterwards is not sent', async () => {
  const adapter = new MockAdapter();
  const seen: unknown[] = [];
  adapter.routes.get('/search', (request) => {
    seen.push(request.headers['x-m']);
    return { status: 200 };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  const ids = [1, 2];
  const values = ['a'];
  const nested = { tag: 'x' };
  const builder = client
    .get('/search')
    .params({ ids, filter: nested })
    .headers({ 'x-m': values });
  ids.push(3);
  values.push('b');
  // A nested object is still the caller's, read when the request is sent.
  nested.tag = 'y';
  const response = await builder.send();

  expect(decodeURIComponent(response.requestURL)).toBe(
    'http://api.test/search?ids[0]=1&ids[1]=2&filter[tag]=y',
  );
  expect(seen).toEqual(['a']);

  // The same through the request options.
  const optionIDs = [1];
  const optionValues = ['a'];
  const optionBuilder = client.get('/search', {
    params: { ids: optionIDs },
    headers: { 'x-m': optionValues },
  });
  optionIDs.push(2);
  optionValues.push('b');
  const optionResponse = await optionBuilder.send();

  expect(decodeURIComponent(optionResponse.requestURL)).toBe(
    'http://api.test/search?ids[0]=1',
  );
  expect(seen).toEqual(['a', 'a']);
});

test('a body is copied when it is handed to a setter, so a later change to it is not sent', async () => {
  const json = { a: 1, nested: { b: 2 } };
  const bytes = new Uint8Array([1, 2, 3]);
  const form = new FormData();
  form.append('a', '1');

  const forwarded: unknown[] = [];
  for (const [set, change] of [
    [
      (builder: HTTPRequestBuilder) => builder.json(json),
      () => {
        json.a = 99;
        json.nested.b = 99;
      },
    ],
    [
      (builder: HTTPRequestBuilder) => builder.body(bytes),
      () => {
        bytes[0] = 99;
      },
    ],
    [
      (builder: HTTPRequestBuilder) => builder.formData(form),
      () => {
        form.append('b', '2');
      },
    ],
  ] as const) {
    const { builder, requireContext } = makeBuilder();
    set(builder);
    change();
    await builder.send();
    forwarded.push(requireContext().options.body);
  }

  expect(forwarded[0]).toEqual({ a: 1, nested: { b: 2 } });
  expect(forwarded[0]).not.toBe(json);
  expect(Array.from(forwarded[1] as Uint8Array)).toEqual([1, 2, 3]);
  expect(forwarded[1]).not.toBe(bytes);
  expect([...(forwarded[2] as FormData).entries()]).toEqual([['a', '1']]);
  expect(forwarded[2]).not.toBe(form);

  // The same through the request options.
  const optionBody = { a: 1 };
  const { sendFn, requireContext } = makeSendFn();
  const optionBuilder = new HTTPRequestBuilder('POST', '/x', sendFn, {
    body: optionBody,
  });
  optionBody.a = 2;
  await optionBuilder.send();

  expect(requireContext().options.body).toEqual({ a: 1 });
});

test('a body whose getter or toJSON throws throws from the setter, and the builder keeps its body', async () => {
  const getterBody = {
    get token(): string {
      throw new Error('getter failed');
    },
  };
  const toJSONBody = {
    toJSON(): never {
      throw new Error('toJSON failed');
    },
  };
  const { builder, requireContext } = makeBuilder();
  builder.json({ kept: true });

  expect(() => builder.json(getterBody)).toThrow('getter failed');
  expect(() => builder.body(toJSONBody)).toThrow('toJSON failed');
  expect(
    () =>
      new HTTPRequestBuilder('POST', '/x', makeSendFn().sendFn, {
        body: toJSONBody,
      }),
  ).toThrow('toJSON failed');

  await builder.send();

  expect(requireContext().options.body).toEqual({ kept: true });
});

test('a JSON body is kept as the data it serializes to', async () => {
  class Point {
    public x = 1;
  }
  const when = new Date('2020-01-02T03:04:05.000Z');
  const { builder, requireContext } = makeBuilder();
  await builder
    .json({ when, point: new Point(), dropped: undefined, list: [undefined] })
    .send();

  const body = requireContext().options.body as Record<string, unknown>;
  expect(body).toEqual({
    when: '2020-01-02T03:04:05.000Z',
    point: { x: 1 },
    list: [null],
  });
  expect(Object.getPrototypeOf(body.point)).toBe(Object.prototype);
  expect(Object.hasOwn(body, 'dropped')).toBe(false);
});

test('a form body is copied from the entries it holds, not ones it reports', async () => {
  const form = new FormData();
  form.append('a', '1');
  // Its own `entries` reports an entry the form does not hold.
  Object.defineProperty(form, 'entries', {
    value: () => {
      const reported = new FormData();
      reported.append('injected', 'x');
      return reported.entries();
    },
  });

  const { builder, requireContext } = makeBuilder();
  builder.formData(form);
  await builder.send();

  expect([
    ...FormData.prototype.entries.call(
      requireContext().options.body as FormData,
    ),
  ]).toEqual([['a', '1']]);

  // A `Proxy` over a form, or an object that only inherits from `FormData.prototype`, has
  // no internal slots to read entries from: no form, so refused as one; as a body of
  // another setter, an unsupported one.
  for (const fake of [
    new Proxy(new FormData(), {}),
    Object.create(FormData.prototype) as FormData,
  ]) {
    expect(() => makeBuilder().builder.formData(fake)).toThrow(
      'HTTPRequestBuilder formData must be a FormData',
    );
    expect(() => makeBuilder().builder.body(fake)).toThrow(
      UNSUPPORTED_REQUEST_BODY_MESSAGE,
    );
  }
});

test('formData() and text() refuse a body of another type rather than sending it as one', () => {
  const { builder } = makeBuilder();

  expect(() => builder.formData({ a: '1' } as never)).toThrow(
    'HTTPRequestBuilder formData must be a FormData (got object)',
  );
  expect(() => builder.formData('a=1' as never)).toThrow(
    'HTTPRequestBuilder formData must be a FormData',
  );
  expect(() => builder.text({ a: 1 } as never)).toThrow(
    'HTTPRequestBuilder text must be a string (got object)',
  );
  expect(() => builder.text(new Uint8Array(1) as never)).toThrow(
    'HTTPRequestBuilder text must be a string',
  );

  // Nullish is no body, as for every body setter.
  expect(() => builder.text(null as never)).not.toThrow();
  expect(() => builder.formData(undefined as never)).not.toThrow();
});

test('a params array keeps a named key set on it, as qs serializes the array', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/search', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  const tags = Object.assign(['x'], { extra: 'y' });
  const builder = client.get('/search').params({ a: tags });
  tags.push('z');
  const response = await builder.send();

  expect(decodeURIComponent(response.requestURL)).toBe(
    'http://api.test/search?a[0]=x&a[extra]=y',
  );
});

test('a byte body whose prototype is a Proxy is copied without running its traps', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let trapCalls = 0;
  Object.setPrototypeOf(
    bytes,
    new Proxy(Uint8Array.prototype, {
      getPrototypeOf() {
        trapCalls++;
        throw new Error('trap ran');
      },
    }),
  );

  const { builder } = makeBuilder();
  expect(() => builder.body(bytes)).not.toThrow();
  expect(trapCalls).toBe(0);
});
