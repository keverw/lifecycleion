import { expect, test } from 'bun:test';

for (const mode of ['mock', 'upload outcome', 'upload retry'] as const) {
  test(`${mode} observes adopted results after promise methods are replaced`, async () => {
    // Isolate the global replacements from the test runner and use a hard watchdog
    // so a dropped continuation produces a failure instead of a hanging suite.
    const script = `
      import { HTTPClient } from ${JSON.stringify(`${import.meta.dir}/http-client.ts`)};
      import { MockAdapter } from ${JSON.stringify(`${import.meta.dir}/adapters/mock-adapter.ts`)};
      const watchdog = setTimeout(() => process.exit(42), 1000);
      let attempts = 0;
      const mode = ${JSON.stringify(mode)};
      const mock = new MockAdapter();
      mock.routes.get('/test', () => Promise.resolve({ status: 200 }));
      const adapter = mode === 'mock' ? mock : {
        getType: () => 'node',
        send() {
          attempts++;
          return Promise.resolve({
            status: mode === 'upload retry' && attempts === 1 ? 503 : 200,
            headers: {}, body: null,
            requestBodySettled: Promise.resolve(mode === 'upload outcome' ? new Error('upload failed') : undefined),
          });
        },
      };
      const client = new HTTPClient({ adapter, baseURL: 'http://test.invalid' });
      const originalThen = Promise.prototype.then;
      const originalRace = Promise.race;
      Promise.prototype.then = function () { return new Promise(() => {}); };
      Promise.race = function () { return new Promise(() => {}); };
      const builder = (mode === 'mock' ? client.get('/test') : client.put('/test').json({ a: 1 }))
        .signal(new AbortController().signal)
        .timeout(100)
        .retryPolicy({ strategy: 'fixed', maxRetryAttempts: mode === 'upload retry' ? 1 : 0, delayMS: 0 });
      const response = await builder.send();
      const upload = await response.requestBodySettled;
      Promise.prototype.then = originalThen;
      Promise.race = originalRace;
      clearTimeout(watchdog);
      process.stdout.write(JSON.stringify({ status: response.status, attempts, upload: upload?.message }));
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
      status: 200,
      attempts: mode === 'mock' ? 0 : mode === 'upload retry' ? 2 : 1,
      ...(mode === 'upload outcome' ? { upload: 'upload failed' } : {}),
    });
  });
}

for (const mode of ['empty', 'text', 'form'] as const) {
  test(`NodeAdapter ${mode} request observes native continuations after Promise methods are replaced`, async () => {
    const script = `
      import { NodeAdapter } from ${JSON.stringify(`${import.meta.dir}/adapters/node-adapter.ts`)};
      const watchdog = setTimeout(() => process.exit(42), 1000);
      const mode = ${JSON.stringify(mode)};
      const form = new FormData();
      form.append('field', 'value');
      const originalThen = Promise.prototype.then;
      const originalCatch = Promise.prototype.catch;
      Promise.prototype.then = function () { return new Promise(() => {}); };
      Promise.prototype.catch = function () { return new Promise(() => {}); };
      const result = await new NodeAdapter({ socketPath: '/tmp/lifecycleion-no-such-socket-' + process.pid }).send({
        requestURL: 'http://example.test/',
        method: mode === 'empty' ? 'GET' : 'POST', headers: {},
        body: mode === 'empty' ? null : mode === 'text' ? 'body' : form,
      });
      Promise.prototype.then = originalThen;
      Promise.prototype.catch = originalCatch;
      clearTimeout(watchdog);
      process.stdout.write(String(result.status));
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
    expect({ code, stderr, stdout }).toEqual({
      code: 0,
      stderr: '',
      stdout: '0',
    });
  });
}

for (const mode of ['text', 'form'] as const) {
  test(`NodeAdapter ${mode} writer completes with replaced Promise methods`, async () => {
    const script = `
      import { EventEmitter } from 'node:events';
      import * as http from 'node:http';
      import { spyOn } from 'bun:test';
      import { NodeAdapter } from ${JSON.stringify(`${import.meta.dir}/adapters/node-adapter.ts`)};
      const watchdog = setTimeout(() => process.exit(42), 1000);
      class Request extends EventEmitter {
        chunks = [];
        writableEnded = false;
        setHeader() {}
        getHeaders() { return {}; }
        write(data, callback) { this.chunks.push(Buffer.from(data)); callback?.(); return true; }
        end() {
          this.writableEnded = true;
          const response = new EventEmitter();
          response.statusCode = 201;
          response.headers = {};
          queueMicrotask(() => { this.emit('response', response); response.emit('end'); });
        }
        destroy() {}
      }
      const request = new Request();
      const requestSpy = spyOn(http, 'request').mockImplementation((_options, callback) => {
        request.on('response', callback);
        return request;
      });
      const form = new FormData();
      form.append('field', 'value');
      const originalThen = Promise.prototype.then;
      const originalCatch = Promise.prototype.catch;
      Promise.prototype.then = function () { return new Promise(() => {}); };
      Promise.prototype.catch = function () { return new Promise(() => {}); };
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/', method: 'POST', headers: {},
        body: ${JSON.stringify(mode)} === 'text' ? 'body' : form,
      });
      Promise.prototype.then = originalThen;
      Promise.prototype.catch = originalCatch;
      requestSpy.mockRestore();
      clearTimeout(watchdog);
      const body = Buffer.concat(request.chunks).toString();
      process.stdout.write(JSON.stringify({
        status: response.status,
        ended: request.writableEnded,
        bodyMatches: ${JSON.stringify(mode)} === 'text' ? body === 'body' : body.includes('name="field"') && body.includes('value'),
      }));
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
    expect({ code, stderr, stdout }).toEqual({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ status: 201, ended: true, bodyMatches: true }),
    });
  });

  test(`NodeAdapter ${mode} writer reports failure with replaced Promise methods`, async () => {
    const script = `
      import { EventEmitter } from 'node:events';
      import * as http from 'node:http';
      import { spyOn } from 'bun:test';
      import { NodeAdapter } from ${JSON.stringify(`${import.meta.dir}/adapters/node-adapter.ts`)};
      const watchdog = setTimeout(() => process.exit(42), 1000);
      class Request extends EventEmitter {
        destroyed = false;
        writableEnded = false;
        setHeader() {}
        getHeaders() { return {}; }
        write(_data, callback) { callback?.(new Error('write failed')); return true; }
        end() { this.writableEnded = true; }
        destroy() { this.destroyed = true; }
      }
      const request = new Request();
      const requestSpy = spyOn(http, 'request').mockImplementation(() => request);
      const form = new FormData();
      form.append('field', 'value');
      const originalThen = Promise.prototype.then;
      const originalCatch = Promise.prototype.catch;
      Promise.prototype.then = function () { return new Promise(() => {}); };
      Promise.prototype.catch = function () { return new Promise(() => {}); };
      const response = await new NodeAdapter().send({
        requestURL: 'http://example.test/', method: 'POST', headers: {},
        body: ${JSON.stringify(mode)} === 'text' ? 'body' : form,
      });
      Promise.prototype.then = originalThen;
      Promise.prototype.catch = originalCatch;
      requestSpy.mockRestore();
      clearTimeout(watchdog);
      process.stdout.write(JSON.stringify({ status: response.status, message: response.errorCause?.message }));
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
    expect({ code, stderr, stdout }).toEqual({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ status: 0, message: 'write failed' }),
    });
  });
}
