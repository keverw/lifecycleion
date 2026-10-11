import { describe, expect, test } from 'bun:test';
import { claimReports, deferred, Plain, setup } from './test-helpers';

class Reporter extends Plain {
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

describe('dispatch availability after lifecycle listeners', () => {
  for (const operation of ['message', 'health'] as const) {
    for (const action of ['stop', 'unregister'] as const) {
      test(`${operation} does not invoke a target invalidated by its ${action} listener`, async () => {
        const { logger, manager } = setup();
        const component = new Reporter(logger, 'target');
        const gate = deferred();
        let calls = 0;
        component.stop = () => gate.promise;
        component.onMessage = <TData>() => {
          calls++;
          return 'reply' as TData;
        };
        component.healthCheck = () => {
          calls++;
          return true;
        };
        await manager.registerComponent(component);
        await manager.startComponent('target');
        let mutation: Promise<unknown> | undefined;
        const events: string[] = [];
        const invalidate = (): void => {
          events.push('started');
          if (action === 'unregister') {
            // A running component cannot be directly unregistered. Model its
            // reported stop first, then remove the now-idle registration.
            expect(component.reportStop()).toBe(true);
          }
          mutation =
            action === 'stop'
              ? manager.stopComponent('target')
              : manager.unregisterComponent('target', { stopIfRunning: false });
        };
        manager.on(
          operation === 'message'
            ? 'component:message-sent'
            : 'component:health-check-started',
          invalidate,
        );
        manager.on(
          operation === 'message'
            ? 'component:message-failed'
            : 'component:health-check-failed',
          () => {
            events.push('failed');
          },
        );
        try {
          const result =
            operation === 'message'
              ? await manager.sendMessageToComponent('target', 'payload', {
                  includeStopped: true,
                  includeStalled: true,
                })
              : await manager.checkComponentHealth('target');
          expect(calls).toBe(0);
          expect(result.code).toBe(action === 'stop' ? 'stopped' : 'not_found');
          expect(events).toEqual(['started', 'failed']);
          if ('sent' in result) {
            expect(result.sent).toBe(false);
            expect(result.componentRunning).toBe(false);
          } else {
            expect(result.healthy).toBe(false);
          }
        } finally {
          gate.resolve();
          await mutation;
          await manager.stopAllComponents();
          await logger.close();
        }
      });
    }
  }
});

for (const signal of ['reload', 'info', 'debug'] as const) {
  for (const outcome of ['unavailable', 'timeout'] as const) {
    test(`${signal} pairs started with failed and reports ${outcome}`, async () => {
      const { logger, manager } = setup();
      const component = new Reporter(logger, 'target');
      const gate = deferred();
      let calls = 0;
      const handler = () => {
        calls++;
        return gate.promise;
      };
      component.onReload = handler;
      component.onInfo = handler;
      component.onDebug = handler;
      Object.defineProperty(component, 'signalTimeoutMS', { value: 5 });
      await manager.registerComponent(component);
      await manager.startComponent('target');
      const events: string[] = [];
      manager.on(`component:${signal}-started`, () => {
        events.push('started');
        if (outcome === 'unavailable') {
          component.reportStop();
        }
      });
      manager.on(`component:${signal}-failed`, () => {
        events.push('failed');
      });
      manager.on(`component:${signal}-completed`, () => {
        events.push('completed');
      });
      try {
        const result =
          signal === 'reload'
            ? await manager.triggerReload()
            : signal === 'info'
              ? await manager.triggerInfo()
              : await manager.triggerDebug();
        expect(result.code).toBe(
          outcome === 'unavailable' ? 'error' : 'timeout',
        );
        expect(result.results[0]?.code).toBe(outcome);
        expect(calls).toBe(outcome === 'unavailable' ? 0 : 1);
        expect(events).toEqual(['started', 'failed']);
        gate.resolve();
        await Promise.resolve();
        expect(events).toEqual(['started', 'failed']);
      } finally {
        gate.resolve();
        await manager.stopAllComponents();
        await logger.close();
      }
    });
  }
}

for (const action of ['stop', 'unregister', 'replace'] as const) {
  test(`getValue refuses its captured provider after its getter performs ${action}`, async () => {
    const { logger, manager } = setup();
    const component = new Reporter(logger, 'target');
    const gate = deferred();
    component.stop = () => gate.promise;
    await manager.registerComponent(component);
    await manager.startComponent('target');
    let calls = 0;
    let mutation: Promise<unknown> | undefined;
    let replacement: Promise<unknown> | undefined;
    Object.defineProperty(component, 'getValue', {
      get() {
        if (action === 'stop') {
          mutation = manager.stopComponent('target');
        } else {
          component.reportStop();
          mutation = manager.unregisterComponent('target', {
            stopIfRunning: false,
          });
          if (action === 'replace') {
            replacement = manager.registerComponent(
              new Plain(logger, 'target'),
            );
          }
        }
        return () => {
          calls++;
          return { found: true, value: 'stale' };
        };
      },
    });
    const events: string[] = [];
    manager.on('component:value-requested', () => {
      events.push('requested');
    });
    manager.on('component:value-returned', () => {
      events.push('returned');
    });
    try {
      const result = manager.getValue('target', 'key', {
        includeStopped: true,
        includeStalled: true,
      });
      expect(calls).toBe(0);
      expect(result.code).toBe(action === 'stop' ? 'stopped' : 'not_found');
      expect(result.found).toBe(false);
      expect(result.componentRunning).toBe(false);
      expect(events).toEqual(['requested', 'returned']);
    } finally {
      gate.resolve();
      await mutation;
      await replacement;
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

for (const action of ['stop', 'unregister', 'replace'] as const) {
  test(`getValue rechecks availability after its getter performs ${action} and throws`, async () => {
    const { logger, manager } = setup();
    const component = new Reporter(logger, 'target');
    const gate = deferred();
    component.stop = () => gate.promise;
    await manager.registerComponent(component);
    await manager.startComponent('target');
    const { reports, release } = claimReports();
    const failure = new Error('Provider getter failed after mutation');
    let mutation: Promise<unknown> | undefined;
    let replacement: Promise<unknown> | undefined;
    Object.defineProperty(component, 'getValue', {
      get() {
        if (action === 'stop') {
          mutation = manager.stopComponent('target');
        } else {
          component.reportStop();
          mutation = manager.unregisterComponent('target', {
            stopIfRunning: false,
          });
          if (action === 'replace') {
            replacement = manager.registerComponent(
              new Plain(logger, 'target'),
            );
          }
        }
        throw failure;
      },
    });
    const events: string[] = [];
    manager.on('component:value-requested', () => {
      events.push('requested');
    });
    manager.on('component:value-returned', () => {
      events.push('returned');
    });
    try {
      const result = manager.getValue('target', 'key', {
        includeStopped: true,
        includeStalled: true,
      });
      expect(reports).toHaveLength(1);
      expect((reports[0] as Error).cause).toBe(failure);
      expect(result.componentFound).toBe(action === 'stop');
      expect(result.handlerImplemented).toBe(false);
      expect(result.code).toBe(action === 'stop' ? 'stopped' : 'not_found');
      expect(result.found).toBe(false);
      expect(result.componentRunning).toBe(false);
      expect(events).toEqual(['requested', 'returned']);
    } finally {
      release();
      gate.resolve();
      await mutation;
      await replacement;
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test('signal broadcast reports partial_error when another target is unavailable', async () => {
  const { logger, manager } = setup();
  const unavailable = new Reporter(logger, 'unavailable');
  const available = new Plain(logger, 'available');
  let calls = 0;
  unavailable.onReload = () => {
    throw new Error('Must not be called');
  };
  available.onReload = () => {
    calls++;
  };
  await manager.registerComponent(unavailable);
  await manager.registerComponent(available);
  await manager.startAllComponents();
  manager.on<{ name: string }>('component:reload-started', ({ name }) => {
    if (name === 'unavailable') {
      unavailable.reportStop();
    }
  });
  try {
    const result = await manager.triggerReload();
    expect(result.code).toBe('partial_error');
    expect(result.results.map(({ code }) => code)).toEqual([
      'unavailable',
      'called',
    ]);
    expect(calls).toBe(1);
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});

test.each([false, true])(
  'message reports dispatch availability after listener stops target (throws=%s)',
  async (doesThrow) => {
    const { logger, manager } = setup();
    const component = new Reporter(logger, 'target');
    component.onMessage = <TData>() => {
      if (doesThrow) {
        throw new Error('handler failed');
      }
      return 'reply' as TData;
    };
    await manager.registerComponent(component);
    await manager.startComponent('target');
    manager.on('component:message-sent', () => {
      component.reportStop();
    });
    const failed: Array<{ componentRunning: boolean }> = [];
    manager.on<{ componentRunning: boolean }>(
      'component:message-failed',
      (event) => {
        failed.push(event);
      },
    );
    try {
      const result = await manager.sendMessageToComponent('target', 'payload', {
        includeStopped: true,
      });
      expect(result.code).toBe(doesThrow ? 'error' : 'sent');
      expect(result.componentRunning).toBe(false);
      if (doesThrow) {
        expect(failed).toMatchObject([{ componentRunning: false }]);
      }
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  },
);
