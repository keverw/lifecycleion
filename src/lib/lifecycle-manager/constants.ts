// Keep this file scoped to lifecycle-manager strings that are reused in more
// than one branch/path. One-off messages stay inline in the main class.

export const LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS =
  'Cannot unregister during bulk operation';
export const LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND =
  'Component not found';
export const LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING =
  'Component not running';
export const LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED =
  'Component is stalled';
export const LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS =
  'Bulk startup in progress';
export const LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS =
  'Shutdown in progress';
export const LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR = 'Unknown error';

export const LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP =
  'Auto-detaching process signals on last component stop';
export const LIFECYCLE_MANAGER_LOG_LOGGER_EXIT_DURING_SHUTDOWN =
  'Logger exit called during shutdown, waiting...';
export const LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED =
  'Message handler failed: {{error.message}}';

export const LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT =
  'Graceful shutdown timed out';
export const LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT =
  'Force shutdown timed out';

export const LIFECYCLE_MANAGER_LOG_OPTIONAL_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP =
  'Optional component stopped unexpectedly during startup, continuing: {{error.message}}';
export const LIFECYCLE_MANAGER_LOG_REQUIRED_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP =
  'Required component stopped unexpectedly during startup: {{error.message}}';
export const LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS =
  'Cannot register component while shutdown is in progress (isShuttingDown=true).';
export const LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP =
  'Cannot register component during startup when it is a required dependency for other components.';
export const LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE =
  'Component instance is already registered.';
