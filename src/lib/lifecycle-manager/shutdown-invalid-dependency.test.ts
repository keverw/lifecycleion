import { expect, test } from 'bun:test';
import { claimReports, Plain, setup } from './test-helpers';

test('continuing after invalid component timeout keeps its dependencies running', async () => {
  const { logger, manager } = setup();
  const dependency = new Plain(logger, 'dependency');
  const independent = new Plain(logger, 'independent');
  const refused = new Plain(logger, 'refused', ['dependency']);
  const stops: string[] = [];
  for (const component of [dependency, independent, refused]) {
    component.stop = (): Promise<void> => {
      stops.push(component.getName());
      return Promise.resolve();
    };
    await manager.registerComponent(component);
  }
  expect((await manager.startAllComponents()).success).toBe(true);

  let timeout = NaN;
  Object.defineProperty(refused, 'shutdownGracefulTimeoutMS', {
    configurable: true,
    get: () => timeout,
  });

  const { reports, release } = claimReports();
  try {
    const result = await manager.stopAllComponents({ haltOnStall: false });
    expect(result.success).toBe(false);
    expect(result.code).toBe('invalid_options');
    expect(result.error?.message).toContain(
      'refused.shutdownGracefulTimeoutMS',
    );
    expect(result.stalledComponents).toEqual([]);
    expect(stops).toEqual(['independent']);
    expect(manager.getComponentStatus('refused')?.state).toBe('running');
    expect(manager.getComponentStatus('dependency')?.state).toBe('running');
    expect(manager.getComponentStatus('independent')?.state).toBe('stopped');
    expect(reports).toEqual([]);

    timeout = 1000;
    const recovered = await manager.stopAllComponents({ haltOnStall: false });
    expect(recovered.success).toBe(true);
    expect(stops).toEqual(['independent', 'refused', 'dependency']);
  } finally {
    release();
  }
});

test('default halt keeps remaining components untouched after invalid timeout', async () => {
  const { logger, manager } = setup();
  const independent = new Plain(logger, 'independent');
  const refused = new Plain(logger, 'refused');
  let independentStops = 0;
  independent.stop = (): Promise<void> => {
    independentStops++;
    return Promise.resolve();
  };
  await manager.registerComponent(independent);
  await manager.registerComponent(refused);
  expect((await manager.startAllComponents()).success).toBe(true);
  Object.defineProperty(refused, 'shutdownGracefulTimeoutMS', {
    configurable: true,
    value: NaN,
  });

  const result = await manager.stopAllComponents();
  expect(result.code).toBe('invalid_options');
  expect(independentStops).toBe(0);
  expect(manager.getComponentStatus('independent')?.state).toBe('running');
  Object.defineProperty(refused, 'shutdownGracefulTimeoutMS', { value: 1000 });
  expect((await manager.stopAllComponents()).success).toBe(true);
});

test('continuing after a throwing stop getter protects the still-running component dependencies', async () => {
  const { logger, manager } = setup();
  const dependency = new Plain(logger, 'dependency');
  const independent = new Plain(logger, 'independent');
  const refused = new Plain(logger, 'refused', ['dependency']);
  const stops: string[] = [];
  for (const component of [dependency, independent, refused]) {
    component.stop = () => {
      stops.push(component.getName());
      return Promise.resolve();
    };
    await manager.registerComponent(component);
  }
  await manager.startAllComponents();
  const failure = new Error('cannot read graceful timeout hook');
  Object.defineProperty(refused, 'onGracefulStopTimeout', {
    configurable: true,
    get() {
      throw failure;
    },
  });
  const { reports, release } = claimReports();
  try {
    const result = await manager.stopAllComponents({ haltOnStall: false });
    expect(result.success).toBe(false);
    expect(result.stalledComponents).toEqual([]);
    expect(stops).toEqual(['independent']);
    expect(manager.isComponentRunning('refused')).toBe(true);
    expect(manager.isComponentRunning('dependency')).toBe(true);
    expect(reports).toHaveLength(1);
    Object.defineProperty(refused, 'onGracefulStopTimeout', {
      value: undefined,
    });
    expect(
      (await manager.stopAllComponents({ haltOnStall: false })).success,
    ).toBe(true);
    expect(stops).toEqual(['independent', 'refused', 'dependency']);
  } finally {
    release();
  }
});
