import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';

const logger = new Logger({ sinks: [], callProcessExit: false });

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

test('bulk restart refuses invalid component startup timeout before shutdown', async () => {
  const manager = new LifecycleManager({ logger });
  const first = new Restartable(logger, { name: 'first' });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(first);
  await manager.registerComponent(component);
  await manager.startAllComponents();
  Object.defineProperty(component, 'startupTimeoutMS', { value: NaN });

  const result = await manager.restartAllComponents();

  expect(result.success).toBe(false);
  expect(result.shutdownResult.code).toBe('invalid_options');
  expect(result.startupResult.code).toBe('invalid_options');
  expect(component.starts).toBe(1);
  expect(component.stops).toBe(0);
  expect(first.starts).toBe(1);
  expect(first.stops).toBe(0);
  expect(manager.getComponentStatus('target')?.state).toBe('running');
  expect(manager.getComponentStatus('first')?.state).toBe('running');
  await manager.stopAllComponents();
});

test('bulk restart starts with startup timeout captured before asynchronous shutdown', async () => {
  const manager = new LifecycleManager({ logger });
  let stopEntered!: () => void;
  let releaseStop!: () => void;
  const entered = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  class DelayedStop extends Restartable {
    public override stop(): void | Promise<void> {
      this.stops++;
      if (this.stops === 1) {
        stopEntered();
        return new Promise<void>((resolve) => {
          releaseStop = resolve;
        });
      }
    }
  }
  const component = new DelayedStop(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startAllComponents();

  const pending = manager.restartAllComponents();
  await entered;
  Object.defineProperty(component, 'startupTimeoutMS', { value: NaN });
  releaseStop();
  const result = await pending;

  expect(result.success).toBe(true);
  expect(component.starts).toBe(2);
  expect(component.stops).toBe(1);
  await manager.stopAllComponents();
});

test('bulk restart reads a stateful component startup timeout getter once', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startAllComponents();
  let reads = 0;
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: () => (++reads === 1 ? 1000 : NaN),
  });

  const result = await manager.restartAllComponents();

  expect(result.success).toBe(true);
  expect(reads).toBe(1);
  expect(component.starts).toBe(2);
  expect(component.stops).toBe(1);
  await manager.stopAllComponents();
});

test('bulk restart does not stop a changed registration after a timeout getter reenters', async () => {
  const manager = new LifecycleManager({ logger });
  const first = new Restartable(logger, { name: 'first' });
  const target = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(first);
  await manager.registerComponent(target);
  await manager.startAllComponents();
  await manager.stopComponent('first');
  Object.defineProperty(target, 'startupTimeoutMS', {
    get: () => {
      void manager.unregisterComponent('first');
      return 1000;
    },
  });

  const result = await manager.restartAllComponents();

  expect(result.success).toBe(false);
  expect(result.startupResult.code).toBe('partial_state');
  expect(result.shutdownResult.code).toBe('partial_state');
  expect(result.shutdownResult.stoppedComponents).toEqual([]);
  expect(target.stops).toBe(0);
  expect(manager.getComponentStatus('target')?.state).toBe('running');
  await manager.stopAllComponents();
});

test('bulk restart does not stop when a timeout getter registers an unsnapshotted component', async () => {
  const manager = new LifecycleManager({ logger });
  const first = new Restartable(logger, { name: 'first' });
  const added = new Restartable(logger, { name: 'added' });
  await manager.registerComponent(first);
  await manager.startAllComponents();
  Object.defineProperty(added, 'startupTimeoutMS', { value: NaN });
  Object.defineProperty(first, 'startupTimeoutMS', {
    get: () => {
      void manager.registerComponent(added, { autoStart: false });
      return 1000;
    },
  });

  const result = await manager.restartAllComponents();

  expect(result.success).toBe(false);
  expect(result.startupResult.code).toBe('partial_state');
  expect(result.shutdownResult.code).toBe('partial_state');
  expect(result.shutdownResult.stoppedComponents).toEqual([]);
  expect(first.stops).toBe(0);
  expect(manager.getComponentStatus('first')?.state).toBe('running');
  await manager.stopAllComponents();
});

test('bulk restart starts remaining components after a deferred unregister', async () => {
  const manager = new LifecycleManager({ logger });
  const removed = new Restartable(logger, { name: 'removed' });
  const remaining = new Restartable(logger, { name: 'remaining' });
  await manager.registerComponent(removed);
  await manager.registerComponent(remaining);
  await manager.startAllComponents();
  let removal: ReturnType<typeof manager.unregisterComponent> | undefined;
  manager.once('lifecycle-manager:shutdown-completed', () => {
    queueMicrotask(() => {
      removal = manager.unregisterComponent('removed', {
        stopIfRunning: false,
      });
    });
  });

  const result = await manager.restartAllComponents();
  const removalResult = await removal;

  expect(removalResult?.success).toBe(true);
  expect(result.success).toBe(true);
  expect(result.startupResult.startedComponents).toEqual(['remaining']);
  expect(remaining.starts).toBe(2);
  expect(removed.starts).toBe(1);
  expect(manager.getComponentStatus('remaining')?.state).toBe('running');
  await manager.stopAllComponents();
});

test('bulk restart does not reuse a removed component timeout for its replacement', async () => {
  const manager = new LifecycleManager({ logger });
  const original = new Restartable(logger, { name: 'target' });
  const replacement = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(original);
  await manager.startAllComponents();
  Object.defineProperty(replacement, 'startupTimeoutMS', { value: NaN });
  let removal: ReturnType<typeof manager.unregisterComponent> | undefined;
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  manager.once('lifecycle-manager:shutdown-completed', () => {
    queueMicrotask(() => {
      removal = manager.unregisterComponent('target', {
        stopIfRunning: false,
      });
      registration = manager.registerComponent(replacement, {
        autoStart: false,
      });
    });
  });

  const result = await manager.restartAllComponents();
  const removalResult = await removal;
  const registrationResult = await registration;

  expect(removalResult?.success).toBe(true);
  expect(registrationResult?.success).toBe(true);
  expect(result.success).toBe(false);
  expect(result.startupResult.code).toBe('required_component_failed');
  expect(replacement.starts).toBe(0);
  expect(original.starts).toBe(1);
});

test('bulk restart logs a preflight registry refusal without stopping components', async () => {
  const warnings: string[] = [];
  const reportingLogger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write(entry) {
          if (entry.type === 'warn') {
            warnings.push(entry.message);
          }
        },
      },
    ],
  });
  const manager = new LifecycleManager({ logger: reportingLogger });
  const original = new Restartable(reportingLogger, { name: 'original' });
  await manager.registerComponent(original);
  await manager.startAllComponents();
  const added = new Restartable(reportingLogger, { name: 'added' });
  Object.defineProperty(original, 'startupTimeoutMS', {
    get() {
      void manager.registerComponent(added);
      return 1000;
    },
  });
  const result = await manager.restartAllComponents();
  expect(result.shutdownResult.code).toBe('partial_state');
  expect(original.stops).toBe(0);
  expect(warnings).toContain(
    'Restart refused before shutdown: Component "added" changed while restart was being prepared',
  );
  await manager.stopAllComponents();
});

test('bulk restart startup refuses replacement of a later snapshot component', async () => {
  const manager = new LifecycleManager({ logger });
  const second = new Restartable(logger, { name: 'second' });
  const replacement = new Restartable(logger, { name: 'second' });
  class First extends BaseComponent {
    public starts = 0;
    public async start(): Promise<void> {
      this.starts++;
      if (this.starts === 2) {
        // The registry remains owned throughout phase two. An earlier start hook
        // cannot replace a later snapshot through the public unregister API.
        const removed = await manager.unregisterComponent('second');
        expect(removed.code).toBe('bulk_operation_in_progress');
        const added = await manager.registerComponent(replacement);
        expect(added.code).toBe('duplicate_name');
      }
    }
    public stop(): void {}
  }
  const first = new First(logger, { name: 'first' });
  await manager.registerComponent(first);
  await manager.registerComponent(second);
  await manager.startAllComponents();
  try {
    expect((await manager.restartAllComponents()).success).toBe(true);
    expect(second.starts).toBe(2);
    expect(replacement.starts).toBe(0);
    expect(manager.getComponentStatus('second')?.state).toBe('running');
  } finally {
    await manager.stopAllComponents();
  }
});

// Starts `idle` - registered ahead of `trigger`, so preparation has already passed it -
// from caller code that runs during restart preparation, with an invalid stop budget the
// stop phase would only meet after stopping `trigger`.
for (const startedFrom of [
  'a later component getter',
  'the restart info sink',
]) {
  test(`bulk restart validates the stop budget of a component started by ${startedFrom}`, async () => {
    const manager = new LifecycleManager({ logger });
    const idle = new Restartable(logger, { name: 'idle' });
    const trigger = new Restartable(logger, { name: 'trigger' });
    await manager.registerComponent(idle);
    await manager.registerComponent(trigger);
    expect((await manager.startComponent('trigger')).success).toBe(true);
    Object.defineProperty(idle, 'shutdownGracefulTimeoutMS', {
      value: -5,
      configurable: true,
    });
    let idleStart: ReturnType<typeof manager.startComponent> | undefined;
    const startIdle = (): void => {
      idleStart ??= manager.startComponent('idle');
    };
    if (startedFrom === 'a later component getter') {
      Object.defineProperty(trigger, 'startupTimeoutMS', {
        get: () => {
          startIdle();
          return 1000;
        },
      });
    } else {
      logger.addSink({
        write(entry) {
          if (entry.message === 'Restarting all components') {
            startIdle();
          }
        },
      });
    }

    const result = await manager.restartAllComponents();
    await idleStart;

    expect(idleStart).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.shutdownResult.code).toBe('invalid_options');
    expect(result.startupResult.code).toBe('invalid_options');
    // Refused before stopping anything: the application is not left half down.
    expect(trigger.stops).toBe(0);
    expect(manager.getComponentStatus('trigger')?.state).toBe('running');
    Object.defineProperty(idle, 'shutdownGracefulTimeoutMS', { value: 1000 });
    await manager.stopAllComponents();
  });
}
