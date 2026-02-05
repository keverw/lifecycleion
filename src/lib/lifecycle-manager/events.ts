import type {
  BroadcastResult,
  ComponentHealthResult,
  ComponentStallInfo,
  ComponentStatus,
  InsertComponentAtResult,
  MessageResult,
  RegistrationFailureCode,
  RegisterComponentResult,
  ShutdownMethod,
  StartupResult,
  ValueResult,
} from './types';
import type { ShutdownSignal } from '../process-signal-manager';

export interface LifecycleManagerEventMap {
  'component:unregistered': { name: string; duringShutdown?: boolean };
  'component:start-skipped': { name: string; reason: string };
  'component:start-failed-optional': { name: string; error?: Error };
  'lifecycle-manager:started': {
    startedComponents: string[];
    failedOptionalComponents: StartupResult['failedOptionalComponents'];
    skippedComponents: string[];
  };
  'lifecycle-manager:signals-attached': undefined;
  'lifecycle-manager:signals-detached': undefined;
  'component:health-check-started': { name: string };
  'component:health-check-completed': {
    name: string;
    healthy: boolean;
    message?: string;
    details?: ComponentHealthResult['details'];
    durationMS: number;
    timedOut: boolean;
  };
  'component:health-check-failed': { name: string; error: Error };
  'component:message-sent': {
    componentName: string;
    from: string | null;
    payload: unknown;
  };
  'component:message-failed': {
    componentName: string;
    from: string | null;
    error: Error;
    timedOut: boolean;
    code: MessageResult['code'];
    componentFound?: boolean;
    componentRunning?: boolean;
    handlerImplemented?: boolean;
    data?: unknown;
  };
  'component:broadcast-started': { from: string | null; payload: unknown };
  'component:broadcast-completed': {
    from: string | null;
    resultsCount: number;
    results: BroadcastResult[];
  };
  'component:value-requested': {
    componentName: string;
    key: string;
    from: string | null;
  };
  'component:value-returned': {
    componentName: string;
    key: string;
    from: string | null;
    found: boolean;
    value: unknown;
    componentFound: boolean;
    componentRunning: boolean;
    handlerImplemented: boolean;
    requestedBy: string | null;
    code: ValueResult['code'];
  };
  'component:registration-rejected': {
    name: string;
    reason: RegistrationFailureCode;
    message?: string;
    target?: string | null;
    cycle?: string[];
    registrationIndexBefore?: number | null;
    registrationIndexAfter?: number | null;
    startupOrder?: string[];
    requestedPosition?: InsertComponentAtResult['requestedPosition'];
    manualPositionRespected?: boolean;
    targetFound?: boolean;
  };
  'component:registered': {
    name: string;
    index: number | null;
    action:
      | RegisterComponentResult['action']
      | InsertComponentAtResult['action'];
    registrationIndexBefore: number | null;
    registrationIndexAfter: number | null;
    startupOrder: string[];
    requestedPosition?: InsertComponentAtResult['requestedPosition'];
    manualPositionRespected?: boolean;
    targetFound?: boolean;
    duringStartup?: boolean;
    autoStartAttempted?: boolean;
    autoStartSucceeded?: boolean;
  };
  'lifecycle-manager:shutdown-initiated': {
    method: ShutdownMethod;
    duringStartup: boolean;
  };
  'lifecycle-manager:shutdown-completed': {
    durationMS: number;
    stoppedComponents: string[];
    stalledComponents: ComponentStallInfo[];
    method: ShutdownMethod;
    duringStartup: boolean;
  };
  'component:starting': { name: string };
  'component:started': { name: string; status?: ComponentStatus };
  'component:start-timeout': {
    name: string;
    error: Error;
    timeoutMS?: number;
    reason?: string;
    code: 'start_timeout';
  };
  'component:start-failed': {
    name: string;
    error: Error;
    reason?: string;
    code: 'unknown_error';
  };
  'lifecycle-manager:shutdown-warning': { timeoutMS: number };
  'component:shutdown-warning': { name: string };
  'component:shutdown-warning-completed': { name: string };
  'lifecycle-manager:shutdown-warning-completed': { timeoutMS: number };
  'component:shutdown-warning-timeout': { name: string; timeoutMS: number };
  'lifecycle-manager:shutdown-warning-timeout': {
    timeoutMS: number;
    pending: string[];
  };
  'component:stopping': { name: string };
  'component:stopped': { name: string; status?: ComponentStatus };
  'component:stop-timeout': {
    name: string;
    error: Error;
    timeoutMS?: number;
    reason?: string;
    code: 'stop_timeout';
  };
  'component:shutdown-force': {
    name: string;
    context: { gracefulPhaseRan: boolean; gracefulTimedOut: boolean };
  };
  'component:stalled': {
    name: string;
    stallInfo: ComponentStallInfo;
    reason?: string;
    code?: string;
  };
  'component:shutdown-force-completed': { name: string };
  'component:shutdown-force-timeout': { name: string; timeoutMS: number };
  'component:startup-rollback': { name: string };
  'signal:shutdown': { method: ShutdownSignal };
  'signal:reload': undefined;
  'signal:info': undefined;
  'signal:debug': undefined;
  'component:reload-started': { name: string };
  'component:reload-completed': { name: string };
  'component:reload-failed': { name: string; error: Error };
  'component:info-started': { name: string };
  'component:info-completed': { name: string };
  'component:info-failed': { name: string; error: Error };
  'component:debug-started': { name: string };
  'component:debug-completed': { name: string };
  'component:debug-failed': { name: string; error: Error };
}

export type LifecycleManagerEventName = keyof LifecycleManagerEventMap;

export type LifecycleManagerEmit = <K extends LifecycleManagerEventName>(
  event: K,
  data: LifecycleManagerEventMap[K],
) => void;

export class LifecycleManagerEvents {
  constructor(private readonly emit: LifecycleManagerEmit) {}

  public componentUnregistered(
    name: string,
    wasDuringShutdown?: boolean,
  ): void {
    this.emit('component:unregistered', {
      name,
      duringShutdown: wasDuringShutdown,
    });
  }

  public componentStartSkipped(name: string, reason: string): void {
    this.emit('component:start-skipped', { name, reason });
  }

  public componentStartFailedOptional(name: string, error?: Error): void {
    this.emit('component:start-failed-optional', { name, error });
  }

  public lifecycleManagerStarted(
    startedComponents: string[],
    failedOptionalComponents: StartupResult['failedOptionalComponents'],
    skippedComponents: string[],
  ): void {
    this.emit('lifecycle-manager:started', {
      startedComponents,
      failedOptionalComponents,
      skippedComponents,
    });
  }

  public lifecycleManagerSignalsAttached(): void {
    this.emit('lifecycle-manager:signals-attached', undefined);
  }

  public lifecycleManagerSignalsDetached(): void {
    this.emit('lifecycle-manager:signals-detached', undefined);
  }

  public componentHealthCheckStarted(name: string): void {
    this.emit('component:health-check-started', { name });
  }

  public componentHealthCheckCompleted(input: {
    name: string;
    healthy: boolean;
    message?: string;
    details?: ComponentHealthResult['details'];
    durationMS: number;
    timedOut: boolean;
  }): void {
    this.emit('component:health-check-completed', input);
  }

  public componentHealthCheckFailed(name: string, error: Error): void {
    this.emit('component:health-check-failed', { name, error });
  }

  public componentMessageSent(input: {
    componentName: string;
    from: string | null;
    payload: unknown;
  }): void {
    this.emit('component:message-sent', input);
  }

  public componentMessageFailed(
    componentName: string,
    from: string | null,
    error: Error,
    info?: {
      timedOut?: boolean;
      code?: MessageResult['code'];
      componentFound?: boolean;
      componentRunning?: boolean;
      handlerImplemented?: boolean;
      data?: unknown;
    },
  ): void {
    this.emit('component:message-failed', {
      componentName,
      from,
      error,
      timedOut: info?.timedOut ?? false,
      code: info?.code ?? 'error',
      componentFound: info?.componentFound,
      componentRunning: info?.componentRunning,
      handlerImplemented: info?.handlerImplemented,
      data: info?.data,
    });
  }

  public componentBroadcastStarted(
    from: string | null,
    payload: unknown,
  ): void {
    this.emit('component:broadcast-started', { from, payload });
  }

  public componentBroadcastCompleted(
    from: string | null,
    resultsCount: number,
    results: BroadcastResult[],
  ): void {
    this.emit('component:broadcast-completed', { from, resultsCount, results });
  }

  public componentValueRequested(
    componentName: string,
    key: string,
    from: string | null,
  ): void {
    this.emit('component:value-requested', { componentName, key, from });
  }

  public componentValueReturned(
    componentName: string,
    key: string,
    from: string | null,
    input: {
      found: boolean;
      value: unknown;
      componentFound: boolean;
      componentRunning: boolean;
      handlerImplemented: boolean;
      requestedBy: string | null;
      code: ValueResult['code'];
    },
  ): void {
    this.emit('component:value-returned', {
      componentName,
      key,
      from,
      ...input,
    });
  }

  public componentRegistrationRejected(input: {
    name: string;
    reason: RegistrationFailureCode;
    message?: string;
    target?: string | null;
    cycle?: string[];
    registrationIndexBefore?: number | null;
    registrationIndexAfter?: number | null;
    startupOrder?: string[];
    requestedPosition?: InsertComponentAtResult['requestedPosition'];
    manualPositionRespected?: boolean;
    targetFound?: boolean;
  }): void {
    this.emit('component:registration-rejected', input);
  }

  public componentRegistered(input: {
    name: string;
    index: number | null;
    action:
      | RegisterComponentResult['action']
      | InsertComponentAtResult['action'];
    registrationIndexBefore: number | null;
    registrationIndexAfter: number | null;
    startupOrder: string[];
    requestedPosition?: InsertComponentAtResult['requestedPosition'];
    manualPositionRespected?: boolean;
    targetFound?: boolean;
    duringStartup?: boolean;
    autoStartAttempted?: boolean;
    autoStartSucceeded?: boolean;
  }): void {
    this.emit('component:registered', input);
  }

  public lifecycleManagerShutdownInitiated(
    method: ShutdownMethod,
    isDuringStartup: boolean,
  ): void {
    this.emit('lifecycle-manager:shutdown-initiated', {
      method,
      duringStartup: isDuringStartup,
    });
  }

  public lifecycleManagerShutdownCompleted(input: {
    durationMS: number;
    stoppedComponents: string[];
    stalledComponents: ComponentStallInfo[];
    method: ShutdownMethod;
    duringStartup: boolean;
  }): void {
    this.emit('lifecycle-manager:shutdown-completed', input);
  }

  public componentStarting(name: string): void {
    this.emit('component:starting', { name });
  }

  public componentStarted(name: string, status?: ComponentStatus): void {
    this.emit('component:started', { name, status });
  }

  public componentStartTimeout(
    name: string,
    error: Error,
    info?: { timeoutMS?: number; reason?: string },
  ): void {
    this.emit('component:start-timeout', {
      name,
      error,
      timeoutMS: info?.timeoutMS,
      reason: info?.reason,
      code: 'start_timeout',
    });
  }

  public componentStartFailed(
    name: string,
    error: Error,
    info?: { reason?: string },
  ): void {
    this.emit('component:start-failed', {
      name,
      error,
      reason: info?.reason,
      code: 'unknown_error',
    });
  }

  public lifecycleManagerShutdownWarning(timeoutMS: number): void {
    this.emit('lifecycle-manager:shutdown-warning', { timeoutMS });
  }

  public componentShutdownWarning(name: string): void {
    this.emit('component:shutdown-warning', { name });
  }

  public componentShutdownWarningCompleted(name: string): void {
    this.emit('component:shutdown-warning-completed', { name });
  }

  public lifecycleManagerShutdownWarningCompleted(timeoutMS: number): void {
    this.emit('lifecycle-manager:shutdown-warning-completed', { timeoutMS });
  }

  public componentShutdownWarningTimeout(
    name: string,
    timeoutMS: number,
  ): void {
    this.emit('component:shutdown-warning-timeout', { name, timeoutMS });
  }

  public lifecycleManagerShutdownWarningTimeout(
    timeoutMS: number,
    pending: string[],
  ): void {
    this.emit('lifecycle-manager:shutdown-warning-timeout', {
      timeoutMS,
      pending,
    });
  }

  public componentStopping(name: string): void {
    this.emit('component:stopping', { name });
  }

  public componentStopped(name: string, status?: ComponentStatus): void {
    this.emit('component:stopped', { name, status });
  }

  public componentStopTimeout(
    name: string,
    error: Error,
    info?: { timeoutMS?: number; reason?: string },
  ): void {
    this.emit('component:stop-timeout', {
      name,
      error,
      timeoutMS: info?.timeoutMS,
      reason: info?.reason,
      code: 'stop_timeout',
    });
  }

  public componentShutdownForce(input: {
    name: string;
    context: { gracefulPhaseRan: boolean; gracefulTimedOut: boolean };
  }): void {
    this.emit('component:shutdown-force', input);
  }

  public componentStalled(
    name: string,
    stallInfo: ComponentStallInfo,
    info?: { reason?: string; code?: string },
  ): void {
    this.emit('component:stalled', {
      name,
      stallInfo,
      reason: info?.reason,
      code: info?.code,
    });
  }

  public componentShutdownForceCompleted(name: string): void {
    this.emit('component:shutdown-force-completed', { name });
  }

  public componentShutdownForceTimeout(name: string, timeoutMS: number): void {
    this.emit('component:shutdown-force-timeout', { name, timeoutMS });
  }

  public componentStartupRollback(name: string): void {
    this.emit('component:startup-rollback', { name });
  }

  public signalShutdown(method: ShutdownSignal): void {
    this.emit('signal:shutdown', { method });
  }

  public signalReload(): void {
    this.emit('signal:reload', undefined);
  }

  public signalInfo(): void {
    this.emit('signal:info', undefined);
  }

  public signalDebug(): void {
    this.emit('signal:debug', undefined);
  }

  public componentReloadStarted(name: string): void {
    this.emit('component:reload-started', { name });
  }

  public componentReloadCompleted(name: string): void {
    this.emit('component:reload-completed', { name });
  }

  public componentReloadFailed(name: string, error: Error): void {
    this.emit('component:reload-failed', { name, error });
  }

  public componentInfoStarted(name: string): void {
    this.emit('component:info-started', { name });
  }

  public componentInfoCompleted(name: string): void {
    this.emit('component:info-completed', { name });
  }

  public componentInfoFailed(name: string, error: Error): void {
    this.emit('component:info-failed', { name, error });
  }

  public componentDebugStarted(name: string): void {
    this.emit('component:debug-started', { name });
  }

  public componentDebugCompleted(name: string): void {
    this.emit('component:debug-completed', { name });
  }

  public componentDebugFailed(name: string, error: Error): void {
    this.emit('component:debug-failed', { name, error });
  }
}
