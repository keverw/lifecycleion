import { expect, test } from 'bun:test';
import {
  committedRegistrationReport,
  isManualPositionRespected,
  newRegistrationProgress,
  reportedComponentName,
} from './registration-policy';

test('uncommitted reports discard partial progress and distinguish relative targets', () => {
  const progress = newRegistrationProgress();
  progress.committed.startupOrder = ['not-committed'];
  progress.didAutoStartAttempt = true;
  const relative = committedRegistrationReport(progress, 'before', undefined);
  expect(relative.startupOrder).toEqual([]);
  expect(relative.autoStartAttempted).toBe(false);
  expect(relative.targetFound).toBe(false);
  expect(
    committedRegistrationReport(progress, 'end', undefined).targetFound,
  ).toBeUndefined();
  expect(relative).not.toHaveProperty('autoStartSucceeded');
});

test('committed reports distinguish deferred auto-starts from attempted failures and successes', () => {
  const progress = newRegistrationProgress();
  progress.hasCommitted = true;
  progress.wasDuringStartup = true;
  progress.isAutoStartDeferred = true;
  progress.committed = { startupOrder: ['example'], targetFound: true };
  const deferred = committedRegistrationReport(progress, 'after', undefined);
  expect(deferred).toMatchObject({
    startupOrder: ['example'],
    duringStartup: true,
    targetFound: true,
    autoStartAttempted: false,
    autoStartDeferred: true,
  });
  expect(deferred).not.toHaveProperty('autoStartSucceeded');
  progress.isAutoStartDeferred = false;
  progress.didAutoStartAttempt = true;
  expect(
    committedRegistrationReport(progress, 'after', undefined)
      .autoStartSucceeded,
  ).toBe(false);
  progress.startResult = { success: true, componentName: 'example' };
  expect(
    committedRegistrationReport(progress, 'after', undefined)
      .autoStartSucceeded,
  ).toBe(true);
});

test('reported names use the captured value without coercing hostile values', () => {
  const progress = newRegistrationProgress();
  expect(reportedComponentName(progress)).toBe('<unknown>');
  progress.nameRead = {
    value: {
      toString: () => {
        throw new Error('must not coerce');
      },
    },
  };
  expect(reportedComponentName(progress)).toBe('<getName() returned object>');
  progress.nameRead = { value: 'captured-name' };
  expect(reportedComponentName(progress)).toBe('captured-name');
});

test('manual positioning describes relative order rather than adjacency', () => {
  const input = {
    componentName: 'example',
    targetComponentName: 'target',
    startupOrder: ['example', 'middle', 'target'],
  };
  expect(isManualPositionRespected({ ...input, position: 'before' })).toBe(
    true,
  );
  expect(isManualPositionRespected({ ...input, position: 'after' })).toBe(
    false,
  );
  expect(isManualPositionRespected({ ...input, position: 'start' })).toBe(true);
  expect(
    isManualPositionRespected({
      ...input,
      position: 'before',
      targetComponentName: 'missing',
    }),
  ).toBe(false);
});
