// module entry point
export { LifecycleManager } from './lib/lifecycle-manager';
export { ProcessSignalManager } from './lib/process-signal-manager';

// ID Helpers
export {
  generateID,
  validateID,
  emptyID,
  isEmptyID,
  IDHelpers,
  type IdentifierType,
  IdentifierTypes,
} from './lib/id-helpers';

// Event handling
export { EventEmitter, EventEmitterProtected } from './lib/event-emitter';
export {
  SingleEventObserver,
  SingleEventObserverProtected,
} from './lib/single-event-observer';

// Callback handling
export {
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from './lib/safe-handle-callback';

// Utility functions
export { isNumber } from './lib/is-number';
export { isFunction } from './lib/is-function';
export { isPromise } from './lib/is-promise';
export { formatJSON } from './lib/json-helpers';

// todo: export is function and is promise
