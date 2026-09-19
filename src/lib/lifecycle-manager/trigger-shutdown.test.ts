import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { sleep } from '../sleep';

function setup() {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  return {
    logger,
    manager: new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 }),
  };
}

class SlowStop extends BaseComponent {
  public stopEntered = false;
  constructor(
    logger: Logger,
    name: string,
    private readonly delayMS: number,
  ) {
    super(logger, { name, dependencies: [] });
  }
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {
    this.stopEntered = true;
    await sleep(this.delayMS);
  }
}

describe('LifecycleManager - triggerShutdown()', () => {
  test('acknowledges immediately while the shutdown runs in the background', async () => {
    const { logger, manager } = setup();
    const component = new SlowStop(logger, 'slow', 120);
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const completed: boolean[] = [];
    manager.on('lifecycle-manager:shutdown-completed', () => {
      completed.push(true);
    });

    const startedAt = Date.now();
    const ack = await manager.triggerShutdown();
    const ackDurationMS = Date.now() - startedAt;

    expect(ack.initiated).toBe(true);
    expect(ack.code).toBe('initiated');
    expect(typeof ack.reason).toBe('string');

    // Returned well before the component's stop could have finished.
    expect(ackDurationMS).toBeLessThan(100);
    // Still mid-stop: a component in `stopping` stays in runningComponents
    // until its stop settles, so the state is the meaningful signal here.
    expect(manager.getComponentStatus('slow')?.state).toBe('stopping');
    expect(component.stopEntered).toBe(true);
    expect(completed.length).toBe(0);

    await sleep(250);
    expect(completed.length).toBe(1);
    expect(manager.getComponentStatus('slow')?.state).toBe('stopped');
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  });

  test('reports already_in_progress without starting a second pass', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 120));
    await manager.startAllComponents();

    let initiatedCount = 0;
    manager.on('lifecycle-manager:shutdown-initiated', () => {
      initiatedCount++;
    });

    const first = await manager.triggerShutdown();
    const second = await manager.triggerShutdown();

    expect(first.initiated).toBe(true);
    expect(second.initiated).toBe(false);
    expect(second.code).toBe('already_in_progress');

    await sleep(250);
    expect(initiatedCount).toBe(1);
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  });

  test('does not emit signal:shutdown for a manual request', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const signals: unknown[] = [];
    manager.on('signal:shutdown', (payload) => {
      signals.push(payload);
    });
    const initiated: unknown[] = [];
    manager.on('lifecycle-manager:shutdown-initiated', (payload) => {
      initiated.push(payload);
    });

    await manager.triggerShutdown();
    await sleep(120);

    expect(signals.length).toBe(0);
    expect(initiated.length).toBe(1);
  });

  test('a failing shutdown still resolves the acknowledgement', async () => {
    const { logger, manager } = setup();

    class Hanging extends BaseComponent {
      public async start(): Promise<void> {}
      public stop(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }

    await manager.registerComponent(
      new Hanging(logger, { name: 'hanging', dependencies: [] }),
    );
    await manager.startAllComponents();

    const ack = await manager.triggerShutdown();
    expect(ack.initiated).toBe(true);

    // The acknowledgement says nothing about the outcome; the component is
    // still stopping at this point.
    expect(manager.getComponentStatus('hanging')?.state).toBe('stopping');
  });
});
