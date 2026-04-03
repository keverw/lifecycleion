import { describe, expect, test } from 'bun:test';
import { HTTPRequestBuilder } from './http-request-builder';
import type { BuilderSendContext } from './http-request-builder';
import type { HTTPResponse } from './types';

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

    test('requestID throws before send', () => {
      const { builder } = makeBuilder();
      expect(() => builder.requestID).toThrow(
        /not available until after .send\(\)/,
      );
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
      const builder = new HTTPRequestBuilder('POST', '/users', sendFn as any);
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
    test('applies options passed to constructor', async () => {
      const { sendFn, requireContext } = makeSendFn();
      const builder = new HTTPRequestBuilder('GET', '/test', sendFn as any, {
        headers: { 'x-init': 'yes' },
        timeout: 1000,
        label: 'init-label',
      });

      await builder.send();
      expect(requireContext().options.headers['x-init']).toBe('yes');
      expect(requireContext().options.timeout).toBe(1000);
      expect(requireContext().options.label).toBe('init-label');
    });

    test('fluent headers() merge on top of constructor headers', async () => {
      const { sendFn, requireContext } = makeSendFn();
      const builder = new HTTPRequestBuilder('GET', '/test', sendFn as any, {
        headers: { 'x-init': 'yes' },
      });

      await builder.headers({ 'x-extra': 'also' }).send();
      expect(requireContext().options.headers['x-init']).toBe('yes');
      expect(requireContext().options.headers['x-extra']).toBe('also');
    });
  });

  describe('callbacks wire up post-send state', () => {
    test('setRequestID makes requestID available', async () => {
      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setRequestID('req-abc');
      });

      await builder.send();
      expect(builder.requestID).toBe('req-abc');
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
    test('calls cancelFn and returns true when in-flight', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe(true);
      expect(wasCancelCalled).toBe(true);
    });

    test('before send: sets state to cancelled and returns true', () => {
      const { builder } = makeBuilder();
      expect(builder.cancel()).toBe(true);
      expect(builder.state).toBe('cancelled');
    });

    test('before send: blocks send() after cancel()', () => {
      const { builder } = makeBuilder();
      builder.cancel();
      expect(() => builder.send()).toThrow(/after cancel\(\)/);
    });

    test('returns false when state is completed', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('completed');
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe(false);
      expect(wasCancelCalled).toBe(false);
    });

    test('returns false when state is cancelled', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('cancelled');
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe(false);
      expect(wasCancelCalled).toBe(false);
    });

    test('returns false when state is failed', async () => {
      let wasCancelCalled = false;

      const { builder } = makeBuilder(undefined, (ctx) => {
        ctx.callbacks.setState('failed');
        ctx.callbacks.setCancelFn(() => {
          wasCancelCalled = true;
        });
      });

      await builder.send();
      expect(builder.cancel()).toBe(false);
      expect(wasCancelCalled).toBe(false);
    });
  });
});
