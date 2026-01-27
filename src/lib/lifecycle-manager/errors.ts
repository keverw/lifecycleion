/**
 * Error thrown when a component name doesn't match kebab-case validation
 *
 * Component names must match the pattern: `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`
 *
 * Valid names: 'database', 'web-server', 'api-gateway-v2'
 * Invalid names: 'Database', 'web_server', 'WebServer', '', 'my server'
 */
export class InvalidComponentNameError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Component';
  public errCode = 'InvalidName';
  public additionalInfo: { name: string };

  constructor(additionalInfo: { name: string }) {
    super(
      `Invalid component name: "${additionalInfo.name}". Component names must be kebab-case (lowercase letters, numbers, and hyphens only).`,
    );
    this.name = 'InvalidComponentNameError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when component registration fails
 *
 * Common causes:
 * - Duplicate component name
 * - Registration attempted during shutdown
 * - Invalid registration options
 */
export class ComponentRegistrationError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Component';
  public errCode = 'RegistrationFailed';
  public additionalInfo: Record<string, unknown>;

  constructor(message: string, additionalInfo: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ComponentRegistrationError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when a circular dependency is detected
 *
 * Example: Component A depends on B, B depends on C, C depends on A
 */
export class DependencyCycleError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Dependency';
  public errCode = 'CyclicDependency';
  public additionalInfo: { cycle: string[] };

  constructor(additionalInfo: { cycle: string[] }) {
    super(
      `Circular dependency detected: ${additionalInfo.cycle.join(' -> ')} -> ${additionalInfo.cycle[0]}`,
    );
    this.name = 'DependencyCycleError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when a component depends on another component that doesn't exist
 */
export class MissingDependencyError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Dependency';
  public errCode = 'NotFound';
  public additionalInfo: { componentName: string; missingDependency: string };

  constructor(additionalInfo: {
    componentName: string;
    missingDependency: string;
  }) {
    super(
      `Component "${additionalInfo.componentName}" depends on "${additionalInfo.missingDependency}", but it is not registered.`,
    );
    this.name = 'MissingDependencyError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when a component fails to start
 *
 * This wraps the underlying error and provides context about which component failed
 */
export class ComponentStartupError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Component';
  public errCode = 'StartupFailed';
  public additionalInfo: { componentName: string };
  public cause?: Error;

  constructor(additionalInfo: { componentName: string }, cause?: Error) {
    const causeMessage = cause ? `: ${cause.message}` : '';
    super(
      `Component "${additionalInfo.componentName}" failed to start${causeMessage}`,
    );
    this.name = 'ComponentStartupError';
    this.additionalInfo = additionalInfo;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Error thrown when a component start operation times out
 */
export class ComponentStartTimeoutError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Component';
  public errCode = 'StartTimeout';
  public additionalInfo: { componentName: string; timeoutMS: number };

  constructor(additionalInfo: { componentName: string; timeoutMS: number }) {
    super(
      `Component "${additionalInfo.componentName}" start timed out after ${additionalInfo.timeoutMS}ms`,
    );
    this.name = 'ComponentStartTimeoutError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when a component stop operation times out
 */
export class ComponentStopTimeoutError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Component';
  public errCode = 'StopTimeout';
  public additionalInfo: { componentName: string; timeoutMS: number };

  constructor(additionalInfo: { componentName: string; timeoutMS: number }) {
    super(
      `Component "${additionalInfo.componentName}" stop timed out after ${additionalInfo.timeoutMS}ms`,
    );
    this.name = 'ComponentStopTimeoutError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when a component message handler times out
 */
export class MessageTimeoutError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Message';
  public errCode = 'MessageTimeout';
  public additionalInfo: { componentName: string; timeoutMS: number };

  constructor(additionalInfo: { componentName: string; timeoutMS: number }) {
    super(
      `Component "${additionalInfo.componentName}" message timed out after ${additionalInfo.timeoutMS}ms`,
    );
    this.name = 'MessageTimeoutError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when the global startup timeout is exceeded
 */
export class StartupTimeoutError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Lifecycle';
  public errCode = 'StartupTimeout';
  public additionalInfo: { timeoutMS: number; startedCount: number };

  constructor(additionalInfo: { timeoutMS: number; startedCount: number }) {
    super(
      `Startup timed out after ${additionalInfo.timeoutMS}ms (${additionalInfo.startedCount} components started)`,
    );
    this.name = 'StartupTimeoutError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error thrown when a component is not found in the registry
 */
export class ComponentNotFoundError extends Error {
  public errPrefix = 'LifecycleManagerErr';
  public errType = 'Component';
  public errCode = 'NotFound';
  public additionalInfo: { componentName: string };

  constructor(additionalInfo: { componentName: string }) {
    super(`Component "${additionalInfo.componentName}" not found in registry`);
    this.name = 'ComponentNotFoundError';
    this.additionalInfo = additionalInfo;
  }
}

/**
 * Error prefix constant for all lifecycle manager errors
 */
export const lifecycleManagerErrPrefix = 'LifecycleManagerErr';

/**
 * Error type constants
 */
export const lifecycleManagerErrTypes = {
  Component: 'Component',
  Dependency: 'Dependency',
  Lifecycle: 'Lifecycle',
  Message: 'Message',
} as const;

/**
 * Error code constants
 */
export const lifecycleManagerErrCodes = {
  InvalidName: 'InvalidName',
  RegistrationFailed: 'RegistrationFailed',
  CyclicDependency: 'CyclicDependency',
  NotFound: 'NotFound',
  StartupFailed: 'StartupFailed',
  StartupTimeout: 'StartupTimeout',
  StartTimeout: 'StartTimeout',
  StopTimeout: 'StopTimeout',
  MessageTimeout: 'MessageTimeout',
} as const;
