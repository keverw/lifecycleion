import { expect, test } from 'bun:test';
import type { Logger } from '../logger';
import { sleep } from '../sleep';
import { BaseComponent } from './base-component';
import { ComponentStartTimeoutError } from './errors';
import { deferred, setup } from './test-helpers';

// A component that records the signal each `start()` receives and what happened to it.
class Records extends BaseComponent {
  public readonly signals: AbortSignal[] = [];
  public readonly order: string[] = [];
  public stops = 0;

  constructor(logger: Logger, name: string, startupTimeoutMS = 30_000) {
    super(logger, { name, startupTimeoutMS });
  }

  public onStart: (signal: AbortSignal) => void | Promise<void> = () => {};

  public start(signal: AbortSignal): void | Promise<void> {
    this.signals.push(signal);
    signal.addEventListener('abort', () => {
      this.order.push('abort');
    });
    return this.onStart(signal);
  }

  public stop(): void {
    this.stops++;
  }

  public lose(error: Error): void {
    this.reportUnexpectedStop(error);
  }
}

class RecordsWithHook extends Records {
  public hookCalls = 0;
  public signalAbortedInHook: boolean | undefined;

  public onStartupAborted(): void {
    this.hookCalls++;
    this.order.push('hook');
    this.signalAbortedInHook = this.signals.at(-1)?.aborted;
  }
}

// Declares `start()` with no parameters, as every component written before the signal
// existed does. It must still compile and behave exactly as before.
class IgnoresSignal extends BaseComponent {
  public stops = 0;
  public readonly gate = deferred();

  constructor(logger: Logger, name: string, startupTimeoutMS = 30_000) {
    super(logger, { name, startupTimeoutMS });
  }

  public async start(): Promise<void> {
    await this.gate.promise;
  }

  public stop(): void {
    this.stops++;
  }
}

test('start() receives a fresh AbortSignal that is not aborted when it succeeds', async () => {
  const { logger, manager } = setup();
  const a = new Records(logger, 'a', 50);
  await manager.registerComponent(a);

  expect((await manager.startComponent('a')).success).toBe(true);
  expect((await manager.stopComponent('a')).success).toBe(true);
  expect((await manager.startComponent('a')).success).toBe(true);

  expect(a.signals).toHaveLength(2);
  expect(a.signals[0]).toBeInstanceOf(AbortSignal);
  // One controller per attempt.
  expect(a.signals[1]).not.toBe(a.signals[0]);

  // Not after its own deadline would have passed, nor after a stop.
  await sleep(80);
  expect(a.signals.map((signal) => signal.aborted)).toEqual([false, false]);
  expect(a.order).toEqual([]);

  await manager.stopAllComponents();
  expect(a.signals[1].aborted).toBe(false);
});

test('the signal is aborted on a per-component startup timeout, before onStartupAborted(), with the result error as its reason', async () => {
  const { logger, manager } = setup();
  const a = new RecordsWithHook(logger, 'a', 30);
  const gate = deferred();
  a.onStart = () => gate.promise;
  await manager.registerComponent(a);

  const result = await manager.startComponent('a');

  expect(result.success).toBe(false);
  expect(result.code).toBe('component_startup_timeout');
  expect(a.signals).toHaveLength(1);
  const [signal] = a.signals;
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBeInstanceOf(ComponentStartTimeoutError);
  expect(signal.reason).toBe(result.error);
  expect(a.order).toEqual(['abort', 'hook']);
  expect(a.signalAbortedInHook).toBe(true);
  expect(manager.getComponentStatus('a')?.state).toBe('starting-timed-out');

  gate.resolve();
  await sleep(10);
});

test('a start that honors the signal settles, and the next attempt gets an unaborted signal', async () => {
  const { logger, manager } = setup();
  const a = new Records(logger, 'a', 30);
  a.onStart = (signal) =>
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error);
      });
    });
  await manager.registerComponent(a);

  const result = await manager.startComponent('a');
  expect(result.code).toBe('component_startup_timeout');
  expect(a.signals[0].aborted).toBe(true);
  // The start settled on the abort, so no late cleanup is owed and none ran.
  await sleep(10);
  expect(a.stops).toBe(0);

  a.onStart = () => {};
  expect((await manager.startComponent('a')).success).toBe(true);
  expect(a.signals).toHaveLength(2);
  expect(a.signals[1].aborted).toBe(false);
  await manager.stopAllComponents();
});

test('the signal is aborted when the startAllComponents() deadline abandons the start', async () => {
  const { logger, manager } = setup();
  const a = new RecordsWithHook(logger, 'a', 10_000);
  const gate = deferred();
  a.onStart = () => gate.promise;
  await manager.registerComponent(a);

  const result = await manager.startAllComponents({ timeoutMS: 40 });

  expect(result.code).toBe('startup_timeout');
  // The bulk deadline bounds the start through the start's own timer; the bulk result
  // may be returned a moment before that timer fires.
  await sleep(20);
  expect(a.signals).toHaveLength(1);
  expect(a.signals[0].aborted).toBe(true);
  expect(a.signals[0].reason).toBeInstanceOf(ComponentStartTimeoutError);
  expect(a.order).toEqual(['abort', 'hook']);

  // Bulk deadlines still clean up a late success, hook or not.
  gate.resolve();
  await sleep(20);
  expect(a.stops).toBe(1);
  expect(manager.getComponentStatus('a')?.state).toBe('starting-timed-out');
});

test('the signal is not aborted when start() rejects or throws', async () => {
  const { logger, manager } = setup();
  const rejects = new RecordsWithHook(logger, 'rejects', 30);
  rejects.onStart = () => Promise.reject(new Error('start failed'));
  const throws = new RecordsWithHook(logger, 'throws', 30);
  throws.onStart = () => {
    throw new Error('start threw');
  };
  await manager.registerComponent(rejects);
  await manager.registerComponent(throws);

  expect((await manager.startComponent('rejects')).code).toBe('error');
  expect((await manager.startComponent('throws')).code).toBe('error');

  await sleep(60);
  expect(rejects.signals[0].aborted).toBe(false);
  expect(throws.signals[0].aborted).toBe(false);
  expect(rejects.hookCalls + throws.hookCalls).toBe(0);
});

test('a component that ignores the signal keeps its timeout and late-cleanup behavior', async () => {
  const { logger, manager } = setup();
  const a = new IgnoresSignal(logger, 'a', 30);
  await manager.registerComponent(a);

  const result = await manager.startComponent('a');
  expect(result.code).toBe('component_startup_timeout');

  a.gate.resolve();
  await sleep(20);
  expect(a.stops).toBe(1);
  expect(manager.getComponentStatus('a')?.state).toBe('starting-timed-out');

  const b = new IgnoresSignal(logger, 'b');
  b.gate.resolve();
  await manager.registerComponent(b);
  expect((await manager.startComponent('b')).success).toBe(true);
  await manager.stopAllComponents();
  expect(b.stops).toBe(1);
});

test('a superseded start has its signal aborted at its deadline, without calling the hook on the newer run', async () => {
  const { logger, manager } = setup();
  const firstGate = deferred();
  let calls = 0;
  const a = new RecordsWithHook(logger, 'a', 40);
  a.onStart = () => {
    calls++;
    if (calls === 1) {
      a.lose(new Error('lost'));
      return firstGate.promise;
    }
  };
  await manager.registerComponent(a);

  const restarts: Promise<unknown>[] = [];
  manager.once('component:unexpected-stop', () => {
    restarts.push(manager.startComponent('a'));
  });

  const first = manager.startComponent('a');
  await Promise.all(restarts);
  expect(manager.isComponentRunning('a')).toBe(true);

  const result = await first;
  expect(result.success).toBe(false);
  expect(a.signals).toHaveLength(2);
  expect(a.signals[0].aborted).toBe(true);
  expect(a.signals[0].reason).toBeInstanceOf(ComponentStartTimeoutError);
  expect(a.signals[1].aborted).toBe(false);
  expect(a.hookCalls).toBe(0);
  expect(manager.isComponentRunning('a')).toBe(true);

  firstGate.resolve();
  await manager.stopAllComponents();
});

test('aborting does not consult an AbortController.prototype.abort replaced after import', async () => {
  const { logger, manager } = setup();
  const a = new RecordsWithHook(logger, 'a', 30);
  const gate = deferred();
  a.onStart = () => gate.promise;
  await manager.registerComponent(a);

  const descriptor = Object.getOwnPropertyDescriptor(
    AbortController.prototype,
    'abort',
  );
  if (descriptor === undefined) {
    throw new Error('AbortController.prototype.abort is missing');
  }
  Object.defineProperty(AbortController.prototype, 'abort', {
    ...descriptor,
    value: () => {
      throw new Error('replaced abort');
    },
  });
  try {
    expect((await manager.startComponent('a')).code).toBe(
      'component_startup_timeout',
    );
  } finally {
    Object.defineProperty(AbortController.prototype, 'abort', descriptor);
  }

  expect(a.signals[0].aborted).toBe(true);
  expect(a.order).toEqual(['abort', 'hook']);
  gate.resolve();
  await sleep(10);
});

// Abort listeners are the component's code, run by the runtime's EventTarget: an error
// one throws never reaches `abort()`'s caller - the runtime reports it as an uncaught
// exception. That is fatal in a test runner, so this runs in its own process with an
// `uncaughtException` handler installed, as an application that tolerates such errors
// would have.
test('a throwing abort listener does not break the timeout result, the hook, or late cleanup', async () => {
  const script = `
    import { Logger } from ${JSON.stringify(new URL('../logger/index.ts', import.meta.url).href)};
    import { LifecycleManager } from ${JSON.stringify(new URL('./lifecycle-manager.ts', import.meta.url).href)};
    import { BaseComponent } from ${JSON.stringify(new URL('./base-component.ts', import.meta.url).href)};
    const watchdog = setTimeout(() => process.exit(42), 2000);
    const uncaught = [];
    process.on('uncaughtException', (error) => { uncaught.push(error.message); });
    const logger = new Logger({ callProcessExit: false, sinks: [{ write() {}, close: async () => {} }] });
    const manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 });
    let releaseLate;
    const late = new Promise((resolve) => { releaseLate = resolve; });
    class Component extends BaseComponent {
      stops = 0;
      hookCalls = 0;
      start(signal) {
        signal.addEventListener('abort', () => { throw new Error(this.name + ' listener'); });
        signal.onabort = () => { throw new Error(this.name + ' onabort'); };
        return late;
      }
      stop() { this.stops++; }
    }
    class WithHook extends Component {
      onStartupAborted() { this.hookCalls++; }
    }
    const hooked = new WithHook(logger, { name: 'hooked', startupTimeoutMS: 30 });
    const plain = new Component(logger, { name: 'plain', startupTimeoutMS: 30 });
    await manager.registerComponent(hooked);
    await manager.registerComponent(plain);
    const results = await Promise.all([manager.startComponent('hooked'), manager.startComponent('plain')]);
    const statesAfterTimeout = [manager.getComponentStatus('hooked').state, manager.getComponentStatus('plain').state];
    releaseLate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const restarted = await manager.startComponent('hooked');
    const stopped = await manager.stopAllComponents();
    clearTimeout(watchdog);
    process.stdout.write(JSON.stringify({
      codes: results.map((result) => result.code),
      statesAfterTimeout,
      hookCalls: hooked.hookCalls,
      plainStops: plain.stops,
      plainState: manager.getComponentStatus('plain').state,
      restarted: restarted.success,
      stopped: stopped.success,
      uncaught: uncaught.sort(),
    }));
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({
    codes: ['component_startup_timeout', 'component_startup_timeout'],
    statesAfterTimeout: ['starting-timed-out', 'starting-timed-out'],
    hookCalls: 1,
    plainStops: 1,
    plainState: 'starting-timed-out',
    restarted: true,
    stopped: true,
    uncaught: [
      'hooked listener',
      'hooked onabort',
      'plain listener',
      'plain onabort',
    ],
  });
});
