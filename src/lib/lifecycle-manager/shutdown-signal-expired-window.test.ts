import { expect, test } from 'bun:test';
import type { ForceShutdownContext } from './types';
import { deferred, Plain, sendSignal, setup } from './test-helpers';

function expireArmedWindow(manager: unknown): void {
  (
    manager as {
      state: { repeatedShutdownRequestState: { remainsArmedUntil: number } };
    }
  ).state.repeatedShutdownRequestState.remainsArmedUntil = Date.now() - 1;
}

// A signal landing on a running pass whose armed window has already lapsed finds a stale
// cycle. Expiring it clears the cycle, and that press is then the first of a new one: it
// seeds the cycle, as the first signal on a pass without a cycle does, rather than being
// dropped - neither counted nor seeding - so the operator needs one more press to force.
test('a signal that expires a lapsed window during a pass seeds the next cycle', async () => {
  const forced: ForceShutdownContext[] = [];
  const { logger, manager } = setup({
    repeatedShutdownRequestPolicy: {
      forceAfterCount: 2,
      withinMS: 10_000,
      onForceShutdown: (context) => {
        forced.push(context);
      },
    },
  });
  const component = new Plain(logger, 'a');
  const stop = deferred();
  component.stop = (): Promise<void> => stop.promise;
  await manager.registerComponent(component);
  await manager.startAllComponents();

  const shutdown = manager.stopAllComponents();
  try {
    expireArmedWindow(manager);

    sendSignal(manager, 'SIGINT');
    const seeded = manager.getShutdownEscalationStatus();
    expect(seeded.firstMethod).toBe('SIGINT');
    expect(seeded.requestCount).toBe(0);

    sendSignal(manager, 'SIGTERM');
    expect(manager.getShutdownEscalationStatus().requestCount).toBe(1);
    expect(forced).toEqual([]);

    sendSignal(manager, 'SIGTERM');
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({
      requestCount: 2,
      firstMethod: 'SIGINT',
      latestMethod: 'SIGTERM',
      isShuttingDown: true,
    });
  } finally {
    stop.resolve();
    await shutdown;
  }
});

// The same press when the window lapses only while the `signal:shutdown` listeners run,
// after the signal found it still open: it is expired when the press is counted, and the
// press seeds the next cycle there instead.
test('a window lapsing during the signal listeners still leaves the press seeding', async () => {
  const { logger, manager } = setup({
    repeatedShutdownRequestPolicy: {
      forceAfterCount: 2,
      withinMS: 10_000,
      onForceShutdown: () => {},
    },
  });
  const component = new Plain(logger, 'a');
  const stop = deferred();
  component.stop = (): Promise<void> => stop.promise;
  await manager.registerComponent(component);
  await manager.startAllComponents();

  const shutdown = manager.stopAllComponents();
  try {
    const state = (
      manager as unknown as {
        state: {
          repeatedShutdownRequestState: {
            firstRequestAt: number | null;
            remainsArmedUntil: number | null;
          };
        };
      }
    ).state.repeatedShutdownRequestState;
    expect(state.firstRequestAt).not.toBeNull();
    state.remainsArmedUntil = Date.now() + 60_000;
    manager.once('signal:shutdown', () => {
      expireArmedWindow(manager);
    });

    sendSignal(manager, 'SIGINT');
    const seeded = manager.getShutdownEscalationStatus();
    expect(seeded.firstMethod).toBe('SIGINT');
    expect(seeded.requestCount).toBe(0);
    expect(seeded.isArmed).toBe(false);
  } finally {
    stop.resolve();
    await shutdown;
  }
});
