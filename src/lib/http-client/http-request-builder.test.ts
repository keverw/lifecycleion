import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  createRequestBuilder,
  HTTPRequestBuilder,
} from './http-request-builder';
import type { BuilderSendContext } from './http-request-builder';
import type { HTTPRequestOptions, HTTPResponse } from './types';
import { HTTPClient } from './http-client';
import { MockAdapter } from './adapters/mock-adapter';
import { UNSUPPORTED_REQUEST_BODY_MESSAGE } from './utils';
import { releaseRequestBody } from './internal/request-body-copy';

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

/**
 * The body a send function was handed, a JSON body's copy read back from its text as the
 * client reads it when an interceptor first looks.
 */
function sentBody(ctx: BuilderSendContext<unknown>): unknown {
  releaseRequestBody(ctx.options.body);
  return ctx.options.body;
}

function makeBuilder<T = unknown>(
  responseOverride?: Partial<HTTPResponse<unknown>>,
  sideEffect?: (ctx: BuilderSendContext<unknown>) => void,
) {
  const { sendFn, getContext, requireContext } = makeSendFn(
    responseOverride,
    sideEffect,
  );

  const builder = createRequestBuilder<T>('GET', '/test', sendFn as any);
  return { builder, getContext, requireContext };
}

describe('HTTPRequestBuilder', () => {
  describe('construction', () => {
    type BuilderConstructor = new (...args: unknown[]) => HTTPRequestBuilder;

    test('throws when constructed through a builder’s constructor, with a send function of the caller’s', () => {
      const Builder = makeBuilder().builder.constructor as BuilderConstructor;
      const { sendFn } = makeSendFn();

      expect(() => new Builder('POST', '/x', sendFn)).toThrow(
        /made by an HTTPClient's request methods/,
      );
    });

    test('throws for a builder an option getter tries to construct while one is being made', async () => {
      const Builder = makeBuilder().builder.constructor as BuilderConstructor;
      let innerError: unknown;
      const { sendFn, requireContext } = makeSendFn();
      const options = {
        get label() {
          try {
            new Builder('GET', '/inner', sendFn);
          } catch (error) {
            innerError = error;
          }
          return 'outer';
        },
      };

      await createRequestBuilder('GET', '/test', sendFn, options).send();

      expect(requireContext().options.label).toBe('outer');
      expect(innerError).toBeInstanceOf(TypeError);
    });
  });

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

    test('headers() refuses an array value whose length is not one an array can have', () => {
      const { builder } = makeBuilder();
      const value = new Proxy(['a'], {
        get: (target, key, receiver) =>
          key === 'length' ? 1.5 : Reflect.get(target, key, receiver),
      });

      expect(() => builder.headers({ 'x-list': value })).toThrow(
        new TypeError('HTTPClient header value has no array length'),
      );
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
      const builder = createRequestBuilder('POST', '/users', sendFn);
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

    test('two keys of one record that differ only by case are one header, the later winning', async () => {
      const { builder, requireContext } = makeBuilder();
      await builder.headers({ 'X-Trace': 'a', 'x-trace': 'b' }).send();
      const headers = requireContext().options.headers;
      expect(Object.keys(headers).filter((key) => key === 'x-trace')).toEqual([
        'x-trace',
      ]);
      expect(headers['x-trace']).toBe('b');
      expect(headers['X-Trace']).toBeUndefined();
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
      expect(sentBody(requireContext())).toEqual({ a: 1 });
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

        const builder = createRequestBuilder('GET', '/test', sendFn, options);
        await builder.send();

        expect(reads).toBe(1);
        expect(
          key === 'body'
            ? sentBody(requireContext())
            : requireContext().options[key],
        ).toEqual(firstValues[key]);
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

      expect(() =>
        createRequestBuilder('GET', '/test', sendFn, options),
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
      const builder = createRequestBuilder('GET', '/test', sendFn, {
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

      expect(() =>
        createRequestBuilder('GET', '/test', sendFn as any, {
          label: '',
        }),
      ).toThrow(/non-empty, non-whitespace/i);

      expect(() =>
        createRequestBuilder('GET', '/test', sendFn as any, {
          label: '   ',
        }),
      ).toThrow(/non-empty, non-whitespace/i);
    });

    test('fluent headers() merge on top of constructor headers', async () => {
      const { sendFn, requireContext } = makeSendFn();
      const builder = createRequestBuilder('GET', '/test', sendFn, {
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

      const sent = builder.send();
      expect(builder.cancel()).toBe('cancelled');
      await sent;
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

      const sent = builder.send();
      builder.cancel('user_navigated_away');
      await sent;
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

      const sent = builder.send();
      builder.cancel();
      await sent;
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

test('headers() whose value throws while it is copied changes no header', async () => {
  const { sendFn, requireContext } = makeSendFn();
  const builder = createRequestBuilder('GET', '/x', sendFn);
  builder.headers({ 'x-first': 'old' });

  const throwingList: string[] = [];
  Object.defineProperty(throwingList, 0, {
    enumerable: true,
    get() {
      throw new Error('index getter failed');
    },
  });
  expect(() =>
    builder.headers({ 'X-First': 'new', 'x-second': throwingList }),
  ).toThrow('index getter failed');

  await builder.send();
  expect(requireContext().options.headers).toEqual({ 'x-first': 'old' });
});

test('headers() refuses a Headers, Map or array instead of dropping its entries', () => {
  for (const value of [
    new Headers({ authorization: 'Bearer t' }),
    new Map([['authorization', 'Bearer t']]),
    [['authorization', 'Bearer t']],
  ]) {
    const { sendFn } = makeSendFn();
    const builder = createRequestBuilder('GET', '/x', sendFn);
    expect(() => builder.headers(value as never)).toThrow(
      'HTTPRequestBuilder headers must be a plain object',
    );
  }

  // Nullish stays a no-op, and a null-prototype record is a plain record.
  const { sendFn } = makeSendFn();
  const builder = createRequestBuilder('GET', '/x', sendFn);
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
    forwarded.push(sentBody(requireContext()));
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
  const optionBuilder = createRequestBuilder('POST', '/x', sendFn, {
    body: optionBody,
  });
  optionBody.a = 2;
  await optionBuilder.send();

  expect(sentBody(requireContext())).toEqual({ a: 1 });
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
  expect(() =>
    createRequestBuilder('POST', '/x', makeSendFn().sendFn, {
      body: toJSONBody,
    }),
  ).toThrow('toJSON failed');

  await builder.send();

  expect(sentBody(requireContext())).toEqual({ kept: true });
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

  const body = sentBody(requireContext()) as Record<string, unknown>;
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

test('params refuses an invalid Date and a value nested inside itself when given, naming the key, as qs could not build the query', async () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = cycle;

  expect(() =>
    client.get('/events').params({ since: new Date('nope') }),
  ).toThrow('HTTPRequestBuilder params.since is not a valid Date');
  expect(() =>
    client.get('/events').params({ range: { from: new Date('nope') } }),
  ).toThrow('HTTPRequestBuilder params.range.from is not a valid Date');
  expect(() => client.get('/events').params({ filter: cycle })).toThrow(
    'HTTPRequestBuilder params.filter.self is an object it is nested inside',
  );
  expect(() =>
    client.get('/events', { params: { since: new Date(Number.NaN) } }),
  ).toThrow('HTTPRequestBuilder params.since is not a valid Date');

  // An object reached twice but not inside itself, and a valid Date, are serialized.
  const adapter = new MockAdapter();
  adapter.routes.get('/events', () => ({ status: 200 }));
  const shared = { x: '1' };
  const response = await new HTTPClient({ adapter, baseURL: 'http://api.test' })
    .get('/events')
    .params({ a: shared, b: shared, at: new Date(0) })
    .send();
  expect(decodeURIComponent(response.requestURL)).toBe(
    'http://api.test/events?a[x]=1&b[x]=1&at=1970-01-01T00:00:00.000Z',
  );
});

test('params checks nested values without running a getter, which qs alone reads at send', async () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  let reads = 0;
  const nested = {
    get value() {
      reads++;
      return new Date('nope');
    },
  };

  const builder = client.get('/events').params({ nested });
  expect(reads).toBe(0);
  const sendError = await builder.send().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(sendError).toBeInstanceOf(RangeError);
  expect(reads).toBe(1);
});

/** An object `levels` deep: `{ l: { l: ... { v: 1 } } }`. */
function nestedParam(levels: number): Record<string, unknown> {
  let value: Record<string, unknown> = { v: 1 };
  for (let level = 1; level < levels; level++) {
    value = { l: value };
  }
  return value;
}

test('params refuses a value nested deeper than qs is given, naming the key, without overflowing the stack', async () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });

  // `a` is at depth 0, so its deepest entry, `v`, is at depth 1000 when it nests 1000.
  expect(() => client.get('/x').params({ a: nestedParam(1001) })).toThrow(
    /^HTTPRequestBuilder params\.a(\.l){4}\.\[976 more keys\](\.l){20} nests deeper than 1000 levels/,
  );
  expect(() => client.get('/x').params({ a: nestedParam(200_000) })).toThrow(
    'nests deeper than 1000 levels',
  );

  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const response = await new HTTPClient({ adapter, baseURL: 'http://api.test' })
    .get('/x')
    .params({ a: nestedParam(1000) })
    .send();
  expect(response.status).toBe(200);
});

test('a params refusal names a long path by its ends and a long key by its start', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const longKey = 'k'.repeat(50);
  let deep: Record<string, unknown> = { v: 1 };
  for (let level = 0; level < 1000; level++) {
    deep = { [longKey]: deep };
  }

  let message = '';
  try {
    client.get('/x').params({ a: deep });
  } catch (error) {
    message = (error as Error).message;
  }

  // Joined whole, the path is over 51,000 characters.
  expect(message).toContain('.[976 more keys].');
  expect(message.length).toBeLessThan(1500);

  expect(() =>
    client.get('/x').params({ ['x'.repeat(10_000)]: new Date(Number.NaN) }),
  ).toThrow(
    `HTTPRequestBuilder params.${'x'.repeat(64)}... is not a valid Date, so it cannot be put in a query`,
  );
});

test('a params refusal shortens a path only to leave out two or more keys, and a key only past 64 code units', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const refusedPath = (keys: string[]): string => {
    let value: unknown = new Date(Number.NaN);
    for (const key of [...keys].reverse()) {
      value = { [key]: value };
    }
    try {
      client.get('/x').params(value as Record<string, unknown>);
    } catch (error) {
      return (error as Error).message
        .replace('HTTPRequestBuilder params.', '')
        .replace(' is not a valid Date, so it cannot be put in a query', '');
    }
    return 'not refused';
  };
  const keys = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `k${String(index)}`);

  expect(refusedPath(keys(26))).toBe(keys(26).join('.'));
  expect(refusedPath(keys(27))).toBe(
    [...keys(5), '[2 more keys]', ...keys(27).slice(7)].join('.'),
  );

  const at64 = 'a'.repeat(64);
  expect(refusedPath(['x', at64, 'y'])).toBe(`x.${at64}.y`);
  expect(refusedPath(['x', `${at64}b`, 'y'])).toBe(`x.${at64}....y`);
  // Not cut between the two halves of an emoji.
  expect(refusedPath([`${'a'.repeat(63)}\u{1F600}`])).toBe(
    `${'a'.repeat(63)}...`,
  );
});

test('params refuses a shared object that nests too deep where it is reached a second time', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  // Ten levels below `shared`: its `v` is at depth 1000 when `shared` is at depth 990.
  const shared = nestedParam(10);
  const reachedAt = (depth: number): Record<string, unknown> => {
    let value: Record<string, unknown> = { shared };
    for (let level = 1; level < depth; level++) {
      value = { l: value };
    }
    return value;
  };

  // Seen first at depth 1 under `a`, then again deep under `b`.
  expect(() =>
    client.get('/x').params({ a: shared, b: reachedAt(990) }),
  ).not.toThrow();
  expect(() =>
    client.get('/x').params({ a: shared, b: reachedAt(991) }),
  ).toThrow(/\.shared(\.l)+ nests deeper than 1000 levels/);
});

test('params names the entry inside a shared object that nests too deep, as it does one met once', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const refusal = (params: Record<string, unknown>): string => {
    try {
      client.get('/x').params(params);
    } catch (error) {
      return (error as Error).message;
    }
    return 'not refused';
  };
  const reachedAt = (
    depth: number,
    target: Record<string, unknown>,
  ): Record<string, unknown> => {
    let value: Record<string, unknown> = { shared: target };
    for (let level = 1; level < depth; level++) {
      value = { l: value };
    }
    return value;
  };

  // `shared` nests 20 levels, so under `b` it reaches 10 levels past the limit. Met
  // first under `a`, it is refused by the walk down its deepest entries.
  const shared = nestedParam(20);
  const sharedMessage = refusal({ a: shared, b: reachedAt(990, shared) });
  const onceMessage = refusal({ b: reachedAt(990, nestedParam(20)) });

  expect(onceMessage).toMatch(
    /^HTTPRequestBuilder params\.b(\.l){4}\.\[\d+ more keys\](\.l)+\.shared(\.l)+ nests/,
  );
  expect(sharedMessage).toBe(onceMessage);

  // Both entries of this one reach past the limit under `b`: the shallower comes first,
  // and the walk refuses under it.
  const twoDeep = (): Record<string, unknown> => ({
    a: nestedParam(15),
    b: nestedParam(20),
  });
  const sharedTwo = twoDeep();
  const sharedTwoMessage = refusal({
    a: sharedTwo,
    b: reachedAt(990, sharedTwo),
  });
  const onceTwoMessage = refusal({ b: reachedAt(990, twoDeep()) });

  expect(onceTwoMessage).toMatch(/\.shared\.a(\.l)+ nests/);
  expect(sharedTwoMessage).toBe(onceTwoMessage);
});

test('a params value changed after .params() is held to the depth qs is given, with or without a query in the path', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  // `a` is at depth 0 and the chain starts at 1, so 999 levels end at depth 1000.
  for (const path of ['/x', '/x?keep=1']) {
    for (const [levels, isSent] of [
      [999, true],
      [1000, false],
    ] as const) {
      const holder: Record<string, unknown> = {};
      const builder = client.get(path).params({ a: holder });
      holder.l = nestedParam(levels);
      const refusal = await builder.send().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal === undefined).toBe(isSent);
      if (!isSent) {
        expect((refusal as Error).message).toBe(
          'Input depth exceeded depth option of 1000',
        );
      }
    }
  }
});

test('a collection a nested getter answers, or one put in after .params(), rejects send() naming its key, with or without a query in the path', async () => {
  const adapter = new MockAdapter();
  let dispatched = 0;
  adapter.routes.get('/search', () => {
    dispatched++;
    return { status: 200 };
  });
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  for (const path of ['/search', '/search?filter=recent']) {
    let reads = 0;
    const filter = {
      get ids() {
        reads++;
        return new Set([1, 2]);
      },
    };
    const fromGetter = await client
      .get(path)
      .params({ filter })
      .send()
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(fromGetter).toBeInstanceOf(TypeError);
    expect((fromGetter as Error).message).toBe(
      'HTTPRequestBuilder params.filter.ids is a Set, whose entries qs does not read, so it cannot be put in a query',
    );
    expect(reads).toBe(1);

    // Inside a class instance and a function, which qs walks by their own keys.
    const holder: Record<string, unknown> = {};
    const builder = client.get(path).params({ holder });
    holder.inner = Object.assign(() => 1, { tags: new Map([['a', 1]]) });
    const changedAfter = await builder.send().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((changedAfter as Error).message).toBe(
      'HTTPRequestBuilder params.holder.inner.tags is a Map, whose entries qs does not read, so it cannot be put in a query',
    );
  }

  expect(dispatched).toBe(0);
});

test('a getter in a function or class instance params holds is read once, into the query qs writes for it', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  class Point {
    public x = 1;
  }

  for (const path of ['/x', '/x?k=1']) {
    let reads = 0;
    const counted = Object.defineProperty(() => 1, 'n', {
      enumerable: true,
      get: () => ++reads,
    });
    const response = await client
      .get(path)
      .params({ fn: counted, point: new Point(), at: new Date(0) })
      .send();

    expect(decodeURIComponent(response.requestURL)).toContain(
      'fn[n]=1&point[x]=1&at=1970-01-01T00:00:00.000Z',
    );
    expect(reads).toBe(1);
  }
});

test('params writes a polyfill buffer as its text and a Proxy in its own key order, as qs does, with or without a query in the path', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  class PolyBuffer extends Uint8Array {
    public static isBuffer(value: unknown): boolean {
      return value instanceof PolyBuffer;
    }

    public override toString(): string {
      return 'hi';
    }
  }
  const reordered = new Proxy(
    { b: 'b', 1: 'one', a: 'a' },
    { ownKeys: () => ['b', '1', 'a'] },
  );

  for (const path of ['/x', '/x?k=1']) {
    const response = await client
      .get(path)
      .params({ nested: { data: new PolyBuffer([1, 2]) }, reordered })
      .send();

    expect(decodeURIComponent(response.requestURL)).toContain(
      'nested[data]=hi&reordered[b]=b&reordered[1]=one&reordered[a]=a',
    );
  }
});

test('a getter in an object params reaches twice is read once for each, with or without a query in the path', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  for (const path of ['/x', '/x?k=1']) {
    let reads = 0;
    const shared = {
      get g() {
        return ++reads;
      },
    };
    const response = await client
      .get(path)
      .params({ a: shared, b: shared })
      .send();

    expect(decodeURIComponent(response.requestURL)).toContain('a[g]=1&b[g]=2');
  }
});

test("a params value nested too deep after .params() rejects send() with qs's depth refusal, not a stack overflow", async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });

  // Without a query in the path, and with one, which `buildURL` snapshots first.
  for (const path of ['/x', '/x?keep=1']) {
    const holder: Record<string, unknown> = {};
    const builder = client.get(path).params({ a: holder });
    holder.l = nestedParam(200_000);
    const refusal = await builder.send().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(RangeError);
    expect((refusal as Error).message).toBe(
      'Input depth exceeded depth option of 1000',
    );
  }
});

test('params checks a function as qs walks one, by its own keys', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const dated = Object.assign(() => 1, { at: new Date('nope') });
  const looped: (() => number) & { self?: unknown } = () => 1;
  looped.self = looped;

  expect(() => client.get('/x').params({ cb: dated })).toThrow(
    'HTTPRequestBuilder params.cb.at is not a valid Date',
  );
  expect(() => client.get('/x').params({ cb: looped })).toThrow(
    'HTTPRequestBuilder params.cb.self is an object it is nested inside',
  );
  expect(() => client.get('/x').params({ cb: () => 1 })).not.toThrow();
});

test('params refuses a Map, Set, WeakMap, WeakSet, URLSearchParams, Headers, FormData, Blob or URL at any depth, whose entries or contents qs would not write', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  class TagSet extends Set<string> {}
  const otherRealmMap: unknown = runInNewContext('new Map([[1, 2]])');
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ids: new Set([1, 2]) }, 'params.ids is a Set'],
    [{ filter: { by: new Map([['a', 1]]) } }, 'params.filter.by is a Map'],
    [{ list: [new WeakMap()] }, 'params.list.0 is a WeakMap'],
    [{ seen: new WeakSet() }, 'params.seen is a WeakSet'],
    [
      { q: { raw: new URLSearchParams('a=1') } },
      'params.q.raw is a URLSearchParams',
    ],
    [{ tags: new TagSet(['a']) }, 'params.tags is a Set'],
    [{ cb: Object.assign(() => 1, { m: new Map() }) }, 'params.cb.m is a Map'],
    [{ foreign: otherRealmMap }, 'params.foreign is a Map'],
    [{ filter: new Headers({ a: '1' }) }, 'params.filter is a Headers'],
    [{ form: { data: new FormData() } }, 'params.form.data is a FormData'],
  ];

  for (const [params, refusal] of cases) {
    expect(() => client.get('/x').params(params)).toThrow(
      new TypeError(
        `HTTPRequestBuilder ${refusal}, whose entries qs does not read, so it cannot be put in a query`,
      ),
    );
  }

  for (const [params, refusal] of [
    [{ file: new Blob(['x']) }, 'params.file is a Blob'],
    [{ upload: [new File(['x'], 'a.txt')] }, 'params.upload.0 is a Blob'],
    [{ next: new URL('https://x.test/p') }, 'params.next is a URL'],
    [
      { links: { self: new URL('https://x.test/') } },
      'params.links.self is a URL',
    ],
  ] as const) {
    expect(() => client.get('/x').params(params)).toThrow(
      new TypeError(
        `HTTPRequestBuilder ${refusal}, whose contents qs does not read, so it cannot be put in a query`,
      ),
    );
  }

  // Only a value holding the collection's own state is one: an object that merely
  // inherits from its prototype is walked by its own keys, as qs walks it.
  expect(() =>
    client.get('/x').params({ fake: Object.create(Map.prototype) as object }),
  ).not.toThrow();
});

test('params checks a value against the collection types the runtime has', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const original = globalThis.Headers;
  const headers = new Headers({ a: '1' });

  try {
    Reflect.deleteProperty(globalThis, 'Headers');
    expect(() => client.get('/x').params({ headers })).not.toThrow();
    expect(() => client.get('/x').params({ ids: new Set([1]) })).toThrow(
      'HTTPRequestBuilder params.ids is a Set',
    );
  } finally {
    globalThis.Headers = original;
  }
});

test('a URL is sent through its href', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/q', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  const next = new URL('https://x.test/p');

  const response = await client.get('/q').params({ next: next.href }).send();
  expect(response.requestURL).toBe(
    'http://api.test/q?next=https%3A%2F%2Fx.test%2Fp',
  );
});

test('a collection type written in JavaScript is told by instanceof too, so an object that fits its member is not one', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const originalBlob = globalThis.Blob;
  const originalHeaders = globalThis.Headers;
  // The shapes of React Native's Blob and whatwg-fetch's Headers: members that read a
  // field rather than refuse what is not one.
  class ScriptBlob {
    public data = { size: 1 };
    public get size(): number {
      return this.data.size;
    }
  }
  class ScriptHeaders {
    public map: Record<string, string> = {};
    public has(name: string): boolean {
      return Object.prototype.hasOwnProperty.call(this.map, name);
    }
  }
  class Filter {
    public data = { size: 2 };
    public map = {};
  }
  let getterReads = 0;
  class Lazy {
    public get data(): { size: number } {
      getterReads++;
      return { size: 1 };
    }
  }

  try {
    globalThis.Blob = ScriptBlob as unknown as typeof Blob;
    globalThis.Headers = ScriptHeaders as unknown as typeof Headers;
    expect(() =>
      client.get('/x').params({ filter: new Filter() }),
    ).not.toThrow();
    // The member is not run against an object that is not one, so its getter is not read.
    expect(() => client.get('/x').params({ lazy: new Lazy() })).not.toThrow();
    expect(getterReads).toBe(0);
    expect(() => client.get('/x').params({ file: new ScriptBlob() })).toThrow(
      'HTTPRequestBuilder params.file is a Blob',
    );
    expect(() => client.get('/x').params({ h: new ScriptHeaders() })).toThrow(
      'HTTPRequestBuilder params.h is a Headers',
    );
  } finally {
    globalThis.Blob = originalBlob;
    globalThis.Headers = originalHeaders;
  }
});

test('a nested function or keyless class instance in params writes nothing and clears the path key, as an empty object does', async () => {
  const adapter = new MockAdapter();
  adapter.routes.get('/x', () => ({ status: 200 }));
  const client = new HTTPClient({ adapter, baseURL: 'http://api.test' });
  class Hidden {
    readonly #secret = 1;
    public get secret(): number {
      return this.#secret;
    }
  }

  for (const value of [{}, () => 1, new Hidden()]) {
    const response = await client.get('/x?t=1&u=2').params({ t: value }).send();
    expect(response.requestURL).toBe('http://api.test/x?u=2');
  }
});

test('params checks an object shared under many parents once, not once per path', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  let shared: Record<string, unknown> = { a: 1 };
  // 2 ** 40 paths to the innermost object.
  for (let level = 0; level < 40; level++) {
    shared = { l: shared, r: shared };
  }

  // Under a millisecond checked once; once per path, it does not finish.
  const startedAt = performance.now();
  client.get('/x').params({ x: shared });
  expect(performance.now() - startedAt).toBeLessThan(5000);
});

test('params walks a typed array as qs does, and keeps a Buffer as its text', () => {
  const client = new HTTPClient({ adapter: new MockAdapter() });
  const bytes = Object.assign(new Uint8Array(1), { extra: new Date('nope') });

  expect(() => client.get('/events').params({ bytes })).toThrow(
    'HTTPRequestBuilder params.bytes.extra is not a valid Date',
  );
  const buffer = Object.assign(Buffer.from('a'), { self: {} });
  buffer.self = buffer;
  expect(() => client.get('/events').params({ buffer })).not.toThrow();
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

test("the entry exports HTTPRequestBuilder as a type only, and a client's methods make one", async () => {
  const entry: Record<string, unknown> = await import('./index');
  expect(Object.hasOwn(entry, 'HTTPRequestBuilder')).toBe(false);
  expect(Object.hasOwn(entry, 'HTTPClient')).toBe(true);

  const client = new HTTPClient({ adapter: new MockAdapter() });
  expect(client.get('/x')).toBeInstanceOf(HTTPRequestBuilder);
});
