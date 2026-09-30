import { expect, test } from 'bun:test';

for (const prototype of ['Object', 'Array'] as const) {
  for (const mode of ['race', 'all', 'settled', 'deadline'] as const) {
    test(`${mode} does not adopt inherited ${prototype}.prototype.then from its result container`, async () => {
      const script = `
        import { racePromises, allPromises, allSettledPromises } from ${JSON.stringify(new URL('./intrinsics.ts', import.meta.url).href)};
        import { raceDeadline } from ${JSON.stringify(new URL('./race-deadline.ts', import.meta.url).href)};
        const prototype = ${prototype}.prototype;
        const original = Object.getOwnPropertyDescriptor(prototype, 'then');
        const watchdog = setTimeout(() => process.exit(42), 500);
        const mode = ${JSON.stringify(mode)};
        let reads = 0;
        let result;
        try {
          Object.defineProperty(prototype, 'then', { configurable: true, value() { reads++; } });
          const inputs = [Promise.resolve(1)];
          result = await (mode === 'race' ? racePromises(inputs)
            : mode === 'all' ? allPromises(inputs)
            : mode === 'settled' ? allSettledPromises(inputs)
            : raceDeadline(new Promise(() => {}), 1, () => ['timeout']));
        } finally {
          if (original) Object.defineProperty(prototype, 'then', original);
          else delete prototype.then;
        }
        clearTimeout(watchdog);
        if (Object.getPrototypeOf(result) !== null) throw new Error('result is not a null-prototype box');
        const expected = mode === 'race' ? 1 : mode === 'all' ? [1]
          : mode === 'settled' ? [{ status: 'fulfilled', value: 1 }] : ['timeout'];
        if (JSON.stringify(result.value) !== JSON.stringify(expected)) throw new Error('wrong outcome');
        if (reads) throw new Error('inherited then was invoked');
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
