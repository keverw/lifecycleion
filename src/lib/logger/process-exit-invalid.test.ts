import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from './index';

test('a fractional real exit code falls back to one and still exits after close', async () => {
  const loggerURL = new URL('./index.ts', import.meta.url).href;
  const script = `
    const { Logger } = await import(${JSON.stringify(loggerURL)});
    const logger = new Logger({
      sinks: [], callProcessExit: true,
      beforeExitCallback(code) {
        process.stdout.write('before:' + code + '\\n');
        return { action: 'proceed' };
      },
    });
    logger.on('logger', ({ eventType, code }) => {
      if (eventType === 'exit-called' || eventType === 'exit-process') {
        process.stdout.write(eventType + ':' + code + '\\n');
      }
    });
    logger.exit(1.5);
    setTimeout(() => process.stdout.write('survived'), 100);
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

  expect(exitCode).toBe(1);
  expect(stdout.trim().split('\n')).toEqual([
    'exit-called:1',
    'before:1',
    'exit-process:1',
  ]);
  expect(stderr).toContain('exit code 1.5 is invalid');
});

test('a throwing process.exit gets one bounded fallback without an unhandled rejection', async () => {
  const loggerURL = new URL('./index.ts', import.meta.url).href;
  const script = `
    const { Logger } = await import(${JSON.stringify(loggerURL)});
    const actualExit = process.exit;
    const calls = [];
    const unhandled = [];
    process.on('unhandledRejection', (error) => unhandled.push(String(error)));
    process.exit = (code) => {
      calls.push(code);
      if (calls.length === 1) throw new Error('exit hook threw');
    };
    const logger = new Logger({ sinks: [], callProcessExit: true });
    logger.exit(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.exit = actualExit;
    process.stdout.write(JSON.stringify({ calls, unhandled, didExit: logger.didExit }));
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

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    calls: [2, 1],
    unhandled: [],
    didExit: true,
  });
  expect(stderr).toContain('exit hook threw');
});

test('a real Node exit listener that throws cannot strand the closed logger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'logger-exit-listener-'));
  try {
    const bundle = await Bun.build({
      entrypoints: [new URL('./index.ts', import.meta.url).pathname],
      target: 'node',
      format: 'esm',
      splitting: false,
    });
    expect(bundle.success).toBe(true);
    await writeFile(
      join(directory, 'logger.mjs'),
      await bundle.outputs[0].text(),
    );
    await writeFile(
      join(directory, 'fixture.mjs'),
      `
        import { Logger } from './logger.mjs';
        process.on('exit', () => { throw new Error('exit listener blew up'); });
        const logger = new Logger({ sinks: [], callProcessExit: true });
        logger.exit(1);
        setInterval(() => process.stdout.write('still alive'), 100);
      `,
    );
    const child = Bun.spawn(['node', join(directory, 'fixture.mjs')], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill(), 1000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('exit listener blew up');
      expect(stderr).toContain('Logger process exit failed');
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulated exits retain a fractional code for inspection', () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  logger.exit(1.5);
  expect(logger.exitCode).toBe(1.5);
});
