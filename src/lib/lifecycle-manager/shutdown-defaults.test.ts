import { expect, test } from 'bun:test';
import { claimReports, Plain, setup, Stalls } from './test-helpers';

test.each([undefined, null])(
  'nullish constructor shutdown flags %s retain halt and retry defaults',
  async (value) => {
    const { logger, manager } = setup({
      shutdownOptions: {
        retryStalled: value as boolean | undefined,
        haltOnStall: value as boolean | undefined,
      },
    });
    const healthy = new Plain(logger, 'healthy');
    const stalled = new Stalls(logger, 'stalled');
    await manager.registerComponent(healthy);
    await manager.registerComponent(stalled);
    await manager.startAllComponents();
    const { release } = claimReports();
    try {
      // Reverse registration order encounters the stall first; the default halt
      // must leave the healthy component running for a later pass.
      expect((await manager.stopAllComponents()).success).toBe(false);
      expect(manager.isComponentRunning('healthy')).toBe(true);
      expect(stalled.forceCalls).toBe(1);

      stalled.onShutdownForce = (): void => {
        stalled.forceCalls++;
      };
      // The default retry must recover the prior stall as well as stopping the
      // component that the first pass deliberately left running.
      expect((await manager.stopAllComponents()).success).toBe(true);
      expect(stalled.forceCalls).toBe(2);
      expect(manager.getComponentStatus('stalled')?.state).toBe('stopped');
      expect(manager.getComponentStatus('healthy')?.state).toBe('stopped');
    } finally {
      release();
    }
  },
);
