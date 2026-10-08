import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import type { ManagerCore } from './internal/manager-core';
import type { LifecycleManagerOptions } from './types';

// Shared by the lifecycle-manager test files. Not a test file itself, so `bun test`
// never runs it on its own.

export function setup(options: Partial<LifecycleManagerOptions> = {}): {
  logger: Logger;
  manager: LifecycleManager;
} {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });

  return {
    logger,
    manager: new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      ...options,
    }),
  };
}

/**
 * The manager's private core, for a test that reaches into a subsystem - to call a
 * step directly, or to patch one. Its subsystems' private members still need a cast.
 */
export function coreOf(manager: LifecycleManager): ManagerCore {
  return (manager as unknown as { core: ManagerCore }).core;
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// Claims every report on the global `'error'` channel until `release()`: asserts they
// were made, and keeps the `console.error` fall-through out of the test output.
export function claimReports(): { reports: unknown[]; release: () => void } {
  const reports: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };

  globalThis.addEventListener('error', onError);

  return {
    reports,
    release: () => {
      globalThis.removeEventListener('error', onError);
    },
  };
}

export function hasReport(reports: unknown[], text: string): boolean {
  return reports.some((report) => (report as Error).message.includes(text));
}

// Stands in for an attached `ProcessSignalManager`, so the auto-detach paths run without
// touching the real process's signal handlers.
export function fakeAttachedSignals(manager: LifecycleManager): void {
  (
    manager as unknown as {
      state: {
        processSignalManager: { getStatus: () => { isAttached: boolean } };
      };
    }
  ).state.processSignalManager = { getStatus: () => ({ isAttached: true }) };
}

// Replaces `attachSignals()` / `detachSignals()` with fakes that track whether handlers
// are attached, so a test can assert on it without installing process-wide handlers.
export function fakeSignals(manager: LifecycleManager): {
  isAttached: () => boolean;
  attachCalls: () => number;
  detachCalls: () => number;
} {
  let isAttached = false;
  let attachCalls = 0;
  let detachCalls = 0;

  manager.attachSignals = (): void => {
    attachCalls++;
    isAttached = true;
    fakeAttachedSignals(manager);
  };
  manager.detachSignals = (): void => {
    detachCalls++;
    isAttached = false;
    (
      manager as unknown as { state: { processSignalManager: unknown } }
    ).state.processSignalManager = undefined;
  };

  return {
    isAttached: () => isAttached,
    attachCalls: () => attachCalls,
    detachCalls: () => detachCalls,
  };
}

export class Plain extends BaseComponent {
  public forceCalls = 0;

  constructor(logger: Logger, name: string, dependencies: string[] = []) {
    super(logger, { name, dependencies });
  }

  // The signals are accepted so tests can replace these with versions that use them.
  public async start(_signal?: AbortSignal): Promise<void> {}
  public async stop(_signal?: AbortSignal): Promise<void> {}
  public onShutdownForce(_signal?: AbortSignal): void {
    this.forceCalls++;
  }
}

// Sends a signal down the same private entry point the OS handlers use.
export function sendSignal(manager: LifecycleManager, method: string): void {
  (
    manager as unknown as {
      handleShutdownRequest: (method: string) => void;
    }
  ).handleShutdownRequest(method);
}

// A component whose stop fails and whose force handler fails too, so every stop of it
// ends stalled.
export class Stalls extends Plain {
  public override stop(): Promise<void> {
    return Promise.reject(new Error('stop failed'));
  }

  public override onShutdownForce(): void {
    this.forceCalls++;
    throw new Error('force failed');
  }
}
