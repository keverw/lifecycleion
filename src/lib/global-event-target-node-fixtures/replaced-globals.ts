/**
 * Node-runtime fixture: an application that replaces the global event methods *after*
 * lifecycleion installed them.
 *
 * From that moment the polyfill is no longer the implementation in use, and saying
 * otherwise would hand callers a backing target that nothing dispatches to.
 */

import { safeHandleCallback } from '../safe-handle-callback';
import {
  getGlobalEventTarget,
  installGlobalEventTarget,
  isGlobalEventTargetPolyfilled,
} from '../global-event-target';

const globalRecord = globalThis as unknown as Record<string, unknown>;

// Importing lifecycleion installed the polyfill.
const before = {
  installResult: installGlobalEventTarget(),
  isPolyfilled: isGlobalEventTargetPolyfilled(),
  hasBackingTarget: getGlobalEventTarget() !== null,
};

// Now the application swaps in its own implementation.
const ownTarget = new EventTarget();

globalRecord.addEventListener = ownTarget.addEventListener.bind(ownTarget);
globalRecord.removeEventListener =
  ownTarget.removeEventListener.bind(ownTarget);
globalRecord.dispatchEvent = ownTarget.dispatchEvent.bind(ownTarget);

const after = {
  installResult: installGlobalEventTarget(),
  isPolyfilled: isGlobalEventTargetPolyfilled(),
  hasBackingTarget: getGlobalEventTarget() !== null,
};

// Reports must follow the replacement, not the abandoned backing target.
const messages: string[] = [];

globalThis.addEventListener('reportError', (event: Event) => {
  const errorEvent = event as ErrorEvent;

  messages.push(
    errorEvent.error instanceof Error ? errorEvent.error.message : '',
  );
});

safeHandleCallback('replacedGlobalsCallback', () => {
  throw new Error('Replaced globals boom');
});

process.stdout.write(JSON.stringify({ before, after, messages }));
