/**
 * Tests for failure paths handed a value that is not a readable `Error`.
 *
 * `throw` accepts any value, so every component callback the manager invokes can hand it
 * one — including an `Error` whose `message` accessor throws, or a value with no
 * prototype chain for `instanceof` to walk. These paths run inside timer callbacks and
 * floating promise chains where there is no caller left to catch anything, so a second
 * failure raised while reporting the first is fatal rather than merely noisy.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';

/** An `Error` whose `message` accessor throws, as a subclass or a `Proxy` can produce. */
function unreadableError(): Error {
  const error = new Error('placeholder');

  Object.defineProperty(error, 'message', {
    get() {
      throw new Error('message getter blew up');
    },
  });

  return error;
}

describe('LifecycleManager - hostile thrown values', () => {
  let logger: Logger;
  let arraySink: ArraySink;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({ sinks: [arraySink], callProcessExit: false });
  });

  test('an unreadable error from reportUnexpectedStop still records and emits', async () => {
    const lifecycle = new LifecycleManager({ logger });

    let reportFn!: (err?: Error) => boolean;

    class SelfStoppingComponent extends BaseComponent {
      public start(): void {
        reportFn = (err?: Error) => this.reportUnexpectedStop(err);
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new SelfStoppingComponent(logger, { name: 'hostile-stop' }),
    );
    await lifecycle.startComponent('hostile-stop');

    const events: string[] = [];

    lifecycle.on('component:unexpected-stop', () => {
      events.push('unexpected-stop');
    });
    lifecycle.on('component:stopped', () => {
      events.push('stopped');
    });

    // The reads sit between the state mutations and the event emissions, so a throw
    // here would leave the manager claiming the component stopped while never saying so.
    expect(() => reportFn(unreadableError())).not.toThrow();

    expect(events).toEqual(['unexpected-stop', 'stopped']);
    expect(lifecycle.isComponentRunning('hostile-stop')).toBe(false);
    expect(lifecycle.getComponentStatus('hostile-stop')?.state).toBe('stopped');

    await lifecycle.stopAllComponents();
  });

  test('an unreadable error reported during start() still returns a result', async () => {
    // The existing coverage reports the stop *after* `startComponent` has resolved. During
    // `start()` the reads sit inside a `try` whose `catch` reads `message` again, so an
    // accessor that throws escaped both and rejected `startComponent` rather than
    // returning the `component_unexpected_stop` result it exists to return.
    const lifecycle = new LifecycleManager({ logger });

    class FailsDuringStart extends BaseComponent {
      public start(): void {
        this.reportUnexpectedStop(unreadableError());
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new FailsDuringStart(logger, { name: 'hostile-start' }),
    );

    const result = await lifecycle.startComponent('hostile-start');

    expect(result.success).toBe(false);
    expect(result.code).toBe('component_unexpected_stop');
    expect(typeof result.reason).toBe('string');

    await lifecycle.stopAllComponents();
  });

  test('a non-Error thrown value from reportUnexpectedStop is normalized', async () => {
    const lifecycle = new LifecycleManager({ logger });

    let reportFn!: (err?: Error) => boolean;

    class SelfStoppingComponent extends BaseComponent {
      public start(): void {
        reportFn = (err?: Error) => this.reportUnexpectedStop(err);
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new SelfStoppingComponent(logger, { name: 'non-error-stop' }),
    );
    await lifecycle.startComponent('non-error-stop');

    let reported: unknown;

    lifecycle.on('component:unexpected-stop', (data) => {
      reported = (data as { error?: unknown }).error;
    });

    // `reportUnexpectedStop` is typed `Error` but is never validated.
    expect(() => reportFn('just a string' as unknown as Error)).not.toThrow();

    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toContain('just a string');
    expect((reported as Error).cause).toBe('just a string');

    await lifecycle.stopAllComponents();
  });

  test('a non-Error self-report does not outrank a real startup failure', async () => {
    // Normalizing what `reportUnexpectedStop` stores must not change the
    // overlapping-failure rule: a self-report that did not carry a real `Error` is a
    // state signal, so the later thrown startup error keeps the more useful diagnostic.
    const lifecycle = new LifecycleManager({ logger });

    class SignalThenThrowComponent extends BaseComponent {
      public start(): void {
        this.reportUnexpectedStop('string signal' as unknown as Error);

        throw new Error('real startup failure');
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new SignalThenThrowComponent(logger, { name: 'signal-then-throw' }),
    );

    const result = await lifecycle.startComponent('signal-then-throw');

    expect(result.success).toBe(false);
    expect(result.reason).toContain('real startup failure');
    expect(result.code).not.toBe('component_unexpected_stop');
  });

  test('an unreadable error from onStartupAborted does not escape the timer', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class SlowComponent extends BaseComponent {
      public async start(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      public stop(): void {}
      public onStartupAborted(): void {
        throw unreadableError();
      }
    }

    await lifecycle.registerComponent(
      new SlowComponent(logger, { name: 'slow', startupTimeoutMS: 50 }),
    );

    // The abort callback runs from a timer, where an escaping throw has no caller to
    // catch it and the runtime treats it as uncaught.
    await lifecycle.startComponent('slow');

    expect(
      arraySink.logs.some((log) =>
        log.message.includes('Error in onStartupAborted callback'),
      ),
    ).toBe(true);

    await lifecycle.stopAllComponents();
  });
});
