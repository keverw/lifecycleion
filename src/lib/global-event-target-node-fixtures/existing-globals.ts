/**
 * Node-runtime fixture: an environment that already has its own global event methods.
 *
 * The methods are installed *before* lifecycleion is imported (hence the dynamic import),
 * and must survive untouched — lifecycleion dispatches through them rather than through
 * its own backing target.
 */
import { captureConsoleError } from './capture-console-error';
import { reportedMessage } from './reported-message';

// Only dynamic imports below (globals must be set up first), so make this a module.
export {};

// `safe-handle-callback` writes an unclaimed report to `console.error`; the harness
// treats any stderr output as a crash, so it is collected and reported instead.
const consoleErrors = captureConsoleError();

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

ownAddEventListener('error', (event: Event) => {
  event.preventDefault();

  const errorEvent = event as ErrorEvent;

  messages.push(reportedMessage(errorEvent.error));
});

safeHandleCallback('existingGlobalsCallback', () => {
  throw new Error('Existing globals boom');
});

process.stdout.write(
  JSON.stringify({
    consoleErrors,
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
