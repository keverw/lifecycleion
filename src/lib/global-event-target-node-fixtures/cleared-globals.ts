/**
 * Node-runtime fixture: a global member explicitly assigned `undefined`.
 *
 * Assigning `undefined` is the ordinary way to clear a global, and the result is
 * indistinguishable from never having set it — so this counts as absent and the polyfill
 * installs normally. This is the deliberate counterpart to `unusable-globals`.
 */

// Only dynamic imports below (the globals must be set up first), so make this a module.
export {};

const globalRecord = globalThis as unknown as Record<string, unknown>;

globalRecord.dispatchEvent = undefined;

const { safeHandleCallback } = await import('../safe-handle-callback');
const { installGlobalEventTarget, isGlobalEventTargetPolyfilled } =
  await import('../global-event-target');

const installResult = installGlobalEventTarget();

const messages: string[] = [];

globalThis.addEventListener('reportError', (event: Event) => {
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
    installResult,
    isPolyfilled: isGlobalEventTargetPolyfilled(),
    messages,
  }),
);
