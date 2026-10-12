import { expect, test } from 'bun:test';

for (const mode of [
  'callback',
  'awaited callback',
  'sink',
  'diagnostic',
] as const) {
  for (const allowedReads of mode === 'awaited callback' ? [1] : [1, 2]) {
    test(`${mode} preserves a successful value whose then changes after ${allowedReads} reads`, async () => {
      const script = `
        import { safeHandleCallback, safeHandleCallbackAndWait } from ${JSON.stringify(new URL('../safe-handle-callback.ts', import.meta.url).href)};
        import { Logger } from ${JSON.stringify(new URL('../logger/index.ts', import.meta.url).href)};
        let reads = 0;
        const value = { get then() { if (++reads > ${allowedReads}) throw new Error('second adoption'); return undefined; } };
        const result = async () => value;
        const mode = ${JSON.stringify(mode)};
        let logger;
        if (mode === 'callback') safeHandleCallback('stateful fulfillment', result);
        else if (mode === 'awaited callback') {
          const outcome = await safeHandleCallbackAndWait('stateful fulfillment', result);
          if (!outcome.success || outcome.value !== value) throw new Error('successful callback was changed');
        } else {
          logger = new Logger({ callProcessExit: false, sinks: mode === 'sink' ? [{ write: result }] : [{ write() { throw new Error('trigger diagnostic'); } }], diagnosticSinks: mode === 'diagnostic' ? [{ write: result }] : [] });
          logger.info('test');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        await logger?.close();
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
}
