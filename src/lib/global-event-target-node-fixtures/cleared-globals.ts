/**
 * Node-runtime fixture: a global member explicitly assigned `undefined`.
 *
 * Assigning `undefined` is the ordinary way to clear a global, and the result is
 * indistinguishable from never having set it — so this counts as absent and the polyfill
 * installs normally. This is the deliberate counterpart to `unusable-globals`.
 */
import { captureConsoleError } from './capture-console-error';

// Only dynamic imports below (the globals must be set up first), so make this a module.
export {};

// `safe-handle-callback` writes an unclaimed report to `console.error`; the harness
// treats any stderr output as a crash, so it is collected and reported instead.
const consoleErrors = captureConsoleError();

const globalRecord = globalThis as unknown as Record<string, unknown>;

globalRecord.dispatchEvent = undefined;

const { safeHandleCallback } = await import('../safe-handle-callback');
const { installGlobalEventTarget, isGlobalEventTargetPolyfilled } =
  await import('../global-event-target');

const installResult = installGlobalEventTarget();

const messages: string[] = [];

globalThis.addEventListener('error', (event: Event) => {
  event.preventDefault();

  const errorEvent = event as ErrorEvent;

  messages.push(
    errorEvent.error instanceof Error ? errorEvent.error.message : '',
  );
});

safeHandleCallback('clearedGlobalsCallback', () => {
  throw new Error('Cleared globals boom');
});

process.stdout.write(
  JSON.stringify({
    consoleErrors,
    installResult,
    isPolyfilled: isGlobalEventTargetPolyfilled(),
    messages,
  }),
);
