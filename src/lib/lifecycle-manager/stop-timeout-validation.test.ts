import { expect, test } from 'bun:test';
import { claimReports, deferred, Plain, setup } from './test-helpers';
import type { ComponentOperationResult } from './types';

for (const field of [
  'shutdownGracefulTimeoutMS',
  'shutdownForceTimeoutMS',
] as const) {
  test.each([NaN, -1, '15'])(
    `invalid ${field} %s refuses the stop before either phase runs`,
    async (value) => {
      const { logger, manager } = setup();
      const component = new Plain(logger, 'a');
      let stops = 0;
      component.stop = (): Promise<void> => {
        stops++;
        return Promise.resolve();
      };
      await manager.registerComponent(component);
      await manager.startComponent('a');
      Object.defineProperty(component, field, { value, configurable: true });
      const { reports, release } = claimReports();
      try {
        const result = await manager.stopComponent('a');
        expect(result.success).toBe(false);
        expect(result.code).toBe('invalid_options');
        expect(result.reason).toContain(`a.${field}`);
        expect(stops).toBe(0);
        expect(component.forceCalls).toBe(0);
        expect(manager.getComponentStatus('a')?.state).toBe('running');
        expect(reports).toEqual([]);
      } finally {
        release();
        Object.defineProperty(component, field, { value: 0 });
        await manager.stopComponent('a');
      }
    },
  );
}

test('graceful escalation reuses the force handler and both validated timeout snapshots', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  let gracefulReads = 0;
  let forceReads = 0;
  Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
    get: () => (++gracefulReads === 1 ? 0 : NaN),
  });
  Object.defineProperty(component, 'shutdownForceTimeoutMS', {
    get: () => (++forceReads === 1 ? 0 : NaN),
  });
  component.stop = (): Promise<void> => {
    component.onShutdownForce = (): never => {
      throw new Error('replacement force handler must not run');
    };
    return Promise.reject(new Error('graceful failure'));
  };
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const { release } = claimReports();
  try {
    const result = await manager.stopComponent('a');
    expect(result.success).toBe(true);
    expect(gracefulReads).toBe(1);
    expect(forceReads).toBe(1);
    expect(component.forceCalls).toBe(1);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  } finally {
    release();
  }
});

for (const field of ['onShutdownForce', 'shutdownForceTimeoutMS'] as const) {
  test(`preflight ${field} getter reentry preserves the nested stop's ownership`, async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const gate = deferred();
    let stops = 0;
    component.stop = (): Promise<void> => {
      stops++;
      return gate.promise;
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const force = (): void => {
      component.forceCalls++;
    };
    let nested: Promise<ComponentOperationResult> | undefined;
    let didReenter = false;
    Object.defineProperty(component, field, {
      get: () => {
        if (!didReenter) {
          didReenter = true;
          nested = manager.stopComponent('a');
        }
        if (field === 'onShutdownForce') {
          return force;
        }
        return 0;
      },
    });
    const outer = manager.stopComponent('a');
    try {
      expect(stops).toBe(1);
      expect((await outer).code).toBe('component_already_stopping');
      expect(component.forceCalls).toBe(0);
      expect(manager.getComponentStatus('a')?.state).toBe('stopping');
    } finally {
      gate.resolve();
      await Promise.all([outer, nested]);
    }
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });
}

test('force-immediate stop does not consult graceful configuration', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
    get: (): never => {
      throw new Error('unused graceful timeout');
    },
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const result = await manager.stopComponent('a', { forceImmediate: true });
  expect(result.success).toBe(true);
  expect(component.forceCalls).toBe(1);
});

test('a stalled force retry does not reread graceful configuration', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  component.stop = (): Promise<void> =>
    Promise.reject(new Error('stop failed'));
  component.onShutdownForce = (): never => {
    throw new Error('force failed');
  };
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const { release } = claimReports();
  try {
    expect((await manager.stopComponent('a')).success).toBe(false);
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
    Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
      get: (): never => {
        throw new Error('unused graceful configuration');
      },
    });
    component.onShutdownForce = (): void => {
      component.forceCalls++;
    };
    expect((await manager.stopAllComponents()).success).toBe(true);
    expect(component.forceCalls).toBe(1);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  } finally {
    release();
  }
});

test('a component without a force handler does not consult force configuration', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  Object.defineProperty(component, 'onShutdownForce', { value: undefined });
  Object.defineProperty(component, 'shutdownForceTimeoutMS', {
    get: (): never => {
      throw new Error('unused force timeout');
    },
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  expect((await manager.stopComponent('a')).success).toBe(true);
});

test('a force-timeout getter throwing its own TypeError is still a callback failure', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const error = new TypeError('caller getter failure');
  Object.defineProperty(component, 'shutdownForceTimeoutMS', {
    get: (): never => {
      throw error;
    },
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const { reports, release } = claimReports();
  try {
    const result = await manager.stopComponent('a');
    expect(result.code).toBe('operation_crashed');
    expect(result.error).toBe(error);
    expect(reports).toHaveLength(1);
    expect(manager.getComponentStatus('a')?.state).toBe('running');
  } finally {
    release();
  }
});

// The same refusal whether the pass stops the component itself or the start it joins
// stops it once `start()` settles.
for (const timing of ['running', 'starting'] as const) {
  test(`a shutdown pass reports an invalid stop budget on a ${timing} component as invalid_options`, async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const startGate = deferred();
    if (timing === 'starting') {
      component.start = (): Promise<void> => startGate.promise;
    }
    await manager.registerComponent(component);
    Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
      value: -5,
      configurable: true,
    });
    const starting = manager.startComponent('a');
    if (timing === 'running') {
      await starting;
    }

    const stopping = manager.stopAllComponents();
    startGate.resolve();
    const result = await stopping;
    await starting;

    expect(result.success).toBe(false);
    expect(result.code).toBe('invalid_options');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.reason).toContain('a.shutdownGracefulTimeoutMS');
    expect(manager.getComponentStatus('a')?.state).toBe('running');

    Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
      value: 1000,
    });
    expect((await manager.stopAllComponents()).success).toBe(true);
  });
}
