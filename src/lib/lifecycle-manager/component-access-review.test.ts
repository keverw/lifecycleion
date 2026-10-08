import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, hasReport, Plain, setup } from './test-helpers';

// Regressions for the component access review: messaging, value reads, health checks
// and signal broadcasts. Each test pins one behavior the fix changed.

class Receiver extends Plain {
  public messages = 0;
  public onMessage<TData>(): TData {
    this.messages++;
    return 'reply' as TData;
  }
}

test('a broadcast selects its targets after its option getters run', async () => {
  const { logger, manager } = setup();
  const kept = new Receiver(logger, 'kept');
  const removed = new Receiver(logger, 'removed');
  const added = new Receiver(logger, 'added');
  await manager.registerComponent(kept);
  await manager.registerComponent(removed);
  await manager.startComponent('kept');

  try {
    const results = await manager.broadcastMessage('payload', {
      includeStopped: true,
      get timeout() {
        void manager.unregisterComponent('removed');
        void manager.registerComponent(added);
        return 100;
      },
    });

    // No row for the component the getter removed, and the one it added is sent to.
    expect(results.map(({ name, code }) => [name, code])).toEqual([
      ['kept', 'sent'],
      ['added', 'sent'],
    ]);
    expect(removed.messages).toBe(0);
    expect(added.messages).toBe(1);
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a componentNames filter Array.isArray cannot classify is refused, not reported', async () => {
  const warnings: string[] = [];
  const logger = new Logger({
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
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const component = new Receiver(logger, 'target');
  await manager.registerComponent(component);
  await manager.startComponent('target');
  const { proxy, revoke } = Proxy.revocable<string[]>([], {});
  revoke();
  const { reports, release } = claimReports();

  try {
    expect(
      await manager.broadcastMessage('payload', { componentNames: proxy }),
    ).toEqual([]);
    expect(reports).toEqual([]);
    expect(warnings).toEqual([
      'Broadcast refused: broadcastMessage componentNames must be an array',
    ]);
    expect(component.messages).toBe(0);
  } finally {
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a value read that crashes after value-requested still emits value-returned', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Receiver(logger, 'target'));
  await manager.startComponent('target');
  const events: Array<[string, unknown]> = [];
  manager.on('component:value-requested', () => {
    events.push(['requested', undefined]);
  });
  manager.on('component:value-returned', (data) => {
    events.push(['returned', (data as { code: string }).code]);
  });
  // A seam the availability read forwards to, failing only after the requested event.
  const internals = manager as unknown as {
    isComponentRunning: (name: string) => boolean;
  };
  const original = internals.isComponentRunning;
  internals.isComponentRunning = (): never => {
    throw new Error('availability exploded');
  };
  const { reports, release } = claimReports();

  try {
    const result = manager.getValue('target', 'key');

    expect(result.code).toBe('operation_crashed');
    expect(result.componentFound).toBe(true);
    expect(result.error?.message).toBe('availability exploded');
    expect(events).toEqual([
      ['requested', undefined],
      ['returned', 'operation_crashed'],
    ]);
    // Reported once, as the safety net would have.
    expect(reports).toHaveLength(1);
    expect(hasReport(reports, 'lifecycle-manager getValue')).toBe(true);
    expect((reports[0] as Error).cause).toBe(result.error);
  } finally {
    internals.isComponentRunning = original;
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a timeout refusal a health-check-failed listener rethrows from another getter is a crash', async () => {
  const { logger, manager } = setup();
  const invalid = new Receiver(logger, 'invalid');
  const rethrows = new Receiver(logger, 'rethrows');
  const healthy = (): boolean => true;
  Object.assign(invalid, { healthCheck: healthy });
  Object.assign(rethrows, { healthCheck: healthy });
  Object.defineProperty(invalid, 'healthCheckTimeoutMS', { value: -1 });
  let captured: unknown;
  Object.defineProperty(rethrows, 'healthCheckTimeoutMS', {
    get(): never {
      throw captured;
    },
  });
  await manager.registerComponent(invalid);
  await manager.registerComponent(rethrows);
  await manager.startAllComponents();
  manager.on('component:health-check-failed', (data) => {
    const { name, error } = data as { name: string; error: Error };
    if (name === 'invalid') {
      captured = error;
    }
  });
  const { reports, release } = claimReports();

  try {
    const report = await manager.checkAllHealth();
    const codes = report.components.map(({ name, code }) => [name, code]);

    // The refusal is still the invalid component's own; rethrown by another
    // component's getter, it is that getter's failure.
    expect(codes).toEqual([
      ['invalid', 'invalid_options'],
      ['rethrows', 'operation_crashed'],
    ]);
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(captured);
  } finally {
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a timeout refusal a reload-failed listener rethrows from another getter is a crash', async () => {
  const { logger, manager } = setup();
  const invalid = new Receiver(logger, 'invalid');
  const rethrows = new Receiver(logger, 'rethrows');
  const onReload = (): void => {};
  Object.assign(invalid, { onReload });
  Object.assign(rethrows, { onReload });
  Object.defineProperty(invalid, 'signalTimeoutMS', { value: -1 });
  let captured: unknown;
  Object.defineProperty(rethrows, 'signalTimeoutMS', {
    get(): never {
      throw captured;
    },
  });
  await manager.registerComponent(invalid);
  await manager.registerComponent(rethrows);
  await manager.startAllComponents();
  manager.on('component:reload-failed', (data) => {
    const { name, error } = data as { name: string; error: Error };
    if (name === 'invalid') {
      captured = error;
    }
  });
  const { reports, release } = claimReports();

  try {
    const result = await manager.triggerReload();
    const codes = result.results.map(({ name, code }) => [name, code]);

    expect(codes).toEqual([
      ['invalid', 'invalid_options'],
      ['rethrows', 'operation_crashed'],
    ]);
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(captured);
  } finally {
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});
