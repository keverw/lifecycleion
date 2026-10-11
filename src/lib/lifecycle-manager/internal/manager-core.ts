import type { Logger } from '../../logger';
import type { LoggerService } from '../../logger/logger-service';
import type {
  ProcessSignalManager,
  ProcessSignalManagerOptions,
} from '../../process-signal-manager';
import type { LifecycleManagerEvents } from '../events';
import type { LifecycleManager } from '../lifecycle-manager';
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
import { MessagingOperations } from './messaging-operations';
import { RegistrationOperations } from './registration-operations';
import type { RegistrationReadTracker } from './registration-read-tracker';
import { RestartOperations } from './restart-operations';
import { ShutdownEscalation } from './shutdown-escalation';
import { ShutdownPassRunner } from './shutdown-pass';
import { SignalIntegration } from './signal-integration';
import { StartSettlements } from './start-settlements';
import { StartupOrchestration } from './startup-orchestration';
import { StartupOrdering } from './startup-ordering';
import { StartupPreflight } from './startup-preflight';
import { StopOutcomes } from './stop-outcomes';
import type { TransitionEventDispatcher } from './transition-event-dispatcher';
import { UnexpectedStops } from './unexpected-stops';
import { UnregistrationOperations } from './unregistration-operations';

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
  /**
   * Creates the `ProcessSignalManager` signals attach through. Supplied by the manager
   * so these modules never import the Node-only signal manager themselves.
   */
  readonly createProcessSignalManager: (
    options: ProcessSignalManagerOptions,
  ) => ProcessSignalManager;
}

/**
 * The shared core every manager subsystem is built over: the manager's state, config,
 * loggers, event plumbing, registry readers and component access context, plus each
 * subsystem, so subsystems reach one another through it rather than through the
 * manager. The one way back to the manager is `manager`, for its public methods.
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
  public readonly createProcessSignalManager: (
    options: ProcessSignalManagerOptions,
  ) => ProcessSignalManager;

  // Subsystems. Each is created below, over this core, and reached through it.

  // The registry, and what changes it.
  public readonly registry: ComponentRegistry;
  public readonly registration: RegistrationOperations;
  public readonly unregistration: UnregistrationOperations;
  public readonly startupOrdering: StartupOrdering;
  // One component's start and stop, and the claims they hold.
  public readonly claims: ComponentClaims;
  public readonly componentStart: ComponentStart;
  public readonly startSettlements: StartSettlements;
  public readonly componentStop: ComponentStop;
  public readonly stopOutcomes: StopOutcomes;
  public readonly lateStartRecovery: LateStartRecovery;
  public readonly unexpectedStops: UnexpectedStops;
  // Bulk operations.
  public readonly startup: StartupOrchestration;
  public readonly startupPreflight: StartupPreflight;
  public readonly shutdownPass: ShutdownPassRunner;
  public readonly shutdownEscalation: ShutdownEscalation;
  public readonly restart: RestartOperations;
  // The process, and requests made of running components.
  public readonly signals: SignalIntegration;
  public readonly loggerExit: LoggerExitHook;
  public readonly messaging: MessagingOperations;

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
    this.createProcessSignalManager = parts.createProcessSignalManager;

    this.registry = new ComponentRegistry(this);
    this.registration = new RegistrationOperations(this);
    this.unregistration = new UnregistrationOperations(this);
    this.startupOrdering = new StartupOrdering(this);
    this.claims = new ComponentClaims(this);
    this.componentStart = new ComponentStart(this);
    this.startSettlements = new StartSettlements(this);
    this.componentStop = new ComponentStop(this);
    this.stopOutcomes = new StopOutcomes(this);
    this.lateStartRecovery = new LateStartRecovery(this);
    this.unexpectedStops = new UnexpectedStops(this);
    this.startup = new StartupOrchestration(this);
    this.startupPreflight = new StartupPreflight(this);
    this.shutdownPass = new ShutdownPassRunner(this);
    this.shutdownEscalation = new ShutdownEscalation(this);
    this.restart = new RestartOperations(this);
    this.signals = new SignalIntegration(this);
    this.loggerExit = new LoggerExitHook(this);
    this.messaging = new MessagingOperations(this);
  }
}
