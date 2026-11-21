import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';

class Component extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public onStart: () => void | Promise<void> = () => {};
  public async start() {
    this.starts++;
    await this.onStart();
  }
  public stop() {
    this.stops++;
  }
}
function setup(startupTimeoutMS = 1000) {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    startupTimeoutMS,
    shutdownWarningTimeoutMS: -1,
  });
  const component = (
    name: string,
    dependencies: string[] = [],
    isOptional = false,
  ) => new Component(logger, { name, dependencies, optional: isOptional });
  return { manager, component, sink };
}

test.each([false, true])(
  'startup drains nested dependency-ordered follow-up batches (restart: %s)',
  async (shouldRestart) => {
    const { manager, component } = setup();
    const root = component('root');
    const middle = component('middle', ['root']);
    const leaf = component('leaf', ['middle']);
    const nested = component('nested', ['leaf']);
    const idle = component('idle');
    await manager.registerComponent(root);
    if (shouldRestart) {
      await manager.startAllComponents();
    }
    root.onStart = async () => {
      // Dependents can arrive first while their follow-up batch is still pending.
      expect(
        await manager.registerComponent(leaf, { autoStart: true }),
      ).toMatchObject({
        success: true,
        autoStartDeferred: true,
        autoStartAttempted: false,
      });
      expect(
        await manager.registerComponent(middle, { autoStart: true }),
      ).toMatchObject({ success: true, autoStartDeferred: true });
      await manager.registerComponent(idle);
      expect(leaf.starts).toBe(0);
    };
    leaf.onStart = async () => {
      expect(
        await manager.registerComponent(nested, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
    };
    const result = shouldRestart
      ? (await manager.restartAllComponents()).startupResult
      : await manager.startAllComponents();
    expect(result.success).toBe(true);
    expect(result.startedComponents).toEqual([
      'root',
      'middle',
      'leaf',
      'nested',
    ]);
    expect([middle.starts, leaf.starts, nested.starts, idle.starts]).toEqual([
      1, 1, 1, 0,
    ]);
    await manager.stopAllComponents();
  },
);

test('failure in the original batch leaves queued starts unattempted', async () => {
  const { manager, component } = setup();
  const first = component('first');
  const bad = component('bad');
  const queued = component('queued');
  first.onStart = async () => {
    await manager.registerComponent(queued, { autoStart: true });
  };
  bad.onStart = () => {
    throw new Error('original failure');
  };
  await manager.registerComponent(first);
  await manager.registerComponent(bad);
  expect(await manager.startAllComponents()).toMatchObject({
    success: false,
    code: 'required_component_failed',
    startedComponents: [],
  });
  expect(queued.starts).toBe(0);
  expect(first.stops).toBe(1);
});

test.each([false, true])(
  'follow-up failures use bulk optional and rollback policy (optional: %s)',
  async (isOptional) => {
    const { manager, component } = setup();
    const first = component('first');
    const good = component('good');
    const bad = component('bad', [], isOptional);
    const nested = component('nested');
    bad.onStart = async () => {
      await manager.registerComponent(nested, { autoStart: true });
      throw new Error('follow-up failure');
    };
    first.onStart = async () => {
      await manager.registerComponent(good, { autoStart: true });
      await manager.registerComponent(bad, { autoStart: true });
    };
    await manager.registerComponent(first);
    const result = await manager.startAllComponents();
    expect(result.success).toBe(isOptional);
    expect(bad.starts).toBe(1);
    if (isOptional) {
      expect(result.failedOptionalComponents.map(({ name }) => name)).toEqual([
        'bad',
      ]);
      expect(result.startedComponents).toEqual(['first', 'good', 'nested']);
    } else {
      expect(result.code).toBe('required_component_failed');
      expect(result.startedComponents).toEqual([]);
      expect([first.stops, good.stops, nested.starts]).toEqual([1, 1, 0]);
    }
    await manager.stopAllComponents();
  },
);

test('follow-up batches retain the original global deadline', async () => {
  const { manager, component } = setup(10_000);
  const first = component('first');
  const late = component('late');
  let finish!: () => void;
  let stopped!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  late.onStart = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  late.stop = () => {
    late.stops++;
    stopped();
  };
  const realNow = Date.now;
  let now = realNow();
  first.onStart = async () => {
    await manager.registerComponent(late, { autoStart: true });
    // Leave a small shared budget without depending on the first hook's wall time.
    now += 9_950;
  };
  await manager.registerComponent(first);
  Date.now = () => now;
  try {
    const result = await manager.startAllComponents();
    expect(result).toMatchObject({
      success: false,
      code: 'startup_timeout',
      startedComponents: ['first'],
    });
    expect(late.starts).toBe(1);
    finish();
    await cleanup;
    expect(late.stops).toBe(1);
  } finally {
    Date.now = realNow;
    await manager.stopAllComponents();
  }
});

test.each(['original', 'frozen-followup'] as const)(
  'missing dependencies of a %s batch remain protected',
  async (mode) => {
    const { manager, component } = setup();
    const first = component('first');
    const dependent = component('dependent', ['missing'], true);
    const missing = component('missing');
    const tryMissing = async () => {
      expect(
        await manager.registerComponent(missing, { autoStart: true }),
      ).toMatchObject({ success: false, code: 'startup_in_progress' });
    };
    await manager.registerComponent(first);
    if (mode === 'original') {
      first.onStart = tryMissing;
      await manager.registerComponent(dependent);
    } else {
      const trigger = component('trigger');
      trigger.onStart = tryMissing;
      first.onStart = async () => {
        await manager.registerComponent(trigger, { autoStart: true });
        await manager.registerComponent(dependent, { autoStart: true });
      };
    }
    expect((await manager.startAllComponents()).success).toBe(true);
    expect(missing.starts).toBe(0);
    await manager.stopAllComponents();
  },
);

test('auto-start from the final started event runs independently after the batch closes', async () => {
  const { manager, component } = setup();
  const first = component('first');
  const late = component('late');
  await manager.registerComponent(first);
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  manager.once('lifecycle-manager:started', () => {
    registration = manager.registerComponent(late, { autoStart: true });
  });
  const result = await manager.startAllComponents();
  expect(await registration).toMatchObject({
    autoStartAttempted: true,
    startResult: { success: true },
  });
  expect(result.startedComponents).toEqual(['first']);
  expect(late.starts).toBe(1);
  await manager.stopAllComponents();
});

test('the last optional failure notification can enqueue another batch', async () => {
  const { manager, component } = setup();
  const bad = component('bad', [], true);
  const late = component('late');
  bad.onStart = () => {
    throw new Error('optional');
  };
  await manager.registerComponent(bad);
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  manager.once('component:start-failed-optional', () => {
    registration = manager.registerComponent(late, { autoStart: true });
  });
  const result = await manager.startAllComponents();
  expect(await registration).toMatchObject({ autoStartDeferred: true });
  expect(result.startedComponents).toEqual(['late']);
  expect(result.failedOptionalComponents.map(({ name }) => name)).toEqual([
    'bad',
  ]);
  await manager.stopAllComponents();
});

test('auto-start from the final success log runs independently after the batch closes', async () => {
  const { manager, component } = setup();
  const first = component('first');
  const late = component('late');
  await manager.registerComponent(first);
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  const internalLogger = (manager as unknown as { logger: Logger }).logger;
  const success = internalLogger.success.bind(internalLogger);
  internalLogger.success = (...args) => {
    if (args[0] === 'All components started') {
      registration = manager.registerComponent(late, { autoStart: true });
    }
    return success(...args);
  };
  const result = await manager.startAllComponents();
  expect(await registration).toMatchObject({
    autoStartAttempted: true,
    startResult: { success: true },
  });
  expect(result.startedComponents).toEqual(['first']);
  expect(late.starts).toBe(1);
  await manager.stopAllComponents();
});

test('shutdown during a follow-up abandons the next queued batch', async () => {
  const { manager, component } = setup();
  const first = component('first');
  const followup = component('followup');
  const queued = component('queued');
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  first.onStart = async () => {
    await manager.registerComponent(followup, { autoStart: true });
  };
  followup.onStart = async () => {
    expect(
      await manager.registerComponent(queued, { autoStart: true }),
    ).toMatchObject({ autoStartDeferred: true });
    shutdown = manager.stopAllComponents();
  };
  await manager.registerComponent(first);
  const result = await manager.startAllComponents();
  await shutdown;
  expect(result.code).toBe('shutdown_in_progress');
  expect(queued.starts).toBe(0);
  expect(first.stops).toBe(1);
  expect(followup.stops).toBeLessThanOrEqual(1);
  expect(manager.getRunningComponentNames()).toEqual([]);
});
