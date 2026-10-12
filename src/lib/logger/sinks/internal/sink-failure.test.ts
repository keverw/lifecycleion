import { expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../../index';
import { ArraySink } from '../array';
import { FileSink } from '../file';
import type { LogSink } from '../../types';
import { registerSinkFailureReporter } from '../../internal/sink-failure-routing';
import type { SinkFailureReport } from '../../internal/sink-failure-routing';
import { reportSinkError } from './sink-failure';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../../../internal/console-test-utils';

const sink: LogSink = { write: (): void => {} };

function routedMessage(
  failure: Parameters<typeof reportSinkError>[1],
): SinkFailureReport {
  const reports: SinkFailureReport[] = [];
  const release = registerSinkFailureReporter(sink, (report) => {
    reports.push(report);
  });
  try {
    reportSinkError(sink, failure, undefined, () => 'terminal', {
      label: 'FileSink',
    });
  } finally {
    release();
  }
  expect(reports).toHaveLength(1);
  return reports[0];
}

test('a routed I/O failure carries its target, disposition, attempt and error text', () => {
  const report = routedMessage({
    kind: 'write',
    error: new Error('EACCES: permission denied, open /var/log/app.log'),
    target: '/var/log/app.log',
    attempt: 2,
    disposition: 'retrying',
  });

  expect(report.message).toBe(
    'FileSink write failed for /var/log/app.log (retrying, attempt 2): EACCES: permission denied, open /var/log/app.log',
  );
});

test('a routed format failure omits the error text, which may come from entry content', () => {
  const report = routedMessage({
    kind: 'format',
    error: new Error('cannot format hunter2'),
    target: '/var/log/app.log',
    disposition: 'lost',
  });

  expect(report.message).toBe(
    'FileSink format failed for /var/log/app.log (lost)',
  );
  expect(report.error.message).toBe('cannot format hunter2');
});

test('an owned FileSink setup failure reaches the other sinks with its path and errno', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sink-failure-'));
  const blocked = join(dir, 'not-a-directory');
  await fs.writeFile(blocked, 'in the way');
  const captured = muteConsoleError();
  const array = new ArraySink();
  const file = new FileSink({
    logDir: join(blocked, 'logs'),
    basename: 'routed',
    jsonFormat: false,
  });
  const logger = new Logger({ sinks: [array, file] });

  try {
    for (let i = 0; i < 100 && array.logs.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(array.logs).toHaveLength(1);
    expect(array.logs[0].message).toContain('FileSink setup failed for');
    expect(array.logs[0].message).toContain(join(blocked, 'logs'));
    expect(array.logs[0].message).toContain('ENOTDIR');
    expect(captured).toHaveLength(0);
  } finally {
    await logger.close();
    restoreConsoleError();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
