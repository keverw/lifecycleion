/**
 * Node-runtime fixture: an environment that already has its own global event methods.
 *
 * The methods are installed *before* lifecycleion is imported (hence the dynamic import),
 * and must survive untouched — lifecycleion dispatches through them rather than through
 * its own backing target.
 */

// Only dynamic imports below (globals must be set up first), so make this a module.
export {};

const globalRecord = globalThis as unknown as Record<string, unknown>;

const ownTarget = new EventTarget();

const ownAddEventListener = ownTarget.addEventListener.bind(ownTarget);
const ownRemoveEventListener = ownTarget.removeEventListener.bind(ownTarget);
const ownDispatchEvent = ownTarget.dispatchEvent.bind(ownTarget);

globalRecord.addEventListener = ownAddEventListener;
globalRecord.removeEventListener = ownRemoveEventListener;
globalRecord.dispatchEvent = ownDispatchEvent;

const { safeHandleCallback } = await import('../safe-handle-callback');
const {
  installGlobalEventTarget,
  getGlobalEventTarget,
  isGlobalEventTargetPolyfilled,
} = await import('../global-event-target');

const installResult = installGlobalEventTarget();

const messages: string[] = [];

ownAddEventListener('reportError', (event: Event) => {
  const errorEvent = event as ErrorEvent;

  messages.push(
    errorEvent.error instanceof Error ? errorEvent.error.message : '',
  );
});

safeHandleCallback('existingGlobalsCallback', () => {
  throw new Error('Existing globals boom');
});

process.stdout.write(
  JSON.stringify({
    installResult,
    isPolyfilled: isGlobalEventTargetPolyfilled(),
    hasBackingTarget: getGlobalEventTarget() !== null,
    isAddPreserved: globalRecord.addEventListener === ownAddEventListener,
    isRemovePreserved:
      globalRecord.removeEventListener === ownRemoveEventListener,
    isDispatchPreserved: globalRecord.dispatchEvent === ownDispatchEvent,
    messages,
  }),
);
