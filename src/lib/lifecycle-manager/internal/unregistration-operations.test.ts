import { expect, test } from 'bun:test';
import { claimReports, Plain, setup } from '../test-helpers';
import { snapshotOperationResult } from './operation-policy';
import { markComponentUnregistered } from './unregistration-operations';

test('a lifecycle getter that throws does not keep an unregistered component registered', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  await manager.registerComponent(component);

  // Throws on its first read only - the unregister's - and stores what is assigned.
  let stored: unknown = (component as unknown as { lifecycle: unknown })
    .lifecycle;
  let hasThrown = false;
  Object.defineProperty(component, 'lifecycle', {
    configurable: true,
    get: () => {
      if (!hasThrown) {
        hasThrown = true;
        throw new Error('lifecycle getter');
      }
      return stored;
    },
    set: (value: unknown) => {
      stored = value;
    },
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.unregisterComponent('a');
    expect(result.success).toBe(true);
  } finally {
    release();
  }

  expect(reports).toHaveLength(1);
  expect(component._isRegisteredWithManager()).toBe(false);
  const again = await manager.registerComponent(component);
  expect(again.success).toBe(true);
  await logger.close();
});

test('a stop answer whose error is not an Error is snapshotted without it', () => {
  const error = new Error('stop failed');
  expect(
    snapshotOperationResult({ success: false, reason: 'r', error }).error,
  ).toBe(error);
  expect(
    snapshotOperationResult({ success: false, error: 'not an error' }).error,
  ).toBeUndefined();
  expect(
    snapshotOperationResult({ success: false, error: { message: 'x' } }).error,
  ).toBeUndefined();
});

test('a lifecycle read that throws is not taken for a re-registration when _markUnregistered throws too', () => {
  const { logger } = setup();
  const component = new Plain(logger, 'a');
  const fields = component as unknown as {
    _isRegistered: boolean;
    lifecycle: unknown;
  };
  fields._isRegistered = true;
  let stored: unknown = { handle: true };
  let reads = 0;
  Object.defineProperty(component, 'lifecycle', {
    configurable: true,
    get: () => {
      if (++reads === 1) {
        throw new Error('lifecycle getter');
      }
      return stored;
    },
    set: (value: unknown) => {
      stored = value;
    },
  });
  component._markUnregistered = (): void => {
    throw new Error('mark failed');
  };

  const { reports, release } = claimReports();
  try {
    markComponentUnregistered(component, 'test unregister');
  } finally {
    release();
  }

  expect(reports).toHaveLength(2);
  expect(fields._isRegistered).toBe(false);
  expect(stored).toBeUndefined();
});
