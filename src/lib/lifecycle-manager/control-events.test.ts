import { describe, expect, test } from 'bun:test';
import type { LifecycleManager } from './lifecycle-manager';
import {
  claimReports,
  deferred,
  Plain,
  sendSignal,
  setup,
  Stalls,
} from './test-helpers';
import { sleep } from '../sleep';
import type {
  LifecycleManagerEventMap,
  LifecycleManagerEventName,
} from './events';
import type { ShutdownResult } from './types';

// Keep the manager's real event dispatch, replacing only the OS-facing transport.
function stubSignals(manager: LifecycleManager): void {
  let isAttached = false;
  (
    manager as unknown as { processSignalManager: unknown }
  ).processSignalManager = {
    attach: (): void => {
      isAttached = true;
    },
    detach: (): void => {
      isAttached = false;
    },
    getStatus: () => ({ isAttached }),
  };
}

class Reporter extends Plain {
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

describe('LifecycleManager synchronous control checkpoints', () => {
  test('a forced listener can exit immediately while the stop hook remains blocked', async () => {
    const { logger, manager } = setup({
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 1000,
        onForceShutdown: () => {},
      },
    });
    manager.enableLoggerExitHook();
    const gate = deferred();
    const stopping = deferred();
    const component = new Plain(logger, 'a');
    component.stop = (): Promise<void> => {
      stopping.resolve();
      return gate.promise;
    };
    await manager.registerComponent(component);
    await manager.startAllComponents();
    const shutdown = manager.stopAllComponents();
    await stopping.promise;
    manager.once('lifecycle-manager:shutdown-escalation-forced', () => {
      logger.exit(1);
    });
    try {
      manager.once('signal:info', () => {
        sendSignal(manager, 'SIGINT');
      });
      await manager.triggerInfo();
      // Logger has asynchronous exit bookkeeping, but the component never resolves
      // until the finally below. A deferred exit cannot pass this assertion.
      await sleep(10);
      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(1);
    } finally {
      gate.resolve();
      await shutdown;
    }
  });

  for (const isNested of [false, true]) {
    test(`signal notification precedes a real process exit (nested=${isNested})`, () => {
      // Exit only the child. Observing the callback's order in-process would miss
      // whether a buffered notification survives the documented process.exit usage.
      const helpers = new URL('./test-helpers.ts', import.meta.url).href;
      const script = `
        import { setup, Plain, deferred, sendSignal } from ${JSON.stringify(helpers)};
        const { logger, manager } = setup({ repeatedShutdownRequestPolicy: {
          forceAfterCount: 1, withinMS: 1000,
          onForceShutdown: () => { console.log('force'); process.exit(17); },
        } });
        const component = new Plain(logger, 'a');
        const stopping = deferred();
        component.stop = () => { stopping.resolve(); return new Promise(() => {}); };
        await manager.registerComponent(component);
        await manager.startAllComponents();
        void manager.stopAllComponents();
        await stopping.promise;
        manager.on('signal:shutdown', () => console.log('signal'));
        if (${isNested}) {
          manager.on('signal:info', () => { console.log('first'); sendSignal(manager, 'SIGINT'); });
          manager.on('signal:info', () => console.log('second'));
          await manager.triggerInfo();
        } else sendSignal(manager, 'SIGINT');
      `;
      const child = Bun.spawnSync([process.execPath, '-e', script], {
        timeout: 5000,
      });
      expect(child.exitCode).toBe(17);
      expect(child.stdout.toString().trim().split('\n')).toEqual(
        isNested ? ['first', 'signal', 'force'] : ['signal', 'force'],
      );
    });
  }

  for (const isBulk of [false, true]) {
    test(`nested startup lets an attach listener refuse it before start runs (bulk=${isBulk})`, async () => {
      const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
      stubSignals(manager);
      const component = new Plain(logger, 'a');
      let startCalls = 0;
      component.start = (): Promise<void> => {
        startCalls++;
        return Promise.resolve();
      };
      let startup:
        | ReturnType<typeof manager.startComponent>
        | ReturnType<typeof manager.startAllComponents>
        | undefined;
      let shutdown: Promise<ShutdownResult> | undefined;
      manager.once('lifecycle-manager:signals-attached', () => {
        shutdown = manager.stopAllComponents();
      });
      manager.once('component:registered', () => {
        startup = isBulk
          ? manager.startAllComponents()
          : manager.startComponent('a');
      });
      try {
        await manager.registerComponent(component);
        const result = await startup;
        expect(result?.code).toBe('shutdown_in_progress');
        expect(startCalls).toBe(0);
      } finally {
        await shutdown;
        manager.detachSignals();
      }
    });
  }

  test('nested bulk attachment still defers an auto-start to the not-yet-ordered startup', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    stubSignals(manager);
    const component = new Plain(logger, 'a');
    const extra = new Plain(logger, 'b', ['a']);
    let extraStarts = 0;
    extra.start = (): Promise<void> => {
      extraStarts++;
      return Promise.resolve();
    };
    let registration: ReturnType<typeof manager.registerComponent> | undefined;
    let startup: ReturnType<typeof manager.startAllComponents> | undefined;
    manager.once('lifecycle-manager:signals-attached', () => {
      registration = manager.registerComponent(extra, { autoStart: true });
    });
    manager.once('component:registered', () => {
      startup = manager.startAllComponents();
    });
    try {
      await manager.registerComponent(component);
      expect((await registration)?.autoStartDeferred).toBe(true);
      expect((await startup)?.success).toBe(true);
      expect(extraStarts).toBe(1);
    } finally {
      await manager.stopAllComponents();
      manager.detachSignals();
    }
  });

  for (const isSignal of [false, true]) {
    test(`expiry logger re-entry preserves the nested pass (signal=${isSignal})`, async () => {
      const { logger, manager } = setup({
        repeatedShutdownRequestPolicy: {
          forceAfterCount: 3,
          withinMS: 1000,
          armedAfterFailureMS: 60_000,
          onForceShutdown: () => {},
        },
      });
      await manager.registerComponent(new Stalls(logger, 'a'));
      await manager.startAllComponents();
      await manager.stopAllComponents();
      (
        manager as unknown as {
          repeatedShutdownRequestState: { remainsArmedUntil: number };
        }
      ).repeatedShutdownRequestState.remainsArmedUntil = Date.now() - 1;
      let nested: Promise<ShutdownResult> | undefined;
      logger.addSink({
        write: (entry): void => {
          if (
            entry.template ===
            'Repeated shutdown escalation window expired, clearing previous shutdown state'
          ) {
            nested = manager.stopAllComponents();
          }
        },
      });
      const signals: LifecycleManagerEventMap['signal:shutdown'][] = [];
      manager.on(
        'signal:shutdown',
        (event: LifecycleManagerEventMap['signal:shutdown']) => {
          signals.push(event);
        },
      );
      let outer: Promise<ShutdownResult> | undefined;
      if (isSignal) {
        sendSignal(manager, 'SIGTERM');
      } else {
        outer = manager.stopAllComponents();
      }
      // Unlike queued expiry listeners, a sink interrupts the acceptance itself.
      // These assertions cover the !isShuttingDown reset guard and the signal's
      // else-if-isShuttingDown branch; removing either guard breaks its variant.
      expect(nested).toBeDefined();
      expect(manager.getShutdownEscalationStatus().firstMethod).toBe('manual');
      if (isSignal) {
        expect(signals).toEqual([
          { method: 'SIGTERM', isAlreadyShuttingDown: true },
        ]);
      } else {
        expect((await outer)?.code).toBe('already_in_progress');
      }
      await nested;
    });
  }

  test('a throwing control listener preserves the surrounding notification drain', async () => {
    const { logger, manager } = setup();
    stubSignals(manager);
    const order: string[] = [];
    let nested: ReturnType<typeof manager.registerComponent> | undefined;
    manager.on(
      'component:registered',
      (event: LifecycleManagerEventMap['component:registered']) => {
        order.push(`first:${event.name}`);
        if (event.name === 'a') {
          manager.attachSignals();
        }
      },
    );
    manager.on(
      'component:registered',
      (event: LifecycleManagerEventMap['component:registered']) => {
        order.push(`second:${event.name}`);
      },
    );
    manager.on('lifecycle-manager:signals-attached', () => {
      order.push('control:first');
      nested = manager.registerComponent(new Plain(logger, 'b'));
      throw new Error('control listener failed');
    });
    manager.on('lifecycle-manager:signals-attached', () => {
      order.push('control:second');
    });
    const { reports, release } = claimReports();
    try {
      await manager.registerComponent(new Plain(logger, 'a'));
      await nested;
      expect(order).toEqual([
        'first:a',
        'control:first',
        'control:second',
        'second:a',
        'first:b',
        'second:b',
      ]);
      expect(reports).toHaveLength(1);
    } finally {
      release();
      manager.detachSignals();
    }
  });

  test('an unexpected delivery failure cannot discard later notifications', async () => {
    const { logger, manager } = setup();
    const component = new Reporter(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const internals = manager as unknown as {
      deliverEvent: (event: LifecycleManagerEventName, data: unknown) => void;
    };
    const original = internals.deliverEvent.bind(manager);
    internals.deliverEvent = (event, data): void => {
      if (event === 'component:unexpected-stop') {
        throw new Error('delivery infrastructure failed');
      }
      original(event, data);
    };
    const events: string[] = [];
    manager.on('component:stopped', () => {
      events.push('stopped');
    });
    manager.on('component:registered', () => {
      events.push('registered');
    });
    const { reports, release } = claimReports();
    try {
      expect(() => component.reportStop()).not.toThrow();
      await manager.registerComponent(new Plain(logger, 'b'));
      expect(events).toEqual(['stopped', 'registered']);
      expect(reports).toHaveLength(1);
    } finally {
      internals.deliverEvent = original;
      release();
    }
  });

  test('an idle notification avoids the queue but re-entrant notifications still wait', async () => {
    const { manager } = setup();
    const pending = (manager as unknown as { pendingEvents: Array<() => void> })
      .pendingEvents;
    const push = pending.push.bind(pending);
    let queueWrites = 0;
    pending.push = (...entries): number => {
      queueWrites += entries.length;
      return push(...entries);
    };
    const order: string[] = [];
    let nested: ReturnType<typeof manager.triggerInfo> | undefined;
    manager.on('signal:info', () => {
      order.push('info:first');
      nested = manager.triggerDebug();
    });
    manager.on('signal:info', () => {
      order.push('info:second');
    });
    manager.on('signal:debug', () => {
      order.push('debug');
    });
    try {
      await manager.triggerInfo();
      await nested;
      expect(order).toEqual(['info:first', 'info:second', 'debug']);
      // Only debug needed queue storage. The idle info event is delivered directly.
      expect(queueWrites).toBe(1);
    } finally {
      pending.push = push;
    }
  });
});
