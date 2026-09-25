import { describe, expect, test } from 'bun:test';
import { deferred, Plain, setup } from './test-helpers';
import type { ComponentOperationResult, StopComponentOptions } from './types';

class Reporter extends Plain {
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

describe('LifecycleManager stop ownership after caller property reads', () => {
  for (const property of [
    'onGracefulStopTimeout',
    'shutdownGracefulTimeoutMS',
    'timeout',
  ] as const) {
    test(`a re-entrant ${property} getter cannot make two stops own the component`, async () => {
      const { logger, manager } = setup();
      const component = new Plain(logger, 'a');
      const gate = deferred();
      let stopCalls = 0;
      component.stop = (): Promise<void> => {
        stopCalls++;
        return gate.promise;
      };
      await manager.registerComponent(component);
      await manager.startComponent('a');
      const options: StopComponentOptions = {};
      let nested: Promise<ComponentOperationResult> | undefined;
      let didReenter = false;
      Object.defineProperty(
        property === 'timeout' ? options : component,
        property,
        {
          configurable: true,
          get: () => {
            if (!didReenter) {
              didReenter = true;
              nested = manager.stopComponent('a');
            }
            return property === 'onGracefulStopTimeout' ? undefined : 0;
          },
        },
      );
      const outer = manager.stopComponent('a', options);
      try {
        // The nested stop owns the pending hook. Refusing the outer attempt must
        // neither invoke stop twice nor escalate the other attempt into force.
        expect(stopCalls).toBe(1);
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

  test('clearing the unexpected-stop handler cannot re-enter ahead of the claim', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const gate = deferred();
    let stopCalls = 0;
    component.stop = (): Promise<void> => {
      stopCalls++;
      return gate.promise;
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const clear = component._clearUnexpectedStopHandler.bind(component);
    let nested: Promise<ComponentOperationResult> | undefined;
    let didReenter = false;
    component._clearUnexpectedStopHandler = (): void => {
      if (!didReenter) {
        didReenter = true;
        nested = manager.stopComponent('a');
      }
      clear();
    };
    const outer = manager.stopComponent('a');
    try {
      expect(stopCalls).toBe(1);
      expect((await nested)?.code).toBe('component_already_stopping');
      expect(component.forceCalls).toBe(0);
    } finally {
      gate.resolve();
      await outer;
    }
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('a timeout getter that unregisters and replaces its stopped component cannot stop the replacement', async () => {
    const { logger, manager } = setup();
    const original = new Reporter(logger, 'a');
    const replacement = new Plain(logger, 'a');
    let stopCalls = 0;
    original.stop = (): Promise<void> => {
      stopCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(original);
    await manager.startComponent('a');
    let unregister: ReturnType<typeof manager.unregisterComponent> | undefined;
    let register: ReturnType<typeof manager.registerComponent> | undefined;
    Object.defineProperty(original, 'shutdownGracefulTimeoutMS', {
      get: () => {
        original.reportStop();
        unregister = manager.unregisterComponent('a');
        register = manager.registerComponent(replacement);
        return 0;
      },
    });
    const result = await manager.stopComponent('a');
    await Promise.all([unregister, register]);
    expect(result.code).toBe('component_not_found');
    expect(stopCalls).toBe(0);
    expect(original.forceCalls).toBe(0);
    expect(manager.getComponentInstance('a')).toBe(replacement);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });
});
