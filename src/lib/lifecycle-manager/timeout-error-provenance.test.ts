import { expect, test } from 'bun:test';
import { toTimerDelayMS } from '../internal/timer-limits';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, Plain, setup } from './test-helpers';

function foreignTimeoutFailure(): number {
  return toTimerDelayMS(NaN, 'caller-owned timeout');
}

test('component startup getter throwing a shared timeout error remains a reported crash', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'component');
  await manager.registerComponent(component);
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: foreignTimeoutFailure,
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.startComponent('component');
    expect(result.code).toBe('operation_crashed');
    expect(result.reason).toContain('Start failed unexpectedly');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(result.error);
    expect(manager.getComponentStatus('component')?.state).toBe('registered');
  } finally {
    release();
  }
});

test('a Logger constructor failure in a lifecycle getter stays a reported crash', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'component');
  await manager.registerComponent(component);
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: (): number => {
      new Logger({ closeTimeoutMS: NaN });
      return 1000;
    },
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.startComponent('component');
    expect(result.code).toBe('operation_crashed');
    expect(result.error?.message).toContain('Logger closeTimeoutMS');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(result.error);
  } finally {
    release();
  }
});

test('a nested LifecycleManager constructor failure stays a reported getter crash', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'component');
  await manager.registerComponent(component);
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: (): number => {
      new LifecycleManager({ logger, startupTimeoutMS: NaN });
      return 1000;
    },
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.startComponent('component');
    expect(result.code).toBe('operation_crashed');
    expect(result.error?.message).toContain('startupTimeoutMS');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(result.error);
  } finally {
    release();
  }
});

test('caller option getter throwing a shared timeout error remains a reported crash', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'component'));
  const options = {
    get timeoutMS(): number {
      return foreignTimeoutFailure();
    },
  };

  const { reports, release } = claimReports();
  try {
    const result = await manager.startAllComponents(options);
    expect(result.code).toBe('operation_crashed');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(result.error);
    expect(manager.getComponentStatus('component')?.state).toBe('registered');
  } finally {
    release();
  }
});

test('component stop getter throwing a shared timeout error remains a reported crash', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'component');
  await manager.registerComponent(component);
  await manager.startComponent('component');
  Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
    get: foreignTimeoutFailure,
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.stopComponent('component');
    expect(result.code).toBe('operation_crashed');
    expect(result.reason).toContain('Stop failed unexpectedly');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(result.error);
    expect(manager.getComponentStatus('component')?.state).toBe('running');
  } finally {
    release();
  }
});

test('health timeout getter throwing a shared timeout error is reported as a check error', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'component');
  Object.defineProperty(component, 'healthCheck', {
    value: (): boolean => true,
  });
  await manager.registerComponent(component);
  await manager.startComponent('component');
  Object.defineProperty(component, 'healthCheckTimeoutMS', {
    get: foreignTimeoutFailure,
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.checkComponentHealth('component');
    expect(result.code).toBe('error');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(result.error);
  } finally {
    release();
  }
});

test('signal callback throwing a shared timeout error reports its aggregate failure', async () => {
  const { manager } = setup({
    onReloadRequested: (): void => {
      foreignTimeoutFailure();
    },
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.triggerReload();
    expect(result.code).toBe('error');
    expect(result.error?.message).toContain('caller-owned timeout');
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(result.error);
  } finally {
    release();
  }
});
