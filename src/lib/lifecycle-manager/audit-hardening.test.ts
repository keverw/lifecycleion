import { expect, test } from 'bun:test';
import { LifecycleManager } from './lifecycle-manager';
import { sleep } from '../sleep';
import { deferred, Plain, setup } from './test-helpers';

for (const failedRead of [1, 2]) {
  test(`startup observation failure on constructor read ${failedRead} aborts and owns late cleanup`, async () => {
    const { logger, manager } = setup({ startupTimeoutMS: 50 });
    const gate = deferred();
    const component = new Plain(logger, 'api');
    Object.defineProperty(component, 'startupTimeoutMS', { value: 50 });
    const failure = new Error('cannot observe startup');
    let signal: AbortSignal | undefined;
    let stops = 0;
    let reads = 0;
    void Object.defineProperty(gate.promise, 'constructor', {
      get: () => {
        if (++reads === failedRead) {
          throw failure;
        }
        return Promise;
      },
    });
    component.start = (startSignal) => {
      signal = startSignal;
      return gate.promise;
    };
    component.stop = () => {
      stops++;
      return Promise.resolve();
    };
    await manager.registerComponent(component);
    try {
      expect((await manager.startComponent('api')).error).toBe(failure);
      expect(signal?.aborted).toBe(true);
      expect((await manager.unregisterComponent('api')).code).toBe(
        'component_starting',
      );
      expect(
        (await manager.restartAllComponents()).shutdownResult.reason,
      ).toContain('Abandoned start');
      gate.resolve();
      expect(
        (await manager.stopAllComponents({ waitForAbandonedStarts: true }))
          .success,
      ).toBe(true);
      expect(stops).toBe(1);
      expect(manager.getComponentStatus('api')?.lastError).toBe(failure);
    } finally {
      gate.resolve();
      await logger.close();
    }
  });
}

test('shutdown continues after a shutdown option getter reports an unexpected stop', async () => {
  const { logger, manager } = setup();
  const a = new Plain(logger, 'a');
  const b = new Plain(logger, 'b');
  await manager.registerComponent(a);
  await manager.registerComponent(b);
  await manager.startAllComponents();
  Object.defineProperty(b, 'shutdownGracefulTimeoutMS', {
    get: () => {
      (
        b as unknown as { reportUnexpectedStop: () => void }
      ).reportUnexpectedStop();
      return 50;
    },
  });
  try {
    expect((await manager.stopAllComponents()).success).toBe(true);
    expect(manager.getRunningComponentNames()).toEqual([]);
  } finally {
    await logger.close();
  }
});

test('untyped false strings do not enable signal attachment or manual escalation', async () => {
  const { logger, manager } = setup({
    attachSignalsBeforeStartup: 'false' as unknown as boolean,
    attachSignalsOnStart: 'false' as unknown as boolean,
    detachSignalsOnStop: 'false' as unknown as boolean,
    repeatedShutdownRequestPolicy: {
      countManualRetriesTowardEscalation: 'false' as unknown as boolean,
      onForceShutdown: () => {
        throw new Error('unexpected escalation');
      },
    },
  });
  let attachments = 0;
  let detachments = 0;
  manager.attachSignals = () => {
    attachments++;
  };
  manager.detachSignals = () => {
    detachments++;
  };
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.startComponent('a');
  await manager.stopAllComponents();
  expect(attachments).toBe(0);
  expect(detachments).toBe(0);
  expect(manager.getShutdownEscalationStatus()).toMatchObject({
    countManualRetriesTowardEscalation: false,
  });
  await logger.close();
});

test('late startup cleanup that stalls retains its timeout after stop eventually fulfills', async () => {
  const { logger, manager } = setup({ startupTimeoutMS: 5 });
  const gate = deferred();
  const stopGate = deferred();
  const component = new Plain(logger, 'api');
  Object.defineProperties(component, {
    startupTimeoutMS: { value: 5 },
    shutdownGracefulTimeoutMS: { value: 5 },
    onShutdownForce: { value: undefined },
  });
  component.start = () => gate.promise;
  component.stop = () => stopGate.promise;
  await manager.registerComponent(component);
  try {
    const result = await manager.startComponent('api');
    expect(result.code).toBe('component_startup_timeout');
    gate.resolve();
    for (
      let n = 0;
      n < 100 && manager.getComponentStatus('api')?.state !== 'stalled';
      n++
    ) {
      await sleep(5);
    }
    expect(manager.getComponentStatus('api')?.state).toBe('stalled');
    stopGate.resolve();
    await sleep(0);
    expect(manager.getComponentStatus('api')).toMatchObject({
      state: 'starting-timed-out',
      lastError: result.error,
    });
  } finally {
    gate.resolve();
    stopGate.resolve();
    await logger.close();
  }
});

test('unregister cannot remove a fulfilled timed-out start before recovery claims cleanup', async () => {
  const { logger, manager } = setup({ startupTimeoutMS: 5 });
  const gate = deferred();
  const component = new Plain(logger, 'api');
  Object.defineProperty(component, 'startupTimeoutMS', { value: 5 });
  let stops = 0;
  component.start = () => gate.promise;
  component.stop = () => {
    stops++;
    return Promise.resolve();
  };
  await manager.registerComponent(component);
  try {
    expect((await manager.startComponent('api')).code).toBe(
      'component_startup_timeout',
    );
    const unregister = gate.promise.then(() =>
      manager.unregisterComponent('api'),
    );
    gate.resolve();
    expect((await unregister).success).toBe(false);
    await manager.stopAllComponents({ waitForAbandonedStarts: true });
    expect(stops).toBe(1);
    expect((await manager.unregisterComponent('api')).success).toBe(true);
  } finally {
    gate.resolve();
    await logger.close();
  }
});

test('shutdown initiation is delivered before dependency getters and pending-start abort listeners', async () => {
  const { logger, manager } = setup({ startupTimeoutMS: 0 });
  const gate = deferred();
  const component = new Plain(logger, 'api');
  const order: string[] = [];
  component.start = (signal) => {
    signal?.addEventListener('abort', () => {
      order.push('abort');
      gate.resolve();
    });
    return gate.promise;
  };
  await manager.registerComponent(component);
  const startup = manager.startComponent('api');
  component.getDependencies = () => {
    order.push('dependencies');
    return [];
  };
  manager.on('lifecycle-manager:shutdown-initiated', () => {
    order.push('initiated');
  });
  try {
    await manager.stopAllComponents({ abortPendingStarts: true });
    await startup;
    expect(order[0]).toBe('initiated');
    expect(order).toContain('abort');
    expect(order).toContain('dependencies');
  } finally {
    gate.resolve();
    await logger.close();
  }
});

test('a stop uses internal running state even when a subclass hides it', async () => {
  const { logger } = setup();
  class HiddenRunningManager extends LifecycleManager {
    public override isComponentRunning(): boolean {
      return false;
    }
  }
  const manager = new HiddenRunningManager({ logger });
  await manager.registerComponent(new Plain(logger, 'api'));
  await manager.startComponent('api');
  expect((await manager.stopComponent('api')).success).toBe(true);
  expect(manager.getComponentStatus('api')?.state).toBe('stopped');
  await logger.close();
});

test('a native startup that permanently refuses adoption stays owned and receives an abort', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const failure = new Error('constructor permanently unreadable');
  const component = new Plain(logger, 'api');
  let signal: AbortSignal | undefined;
  void Object.defineProperty(gate.promise, 'constructor', {
    get: () => {
      throw failure;
    },
  });
  component.start = (startSignal) => {
    signal = startSignal;
    return gate.promise;
  };
  await manager.registerComponent(component);
  try {
    expect((await manager.startComponent('api')).error).toBe(failure);
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await sleep(0);
    expect((await manager.unregisterComponent('api')).code).toBe(
      'component_starting',
    );
    expect((await manager.stopAllComponents()).code).toBe('cleanup_incomplete');
    expect((await manager.restartAllComponents()).shutdownResult.code).toBe(
      'cleanup_incomplete',
    );
  } finally {
    gate.resolve();
    await logger.close();
  }
});
