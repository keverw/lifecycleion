import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports } from './test-helpers';

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

test('invalid startup timeout refuses restart before stopping a running component', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  Object.defineProperty(component, 'startupTimeoutMS', { value: NaN });

  const result = await manager.restartComponent('target');

  expect(result.success).toBe(false);
  expect(result.code).toBe('invalid_options');
  expect(component.starts).toBe(1);
  expect(component.stops).toBe(0);
  expect(manager.getComponentStatus('target')?.state).toBe('running');
  await manager.stopAllComponents();
});

test('restart uses the startup timeout captured before an asynchronous stop', async () => {
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
  await manager.startComponent('target');
  const pending = manager.restartComponent('target');
  await entered;
  Object.defineProperty(component, 'startupTimeoutMS', { value: NaN });
  releaseStop();

  const result = await pending;
  expect(result.success).toBe(true);
  expect(component.starts).toBe(2);
  expect(component.stops).toBe(1);
  await manager.stopAllComponents();
});

test('restart reads a stateful startup timeout getter only once', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  let reads = 0;
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: () => (++reads === 1 ? 1000 : NaN),
  });

  const result = await manager.restartComponent('target');

  expect(result.success).toBe(true);
  expect(reads).toBe(1);
  expect(component.starts).toBe(2);
  expect(component.stops).toBe(1);
  await manager.stopAllComponents();
});

test('restart does not stop again when its timeout getter begins a stop', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  let nestedStop: ReturnType<typeof manager.stopComponent> | undefined;
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: () => {
      nestedStop = manager.stopComponent('target');
      return 1000;
    },
  });

  const result = await manager.restartComponent('target');
  await nestedStop;

  expect(result.success).toBe(false);
  expect(result.code).toBe('component_already_stopping');
  expect(component.starts).toBe(1);
  expect(component.stops).toBe(1);
});

test('invalid stop override remains an invalid-options restart refusal', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');

  const result = await manager.restartComponent('target', {
    stopOptions: { timeout: NaN },
  });

  expect(result.success).toBe(false);
  expect(result.code).toBe('invalid_options');
  expect(component.stops).toBe(0);
  expect(manager.getComponentStatus('target')?.state).toBe('running');
  await manager.stopAllComponents();
});

test('restart preserves missing-component refusal before attempting a stop', async () => {
  const manager = new LifecycleManager({ logger });

  const result = await manager.restartComponent('missing');

  expect(result.success).toBe(false);
  expect(result.code).toBe('component_not_found');
});

test('restart preserves already-stopping refusal before attempting a second stop', async () => {
  const manager = new LifecycleManager({ logger });
  let stopEntered!: () => void;
  let releaseStop!: () => void;
  const entered = new Promise<void>((resolve) => {
    stopEntered = resolve;
  });
  class DelayedStop extends Restartable {
    public override stop(): Promise<void> {
      this.stops++;
      stopEntered();
      return new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    }
  }
  const component = new DelayedStop(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  const stopping = manager.stopComponent('target');
  await entered;

  const result = await manager.restartComponent('target');

  expect(result.success).toBe(false);
  expect(result.code).toBe('component_already_stopping');
  expect(component.stops).toBe(1);
  releaseStop();
  await stopping;
});

test('restart rechecks shutdown after an option getter starts one', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  const options = {
    get stopOptions() {
      shutdown = manager.stopAllComponents();
      return {};
    },
  };

  const result = await manager.restartComponent('target', options);

  expect(result.success).toBe(false);
  expect(result.code).toBe('shutdown_in_progress');
  await shutdown;
  expect(component.stops).toBe(1);
});

test('restart keeps a refusal from a stop option getter that starts another stop', async () => {
  const manager = new LifecycleManager({ logger });
  let releaseStop!: () => void;
  class DelayedStop extends Restartable {
    public override stop(): Promise<void> {
      this.stops++;
      return new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    }
  }
  const component = new DelayedStop(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  let nestedStop: ReturnType<typeof manager.stopComponent> | undefined;
  const stopOptions = {
    get allowStopWithRunningDependents() {
      nestedStop = manager.stopComponent('target');
      return true;
    },
  };

  const result = await manager.restartComponent('target', { stopOptions });

  expect(result.success).toBe(false);
  expect(result.code).toBe('component_already_stopping');
  expect(component.stops).toBe(1);
  releaseStop();
  await nestedStop;
});

test('restart keeps an unexpected pre-stop option error without stop-failed wrapping', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  const stopOptions = {
    get allowStopWithRunningDependents(): never {
      throw new Error('stop option exploded');
    },
  };
  const { release } = claimReports();
  let result;
  try {
    result = await manager.restartComponent('target', { stopOptions });
  } finally {
    release();
  }

  expect(result.success).toBe(false);
  expect(result.code).toBe('unknown_error');
  expect(component.stops).toBe(0);
  await manager.stopAllComponents();
});

test('nested stop cannot make a failed outer option read look like its own attempt', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Restartable(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  let nestedStop: ReturnType<typeof manager.stopComponent> | undefined;
  const stopOptions = {
    get allowStopWithRunningDependents(): never {
      nestedStop = manager.stopComponent('target');
      throw new Error('outer stop option exploded');
    },
  };
  const { release } = claimReports();
  let result;
  try {
    result = await manager.restartComponent('target', { stopOptions });
  } finally {
    release();
  }
  await nestedStop;

  expect(result.success).toBe(false);
  expect(result.code).toBe('unknown_error');
  expect(component.stops).toBe(1);
});

test('restart wraps a validation-shaped failure after its stop claim', async () => {
  const manager = new LifecycleManager({ logger });
  class FailedStop extends Restartable {
    public override stop(): void {
      this.stops++;
      throw new Error('graceful failed');
    }
    public override onShutdownForce(): void {}
  }
  const component = new FailedStop(logger, { name: 'target' });
  await manager.registerComponent(component);
  await manager.startComponent('target');
  const refused = await manager.stopComponent('target', { timeout: NaN });
  expect(refused.code).toBe('invalid_options');
  const validationError = refused.error;
  if (!(validationError instanceof Error)) {
    throw new Error('Expected the timeout validation error');
  }
  Object.defineProperty(component, 'onShutdownForceAborted', {
    configurable: true,
    get() {
      // Reusing a validation error does not undo the graceful stop this restart
      // already attempted. Classification must follow ownership, not its code.
      throw validationError;
    },
  });
  const { release } = claimReports();
  let result;
  try {
    result = await manager.restartComponent('target');
  } finally {
    release();
    Object.defineProperty(component, 'onShutdownForceAborted', {
      value: undefined,
    });
  }
  expect(component.stops).toBe(1);
  expect(result.success).toBe(false);
  expect(result.code).toBe('restart_stop_failed');
  await manager.stopAllComponents({ retryStalled: true });
});
