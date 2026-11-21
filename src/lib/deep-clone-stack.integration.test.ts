import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Node clones deep JSON mixing objects and arrays on a small call stack', async () => {
  // An array between each object and the next adds calls of its own between the two, so
  // the depth filled by recursion has to leave room for them: a caller already deep in
  // its stack - here, a stack of a third of Node's default - must not overflow it.
  const directory = await mkdtemp(join(tmpdir(), 'deep-clone-stack-'));
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

        const depth = 1500;
        const original = JSON.parse('{"a":['.repeat(depth) + '1' + ']}'.repeat(depth));
        const cloned = deepClone(original);

        let node = cloned;
        for (let level = 0; level < depth; level++) {
          node = node.a[0];
        }
        assert.equal(node, 1);
        assert.notEqual(cloned, original);
      `,
    );
    const child = spawnSync('node', ['--stack-size=300', fixture], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
