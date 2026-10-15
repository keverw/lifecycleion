import { afterEach, expect, test } from 'bun:test';
import type { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { Plain, setup } from './test-helpers';

// A required component whose own `start()` never settles, with a short own timeout.
class Hangs extends BaseComponent {
  constructor(logger: Logger, name: string, dependencies: string[] = []) {
    super(logger, { name, dependencies, startupTimeoutMS: 50 });
  }

  public start(): Promise<void> {
    return new Promise<void>(() => {});
  }

  public async stop(): Promise<void> {}
}

interface CapturedTimer {
  callback: () => void;
  ms: number | undefined;
  handle: ReturnType<typeof setTimeout>;
}

const realSetTimeout = globalThis.setTimeout;
let captured: CapturedTimer[] = [];

// Captures every timer created while installed, so the test fires them in a chosen
// order. Each still gets a real (never-firing) handle, so `clearTimeout()` keeps working.
function captureTimers(): void {
  captured = [];
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    const handle = realSetTimeout(() => {}, 2 ** 31 - 1);
    captured.push({ callback, ms, handle });
    return handle;
  }) as typeof setTimeout;
}

function restoreTimers(): void {
  globalThis.setTimeout = realSetTimeout;
  for (const timer of captured) {
    clearTimeout(timer.handle);
  }
}

afterEach(() => {
  restoreTimers();
});

test("a required component's own startup timeout still rolls back when the bulk deadline also passes", async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'a'));
  // No dependency on `a`: its unfinished start would otherwise keep `a` up through
  // the rollback, as documented for dependencies of unfinished starts.
  await manager.registerComponent(new Hangs(logger, 'b'));

  captureTimers();
  const pending = manager.startAllComponents({ timeoutMS: 10_000 });

  // The bulk deadline's timer is the first one the startup creates.
  const bulkTimer = captured[0];
  expect(bulkTimer?.ms).toBe(10_000);

  // Wait until `b`'s own 50ms timer exists: `a` is up and `b` is starting.
  while (!captured.some((timer) => timer.ms === 50)) {
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 0);
    });
  }
  const ownTimer = captured.find((timer) => timer.ms === 50);

  // `b`'s own timeout fires first, then the bulk deadline, before the startup loop
  // gets to see `b`'s result.
  ownTimer?.callback();
  bulkTimer?.callback();
  restoreTimers();

  const result = await pending;

  // The component's own timeout is a required failure: rolled back, not a bulk timeout.
  expect(result.success).toBe(false);
  expect(result.code).toBe('required_component_failed');
  expect(result.timedOut).not.toBe(true);
  expect(result.startedComponents).toEqual([]);
  expect(manager.isComponentRunning('a')).toBe(false);
  expect(manager.getComponentStatus('b')?.state).toBe('starting-timed-out');
});

test('a timeout the bulk deadline causes still returns partial startup_timeout results', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'a'));
  // Own timeout longer than the bulk budget, so the bulk deadline is the one used.
  const hangs = new Hangs(logger, 'b', ['a']);
  Object.defineProperty(hangs, 'startupTimeoutMS', { value: 60_000 });
  await manager.registerComponent(hangs);

  const result = await manager.startAllComponents({ timeoutMS: 50 });

  expect(result.success).toBe(false);
  expect(result.code).toBe('startup_timeout');
  expect(result.timedOut).toBe(true);
  expect(result.startedComponents).toEqual(['a']);
  expect(manager.isComponentRunning('a')).toBe(true);

  await manager.stopAllComponents();
});
