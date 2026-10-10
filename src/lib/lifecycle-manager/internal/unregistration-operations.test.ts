import { expect, test } from 'bun:test';
import { claimReports, Plain, setup } from '../test-helpers';

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
