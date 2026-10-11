import { expect, test } from 'bun:test';
import type { ComponentStatus } from './types';
import { claimReports, Plain, setup } from './test-helpers';

test('getAllComponentStatuses() reads each entry through getComponentStatus()', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'api'));
  await manager.registerComponent(new Plain(logger, 'hidden'));
  await manager.registerComponent(new Plain(logger, 'broken'));
  const status = manager.getComponentStatus.bind(manager);
  const failure = new Error('status override failed');
  manager.getComponentStatus = (name): ComponentStatus | undefined => {
    if (name === 'hidden') {
      return undefined;
    }
    if (name === 'broken') {
      throw failure;
    }
    const current = status(name);
    return current && { ...current, lastError: new Error('decorated') };
  };
  const { reports, release } = claimReports();
  try {
    const statuses = manager.getAllComponentStatuses();
    expect(statuses.map((entry) => entry.name)).toEqual(['api']);
    expect(statuses[0]?.lastError?.message).toBe('decorated');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(failure);
  } finally {
    manager.getComponentStatus = status;
    release();
    await logger.close();
  }
});
