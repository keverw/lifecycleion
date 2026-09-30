import { expect, test } from 'bun:test';

const imports = {
  callback: new URL('../safe-handle-callback.ts', import.meta.url).href,
  logger: new URL('../logger/index.ts', import.meta.url).href,
  retry: new URL('../retry-utils/lib/retry-runner.ts', import.meta.url).href,
  lifecycle: new URL(
    '../lifecycle-manager/lifecycle-manager.ts',
    import.meta.url,
  ).href,
  component: new URL('../lifecycle-manager/base-component.ts', import.meta.url)
    .href,
  http: new URL('../http-client/http-client.ts', import.meta.url).href,
  mock: new URL('../http-client/adapters/mock-adapter.ts', import.meta.url)
    .href,
};

async function runIsolated(
  body: string,
): Promise<{ code: number; stderr: string }> {
  const script = `
    import { safeHandleCallbackAndWait } from ${JSON.stringify(imports.callback)};
    import { Logger } from ${JSON.stringify(imports.logger)};
    import { RetryRunner } from ${JSON.stringify(imports.retry)};
    import { LifecycleManager } from ${JSON.stringify(imports.lifecycle)};
    import { BaseComponent } from ${JSON.stringify(imports.component)};
    import { HTTPClient } from ${JSON.stringify(imports.http)};
    import { MockAdapter } from ${JSON.stringify(imports.mock)};
    const watchdog = setTimeout(() => process.exit(42), 3000);
    const originalThen = Promise.prototype.then;
    const tracked = new WeakSet();
    let liveThenCalls = 0;
    function hostile(value, shouldReject = false) {
      const promise = shouldReject ? Promise.reject(value) : Promise.resolve(value);
      let constructorReads = 0;
      Object.defineProperty(promise, 'constructor', {
        get() { return ++constructorReads === 1 ? Promise : Object; },
      });
      tracked.add(promise);
      return promise;
    }
    Promise.prototype.then = function (...args) {
      if (tracked.has(this)) { liveThenCalls++; return undefined; }
      return Reflect.apply(originalThen, this, args);
    };
    try {
      ${body}
      if (liveThenCalls !== 0) throw new Error('live then was called ' + liveThenCalls + ' times');
      clearTimeout(watchdog);
    } finally {
      Promise.prototype.then = originalThen;
    }
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr };
}

test('safeHandleCallbackAndWait awaits an adopted native promise through captured observation', async () => {
  const outcome = await runIsolated(`
    const result = await safeHandleCallbackAndWait('hostile return', () => hostile(17));
    if (!result.success || result.value !== 17) throw new Error('wrong callback result');
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('Logger.close completes when a sink returns a native promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    const logger = new Logger({
      callProcessExit: false,
      closeTimeoutMS: 1000,
      sinks: [{ write() {}, close() { return hostile(undefined); } }],
    });
    await logger.close();
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('RetryRunner completes an attempt whose promise changes constructor', async () => {
  const outcome = await runIsolated(`
    const runner = new RetryRunner(
      { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 1 },
      (report) => {
        report('success', 'ok');
        return hostile(undefined);
      },
    );
    const result = await runner.run(true);
    if (result.status !== 'attempt_success') throw new Error('wrong retry result: ' + result.status);
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('LifecycleManager awaits a zero-timeout start promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    const logger = new Logger({ callProcessExit: false, sinks: [] });
    const manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 });
    class Component extends BaseComponent {
      start() { return hostile(undefined); }
      stop() {}
    }
    await manager.registerComponent(new Component(logger, {
      name: 'hostile-start', startupTimeoutMS: 0,
    }));
    const result = await manager.startComponent('hostile-start');
    if (!result.success) throw new Error('start failed');
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('LifecycleManager awaits a zero-timeout stop promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    const logger = new Logger({ callProcessExit: false, sinks: [] });
    const manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 });
    class Component extends BaseComponent {
      start() {}
      stop() { return hostile(undefined); }
    }
    await manager.registerComponent(new Component(logger, {
      name: 'hostile-stop', shutdownGracefulTimeoutMS: 0,
    }));
    if (!(await manager.startComponent('hostile-stop')).success) throw new Error('start failed');
    const result = await manager.stopComponent('hostile-stop', { timeout: 0 });
    if (!result.success) throw new Error('stop failed');
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('LifecycleManager completes a detached warning promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    const logger = new Logger({ callProcessExit: false, sinks: [] });
    const manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: 0 });
    class Component extends BaseComponent {
      start() {}
      stop() {}
      onShutdownWarning() { return hostile(undefined); }
    }
    await manager.registerComponent(new Component(logger, { name: 'hostile-warning' }));
    if (!(await manager.startComponent('hostile-warning')).success) throw new Error('start failed');
    const completed = new Promise((resolve) => {
      manager.on('component:shutdown-warning-completed', resolve);
    });
    await manager.stopAllComponents();
    await completed;
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('HTTPClient awaits an adapter promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    const client = new HTTPClient({
      baseURL: 'http://example.test',
      adapter: {
        getType: () => 'node',
        send: () => hostile({ status: 200, headers: {}, body: new Uint8Array() }),
      },
    });
    const response = await client.get('/x').send();
    if (response.status !== 200) throw new Error('wrong adapter result');
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('HTTPClient awaits an interceptor promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    const client = new HTTPClient({
      baseURL: 'http://example.test',
      adapter: {
        getType: () => 'node',
        send: () => Promise.resolve({ status: 200, headers: {}, body: new Uint8Array() }),
      },
    });
    client.addRequestInterceptor((request) => hostile(request));
    const response = await client.get('/x').send();
    if (response.status !== 200) throw new Error('wrong interceptor result');
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('MockAdapter awaits a route promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    const adapter = new MockAdapter();
    adapter.routes.get('/x', () => hostile({ status: 200, body: { ok: true } }));
    const response = await adapter.send({
      requestURL: 'http://example.test/x', method: 'GET', headers: {},
    });
    if (response.status !== 200) {
      throw new Error('wrong mock result');
    }
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('boxed awaiting preserves a fulfilled object whose then changes after the first read', async () => {
  const outcome = await runIsolated(`
    let reads = 0;
    const value = {
      get then() {
        if (++reads > 1) throw new Error('fulfilled value was adopted twice');
        return undefined;
      },
    };
    const result = await safeHandleCallbackAndWait('stateful value', async () => value);
    if (!result.success || result.value !== value || reads !== 1) {
      throw new Error('fulfilled value changed');
    }
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});

test('boxed awaiting observes rejection from a promise with changing constructor', async () => {
  const outcome = await runIsolated(`
    let unhandled = 0;
    process.on('unhandledRejection', () => { unhandled++; });
    globalThis.addEventListener('error', (event) => event.preventDefault());
    const failure = new Error('operation failed');
    const result = await safeHandleCallbackAndWait('rejecting return', () => hostile(failure, true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (result.success || result.error !== failure || unhandled !== 0) {
      throw new Error('rejection was lost or unhandled');
    }
  `);
  expect(outcome).toEqual({ code: 0, stderr: '' });
});
