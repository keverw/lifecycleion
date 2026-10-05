import { expect, test } from 'bun:test';
import { claimReports, Plain, setup } from './test-helpers';
import type { BroadcastOptions, StartComponentOptions } from './types';

test.each([new Set(['a']), 'a', {}])(
  'malformed broadcast recipient filter %s cannot widen delivery',
  async (componentNames) => {
    const { logger, manager } = setup();
    const calls: string[] = [];
    for (const name of ['a', 'b']) {
      const component = new Plain(logger, name);
      component.onMessage = <TData>() => {
        calls.push(name);
        return undefined as TData;
      };
      await manager.registerComponent(component);
    }
    await manager.startAllComponents();
    let started = 0;
    manager.on('component:broadcast-started', () => {
      started++;
    });
    const { reports, release } = claimReports();
    try {
      const result = await manager.broadcastMessage('x', {
        componentNames,
      } as unknown as BroadcastOptions);
      expect(result).toEqual([]);
      expect(calls).toEqual([]);
      expect(started).toBe(0);
      // A configuration refusal, not a crash: no global callback-error report.
      expect(reports).toHaveLength(0);
    } finally {
      release();
      await manager.stopAllComponents();
      await logger.close();
    }
  },
);

test('throwing autoStart option refuses registration before publication', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const { release } = claimReports();
  try {
    const result = await manager.registerComponent(component, {
      get autoStart(): boolean {
        throw new Error('bad option');
      },
    });
    expect(result.success).toBe(false);
    expect(result.registered).toBe(false);
    expect(manager.hasComponent('a')).toBe(false);
    expect((await manager.registerComponent(component)).success).toBe(true);
  } finally {
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});

for (const field of [
  'allowDuringBulkStartup',
  'forceStalled',
  'allowNonRunningDependencies',
] as const) {
  test(`restart reads ${field} before stopping`, async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    let stops = 0;
    component.stop = () => {
      stops++;
      return Promise.resolve();
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const options: StartComponentOptions = {};
    Object.defineProperty(options, field, {
      get() {
        throw new Error('bad start option');
      },
    });
    const { release } = claimReports();
    try {
      expect(
        (await manager.restartComponent('a', { startOptions: options }))
          .success,
      ).toBe(false);
      expect(stops).toBe(0);
      expect(manager.getComponentStatus('a')?.state).toBe('running');
    } finally {
      release();
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test('null broadcast recipient filter uses the default without reporting failure', async () => {
  const { logger, manager } = setup();
  const calls: string[] = [];
  for (const name of ['a', 'b']) {
    const component = new Plain(logger, name);
    component.onMessage = <TData>() => {
      calls.push(name);
      return undefined as TData;
    };
    await manager.registerComponent(component);
  }
  await manager.startAllComponents();
  const { reports, release } = claimReports();
  try {
    const results = await manager.broadcastMessage('x', {
      componentNames: null,
    });
    expect(calls).toEqual(['a', 'b']);
    expect(results.every((result) => result.sent)).toBe(true);
    expect(reports).toHaveLength(0);
  } finally {
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});
