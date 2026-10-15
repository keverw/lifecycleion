import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import { BaseComponent } from './base-component';

class Component extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public onStart: () => void | Promise<void> = () => {};
  public async start() {
    this.starts++;
    await this.onStart();
  }
  public stop() {
    this.stops++;
  }
  public reportStopped() {
    this.reportUnexpectedStop();
  }
}

test.each([
  'success',
  'required failure',
  'deadline',
  'deadline required stop',
  'shutdown',
] as const)(
  'final optional-stop reconciliation drains newly deferred starts under bulk policy (%s)',
  async (outcome) => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      startupTimeoutMS: 10_000,
      shutdownWarningTimeoutMS: -1,
    });
    const survivor = new Component(logger, { name: 'survivor' });
    const root = new Component(logger, { name: 'root', optional: true });
    const bad = new Component(logger, {
      name: 'bad',
      dependencies: ['missing'],
    });
    const skipped = new Component(logger, {
      name: 'skipped',
      dependencies: ['bad'],
    });
    const late = new Component(logger, {
      name: 'late',
      dependencies: ['survivor'],
    });
    const nested = new Component(logger, {
      name: 'nested',
      dependencies: ['late'],
    });
    let optionalReads = 0;
    // Tolerate bad's own failure, then skip its dependent. That last skip reports
    // root stopped, leaving its optional failure for final reconciliation.
    bad.isOptional = () => ++optionalReads === 1;
    manager.once('component:start-skipped', () => root.reportStopped());
    let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
    let registration: ReturnType<typeof manager.registerComponent> | undefined;
    const realNow = Date.now;
    let now = realNow();
    logger.addSink({
      write(entry) {
        if (
          outcome === 'deadline required stop' &&
          entry.template ===
            'Startup timeout exceeded, returning partial results'
        ) {
          survivor.reportStopped();
        }
        if (
          entry.template.startsWith(
            'Optional component stopped unexpectedly during startup, continuing:',
          )
        ) {
          registration = manager.registerComponent(late, { autoStart: true });
          if (outcome === 'deadline' || outcome === 'deadline required stop') {
            now += 10_001;
          }
          if (outcome === 'shutdown') {
            shutdown = manager.stopAllComponents();
          }
        }
      },
    });
    late.onStart = async () => {
      if (outcome === 'required failure') {
        throw new Error('reconciliation follow-up failed');
      }
      expect(
        await manager.registerComponent(nested, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
    };
    for (const component of [survivor, root, bad, skipped]) {
      await manager.registerComponent(component);
    }
    Date.now = () => now;
    try {
      const result = await manager.startAllComponents();
      expect(await registration).toMatchObject({
        autoStartDeferred: true,
        autoStartAttempted: false,
      });
      expect(result.failedOptionalComponents.map(({ name }) => name)).toEqual([
        'bad',
        'root',
      ]);
      expect(result.skippedDueToDependency).toEqual(['skipped']);
      if (outcome === 'success') {
        expect(result.success).toBe(true);
        expect(result.startedComponents).toEqual([
          'survivor',
          'late',
          'nested',
        ]);
        expect([late.starts, nested.starts, survivor.stops]).toEqual([1, 1, 0]);
      } else if (outcome === 'required failure') {
        expect(result.code).toBe('required_component_failed');
        expect(result.startedComponents).toEqual([]);
        expect(late.starts).toBe(1);
        expect(survivor.stops).toBe(1);
      } else if (outcome === 'deadline required stop') {
        // A known required failure wins before the final timeout summary.
        expect(
          sink.logs.some(
            (entry) => entry.message === 'Startup completed with timeout',
          ),
        ).toBe(false);

        expect(result.code).toBe('component_unexpected_stop');
        expect(result.startedComponents).toEqual([]);
        expect(late.starts).toBe(0);
      } else if (outcome === 'shutdown') {
        expect(result.code).toBe('shutdown_in_progress');
        expect(late.starts).toBe(0);
        await shutdown;
      } else {
        expect(result.code).toBe('startup_timeout');
        expect(result.startedComponents).toEqual(['survivor']);
        expect(late.starts).toBe(0);
      }
      const warnings = sink.logs.filter((entry) =>
        entry.message.includes('deferred auto-starts were not attempted'),
      );
      expect(warnings).toHaveLength(
        outcome === 'deadline' ||
          outcome === 'deadline required stop' ||
          outcome === 'shutdown'
          ? 1
          : 0,
      );
      if (outcome === 'deadline') {
        expect(warnings[0].params).toMatchObject({
          components: ['late'],
          reason: 'timed out',
        });
      }
    } finally {
      Date.now = realNow;
      await shutdown;
      await manager.stopAllComponents();
    }
  },
);
