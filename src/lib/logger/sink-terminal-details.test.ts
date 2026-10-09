import { expect, spyOn, test } from 'bun:test';
import { Logger } from './index';
import { FileSink } from './sinks/file';
import { ArraySink } from './sinks/array';
import type { LoggerDiagnostic } from './types';
import { TmpDir } from '../tmp-dir';
import { sleep } from '../sleep';
import { reportSinkFailure } from './internal/sink-failure-routing';

for (const doesDiagnosticFail of [false, true]) {
  test(`file failure retains detailed terminal report (diagnostic fails: ${doesDiagnosticFail})`, async () => {
    const directory = new TmpDir({ unsafeCleanup: true });
    await directory.initialize();
    const file = new FileSink({
      logDir: directory.path,
      basename: 'terminal',
      maxRetries: 0,
    });
    await file.flush();
    const diagnostics: LoggerDiagnostic[] = [];
    const logger = new Logger({
      callProcessExit: false,
      sinks: [file],
      diagnosticSinks: doesDiagnosticFail
        ? [
            {
              write() {},
              writeDiagnostic(diagnostic) {
                diagnostics.push(diagnostic);
                throw new Error('secondary destination failed');
              },
            },
          ]
        : undefined,
    });
    const write = spyOn(
      file as unknown as { writeEntry(): Promise<void> },
      'writeEntry',
    ).mockRejectedValue(new Error('ENOSPC: volume is full'));
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      logger.info('original');
      await file.flush();
      await sleep(0);
      expect(output).toHaveBeenCalledTimes(1);
      const text = String(output.mock.calls[0]?.[0]);
      expect(text).toContain('ENOSPC: volume is full');
      expect(text).toContain(directory.path);
      if (doesDiagnosticFail) {
        expect(text).toContain('secondary destination failed');
        expect(diagnostics).toHaveLength(1);
        // The routed message carries the I/O detail too: other sinks persist it.
        expect(diagnostics[0].message).toContain('ENOSPC: volume is full');
        expect(diagnostics[0].message).toContain(directory.path);
        expect(Object.hasOwn(diagnostics[0], 'terminalLine')).toBe(false);
      }
    } finally {
      write.mockRestore();
      await logger.close();
      output.mockRestore();
      await directory.cleanup();
    }
  });
}

test('file rotation flush losses still reach other sinks while the logger is open', async () => {
  const directory = new TmpDir({ unsafeCleanup: true });
  await directory.initialize();
  const file = new FileSink({ logDir: directory.path, basename: 'rotation' });
  await file.flush();
  const stored = new ArraySink();
  const logger = new Logger({ sinks: [file, stored], callProcessExit: false });
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    // Simulate the bounded stream flush reporting bytes abandoned by rotation.
    (
      file as unknown as {
        reportRotationFlushLoss(bytes: number, target: string): void;
      }
    ).reportRotationFlushLoss(42, directory.path);
    await sleep(0);
    expect(logger.closed).toBe(false);
    expect(stored.logs).toHaveLength(1);
    expect(stored.logs[0].tags).toContain('lifecycleion-diagnostic');
    expect(output).not.toHaveBeenCalled();
  } finally {
    await logger.close();
    output.mockRestore();
    await directory.cleanup();
  }
});

test('an unreadable terminal detail falls back to the safe summary', async () => {
  const sink = { write() {} };
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    reportSinkFailure(sink, {
      kind: 'sink',
      context: 'write',
      error: new Error('original'),
      message: 'Safe summary',
      terminalLine() {
        throw new Error('private render failure');
      },
    });
    await sleep(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]?.[0]).toBe('Safe summary');
  } finally {
    await logger.close();
    output.mockRestore();
  }
});

test('healthy destinations receive only the safe summary without rendering terminal details', async () => {
  const source = { write() {} };
  const stored = new ArraySink();
  const logger = new Logger({
    sinks: [source, stored],
    callProcessExit: false,
  });
  let renders = 0;
  try {
    reportSinkFailure(source, {
      kind: 'sink',
      error: new Error('private details'),
      message: 'Safe summary',
      terminalLine() {
        renders++;
        return 'private details';
      },
    });
    await sleep(0);
    expect(stored.logs).toHaveLength(1);
    expect(stored.logs[0].message).toBe('Safe summary');
    expect(renders).toBe(0);
  } finally {
    await logger.close();
  }
});
