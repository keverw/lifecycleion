import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, coreOf } from './test-helpers';

class Component extends BaseComponent {
  public starts = 0;
  public onStart: () => void | Promise<void> = () => {};
  public async start() {
    this.starts++;
    await this.onStart();
  }
  public stop() {}
  public fail() {
    this.reportUnexpectedStop(new Error('stopped during startup'));
  }
}
function setup() {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    startupTimeoutMS: 10_000,
    shutdownWarningTimeoutMS: -1,
  });
  const component = (
    name: string,
    dependencies: string[] = [],
    isOptional = false,
  ) => new Component(logger, { name, dependencies, optional: isOptional });
  const warnings = () =>
    sink.logs.filter((log) =>
      log.message.includes('deferred auto-starts were not attempted'),
    );
  return { sink, logger, manager, component, warnings };
}

test('deferred auto-starts included in the initial order are warned when not attempted', async () => {
  const { manager, component, warnings } = setup();
  const root = component('root');
  const late = component('late');
  await manager.registerComponent(root);
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  let hasRequestedRegistration = false;
  root.getDependencies = () => {
    if (!hasRequestedRegistration) {
      hasRequestedRegistration = true;
      registration = manager.registerComponent(late, { autoStart: true });
    }
    return [];
  };
  root.onStart = () => {
    throw new Error('root failed');
  };
  expect((await manager.startAllComponents()).code).toBe(
    'required_component_failed',
  );
  expect(await registration).toMatchObject({ autoStartDeferred: true });
  expect(late.starts).toBe(0);
  expect(warnings()).toHaveLength(1);
  expect(warnings()[0].params?.components).toEqual(['late']);
});

test('a registration from post-loop unexpected-stop reporting remains owned by the failing startup', async () => {
  const { logger, manager, component, warnings } = setup();
  const root = component('root');
  const last = component('last');
  const late = component('late');
  const realNow = Date.now;
  let now = realNow();
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  last.onStart = () => {
    now += 10_001;
  };
  logger.addSink({
    write(entry) {
      if (
        entry.template === 'Startup timeout exceeded, returning partial results'
      ) {
        root.fail();
      }
      if (
        entry.template.startsWith(
          'Required component stopped unexpectedly during startup:',
        )
      ) {
        registration = manager.registerComponent(late, { autoStart: true });
      }
    },
  });
  await manager.registerComponent(root);
  await manager.registerComponent(last);
  Date.now = () => now;
  try {
    expect((await manager.startAllComponents()).code).toBe(
      'component_unexpected_stop',
    );
    expect(await registration).toMatchObject({ autoStartDeferred: true });
    expect(late.starts).toBe(0);
    expect(manager.getRunningComponentNames()).toEqual([]);
    expect(warnings()).toHaveLength(1);
  } finally {
    Date.now = realNow;
    await manager.stopAllComponents();
  }
});

test('a registration from a follow-up ordering crash report cannot escape rollback', async () => {
  const { manager, component, warnings } = setup();
  const root = component('root');
  const queued = component('queued');
  const late = component('late');
  let isFollowupReady = false;
  root.onStart = async () => {
    await manager.registerComponent(queued, { autoStart: true });
    isFollowupReady = true;
  };
  await manager.registerComponent(root);
  // Inject an internal failure after the ordinary registration checks have completed.
  const internal = coreOf(manager).startupOrdering;
  const order = internal.getStartupOrderInternal.bind(internal);
  internal.getStartupOrderInternal = (...args) => {
    if (isFollowupReady) {
      isFollowupReady = false;
      throw new Error('unexpected ordering failure');
    }
    return order(...args);
  };
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  const { reports, release } = claimReports();
  const onError = () => {
    registration = manager.registerComponent(late, { autoStart: true });
  };
  globalThis.addEventListener('error', onError);
  try {
    expect((await manager.startAllComponents()).code).toBe('operation_crashed');
    expect(await registration).toMatchObject({ autoStartDeferred: true });
    expect(reports).toHaveLength(1);
    expect(late.starts).toBe(0);
    expect(manager.getRunningComponentNames()).toEqual([]);
    expect(warnings()[0].params?.components).toEqual(['queued', 'late']);
  } finally {
    internal.getStartupOrderInternal = order;
    globalThis.removeEventListener('error', onError);
    release();
    await manager.stopAllComponents();
  }
});

test('a cycle introduced before follow-up ordering returns dependency_cycle and rolls back without an internal crash report', async () => {
  const { manager, component } = setup();
  const root = component('root');
  const a = component('a');
  const b = component('b');
  root.onStart = async () => {
    await manager.registerComponent(a, { autoStart: true });
    await manager.registerComponent(b, { autoStart: true });
    a.getDependencies = () => ['b'];
    b.getDependencies = () => ['a'];
  };
  await manager.registerComponent(root);
  const { reports, release } = claimReports();
  try {
    expect((await manager.startAllComponents()).code).toBe('dependency_cycle');
    expect(reports).toHaveLength(0);
    expect(manager.getRunningComponentNames()).toEqual([]);
    expect([a.starts, b.starts]).toEqual([0, 0]);
  } finally {
    release();
    await manager.stopAllComponents();
  }
});

test.each([false, true])(
  'a follow-up dependency registered without auto-start only runs if explicitly started (%s)',
  async (shouldStart) => {
    const { manager, component } = setup();
    const root = component('root');
    const follower = component('follower', ['dependency'], true);
    const dependency = component('dependency');
    root.onStart = async () => {
      expect(
        await manager.registerComponent(follower, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
      expect(
        await manager.registerComponent(dependency, { autoStart: false }),
      ).toMatchObject({ success: true, autoStartAttempted: false });
      if (shouldStart) {
        expect(
          (
            await manager.startComponent('dependency', {
              allowDuringBulkStartup: true,
            })
          ).success,
        ).toBe(true);
      }
    };
    await manager.registerComponent(root);
    const result = await manager.startAllComponents();
    expect(result.success).toBe(true);
    expect(dependency.starts).toBe(shouldStart ? 1 : 0);
    expect(follower.starts).toBe(shouldStart ? 1 : 0);
    expect(result.failedOptionalComponents.map(({ name }) => name)).toEqual(
      shouldStart ? [] : ['follower'],
    );
    if (!shouldStart) {
      expect(result.failedOptionalComponents[0].error.message).toContain(
        'not running',
      );
    }
    await manager.stopAllComponents();
  },
);

test('completion callback auto-start logs its independent decision and rechecks shutdown triggered by that log', async () => {
  const { logger, manager, component, sink } = setup();
  const root = component('root');
  const late = component('late');
  await manager.registerComponent(root);
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  logger.addSink({
    write(entry) {
      if (
        entry.template ===
        'AutoStart: starting component (bulk startup completing)'
      ) {
        shutdown = manager.stopAllComponents();
      }
    },
  });
  manager.once('lifecycle-manager:started', () => {
    registration = manager.registerComponent(late, { autoStart: true });
  });
  await manager.startAllComponents();
  expect(await registration).toMatchObject({
    autoStartAttempted: true,
    startResult: { success: false, code: 'shutdown_in_progress' },
  });
  await shutdown;
  expect(
    sink.logs.some(
      (entry) =>
        entry.template ===
        'AutoStart: starting component (bulk startup completing)',
    ),
  ).toBe(true);
  expect(late.starts).toBe(0);
  await manager.stopAllComponents();
});

test('auto-starts deferred by final optional-stop reconciliation join successful completion', async () => {
  const { logger, manager, component, warnings } = setup();
  const root = component('root', [], true);
  const bad = component('bad', ['missing']);
  const skipped = component('skipped', ['bad']);
  const late = component('late');
  // Caller-owned optionality can change: tolerate bad's own failure, then skip
  // its dependent. That final skip reports root's stop after per-start reconciliation.
  let optionalReads = 0;
  bad.isOptional = () => ++optionalReads === 1;
  manager.once('component:start-skipped', () => root.fail());
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  logger.addSink({
    write(entry) {
      if (
        entry.template.startsWith(
          'Optional component stopped unexpectedly during startup, continuing:',
        )
      ) {
        registration = manager.registerComponent(late, { autoStart: true });
      }
    },
  });
  for (const c of [root, bad, skipped]) {
    await manager.registerComponent(c);
  }
  const result = await manager.startAllComponents();
  expect(result.success).toBe(true);
  expect(result.skippedDueToDependency).toEqual(['skipped']);
  expect(await registration).toMatchObject({ autoStartDeferred: true });
  expect(late.starts).toBe(1);
  expect(result.startedComponents).toEqual(['late']);
  expect(warnings()).toHaveLength(0);
  await manager.stopAllComponents();
});

// Completion callbacks belong to the already committed pass. They may start new
// independent work, so a stop there cannot reopen rollback; the returned availability
// snapshot must nevertheless omit a component that the callback just stopped.
test.each(['success log', 'started event'])(
  'a stop from the %s keeps completion committed and updates its snapshot',
  async (source) => {
    const { logger, manager, component } = setup();
    const root = component('root');
    const dependent = component('dependent', ['root']);
    let dependentStops = 0;
    dependent.stop = () => {
      dependentStops++;
    };
    await manager.registerComponent(root);
    await manager.registerComponent(dependent);
    if (source === 'success log') {
      logger.addSink({
        write(entry) {
          if (entry.template === 'All components started') {
            root.fail();
          }
        },
      });
    } else {
      manager.once('lifecycle-manager:started', () => root.fail());
    }
    try {
      const result = await manager.startAllComponents();
      expect(result.success).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.startedComponents).toEqual(['dependent']);
      expect(manager.getComponentStatus('root')?.state).toBe('stopped');
      expect(manager.getComponentStatus('dependent')?.state).toBe('running');
      expect(dependentStops).toBe(0);
    } finally {
      await manager.stopAllComponents();
    }
  },
);
