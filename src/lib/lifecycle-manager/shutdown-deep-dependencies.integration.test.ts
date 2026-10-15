import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Node and Bun shut down deep startup and concurrent-stop dependency graphs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shutdown-deep-dependencies-'));
  try {
    const fixture = join(dir, 'fixture.ts');
    await writeFile(
      fixture,
      `
      import assert from 'node:assert/strict';
      import { Logger } from ${JSON.stringify(fileURLToPath(new URL('../logger/index.ts', import.meta.url)))};
      import { LifecycleManager } from ${JSON.stringify(fileURLToPath(new URL('./lifecycle-manager.ts', import.meta.url)))};
      import { BaseComponent } from ${JSON.stringify(fileURLToPath(new URL('./base-component.ts', import.meta.url)))};
      import { claimReports, deferred } from ${JSON.stringify(fileURLToPath(new URL('./test-helpers.ts', import.meta.url)))};

      const mode = process.argv[2];
      const logger = new Logger({ sinks: [], callProcessExit: false });
      const manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 });
      const stopped = new Set();
      class Component extends BaseComponent {
        start() {}
        stop() { stopped.add(this.getName()); }
      }
      const depth = 10_000;
      const components = Array.from({ length: depth }, (_, index) =>
        new Component(logger, {
          name: 'c' + index,
          dependencies: index === 0 ? [] : ['c' + (index - 1)],
          startupTimeoutMS: 0,
          shutdownGracefulTimeoutMS: 0,
        }),
      );
      const independent = new Component(logger, { name: 'independent' });
      const top = components.at(-1);
      // Seed a committed registry as the existing deep-graph validation test does:
      // public registration repeatedly sorts the entire growing graph.
      components.splice(components.length - 1, 0, independent);
      const names = new Map(components.map(component => [component.getName(), component]));
      const states = new Map(components.map(component => [component.getName(), 'running']));
      const running = new Set(names.keys());
      if (mode === 'concurrent') {
        // Live dependency metadata can include registered components that aren't up.
        // Only these three are stop candidates, so this tests reachability without
        // repeating a full graph walk for every intermediate node.
        for (const name of running) {
          if (name !== 'c0' && name !== top.getName() && name !== 'independent') {
            running.delete(name);
            states.set(name, 'registered');
          }
        }
      } else {
        states.set(top.getName(), 'registered');
        running.delete(top.getName());
      }
      Object.assign(manager.state, {
        componentEntries: components,
        components,
        componentsByName: names,
        registeredNames: new WeakMap(components.map(component => [component, component.getName()])),
        componentStates: states,
        runningComponents: running,
      });

      const gate = deferred();
      if (mode === 'concurrent') {
        top.stop = () => gate.promise;
      } else {
        top.start = () => gate.promise;
      }
      const owned = mode === 'concurrent'
        ? manager.stopComponent(top.getName())
        : manager.startComponent(top.getName());
      const { reports, release } = claimReports();
      try {
        // A pass waits for a pending start, or a concurrent stop, until its deadline.
        const result = await manager.stopAllComponents({
          timeoutMS: mode === 'override' ? 0 : 100,
          allowStopWithPendingStarts: mode === 'override',
        });
        assert.equal(result.code, mode === 'override' ? 'cleanup_incomplete' : 'shutdown_timeout');
        assert.equal(stopped.has('independent'), true);
        assert.equal(stopped.has('c0'), mode === 'override');
        assert.equal(stopped.has(top.getName()), false);
        assert.equal(reports.length, 0);
      } finally {
        gate.resolve();
        await owned;
        await manager.stopAllComponents();
        await logger.close();
        release();
      }
    `,
    );
    const build = await Bun.build({ entrypoints: [fixture], target: 'node' });
    expect(build.success).toBe(true);
    const bundle = join(dir, 'fixture.mjs');
    await writeFile(bundle, await build.outputs[0].text());
    for (const runtime of ['node', process.execPath]) {
      for (const mode of ['pending', 'override', 'concurrent']) {
        const result = spawnSync(runtime, [bundle, mode], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.error, `${runtime}: ${mode}`).toBeUndefined();
        expect(result.status, `${runtime}: ${mode}\n${result.stderr}`).toBe(0);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
