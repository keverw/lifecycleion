import { expect, test } from 'bun:test';

test('callback, failure reporter, and ArraySink observe adopted promises after prototype methods change', async () => {
  // Run in a child process: changing Promise.prototype can disturb Bun's test runner.
  // Import first so the library has captured the native method, then replace the live
  // methods before each of the three rejection observers attaches its reaction.
  const callbackURL = new URL('../safe-handle-callback.ts', import.meta.url)
    .href;
  const reporterURL = new URL('./failure-reporter.ts', import.meta.url).href;
  const sinkURL = new URL('../logger/sinks/array.ts', import.meta.url).href;
  const guardURL = new URL(
    '../lifecycle-manager/guarded-logger.ts',
    import.meta.url,
  ).href;
  const script = `
    const { runCallbackSafely } = await import(${JSON.stringify(callbackURL)});
    const { reportThroughHandler } = await import(${JSON.stringify(reporterURL)});
    const { ArraySink } = await import(${JSON.stringify(sinkURL)});
    const { createGuardedLoggerService } = await import(${JSON.stringify(guardURL)});
    const guardReports = [];
    globalThis.addEventListener('error', event => { event.preventDefault(); guardReports.push(String(event.error?.cause ?? event.error)); });
    const originalThen = Promise.prototype.then;
    const originalCatch = Promise.prototype.catch;
    const reports = [];
    const consoleErrors = [];
    const originalConsoleError = console.error;
    console.error = (...args) => consoleErrors.push(args.map(String).join(' '));
    Promise.prototype.then = function () { throw new Error('live then used'); };
    Promise.prototype.catch = function () { throw new Error('live catch used'); };
    const thrown = [];
    try {
      try {
        createGuardedLoggerService({ entity() { return Promise.reject(new Error('entity rejected')); } }).entity('child');
      } catch (error) { thrown.push('guard: ' + error.message); }
      try {
        runCallbackSafely('callback', () => Promise.reject('callback rejected'), [],
          (error) => reports.push(error));
      } catch (error) { thrown.push('callback: ' + error.message); }
      try {
        reportThroughHandler(() => Promise.reject('handler rejected'), () => 'original failure');
      } catch (error) { thrown.push('reporter: ' + error.message); }
      try {
        const sink = new ArraySink({
          transformer: () => { throw new Error('transformer failed'); },
          onFormatError: () => Promise.reject('sink handler rejected'),
        });
        sink.write({ timestamp: 0, type: 'info', template: 'test', message: 'test' });
      } catch (error) { thrown.push('sink: ' + error.message); }
    } finally {
      Promise.prototype.then = originalThen;
      Promise.prototype.catch = originalCatch;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    console.error = originalConsoleError;
    process.stdout.write(JSON.stringify({ thrown, reports, consoleErrors, guardReports }));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout) as {
    thrown: string[];
    reports: string[];
    consoleErrors: string[];
    guardReports: string[];
  };
  expect(
    result.guardReports.some((line) => line.includes('entity rejected')),
  ).toBe(true);
  expect(result.thrown).toEqual([]);
  expect(result.reports).toEqual(['callback rejected']);
  expect(result.consoleErrors).toHaveLength(2);
  expect(
    result.consoleErrors.some((line) => line.includes('handler rejected')),
  ).toBe(true);
  expect(
    result.consoleErrors.some((line) => line.includes('sink handler rejected')),
  ).toBe(true);
});
