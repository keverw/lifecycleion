import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Node interceptor and observer snapshots survive a replaced Array constructor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'registration-snapshot-'));
  try {
    const fixture = join(directory, 'fixture.ts');
    await writeFile(
      fixture,
      `
        import assert from 'node:assert/strict';
        import { RequestInterceptorManager } from ${JSON.stringify(fileURLToPath(new URL('./interceptors.ts', import.meta.url)))};
        import { ResponseObserverManager, ErrorObserverManager } from ${JSON.stringify(fileURLToPath(new URL('./observers.ts', import.meta.url)))};

        const interceptors = new RequestInterceptorManager();
        const responses = new ResponseObserverManager();
        const errors = new ErrorObserverManager();
        const calls = [];
        interceptors.add(request => {
          calls.push('request');
          return { ...request, headers: { 'x-ran': 'yes' } };
        });
        responses.add(() => { calls.push('response'); });
        errors.add(() => { calls.push('error'); });
        const originalArray = globalThis.Array;
        let requestChain, responseChain, errorChain;
        try {
          globalThis.Array = new Proxy(originalArray, {
            construct() { throw new Error('replaced Array constructor used'); },
          });
          requestChain = interceptors.snapshot();
          responseChain = responses.snapshot();
          errorChain = errors.snapshot();
        } finally {
          globalThis.Array = originalArray;
        }
        const request = { requestURL: 'https://example.test/', method: 'GET', headers: {} };
        const result = await requestChain(request, { type: 'initial' }, {});
        assert.equal(result.headers['x-ran'], 'yes');
        await responseChain({ status: 200, headers: {} }, request, { type: 'final' });
        await errorChain({ code: 'network_error' }, request, { type: 'final' });
        assert.deepEqual(calls, ['request', 'response', 'error']);
      `,
    );
    const build = await Bun.build({ entrypoints: [fixture], target: 'node' });
    expect(build.success).toBe(true);
    const bundle = join(directory, 'fixture.mjs');
    await writeFile(bundle, await build.outputs[0].text());
    const child = spawnSync('node', [bundle], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
