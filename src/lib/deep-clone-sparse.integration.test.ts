import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Node clones a long sparse array without allocating its holes', async () => {
  // V8 allocates every hole up to a length set on an empty array, where JavaScriptCore
  // does not, so this is run on Node.
  const directory = await mkdtemp(join(tmpdir(), 'deep-clone-sparse-'));
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL('./deep-clone.ts', import.meta.url))],
      target: 'node',
      format: 'esm',
    });
    expect(build.success).toBe(true);
    await writeFile(
      join(directory, 'deep-clone.mjs'),
      await build.outputs[0].text(),
    );
    const fixture = join(directory, 'fixture.mjs');
    await writeFile(
      fixture,
      `
        import assert from 'node:assert/strict';
        import { deepClone } from './deep-clone.mjs';

        const sparse = [];
        sparse[5] = 'x';
        sparse[2 ** 24] = 'y';
        sparse.length = 2 ** 24 + 2;

        const before = process.memoryUsage().rss;
        const clones = Array.from({ length: 4 }, () => deepClone(sparse));
        const grown = process.memoryUsage().rss - before;

        for (const clone of clones) {
          assert.equal(clone.length, 2 ** 24 + 2);
          assert.deepEqual(Object.keys(clone), ['5', String(2 ** 24)]);
        }
        // Each would be 128 MiB allocated whole.
        assert.ok(grown < 64 * 1024 * 1024, 'grew ' + grown + ' bytes');
      `,
    );
    const child = spawnSync('node', [fixture], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
