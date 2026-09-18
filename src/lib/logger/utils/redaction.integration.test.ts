import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Node and Bun preserve unmatched Errors, their causes, and private fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'redaction-errors-'));
  try {
    const fixture = join(dir, 'fixture.ts');
    await writeFile(
      fixture,
      `
      import assert from 'node:assert/strict';
      import { applyRedaction, REDACTION_FAILED_MARKER } from ${JSON.stringify(new URL('./redaction.ts', import.meta.url).pathname)};
      class AccessorError extends Error {
        get code() { return 'E_TEST'; }
      }
      const accessorError = new AccessorError('original error');
      const originalStack = accessorError.stack;
      const copied = applyRedaction({ password: 'secret', error: accessorError }, ['password']).error;
      assert.notEqual(copied, accessorError);
      assert.ok(copied instanceof AccessorError);
      assert.equal(copied.code, 'E_TEST');
      assert.equal(copied.stack, originalStack);
      assert.equal(accessorError.stack, originalStack);
      class Diagnostic extends Error {
        #detail = 'private detail';
        get detail() { return this.#detail; }
        toJSON() { return { detail: this.#detail }; }
      }
      const error = process.argv[2] === 'cause'
        ? new Error('outer', { cause: new Error('inner') })
        : new Diagnostic('outer');
      const result = applyRedaction({ password: 'secret', error }, ['password']);
      assert.notEqual(result.error, REDACTION_FAILED_MARKER);
      assert.equal(result.error, error);
      if (error instanceof Diagnostic) {
        assert.equal(result.error.detail, 'private detail');
        assert.equal(JSON.stringify(result.error), '{"detail":"private detail"}');
      } else {
        assert.equal(result.error.cause, error.cause);
      }
      // Native stack accessors still need their values inspected: custom stack
      // formatters can return objects, including an unmasked ancestor.
      if (process.argv[2] === 'cause') {
        const params = { password: 'secret' };
        const original = Error.prepareStackTrace;
        try {
          Error.prepareStackTrace = () => params;
          params.error = new Error('unsafe');
          const failures = [];
          assert.equal(applyRedaction(params, ['password'], undefined, (_error, kind, path) => failures.push({kind, path})).error, REDACTION_FAILED_MARKER);
          assert.deepEqual(failures, [{kind: 'redaction', path: 'error'}]);
        } finally { Error.prepareStackTrace = original; }
      }
    `,
    );
    const build = await Bun.build({ entrypoints: [fixture], target: 'node' });
    expect(build.success).toBe(true);
    const bundle = join(dir, 'fixture.mjs');
    await writeFile(bundle, await build.outputs[0].text());
    for (const runtime of ['node', process.execPath]) {
      for (const mode of ['cause', 'private']) {
        const result = spawnSync(runtime, [bundle, mode], {
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
