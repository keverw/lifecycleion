import { expect, test } from 'bun:test';

for (const isBulkStartup of [false, true]) {
  test(`long-lived callbacks release retired components after ${isBulkStartup ? 'bulk startup' : 'registration'}`, async () => {
    // Isolate the collection probe from the test runner: repeated in-process
    // runs can retain temporary values on its stack even after explicit GC.
    const probe = Bun.spawn({
      cmd: [
        process.execPath,
        '--eval',
        `
        import { Plain, setup } from ${JSON.stringify(new URL('./test-helpers.ts', import.meta.url).href)};
        class Reporter extends Plain {
          reportStop() { return this.reportUnexpectedStop(); }
        }
        const { logger, manager } = setup();
        async function retireComponent() {
          let retired = new Reporter(logger, 'retired');
          const survivor = new Plain(logger, 'survivor', ${isBulkStartup} ? ['retired'] : []);
          await manager.registerComponent(retired);
          await manager.registerComponent(survivor);
          if (${isBulkStartup}) {
            if (!(await manager.startAllComponents()).success) throw new Error('startup failed');
            if (!retired.reportStop()) throw new Error('stop report failed');
          }
          if (!(await manager.unregisterComponent('retired')).success) throw new Error('unregister failed');
          const reference = new WeakRef(retired);
          retired = undefined;
          return reference;
        }
        const retired = await retireComponent();
        // WeakRef keeps a target alive for the current job. Use fresh jobs and
        // never dereference the target between collections.
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 0));
          Bun.gc(true);
        }
        if (retired.deref() !== undefined) throw new Error('Retired component retained by survivor');
        if (manager.getComponentStatus('survivor')?.state !== ${JSON.stringify(isBulkStartup ? 'running' : 'registered')}) {
          throw new Error('Survivor must remain live during collection');
        }
        await manager.stopAllComponents();
        await logger.close();
      `,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      probe.exited,
      new Response(probe.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
  });
}
