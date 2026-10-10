import { expect, test } from 'bun:test';
import type { Logger } from '../logger';
import { sleep } from '../sleep';
import { BaseComponent } from './base-component';
import {
  ComponentStartObservationError,
  StartupInterruptedByShutdownError,
} from './errors';
import type { ComponentOptions } from './types';
import { claimReports, deferred, setup } from './test-helpers';

// A start that stays pending until the test releases it, counting starts and stops.
class LateStart extends BaseComponent {
  public readonly gate = deferred();
  public readonly signals: AbortSignal[] = [];
  public starts = 0;
  public stops = 0;

  constructor(logger: Logger, options: Partial<ComponentOptions> = {}) {
    super(logger, { name: 'late', startupTimeoutMS: 20, ...options });
  }

  public start(signal: AbortSignal): Promise<void> {
    this.starts++;
    this.signals.push(signal);
    return this.gate.promise;
  }

  public stop(): void {
    this.stops++;
  }
}

test('ownsLateStartCleanup defaults to false and is readable', () => {
  const { logger } = setup();

  expect(new LateStart(logger).ownsLateStartCleanup).toBe(false);
  expect(
    new LateStart(logger, { ownsLateStartCleanup: true }).ownsLateStartCleanup,
  ).toBe(true);
  expect(
    new LateStart(logger, { ownsLateStartCleanup: null }).ownsLateStartCleanup,
  ).toBe(false);
});

test.each([['yes'], [1], [{}]])(
  'the constructor refuses a non-boolean ownsLateStartCleanup (%p)',
  (value) => {
    const { logger } = setup();

    expect(
      () =>
        new LateStart(logger, {
          ownsLateStartCleanup: value as unknown as boolean,
        }),
    ).toThrow(new TypeError('ownsLateStartCleanup must be a boolean'));
  },
);

test('without it, a timed-out start that completes late is stopped by the manager', async () => {
  const { logger, manager } = setup();
  const component = new LateStart(logger);
  await manager.registerComponent(component);

  expect((await manager.startComponent('late')).code).toBe(
    'component_startup_timeout',
  );
  expect(component.signals[0].aborted).toBe(true);
  component.gate.resolve();
  await sleep(10);

  expect(component.stops).toBe(1);
  expect(manager.isComponentRunning('late')).toBe(false);
  expect(manager.getComponentStatus('late')?.state).toBe('starting-timed-out');
});

test('with it, a timed-out start that completes late is left to the component', async () => {
  const { logger, manager } = setup();
  const component = new LateStart(logger, { ownsLateStartCleanup: true });
  await manager.registerComponent(component);

  expect((await manager.startComponent('late')).code).toBe(
    'component_startup_timeout',
  );
  expect(component.signals[0].aborted).toBe(true);
  component.gate.resolve();
  await sleep(10);

  expect(component.stops).toBe(0);
  expect(manager.isComponentRunning('late')).toBe(false);
  expect(manager.getComponentStatus('late')?.state).toBe('starting-timed-out');
});

test('a bulk startup deadline leaves its late start to the component too', async () => {
  const { logger, manager } = setup();
  const component = new LateStart(logger, {
    ownsLateStartCleanup: true,
    startupTimeoutMS: 0,
  });
  await manager.registerComponent(component);

  expect((await manager.startAllComponents({ timeoutMS: 20 })).code).toBe(
    'startup_timeout',
  );
  expect(component.signals[0].aborted).toBe(true);
  component.gate.resolve();
  await sleep(10);

  expect(component.stops).toBe(0);
  expect(manager.isComponentRunning('late')).toBe(false);
  expect(manager.getComponentStatus('late')?.state).toBe('starting-timed-out');
});

test.each([false, true])(
  'a start a shutdown cue aborted that comes up anyway is stopped by the manager only when it does not own its cleanup (%p)',
  async (doesOwnCleanup) => {
    const { logger, manager } = setup();
    const component = new LateStart(logger, {
      ownsLateStartCleanup: doesOwnCleanup,
      startupTimeoutMS: 0,
    });
    await manager.registerComponent(component);

    const starting = manager.startComponent('late');
    await sleep(0);
    const shutdown = manager.stopAllComponents({ abortPendingStarts: true });
    expect(component.signals[0].reason).toBeInstanceOf(
      StartupInterruptedByShutdownError,
    );
    component.gate.resolve();

    expect((await starting).code).toBe('shutdown_in_progress');
    expect((await shutdown).success).toBe(true);
    expect(component.stops).toBe(doesOwnCleanup ? 0 : 1);
    expect(manager.isComponentRunning('late')).toBe(false);
    expect(manager.getComponentStatus('late')?.state).toBe(
      doesOwnCleanup ? 'registered' : 'stopped',
    );
  },
);

test('a start whose promise cannot be observed is left to the component too', async () => {
  const { logger, manager } = setup();
  class Unobservable extends LateStart {
    public override start(signal: AbortSignal): Promise<void> {
      const promise = super.start(signal);
      // Adoption reads `constructor` once; the second read, observing it, throws.
      let reads = 0;
      void Object.defineProperty(promise, 'constructor', {
        get(): PromiseConstructor {
          if (++reads === 2) {
            throw new Error('unobservable');
          }
          return Promise;
        },
      });
      return promise;
    }
  }
  const component = new Unobservable(logger, { ownsLateStartCleanup: true });
  await manager.registerComponent(component);

  expect((await manager.startComponent('late')).success).toBe(false);
  expect(component.signals[0].aborted).toBe(true);
  expect(component.signals[0].reason).toBeInstanceOf(
    ComponentStartObservationError,
  );
  component.gate.resolve();
  await sleep(10);

  expect(component.stops).toBe(0);
  expect(manager.isComponentRunning('late')).toBe(false);
});

test('a component that cleans up its own late start through its signal', async () => {
  const { logger, manager } = setup();
  let tornDown = 0;
  class OwnsCleanup extends LateStart {
    public override async start(signal: AbortSignal): Promise<void> {
      await super.start(signal);
      if (signal.aborted) {
        tornDown++;
      }
    }
  }
  const component = new OwnsCleanup(logger, { ownsLateStartCleanup: true });
  await manager.registerComponent(component);

  expect((await manager.startComponent('late')).code).toBe(
    'component_startup_timeout',
  );
  component.gate.resolve();
  await sleep(10);

  expect(tornDown).toBe(1);
  expect(component.stops).toBe(0);
});

test('a non-boolean value is refused before start() runs', async () => {
  const { logger, manager } = setup();
  const component = new LateStart(logger);
  await manager.registerComponent(component);
  Object.defineProperty(component, 'ownsLateStartCleanup', { value: 'yes' });

  const result = await manager.startComponent('late');

  expect(result.success).toBe(false);
  expect(result.code).toBe('invalid_options');
  expect(result.reason).toContain(
    'late.ownsLateStartCleanup must be a boolean',
  );
  expect(component.starts).toBe(0);
  expect(manager.getComponentStatus('late')?.state).toBe('registered');
});

test('a throwing ownsLateStartCleanup getter fails the start before it is claimed', async () => {
  const { logger, manager } = setup();
  const component = new LateStart(logger);
  await manager.registerComponent(component);
  Object.defineProperty(component, 'ownsLateStartCleanup', {
    get: (): never => {
      throw new Error('getter exploded');
    },
  });

  const { release } = claimReports();
  let result;
  try {
    result = await manager.startComponent('late');
  } finally {
    release();
  }

  // Read before the start, so it fails there - not later, inside the timer.
  expect(result.code).toBe('operation_crashed');
  expect(component.starts).toBe(0);
  expect(manager.getComponentStatus('late')?.state).toBe('registered');
});

test('the option is read once per start, before the start, not in the timer', async () => {
  const { logger, manager } = setup();
  const component = new LateStart(logger);
  await manager.registerComponent(component);
  let reads = 0;
  Object.defineProperty(component, 'ownsLateStartCleanup', {
    get: () => {
      reads++;
      return reads === 1;
    },
  });

  expect((await manager.startComponent('late')).code).toBe(
    'component_startup_timeout',
  );
  component.gate.resolve();
  await sleep(10);

  // The `true` read before the start decided it: no manager cleanup.
  expect(reads).toBe(1);
  expect(component.stops).toBe(0);
});

class Restartable extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public start(): void {
    this.starts++;
  }
  public stop(): void | Promise<void> {
    this.stops++;
  }
}

test('restartComponent() refuses a non-boolean value before stopping the component', async () => {
  const { logger, manager } = setup();
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  Object.defineProperty(component, 'ownsLateStartCleanup', { value: 1 });

  const result = await manager.restartComponent('target');

  expect(result.success).toBe(false);
  expect(result.code).toBe('invalid_options');
  expect(component.stops).toBe(0);
  expect(manager.getComponentStatus('target')?.state).toBe('running');
  Object.defineProperty(component, 'ownsLateStartCleanup', { value: false });
  await manager.stopAllComponents();
});

test('restartAllComponents() refuses a non-boolean value before stopping anything', async () => {
  const { logger, manager } = setup();
  const first = new Restartable(logger, { name: 'first' });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(first);
  await manager.registerComponent(component);
  await manager.startAllComponents();
  Object.defineProperty(component, 'ownsLateStartCleanup', { value: 'no' });

  const result = await manager.restartAllComponents();

  expect(result.success).toBe(false);
  expect(result.shutdownResult.code).toBe('invalid_options');
  expect(result.startupResult.code).toBe('invalid_options');
  expect(first.stops).toBe(0);
  expect(component.stops).toBe(0);
  expect(manager.getRunningComponentNames().sort()).toEqual([
    'first',
    'target',
  ]);
  Object.defineProperty(component, 'ownsLateStartCleanup', { value: false });
  await manager.stopAllComponents();
});

test('restart starts with the value captured before its asynchronous stop', async () => {
  const { logger, manager } = setup();
  const stopGate = deferred();
  class DelayedStop extends Restartable {
    public override stop(): Promise<void> {
      this.stops++;
      return stopGate.promise;
    }
  }
  const component = new DelayedStop(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  const pending = manager.restartComponent('target');
  await sleep(1);
  Object.defineProperty(component, 'ownsLateStartCleanup', { value: 'late' });
  stopGate.resolve();

  const result = await pending;
  expect(result.success).toBe(true);
  expect(component.starts).toBe(2);
  Object.defineProperty(component, 'ownsLateStartCleanup', { value: false });
  await manager.stopAllComponents();
});
