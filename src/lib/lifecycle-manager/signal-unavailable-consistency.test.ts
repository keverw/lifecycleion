import { describe, expect, test } from 'bun:test';
import { claimReports, Plain, setup } from './test-helpers';
import type { LifecycleManager } from './lifecycle-manager';

// A signal target that caller code makes unavailable during its own dispatch is
// reported one way, whichever caller code did it: its handler getter, its
// `signalTimeoutMS` getter, or a `*-started` listener. Each answers one `unavailable`
// row, a paired `*-started` then `*-failed`, and counts toward the aggregate.

class Reporter extends Plain {
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

const SIGNALS = ['reload', 'info', 'debug'] as const;
type Signal = (typeof SIGNALS)[number];

const HANDLER_KEY = {
  reload: 'onReload',
  info: 'onInfo',
  debug: 'onDebug',
} as const satisfies Record<Signal, string>;

const CAUSES = [
  // The handler getter stops its component and returns a handler.
  'handler-getter',
  // The handler getter stops its component and returns no handler.
  'handler-getter-no-handler',
  // The handler getter stops its component, then throws.
  'handler-getter-throws',
  // The timeout getter stops its component.
  'timeout-getter',
  // A started listener stops the component: the reference behavior.
  'started-listener',
] as const;
type Cause = (typeof CAUSES)[number];

function trigger(manager: LifecycleManager, signal: Signal) {
  return signal === 'reload'
    ? manager.triggerReload()
    : signal === 'info'
      ? manager.triggerInfo()
      : manager.triggerDebug();
}

function arm(component: Reporter, signal: Signal, cause: Cause): () => number {
  let calls = 0;
  const handler = (): void => {
    calls++;
  };

  if (cause === 'started-listener') {
    Object.assign(component, { [HANDLER_KEY[signal]]: handler });
  } else if (cause === 'timeout-getter') {
    Object.assign(component, { [HANDLER_KEY[signal]]: handler });
    Object.defineProperty(component, 'signalTimeoutMS', {
      get: () => {
        component.reportStop();
        return 50;
      },
    });
  } else {
    Object.defineProperty(component, HANDLER_KEY[signal], {
      get: () => {
        component.reportStop();
        if (cause === 'handler-getter-throws') {
          throw new Error('getter failed after stopping');
        }
        return cause === 'handler-getter' ? handler : undefined;
      },
    });
  }

  return () => calls;
}

describe('signal broadcast: target made unavailable during its dispatch', () => {
  for (const signal of SIGNALS) {
    for (const cause of CAUSES) {
      test(`${signal}: ${cause} reports unavailable with paired events`, async () => {
        const { logger, manager } = setup();
        const target = new Reporter(logger, 'target');
        const other = new Plain(logger, 'other');
        let otherCalls = 0;
        Object.assign(other, {
          [HANDLER_KEY[signal]]: () => {
            otherCalls++;
          },
        });
        const calls = arm(target, signal, cause);
        await manager.registerComponent(target);
        await manager.registerComponent(other);
        await manager.startAllComponents();

        const events: string[] = [];
        manager.on<{ name: string }>(
          `component:${signal}-started`,
          ({ name }) => {
            events.push(`${name}:started`);
            if (cause === 'started-listener' && name === 'target') {
              target.reportStop();
            }
          },
        );
        manager.on<{ name: string; error: Error }>(
          `component:${signal}-failed`,
          ({ name, error }) => {
            events.push(`${name}:failed:${error.message}`);
          },
        );
        manager.on<{ name: string }>(
          `component:${signal}-completed`,
          ({ name }) => {
            events.push(`${name}:completed`);
          },
        );

        const claimed = claimReports();
        try {
          const result = await trigger(manager, signal);
          const unavailableMessage = `Component "target" became unavailable before ${signal} dispatch`;

          expect(calls()).toBe(0);
          expect(otherCalls).toBe(1);
          expect(result.code).toBe('partial_error');
          expect(result.timedOut).toBe(false);
          expect(result.results).toHaveLength(2);
          expect(result.results[0]).toMatchObject({
            name: 'target',
            called: false,
            timedOut: false,
            code: 'unavailable',
          });
          expect(result.results[0]?.error?.message).toBe(unavailableMessage);
          expect(result.results[1]).toMatchObject({
            name: 'other',
            called: true,
            error: null,
            code: 'called',
          });
          expect(events).toEqual([
            'target:started',
            `target:failed:${unavailableMessage}`,
            'other:started',
            'other:completed',
          ]);
          // A getter that threw broke the component's contract and is still reported,
          // even though availability decides the row.
          expect(
            claimed.reports.some(
              (report) =>
                (report as Error).cause instanceof Error &&
                ((report as Error).cause as Error).message ===
                  'getter failed after stopping',
            ),
          ).toBe(cause === 'handler-getter-throws');
        } finally {
          claimed.release();
          await manager.stopAllComponents();
          await logger.close();
        }
      });
    }

    test(`${signal}: a lone target its getter stops answers error`, async () => {
      const { logger, manager } = setup();
      const target = new Reporter(logger, 'target');
      const calls = arm(target, signal, 'handler-getter');
      await manager.registerComponent(target);
      await manager.startComponent('target');
      const events: string[] = [];
      manager.on(`component:${signal}-started`, () => {
        events.push('started');
      });
      manager.on(`component:${signal}-failed`, () => {
        events.push('failed');
      });
      manager.on(`component:${signal}-completed`, () => {
        events.push('completed');
      });
      try {
        const result = await trigger(manager, signal);
        expect(calls()).toBe(0);
        expect(result.code).toBe('error');
        expect(result.results.map(({ code }) => code)).toEqual(['unavailable']);
        expect(events).toEqual(['started', 'failed']);
      } finally {
        await manager.stopAllComponents();
        await logger.close();
      }
    });
  }

  test('a target stopped before dispatch reaches it is still skipped with no row', async () => {
    const { logger, manager } = setup();
    const first = new Plain(logger, 'first');
    const second = new Reporter(logger, 'second');
    let secondCalls = 0;
    first.onReload = () => {
      second.reportStop();
    };
    second.onReload = () => {
      secondCalls++;
    };
    await manager.registerComponent(first);
    await manager.registerComponent(second);
    await manager.startAllComponents();
    const events: string[] = [];
    manager.on<{ name: string }>('component:reload-started', ({ name }) => {
      events.push(`${name}:started`);
    });
    manager.on<{ name: string }>('component:reload-failed', ({ name }) => {
      events.push(`${name}:failed`);
    });
    manager.on<{ name: string }>('component:reload-completed', ({ name }) => {
      events.push(`${name}:completed`);
    });
    try {
      const result = await manager.triggerReload();
      expect(secondCalls).toBe(0);
      expect(result.code).toBe('ok');
      expect(result.results.map(({ name }) => name)).toEqual(['first']);
      expect(events).toEqual(['first:started', 'first:completed']);
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });
});
