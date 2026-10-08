import type { Logger } from '../../logger';
import type { LoggerService } from '../../logger/logger-service';
import type { LifecycleManagerEvents } from '../events';
import type { LifecycleManager } from '../lifecycle-manager';
import type {
  BroadcastOptions,
  BroadcastResult,
  ComponentOperationResult,
  GetValueOptions,
  MessageResult,
  SendMessageOptions,
  ValueResult,
} from '../types';
import type { ComponentAccessContext } from './component-access-context';
import { ComponentClaims } from './component-claims';
import type { ComponentMetadataReader } from './component-metadata-reader';
import { ComponentRegistry } from './component-registry';
import { ComponentStart } from './component-start';
import { ComponentStop } from './component-stop';
import { LateStartRecovery } from './late-start-recovery';
import { LoggerExitHook } from './logger-exit-hook';
import type { ManagerConfig } from './manager-config';
import type { LifecycleManagerState } from './manager-state';
import { RegistrationOperations } from './registration-operations';
import type { RegistrationReadTracker } from './registration-read-tracker';
import { RestartOperations } from './restart-operations';
import { ShutdownEscalation } from './shutdown-escalation';
import { ShutdownPassRunner } from './shutdown-pass';
import { StartupOrchestration } from './startup-orchestration';
import { StartupOrdering } from './startup-ordering';
import type { TransitionEventDispatcher } from './transition-event-dispatcher';
import { UnexpectedStops } from './unexpected-stops';

/**
 * Manager operations a subsystem calls that still live on the manager itself, because
 * no subsystem owns them yet. The manager supplies them as callbacks that forward to
 * its own members at call time, so a patched or overridden member is the one that
 * runs. An extraction that takes one of these over moves it onto its subsystem.
 */
export interface ManagerInternals {
  /** `sendMessageToComponent()` under its safety net, as a component's handle sends it. */
  sendMessageSettled(
    componentName: string,
    payload: unknown,
    from: string | null,
    options?: SendMessageOptions,
  ): Promise<MessageResult>;
  /** `broadcastMessage()` under its safety net, as a component's handle sends it. */
  broadcastMessageSettled(
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]>;
  /** `getValue()` under its safety net, as a component's handle asks it. */
  getValueSettled<T = unknown>(
    componentName: string,
    key: string,
    from: string | null,
    options?: GetValueOptions,
  ): ValueResult<T>;
  /** Recompute `isStarted` from the running and stalled sets. */
  updateStartedFlag(): void;
  /** Record now as a component's `startedAt` or `stoppedAt`. */
  stampTimestamp(name: string, field: 'startedAt' | 'stoppedAt'): void;
  /** The `detachSignalsOnStop` check a stop or unregister runs once it has settled. */
  detachSignalsAfterLastStop(trigger?: string, logMessage?: string): void;
  /** Whether a component is up: running, and not on its way down. */
  isComponentUp(name: string): boolean;
  /** Attach signals on the manager's own initiative, ahead of a start; never throws. */
  autoAttachSignals(
    trigger: string,
  ):
    { outcome: 'attached' | 'unchanged' } | { outcome: 'failed'; error: Error };
  /** Stop a started component whose `attachSignalsOnStart` attach failed. */
  rollBackStartForSignalAttach(
    name: string,
    error: Error,
  ): Promise<ComponentOperationResult>;
  /** The `detachSignalsOnStop` check: detach once the manager is idle. */
  detachSignalsIfIdle(
    trigger: string,
    options?: { logMessage?: string; isEndingShutdownPass?: boolean },
  ): void;
  /** Run a detach `detachSignalsIfIdle()` deferred, once what held it has ended. */
  runDeferredSignalDetach(trigger: string): void;
}

/** What the manager hands its core: everything a subsystem shares, built once. */
export interface ManagerCoreParts {
  /**
   * The facade. Subsystems call its public methods through this reference, at call
   * time, so a subclass override or an instance patch is the one that runs.
   */
  readonly manager: LifecycleManager;
  readonly state: LifecycleManagerState;
  readonly config: ManagerConfig;
  /** The manager's guarded logging surface. */
  readonly logger: LoggerService;
  /** The caller's own `Logger`, never wrapped. */
  readonly rootLogger: Logger;
  readonly lifecycleEvents: LifecycleManagerEvents;
  readonly dispatcher: TransitionEventDispatcher;
  readonly registryReads: RegistrationReadTracker;
  readonly componentMetadata: ComponentMetadataReader;
  /** The live view and dispatch callbacks the component-facing operations use. */
  readonly componentAccess: ComponentAccessContext;
  readonly internals: ManagerInternals;
}

/**
 * The shared core every manager subsystem is built over: the manager's state, config,
 * loggers, event plumbing, registry readers and component access context, plus each
 * subsystem, so subsystems reach one another through it rather than through the
 * manager.
 *
 * Subsystems are created here, after the shared parts, and receive this core in their
 * constructor. A constructor only stores the core: another subsystem may not exist
 * yet while it runs.
 */
export class ManagerCore implements ManagerCoreParts {
  public readonly manager: LifecycleManager;
  public readonly state: LifecycleManagerState;
  public readonly config: ManagerConfig;
  public readonly logger: LoggerService;
  public readonly rootLogger: Logger;
  public readonly lifecycleEvents: LifecycleManagerEvents;
  public readonly dispatcher: TransitionEventDispatcher;
  public readonly registryReads: RegistrationReadTracker;
  public readonly componentMetadata: ComponentMetadataReader;
  public readonly componentAccess: ComponentAccessContext;
  public readonly internals: ManagerInternals;

  // Subsystems
  public readonly registry: ComponentRegistry;
  public readonly startupOrdering: StartupOrdering;
  public readonly loggerExit: LoggerExitHook;
  public readonly claims: ComponentClaims;
  public readonly componentStop: ComponentStop;
  public readonly componentStart: ComponentStart;
  public readonly lateStartRecovery: LateStartRecovery;
  public readonly unexpectedStops: UnexpectedStops;
  public readonly shutdownPass: ShutdownPassRunner;
  public readonly shutdownEscalation: ShutdownEscalation;
  public readonly startup: StartupOrchestration;
  public readonly restart: RestartOperations;
  public readonly registration: RegistrationOperations;

  constructor(parts: ManagerCoreParts) {
    this.manager = parts.manager;
    this.state = parts.state;
    this.config = parts.config;
    this.logger = parts.logger;
    this.rootLogger = parts.rootLogger;
    this.lifecycleEvents = parts.lifecycleEvents;
    this.dispatcher = parts.dispatcher;
    this.registryReads = parts.registryReads;
    this.componentMetadata = parts.componentMetadata;
    this.componentAccess = parts.componentAccess;
    this.internals = parts.internals;

    this.registry = new ComponentRegistry(this);
    this.startupOrdering = new StartupOrdering(this);
    this.loggerExit = new LoggerExitHook(this);
    this.claims = new ComponentClaims(this);
    this.componentStop = new ComponentStop(this);
    this.componentStart = new ComponentStart(this);
    this.lateStartRecovery = new LateStartRecovery(this);
    this.unexpectedStops = new UnexpectedStops(this);
    this.shutdownPass = new ShutdownPassRunner(this);
    this.shutdownEscalation = new ShutdownEscalation(this);
    this.startup = new StartupOrchestration(this);
    this.restart = new RestartOperations(this);
    this.registration = new RegistrationOperations(this);
  }
}
