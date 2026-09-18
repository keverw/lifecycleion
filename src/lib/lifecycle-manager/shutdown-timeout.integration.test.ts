import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('Node and Bun settle shutdown deadlines when the timeout logger throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shutdown-timeout-'));
  try {
    const fixture = join(dir, 'fixture.ts');
    await writeFile(
      fixture,
      `
      import assert from 'node:assert/strict';
      import { Logger } from ${JSON.stringify(new URL('../logger/index.ts', import.meta.url).pathname)};
      import { LifecycleManager } from ${JSON.stringify(new URL('./lifecycle-manager.ts', import.meta.url).pathname)};
      import { BaseComponent } from ${JSON.stringify(new URL('./base-component.ts', import.meta.url).pathname)};
      const watchdog = setTimeout(() => process.exit(2), 1500);
      const logger = new Logger({ sinks: [], callProcessExit: false });
      const manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 });
      const scoped = Reflect.get(manager, 'logger');
      let notified = false;
      const warn = scoped.warn.bind(scoped);
      scoped.warn = (message, ...args) => {
        if (message === 'Shutdown timeout exceeded, halting further stop attempts') {
          notified = true;
          throw new Error('logger refused timeout');
        }
        return warn(message, ...args);
      };
      class Hanging extends BaseComponent {
        start() {}
        stop() { return new Promise(() => {}); }
      }
      await manager.registerComponent(new Hanging(logger, { name: 'hanging', shutdownGracefulTimeoutMS: 5000 }));
      await manager.startAllComponents();
      const result = await manager.stopAllComponents({ timeoutMS: 20 });
      assert.equal(notified, true);
      assert.equal(result.code, 'shutdown_timeout');
      assert.equal(result.timedOut, true);
      clearTimeout(watchdog);
      process.exit(0);
    `,
    );
    const build = await Bun.build({ entrypoints: [fixture], target: 'node' });
    expect(build.success).toBe(true);
    const bundle = join(dir, 'fixture.mjs');
    await writeFile(bundle, await build.outputs[0].text());
    for (const runtime of ['node', process.execPath]) {
      const result = spawnSync(runtime, [bundle], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
