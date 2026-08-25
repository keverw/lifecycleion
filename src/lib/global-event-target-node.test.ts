/**
 * Node-runtime tests.
 *
 * These are the tests that actually catch the bug this module exists for: under Bun the
 * global event methods are native, so a Bun-only test can never prove that lifecycleion
 * works on Node, where `globalThis` is not an EventTarget. Each fixture is bundled with
 * `Bun.build({ target: 'node' })` and executed by the real `node` binary; the fixture
 * prints a JSON report to stdout and the assertions run back here in Bun.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dir, 'global-event-target-node-fixtures');

let buildDir: string;

interface NodeRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Bundle a fixture for Node and run it with the `node` binary. */
async function runFixtureOnNode(fixtureName: string): Promise<NodeRun> {
  const outfile = join(buildDir, `${fixtureName}.mjs`);

  const build = await Bun.build({
    entrypoints: [join(FIXTURE_DIR, `${fixtureName}.ts`)],
    target: 'node',
    format: 'esm',
    splitting: false,
  });

  if (!build.success) {
    throw new Error(
      `Failed to bundle fixture ${fixtureName}: ${build.logs
        .map((entry) => entry.message)
        .join('\n')}`,
    );
  }

  await Bun.write(outfile, await build.outputs[0].text());

  const proc = Bun.spawn(['node', outfile], {
    stdout: 'pipe',
    stderr: 'pipe',
    // A bare environment: nothing here should depend on Bun being the runtime.
    env: { ...process.env, NODE_ENV: 'test' },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function runFixtureJSON<T>(fixtureName: string): Promise<T> {
  const run = await runFixtureOnNode(fixtureName);

  // An uncaught exception or unhandled rejection shows up as a non-zero exit and a
  // stack trace on stderr, so these two assertions are the "did not crash" proof.
  expect(run.stderr).toBe('');
  expect(run.exitCode).toBe(0);

  return JSON.parse(run.stdout) as T;
}

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), 'lifecycleion-node-test-'));
});

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true });
});

describe('global event target on the Node runtime', () => {
  test('node itself has ErrorEvent but no global event methods', async () => {
    const proc = Bun.spawn(
      [
        'node',
        '-p',
        'JSON.stringify({' +
          'version: process.versions.node,' +
          'hasErrorEvent: typeof globalThis.ErrorEvent === "function",' +
          'hasDispatchEvent: typeof globalThis.dispatchEvent === "function",' +
          'hasAddEventListener: typeof globalThis.addEventListener === "function"' +
          '})',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const info = JSON.parse(stdout.trim()) as {
      version: string;
      hasErrorEvent: boolean;
      hasDispatchEvent: boolean;
      hasAddEventListener: boolean;
    };

    // The package requires Node >= 25, where `ErrorEvent` is native.
    expect(
      Number.parseInt(info.version.split('.')[0], 10),
    ).toBeGreaterThanOrEqual(25);
    expect(info.hasErrorEvent).toBe(true);

    // This is the gap lifecycleion fills: Node's `globalThis` is not an EventTarget.
    expect(info.hasDispatchEvent).toBe(false);
    expect(info.hasAddEventListener).toBe(false);
  }, 30_000);

  test('safeHandleCallback reports failures to a plain global listener', async () => {
    interface ReportErrorFixtureResult {
      nodeVersion: string;
      globalsAfterImport: {
        hasAddEventListener: boolean;
        hasRemoveEventListener: boolean;
        hasDispatchEvent: boolean;
        hasErrorEvent: boolean;
        isPolyfilled: boolean;
        areEnumerable: string[];
      };
      reported: {
        isErrorEvent: boolean;
        type: string;
        message: string;
        originalStack: boolean;
      }[];
      waitResult: { success: boolean; errorMessage: string | null };
      repeat: {
        results: string[];
        isSameTarget: boolean;
        isSameDispatch: boolean;
        countBeforeFinalDispatch: number;
      };
      uncaught: string[];
      unhandled: string[];
    }

    const result =
      await runFixtureJSON<ReportErrorFixtureResult>('report-error');

    // 1. Importing lifecycleion is enough for normal registration to work.
    expect(result.globalsAfterImport).toMatchObject({
      hasAddEventListener: true,
      hasRemoveEventListener: true,
      hasDispatchEvent: true,
      hasErrorEvent: true,
      isPolyfilled: true,
    });

    // Installed properties must not be enumerable.
    expect(result.globalsAfterImport.areEnumerable).toEqual([]);

    // 2 + 3. Sync throws, async rejections, and non-function callbacks all arrive as
    // ErrorEvents carrying the wrapped callback name and the original error details.
    const messages = result.reported.map((entry) => entry.message);

    // Async rejections land a tick later than the synchronous reports, so match by
    // callback name rather than by position.
    const messageFor = (callbackName: string): string => {
      const match = messages.find((message) =>
        message.includes(`Error in a callback ${callbackName}`),
      );

      expect(match).toBeDefined();

      return match as string;
    };

    expect(messageFor('syncCallbackWithError')).toContain('Sync boom');
    expect(messageFor('asyncCallbackWithError')).toContain('Async boom');
    expect(messageFor('nonFunctionCallback')).toContain(
      'Callback provided for nonFunctionCallback is not a function',
    );
    expect(messageFor('waitCallbackWithError')).toContain('Wait boom');

    for (const entry of result.reported) {
      expect(entry.isErrorEvent).toBe(true);
      expect(entry.type).toBe('reportError');
      expect(entry.originalStack).toBe(true);
    }

    // 4. No uncaught exception and no unhandled rejection.
    expect(result.uncaught).toEqual([]);
    expect(result.unhandled).toEqual([]);

    // 5. safeHandleCallbackAndWait still returns its structured failure.
    expect(result.waitResult).toEqual({
      success: false,
      errorMessage: 'Wait boom',
    });

    // 6. Repeat installation is harmless and keeps the same backing target, so
    // listeners registered earlier keep receiving events.
    expect(result.repeat.results).toEqual([
      'already-installed',
      'already-installed',
      'already-installed',
    ]);

    expect(result.repeat.isSameTarget).toBe(true);
    expect(result.repeat.isSameDispatch).toBe(true);
    expect(result.reported.length).toBe(
      result.repeat.countBeforeFinalDispatch + 1,
    );

    // Removal works too: the event dispatched after removeEventListener is absent.
    expect(messages).not.toContain('After removal');
    expect(messages[messages.length - 1]).toBe('After reinstall');
  }, 30_000);

  test('existing global implementations are never overwritten', async () => {
    interface ExistingGlobalsFixtureResult {
      installResult: string;
      isPolyfilled: boolean;
      hasBackingTarget: boolean;
      isAddPreserved: boolean;
      isRemovePreserved: boolean;
      isDispatchPreserved: boolean;
      messages: string[];
    }

    const result =
      await runFixtureJSON<ExistingGlobalsFixtureResult>('existing-globals');

    // 7. Pre-existing methods are left exactly as they were.
    expect(result.installResult).toBe('native');
    expect(result.isPolyfilled).toBe(false);
    expect(result.hasBackingTarget).toBe(false);
    expect(result.isAddPreserved).toBe(true);
    expect(result.isRemovePreserved).toBe(true);
    expect(result.isDispatchPreserved).toBe(true);

    // ...and reports flow through them, not through a target of our own.
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]).toContain(
      'Error in a callback existingGlobalsCallback',
    );
    expect(result.messages[0]).toContain('Existing globals boom');
  }, 30_000);

  test('a partial global surface is left alone rather than mixed', async () => {
    interface PartialGlobalsFixtureResult {
      installResult: string;
      isPolyfilled: boolean;
      hasDispatchEvent: boolean;
      hasRemoveEventListener: boolean;
      didThrow: boolean;
      waitResult: { success: boolean; errorMessage: string | null };
    }

    const result =
      await runFixtureJSON<PartialGlobalsFixtureResult>('partial-globals');

    expect(result.installResult).toBe('partial');
    expect(result.isPolyfilled).toBe(false);

    // Nothing was grafted onto the foreign implementation.
    expect(result.hasDispatchEvent).toBe(false);
    expect(result.hasRemoveEventListener).toBe(false);

    // Reporting degrades quietly; the helpers still behave.
    expect(result.didThrow).toBe(false);
    expect(result.waitResult).toEqual({
      success: false,
      errorMessage: 'Partial globals wait boom',
    });
  }, 30_000);

  test('an existing non-callable member is preserved, not overwritten', async () => {
    interface UnusableGlobalsFixtureResult {
      installResult: string;
      isPolyfilled: boolean;
      isDispatchPreserved: boolean;
      hasAddEventListener: boolean;
      hasRemoveEventListener: boolean;
      didThrow: boolean;
      waitResult: { success: boolean; errorMessage: string | null };
    }

    const result =
      await runFixtureJSON<UnusableGlobalsFixtureResult>('unusable-globals');

    // `globalThis.dispatchEvent = null` is present, so the surface is somebody else's
    // and stays untouched even though it cannot be used.
    expect(result.installResult).toBe('partial');
    expect(result.isPolyfilled).toBe(false);
    expect(result.isDispatchPreserved).toBe(true);
    expect(result.hasAddEventListener).toBe(false);
    expect(result.hasRemoveEventListener).toBe(false);

    // Reporting degrades quietly; the helpers still behave.
    expect(result.didThrow).toBe(false);
    expect(result.waitResult).toEqual({
      success: false,
      errorMessage: 'Unusable globals wait boom',
    });
  }, 30_000);

  test('a member explicitly cleared to undefined counts as absent', async () => {
    interface ClearedGlobalsFixtureResult {
      installResult: string;
      isPolyfilled: boolean;
      messages: string[];
    }

    const result =
      await runFixtureJSON<ClearedGlobalsFixtureResult>('cleared-globals');

    // Assigning `undefined` is how a global gets cleared, and is indistinguishable from
    // never having set it — so the polyfill installs and reporting works.
    expect(result.installResult).toBe('already-installed');
    expect(result.isPolyfilled).toBe(true);

    expect(result.messages.length).toBe(1);
    expect(result.messages[0]).toContain(
      'Error in a callback clearedGlobalsCallback',
    );
    expect(result.messages[0]).toContain('Cleared globals boom');
  }, 30_000);

  test('a non-extensible global object is handled instead of throwing', async () => {
    interface NonExtensibleFixtureResult {
      didImportThrow: boolean;
      installResult: string;
      isPolyfilled: boolean;
      hasAddEventListener: boolean;
      hasRemoveEventListener: boolean;
      hasDispatchEvent: boolean;
      hasSharedState: boolean;
      didThrow: boolean;
      waitResult: { success: boolean | null; errorMessage: string | null };
    }

    const result = await runFixtureJSON<NonExtensibleFixtureResult>(
      'non-extensible-globals',
    );

    // Installation happens during module init, so throwing here would break the import
    // of safe-handle-callback and every module that depends on it.
    expect(result.didImportThrow).toBe(false);
    expect(result.installResult).toBe('blocked');
    expect(result.isPolyfilled).toBe(false);

    // Nothing half-installed, not even the backing target.
    expect(result.hasAddEventListener).toBe(false);
    expect(result.hasRemoveEventListener).toBe(false);
    expect(result.hasDispatchEvent).toBe(false);
    expect(result.hasSharedState).toBe(false);

    // Reporting degrades quietly; the helpers still behave.
    expect(result.didThrow).toBe(false);
    expect(result.waitResult).toEqual({
      success: false,
      errorMessage: 'Sealed globals wait boom',
    });
  }, 30_000);

  test('a throwing accessor on a global is probed without crashing', async () => {
    interface HostileGlobalsFixtureResult {
      didImportThrow: boolean;
      installResult: string;
      isPolyfilled: boolean;
      wasGetterCalled: boolean;
      isAccessorPreserved: boolean;
      didThrow: boolean;
      waitResult: { success: boolean | null; errorMessage: string | null };
    }

    const result =
      await runFixtureJSON<HostileGlobalsFixtureResult>('hostile-globals');

    // Reading the global runs the getter, and this happens during module init — an
    // unguarded probe would take the import down with it.
    expect(result.didImportThrow).toBe(false);
    expect(result.wasGetterCalled).toBe(true);

    // Unreadable means unreplaceable: treat it as somebody else's surface.
    expect(result.installResult).toBe('partial');
    expect(result.isPolyfilled).toBe(false);
    expect(result.isAccessorPreserved).toBe(true);

    // Reporting degrades quietly; the helpers still behave.
    expect(result.didThrow).toBe(false);
    expect(result.waitResult).toEqual({
      success: false,
      errorMessage: 'Hostile globals wait boom',
    });
  }, 30_000);

  test('a throwing EventTarget accessor is handled instead of crashing', async () => {
    interface HostileEventTargetFixtureResult {
      didImportThrow: boolean;
      installResult: string;
      isPolyfilled: boolean;
      wasGetterCalled: boolean;
      didThrow: boolean;
      waitResult: { success: boolean | null; errorMessage: string | null };
    }

    const result = await runFixtureJSON<HostileEventTargetFixtureResult>(
      'hostile-event-target',
    );

    expect(result.didImportThrow).toBe(false);
    expect(result.wasGetterCalled).toBe(true);

    // A constructor that cannot be read is one that cannot back anything.
    expect(result.installResult).toBe('unsupported');
    expect(result.isPolyfilled).toBe(false);

    expect(result.didThrow).toBe(false);
    expect(result.waitResult).toEqual({
      success: false,
      errorMessage: 'Hostile EventTarget wait boom',
    });
  }, 30_000);

  test('logger.registerReportErrorListener works and logs callback failures', async () => {
    interface LoggerFixtureResult {
      isAvailable: boolean;
      registerResult: string;
      unregisterResult: string;
      logs: { type: string; message: string }[];
    }

    const result = await runFixtureJSON<LoggerFixtureResult>(
      'logger-report-error',
    );

    expect(result.isAvailable).toBe(true);
    expect(result.registerResult).toBe('success');
    expect(result.unregisterResult).toBe('success');

    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.logs[0].type).toBe('error');
    expect(result.logs[0].message).toContain('Uncaught exception');
  }, 30_000);

  test('frozen shared state does not crash the install', async () => {
    interface FrozenSharedStateFixtureResult {
      didImportThrow: boolean;
      installResult: string;
      isPolyfilled: boolean;
      isStateUnchanged: boolean;
      areMethodsRolledBack: boolean;
    }

    const result = await runFixtureJSON<FrozenSharedStateFixtureResult>(
      'frozen-shared-state',
    );

    // The state object is shared and may be frozen by another holder. Flipping
    // isInstalled on it throws in strict mode, and this happens during module
    // init — after the three methods have already been defined.
    expect(result.didImportThrow).toBe(false);

    // Nothing half-installed: the methods it defined are rolled back, and the
    // state it could not write to is left exactly as found.
    expect(result.installResult).toBe('blocked');
    expect(result.isPolyfilled).toBe(false);
    expect(result.isStateUnchanged).toBe(true);
    expect(result.areMethodsRolledBack).toBe(true);
  }, 30_000);
});
