import { expect, test } from 'bun:test';

for (const mode of [
  'callback',
  'logger close',
  'lifecycle',
  'mock request',
] as const) {
  test(`${mode} keeps native internal promises after the global constructor is replaced`, async () => {
    const script = `
      import { safeHandleCallbackAndWait, safeHandleCallback } from ${JSON.stringify(new URL('../safe-handle-callback.ts', import.meta.url).href)};
      import { Logger } from ${JSON.stringify(new URL('../logger/index.ts', import.meta.url).href)};
      import { LifecycleManager } from ${JSON.stringify(new URL('../lifecycle-manager/lifecycle-manager.ts', import.meta.url).href)};
      import { BaseComponent } from ${JSON.stringify(new URL('../lifecycle-manager/base-component.ts', import.meta.url).href)};
      import { HTTPClient } from ${JSON.stringify(new URL('../http-client/http-client.ts', import.meta.url).href)};
      import { MockAdapter } from ${JSON.stringify(new URL('../http-client/adapters/mock-adapter.ts', import.meta.url).href)};
      const NativePromise = Promise;
      class Replacement {
        constructor(executor) { this.inner = new NativePromise(executor); }
        then(ok, fail) { return this.inner.then(ok, fail); }
        catch(fail) { return this.inner.catch(fail); }
        static resolve(value) { return new Replacement(resolve => resolve(value)); }
        static reject(error) { return new Replacement((_, reject) => reject(error)); }
      }
      const watchdog = setTimeout(() => process.exit(42), 1000);
      const logger = new Logger({ callProcessExit: false, sinks: [{ write() {}, close: async () => {} }] });
      const manager = new LifecycleManager({ logger });
      class Component extends BaseComponent {
        start() {} stop() {} onShutdownForce() {}
        healthCheck() { return { healthy: true }; }
        onMessage() { return 'message'; }
      }
      manager.registerComponent(new Component(logger, { name: 'test' }));
      const mode = ${JSON.stringify(mode)};
      let result;
      globalThis.Promise = Replacement;
      try {
        if (mode === 'callback') {
          safeHandleCallback('native async', async () => 1);
          result = (await safeHandleCallbackAndWait('thenable', () => ({ then(resolve) { resolve(2); } }))).value;
        } else if (mode === 'logger close') {
          logger.exit(1);
          await logger.close();
          result = logger.didExit;
        } else if (mode === 'lifecycle') {
          const started = await manager.startComponent('test');
          const health = await manager.checkComponentHealth('test');
          const message = await manager.sendMessageToComponent('test', {});
          const stopped = await manager.stopAllComponents({ forceImmediate: true });
          result = { started: started.success, healthy: health.healthy, message: message.code === 'sent', stopped: stopped.success };
        } else {
          const adapter = new MockAdapter();
          adapter.routes.get('/test', async () => ({ status: 200 }));
          const client = new HTTPClient({ adapter, baseURL: 'http://test.invalid' });
          result = (await client.get('/test').signal(new AbortController().signal).send()).status;
        }
      } finally { globalThis.Promise = NativePromise; }
      await logger.close();
      clearTimeout(watchdog);
      process.stdout.write(JSON.stringify(result));
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual(
      mode === 'callback'
        ? 2
        : mode === 'logger close'
          ? true
          : mode === 'mock request'
            ? 200
            : {
                started: true,
                healthy: true,
                message: true,
                stopped: true,
              },
    );
  });
}

for (const mode of ['thenable', 'diagnostic'] as const) {
  test(`${mode} uses native promise jobs when queueMicrotask is replaced`, async () => {
    const script = `
      import { safeHandleCallbackAndWait } from ${JSON.stringify(new URL('../safe-handle-callback.ts', import.meta.url).href)};
      import { Logger } from ${JSON.stringify(new URL('../logger/index.ts', import.meta.url).href)};
      const watchdog = setTimeout(() => process.exit(42), 500);
      const original = queueMicrotask;
      let queued = 0;
      globalThis.queueMicrotask = () => { queued++; };
      let result;
      if (${JSON.stringify(mode)} === 'thenable') {
        result = (await safeHandleCallbackAndWait('thenable', () => ({ then(resolve) { resolve(2); } }))).value;
      } else {
        const logger = new Logger({ callProcessExit: false, sinks: [{ write() { throw new Error('sink failure'); }, writeDiagnostic() {} }] });
        let reported = false;
        logger.on('diagnostic', () => { reported = true; });
        logger.info('entry');
        await new Promise(resolve => setTimeout(resolve, 0));
        result = reported;
        await logger.close();
      }
      globalThis.queueMicrotask = original;
      clearTimeout(watchdog);
      process.stdout.write(JSON.stringify({ result, queued }));
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(stdout)).toEqual({
      result: mode === 'thenable' ? 2 : true,
      queued: 0,
    });
  });
}

// These helpers are also reached without an AbortSignal. A replaced constructor
// must not change the delay contract or turn a buffered upload into a failure.
for (const mode of [
  'sleep',
  'mock delay',
  'buffered upload',
  'multipart upload',
] as const) {
  test(`${mode} does not consult a replacement Promise constructor`, async () => {
    const script = `
      import { sleep } from ${JSON.stringify(new URL('../sleep.ts', import.meta.url).href)};
      import { MockAdapter } from ${JSON.stringify(new URL('../http-client/adapters/mock-adapter.ts', import.meta.url).href)};
      import { EventEmitter } from 'node:events';
      import { writeRequestBodyChunked } from ${JSON.stringify(new URL('../http-client/internal/request-body-writer.ts', import.meta.url).href)};
      import { serializeMultipartFormData } from ${JSON.stringify(new URL('../http-client/internal/multipart.ts', import.meta.url).href)};
      const NativePromise = Promise;
      globalThis.Promise = class { constructor() { throw new Error('replacement constructor called'); } };
      try {
        if (${JSON.stringify(mode)} === 'sleep') await sleep(1);
        else if (${JSON.stringify(mode)} === 'mock delay') {
          const adapter = new MockAdapter();
          adapter.routes.get('/test', () => ({ status: 200, delay: 1 }));
          const result = await adapter.send({ requestURL: '/test', method: 'GET', headers: {}, body: null });
          if (result.status !== 200) throw new Error('request failed');
        } else {
          const req = new EventEmitter();
          req.destroyed = false;
          req.setHeader = () => {};
          let writes = 0;
          req.write = (data, done) => { writes++; done(); return true; };
          if (${JSON.stringify(mode)} === 'buffered upload') await writeRequestBodyChunked(Buffer.from('body'), req);
          else {
            const form = new FormData();
            form.append('field', 'body');
            await serializeMultipartFormData(form, req, 'boundary');
          }
          if (!writes) throw new Error('no body written');
        }
      } finally { globalThis.Promise = NativePromise; }
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  });
}

test('captures the async-function realm when Promise was replaced before import', async () => {
  const script = `
    const NativePromise = Promise;
    class Replacement {
      constructor(executor) { this.inner = new NativePromise(executor); }
      then(ok, fail) { return this.inner.then(ok, fail); }
      static resolve(value) { return new Replacement(resolve => resolve(value)); }
      static reject(error) { return new Replacement((_, reject) => reject(error)); }
    }
    globalThis.Promise = Replacement;
    const watchdog = setTimeout(() => process.exit(42), 1000);
    const { Logger } = await import(${JSON.stringify(new URL('../logger/index.ts', import.meta.url).href)});
    const logger = new Logger({ sinks: [{ write() {}, async close() {} }] });
    await logger.close();
    globalThis.Promise = NativePromise;
    clearTimeout(watchdog);
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
});

for (const mode of ['message', 'health', 'reload'] as const) {
  test(`${mode} does not re-adopt the winning hook value past its deadline`, async () => {
    const script = `
      import { Logger } from ${JSON.stringify(new URL('../logger/index.ts', import.meta.url).href)};
      import { LifecycleManager } from ${JSON.stringify(new URL('../lifecycle-manager/lifecycle-manager.ts', import.meta.url).href)};
      import { BaseComponent } from ${JSON.stringify(new URL('../lifecycle-manager/base-component.ts', import.meta.url).href)};
      const logger = new Logger({ sinks: [] });
      const manager = new LifecycleManager({ logger });
      let reads = 0;
      // Adoption completes. Reading then once more from the fulfilled value would
      // turn it into pending work after the race had already consumed its deadline.
      const value = { healthy: true, get then() { return ++reads <= 1 ? undefined : () => {}; } };
      class Component extends BaseComponent {
        start() {} stop() {}
        onMessage() { return value; }
        healthCheck() { return value; }
        onReload() { return value; }
      }
      await manager.registerComponent(new Component(logger, { name: 'a', healthCheckTimeoutMS: 5, signalTimeoutMS: 5 }));
      await manager.startComponent('a');
      const watchdog = setTimeout(() => process.exit(42), 500);
      const result = ${JSON.stringify(mode)} === 'message'
        ? await manager.sendMessageToComponent('a', {}, { timeout: 5 })
        : ${JSON.stringify(mode)} === 'health'
          ? await manager.checkComponentHealth('a')
          : await manager.triggerReload();
      if (result.code !== (${JSON.stringify(mode)} === 'message' ? 'sent' : 'ok')) throw new Error(JSON.stringify(result));
      if (reads !== 1) throw new Error('winner read again');
      clearTimeout(watchdog);
      await manager.stopAllComponents();
      await logger.close();
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  });
}
