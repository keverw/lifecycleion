import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { MAX_TIMER_MS } from '../internal/timer-limits';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import type { LifecycleManagerOptions } from './types';
import { claimReports } from './test-helpers';

const logger = new Logger({ sinks: [], callProcessExit: false });

async function withoutGlobalReports<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const { reports, release } = claimReports();
  try {
    const result = await operation();
    expect(reports).toEqual([]);
    return result;
  } finally {
    release();
  }
}

class Component extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public healthChecks = 0;
  public messages = 0;
  public reloads = 0;
  public start(): void {
    this.starts++;
  }
  public stop(): void {
    this.stops++;
  }
  public healthCheck(): boolean {
    this.healthChecks++;
    return true;
  }
  public onMessage<TData = unknown>(): TData {
    this.messages++;
    return undefined as TData;
  }
  public onReload(): void {
    this.reloads++;
  }
}

const componentFields = [
  'startupTimeoutMS',
  'shutdownGracefulTimeoutMS',
  'shutdownForceTimeoutMS',
  'healthCheckTimeoutMS',
  'signalTimeoutMS',
] as const;

for (const field of componentFields) {
  test.each([
    [NaN, TypeError],
    ['15', TypeError],
    [-1, RangeError],
    [-Infinity, RangeError],
  ] as const)(`${field} refuses explicit %s`, (value, errorType) => {
    expect(
      () =>
        new Component(logger, {
          name: 'invalid',
          [field]: value,
        }),
    ).toThrow(errorType);
  });

  test(`${field} clamps Infinity and accepts omission`, () => {
    const infinite = new Component(logger, {
      name: 'infinite',
      [field]: Infinity,
    });
    expect(infinite[field]).toBe(MAX_TIMER_MS);
    const omitted = new Component(logger, { name: 'omitted' });
    expect(omitted[field]).toBeGreaterThan(0);
  });
}

for (const field of [
  'startupTimeoutMS',
  'messageTimeoutMS',
  'shutdownOptions',
] as const) {
  test.each([
    [NaN, TypeError],
    ['15', TypeError],
    [-1, RangeError],
  ] as const)(`manager ${field} refuses explicit %s`, (value, errorType) => {
    const options =
      field === 'shutdownOptions'
        ? { shutdownOptions: { timeoutMS: value } }
        : { [field]: value };
    expect(
      () =>
        new LifecycleManager({
          logger,
          ...options,
        } as LifecycleManagerOptions & { logger: Logger }),
    ).toThrow(errorType);
  });
}

test.each([-1, -Infinity, -100])(
  'negative warning timeout %s retains the skip sentinel',
  (timeout) => {
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: timeout,
    });
    expect(Reflect.get(manager, 'shutdownWarningTimeoutMS')).toBe(-1);
  },
);

test.each([NaN, '15'])('warning timeout refuses explicit %s', (timeout) => {
  expect(
    () =>
      new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: timeout as number,
      }),
  ).toThrow(TypeError);
});

for (const field of ['withinMS', 'armedAfterFailureMS'] as const) {
  test.each([
    [NaN, TypeError],
    ['15', TypeError],
    [-1, RangeError],
  ] as const)(
    `repeated shutdown ${field} refuses explicit %s`,
    (value, errorType) => {
      expect(
        () =>
          new LifecycleManager({
            logger,
            repeatedShutdownRequestPolicy: {
              forceAfterCount: 3,
              withinMS: 100,
              onForceShutdown: () => {},
              [field]: value,
            },
          }),
      ).toThrow(errorType);
    },
  );
}

test('invalid stop override returns a failure without calling stop', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  await manager.registerComponent(component);
  await manager.startComponent('component');
  const result = await withoutGlobalReports(() =>
    manager.stopComponent('component', { timeout: NaN }),
  );
  expect(result.success).toBe(false);
  expect(result.code).toBe('invalid_options');
  expect(result.error?.message).toContain('stopComponent timeout');
  expect(result.error?.message).not.toContain('shutdownGracefulTimeoutMS');
  expect(component.stops).toBe(0);
  expect(manager.getComponentStatus('component')?.state).toBe('running');
  await manager.stopAllComponents();
});

test('invalid component health timeout returns a failure without calling healthCheck', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  await manager.registerComponent(component);
  await manager.startComponent('component');
  Object.defineProperty(component, 'healthCheckTimeoutMS', { value: NaN });
  const result = await withoutGlobalReports(() =>
    manager.checkComponentHealth('component'),
  );
  expect(result.healthy).toBe(false);
  expect(result.code).toBe('invalid_options');
  expect(component.healthChecks).toBe(0);
  await manager.stopAllComponents();
});

test('invalid component signal timeout returns a failure without calling onReload', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  await manager.registerComponent(component);
  await manager.startComponent('component');
  Object.defineProperty(component, 'signalTimeoutMS', { value: NaN });
  const result = await withoutGlobalReports(() => manager.triggerReload());
  expect(result.results[0]?.called).toBe(false);
  expect(result.results[0]?.code).toBe('invalid_options');
  expect(component.reloads).toBe(0);
  await manager.stopAllComponents();
});

test.each([NaN])(
  'invalid bulk startup timeout %s returns failure and permits a later start',
  async (timeout) => {
    const manager = new LifecycleManager({ logger });
    const component = new Component(logger, { name: 'component' });
    await manager.registerComponent(component);
    const invalid = await withoutGlobalReports(() =>
      manager.startAllComponents({ timeoutMS: timeout }),
    );
    expect(invalid.success).toBe(false);
    expect(invalid.code).toBe('invalid_options');
    expect(component.starts).toBe(0);
    expect((await manager.startAllComponents()).success).toBe(true);
    expect(component.starts).toBe(1);
    await manager.stopAllComponents();
  },
);

test.each([NaN])(
  'invalid bulk shutdown timeout %s returns failure and permits a later stop',
  async (timeout) => {
    const manager = new LifecycleManager({ logger });
    const component = new Component(logger, { name: 'component' });
    await manager.registerComponent(component);
    await manager.startAllComponents();
    const invalid = await withoutGlobalReports(() =>
      manager.stopAllComponents({ timeoutMS: timeout }),
    );
    expect(invalid.success).toBe(false);
    expect(invalid.code).toBe('invalid_options');
    expect(component.stops).toBe(0);
    expect((await manager.stopAllComponents()).success).toBe(true);
    expect(component.stops).toBe(1);
  },
);

test.each([NaN])(
  'invalid message timeout %s returns failure without calling onMessage',
  async (timeout) => {
    const manager = new LifecycleManager({ logger });
    const component = new Component(logger, { name: 'component' });
    await manager.registerComponent(component);
    await manager.startAllComponents();
    const invalid = await withoutGlobalReports(() =>
      manager.sendMessageToComponent('component', null, {
        timeout: timeout,
      }),
    );
    expect(invalid.sent).toBe(false);
    expect(invalid.code).toBe('invalid_options');
    expect(invalid.componentFound).toBe(true);
    expect(invalid.componentRunning).toBe(true);
    expect(invalid.handlerImplemented).toBe(true);
    expect(component.messages).toBe(0);
    expect((await manager.sendMessageToComponent('component', null)).sent).toBe(
      true,
    );
    expect(component.messages).toBe(1);
    await manager.stopAllComponents();
  },
);

test('invalid component startup timeout fails before the start handler runs', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  Object.defineProperty(component, 'startupTimeoutMS', { value: NaN });
  await manager.registerComponent(component);
  const invalid = await withoutGlobalReports(() =>
    manager.startComponent('component'),
  );
  expect(invalid.success).toBe(false);
  expect(invalid.code).toBe('invalid_options');
  expect(component.starts).toBe(0);
  expect(manager.getComponentStatus('component')?.state).toBe('registered');
});

test.each(['shutdownWarningTimeoutMS', 'shutdownOptions.timeoutMS'] as const)(
  'constructor reads %s once before rejecting invalid value',
  (field) => {
    let reads = 0;
    const unstable = {
      get timeoutMS() {
        reads++;
        return reads === 1 ? NaN : 100;
      },
    };
    const options =
      field === 'shutdownWarningTimeoutMS'
        ? {
            get shutdownWarningTimeoutMS() {
              reads++;
              return reads === 1 ? NaN : 100;
            },
          }
        : { shutdownOptions: unstable };
    expect(() => new LifecycleManager({ logger, ...options })).toThrow(
      TypeError,
    );
    expect(reads).toBe(1);
  },
);

test('explicit Infinity policy arming is reported as explicit', () => {
  const manager = new LifecycleManager({
    logger,
    repeatedShutdownRequestPolicy: {
      forceAfterCount: 3,
      withinMS: 100,
      armedAfterFailureMS: Infinity,
      onForceShutdown: () => {},
    },
  });
  expect(manager.getShutdownEscalationStatus()).toMatchObject({
    armedAfterFailureMS: MAX_TIMER_MS,
    armedAfterFailureMSSource: 'explicit',
  });
});

test.each([
  ['startup NaN', { startupOptions: { timeoutMS: NaN } }],
  ['startup negative', { startupOptions: { timeoutMS: -1 } }],
  ['shutdown NaN', { shutdownTimeoutMS: NaN }],
  ['shutdown negative', { shutdownTimeoutMS: -1 }],
] as const)(
  'invalid %s restart timeout leaves running components untouched',
  async (_phase, options) => {
    const manager = new LifecycleManager({ logger });
    const component = new Component(logger, { name: 'component' });
    await manager.registerComponent(component);
    await manager.startAllComponents();
    const result = await withoutGlobalReports(() =>
      manager.restartAllComponents(options),
    );
    expect(result.success).toBe(false);
    expect(result.shutdownResult.code).toBe('invalid_options');
    expect(result.startupResult.code).toBe('invalid_options');
    expect(component.stops).toBe(0);
    expect(component.starts).toBe(1);
    expect(manager.getComponentStatus('component')?.state).toBe('running');
    await manager.stopAllComponents();
  },
);

test('restart snapshots startup timeout once before stopping', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  await manager.registerComponent(component);
  await manager.startAllComponents();
  let reads = 0;
  const startupOptions = {
    get timeoutMS() {
      reads++;
      return reads === 1 ? 100 : NaN;
    },
  };
  const result = await manager.restartAllComponents({ startupOptions });
  expect(result.success).toBe(true);
  expect(reads).toBe(1);
  expect(component.stops).toBe(1);
  expect(component.starts).toBe(2);
  await manager.stopAllComponents();
});

test('restart uses validated startup timeout when caller mutates options during stop', async () => {
  const manager = new LifecycleManager({ logger });
  const startupOptions = { timeoutMS: 100 };
  class MutatingComponent extends Component {
    public override stop(): void {
      super.stop();
      startupOptions.timeoutMS = NaN;
    }
  }
  const component = new MutatingComponent(logger, { name: 'component' });
  await manager.registerComponent(component);
  await manager.startAllComponents();
  const result = await manager.restartAllComponents({ startupOptions });
  expect(result.success).toBe(true);
  expect(component.stops).toBe(1);
  expect(component.starts).toBe(2);
  await manager.stopAllComponents();
});

test('invalid graceful timeout getter returns invalid_options without running stop', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  await manager.registerComponent(component);
  await manager.startComponent('component');
  let reads = 0;
  Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
    get() {
      reads++;
      return NaN;
    },
  });
  const result = await withoutGlobalReports(() =>
    manager.stopComponent('component'),
  );
  expect(result.code).toBe('invalid_options');
  expect(reads).toBe(1);
  expect(component.stops).toBe(0);
  expect(manager.getComponentStatus('component')?.state).toBe('running');
});

test('invalid startup timeout getter returns invalid_options without running start', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  let reads = 0;
  Object.defineProperty(component, 'startupTimeoutMS', {
    get() {
      reads++;
      return NaN;
    },
  });
  await manager.registerComponent(component);
  const result = await withoutGlobalReports(() =>
    manager.startComponent('component'),
  );
  expect(result.code).toBe('invalid_options');
  expect(reads).toBe(1);
  expect(component.starts).toBe(0);
  expect(manager.getComponentStatus('component')?.state).toBe('registered');
});

test('a handler TypeError remains a handler failure, not invalid_options', async () => {
  const manager = new LifecycleManager({ logger });
  const component = new Component(logger, { name: 'component' });
  component.onMessage = (): never => {
    throw new TypeError('handler failed');
  };
  await manager.registerComponent(component);
  await manager.startComponent('component');
  const result = await manager.sendMessageToComponent('component', null);
  expect(result.code).toBe('error');
  expect(result.error?.message).toBe('handler failed');
  await manager.stopAllComponents();
});

for (const field of [
  'shutdownGracefulTimeoutMS',
  'shutdownForceTimeoutMS',
] as const) {
  test(`bulk shutdown keeps ${field} validation failure and recovers after repair`, async () => {
    const manager = new LifecycleManager({ logger });
    class Forceful extends Component {
      public forceCalls = 0;
      public onShutdownForce(): void {
        this.forceCalls++;
      }
    }
    const component = new Forceful(logger, { name: 'component' });
    await manager.registerComponent(component);
    await manager.startAllComponents();
    let timeout = NaN;
    let reads = 0;
    Object.defineProperty(component, field, {
      get() {
        reads++;
        return timeout;
      },
    });

    const invalid = await withoutGlobalReports(() =>
      manager.stopAllComponents(),
    );
    expect(invalid.code).toBe('invalid_options');
    expect(invalid.error?.message).toContain(field);
    expect(invalid.stoppedComponents).toEqual([]);
    expect(invalid.stalledComponents).toEqual([]);
    expect(reads).toBe(1);
    expect(component.stops).toBe(0);
    expect(component.forceCalls).toBe(0);
    expect(manager.getComponentStatus('component')?.state).toBe('running');

    timeout = field === 'shutdownGracefulTimeoutMS' ? 1000 : 500;
    const recovered = await manager.stopAllComponents();
    expect(recovered.success).toBe(true);
    expect(component.stops).toBe(1);
  });

  test(`restart refuses ${field} before stopping and recovers after repair`, async () => {
    const manager = new LifecycleManager({ logger });
    class Forceful extends Component {
      public forceCalls = 0;
      public onShutdownForce(): void {
        this.forceCalls++;
      }
    }
    const component = new Forceful(logger, { name: 'component' });
    await manager.registerComponent(component);
    await manager.startAllComponents();
    let timeout = NaN;
    Object.defineProperty(component, field, {
      get() {
        return timeout;
      },
    });

    const invalid = await withoutGlobalReports(() =>
      manager.restartAllComponents(),
    );
    expect(invalid.success).toBe(false);
    expect(invalid.shutdownResult.code).toBe('invalid_options');
    expect(invalid.shutdownResult.error?.message).toContain(field);
    expect(invalid.startupResult.code).toBe('invalid_options');
    expect(component.stops).toBe(0);
    expect(component.forceCalls).toBe(0);
    expect(component.starts).toBe(1);
    expect(manager.getComponentStatus('component')?.state).toBe('running');

    timeout = field === 'shutdownGracefulTimeoutMS' ? 1000 : 500;
    const recovered = await manager.restartAllComponents();
    expect(recovered.success).toBe(true);
    expect(component.stops).toBe(1);
    expect(component.starts).toBe(2);
    await manager.stopAllComponents();
  });
}

test.each([NaN, -1])(
  'invalid broadcast timeout %s refuses before events or handlers',
  async (timeout) => {
    const manager = new LifecycleManager({ logger });
    const components = ['first', 'second'].map(
      (name) => new Component(logger, { name }),
    );
    for (const component of components) {
      await manager.registerComponent(component);
    }
    await manager.startAllComponents();
    const events: string[] = [];
    manager.on('component:broadcast-started', () => {
      events.push('started');
    });
    manager.on('component:broadcast-completed', () => {
      events.push('completed');
    });
    manager.on('component:message-sent', () => {
      events.push('sent');
    });
    try {
      const result = await withoutGlobalReports(() =>
        manager.broadcastMessage('hello', { timeout: timeout }),
      );
      expect(result).toEqual([]);
      expect(events).toEqual([]);
      expect(components.map((component) => component.messages)).toEqual([0, 0]);
      // A refused configuration must not poison the next valid broadcast.
      const valid = await manager.broadcastMessage('hello', { timeout: 0 });
      expect(valid.map((entry) => entry.code)).toEqual(['sent', 'sent']);
      expect(events).toEqual(['started', 'sent', 'sent', 'completed']);
    } finally {
      await manager.stopAllComponents();
    }
  },
);

test('invalid broadcast timeout reports its refusal through the configured logger', async () => {
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
  expect(
    await withoutGlobalReports(() =>
      manager.broadcastMessage('hello', { timeout: NaN }),
    ),
  ).toEqual([]);
  expect(warnings).toEqual([
    'Broadcast refused: broadcastMessage timeout must be a number other than NaN',
  ]);
});

test('active bulk startup refuses without reading unused timeout options', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class Pending extends BaseComponent {
    public start(): Promise<void> {
      return gate;
    }
    public stop(): void {}
  }
  const manager = new LifecycleManager({ logger });
  await manager.registerComponent(new Pending(logger, { name: 'pending' }));
  const first = manager.startAllComponents();
  let reads = 0;
  try {
    const second = await withoutGlobalReports(() =>
      manager.startAllComponents({
        get timeoutMS() {
          reads++;
          return NaN;
        },
      }),
    );
    expect(second.code).toBe('already_in_progress');
    expect(reads).toBe(0);
  } finally {
    release();
    await first;
    await manager.stopAllComponents();
  }
});

test('bulk startup rechecks ownership after a timeout getter starts a nested startup', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class Pending extends BaseComponent {
    public start(): Promise<void> {
      return gate;
    }
    public stop(): void {}
  }
  const manager = new LifecycleManager({ logger });
  await manager.registerComponent(new Pending(logger, { name: 'pending' }));
  let nested: ReturnType<LifecycleManager['startAllComponents']> | undefined;
  try {
    const outer = await manager.startAllComponents({
      get timeoutMS() {
        nested = manager.startAllComponents();
        return 1000;
      },
    });
    expect(outer.code).toBe('already_in_progress');
  } finally {
    release();
    await nested;
    await manager.stopAllComponents();
  }
});

// Optional settings from JSON can explicitly be null. They must inherit the same
// defaults as omission, while the invalid-number cases above still fail fast.
test('null component and manager timeout options inherit defaults', () => {
  const defaults = new Component(logger, { name: 'defaults' });
  const component = new Component(logger, {
    name: 'nullable',
    ...Object.fromEntries(componentFields.map((field) => [field, null])),
  });
  for (const field of componentFields) {
    expect(component[field]).toBe(defaults[field]);
  }
  const manager = new LifecycleManager({
    logger,
    startupTimeoutMS: null,
    messageTimeoutMS: null,
    shutdownWarningTimeoutMS: null,
    shutdownOptions: { timeoutMS: null },
    repeatedShutdownRequestPolicy: {
      withinMS: null,
      armedAfterFailureMS: null,
      onForceShutdown: () => {},
    },
  });
  const ordinary = new LifecycleManager({
    logger,
    repeatedShutdownRequestPolicy: { onForceShutdown: () => {} },
  });
  for (const field of [
    'startupTimeoutMS',
    'messageTimeoutMS',
    'shutdownWarningTimeoutMS',
    'shutdownOptions',
  ]) {
    expect(Reflect.get(manager, field)).toEqual(Reflect.get(ordinary, field));
  }
  expect(manager.getShutdownEscalationStatus()).toEqual(
    ordinary.getShutdownEscalationStatus(),
  );
});

test('null per-call budgets inherit defaults across startup, messaging, restart and stop', async () => {
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const component = new Component(logger, { name: 'component' });
  await manager.registerComponent(component);
  try {
    expect(
      (await manager.startAllComponents({ timeoutMS: null })).success,
    ).toBe(true);
    expect(
      (
        await manager.sendMessageToComponent('component', null, {
          timeout: null,
        })
      ).sent,
    ).toBe(true);
    expect(
      (await manager.broadcastMessage(null, { timeout: null }))[0]?.sent,
    ).toBe(true);
    expect(
      (
        await manager.restartAllComponents({
          startupOptions: { timeoutMS: null },
          shutdownTimeoutMS: null,
        })
      ).success,
    ).toBe(true);
    expect(
      (await manager.stopComponent('component', { timeout: null })).success,
    ).toBe(true);
    expect(
      (await manager.startAllComponents({ timeoutMS: null })).success,
    ).toBe(true);
    expect((await manager.stopAllComponents({ timeoutMS: null })).success).toBe(
      true,
    );
  } finally {
    await manager.stopAllComponents();
  }
});
