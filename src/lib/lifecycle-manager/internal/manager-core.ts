import type { Logger } from '../../logger';
import type { LoggerService } from '../../logger/logger-service';
import type { LifecycleManagerEvents } from '../events';
import type { LifecycleManager } from '../lifecycle-manager';
import type { ComponentMetadataReader } from './component-metadata-reader';
import { LoggerExitHook } from './logger-exit-hook';
import type { ManagerConfig } from './manager-config';
import type { LifecycleManagerState } from './manager-state';
import type { RegistrationReadTracker } from './registration-read-tracker';
import type { TransitionEventDispatcher } from './transition-event-dispatcher';

/**
 * Manager operations a subsystem calls that still live on the manager itself, because
 * no subsystem owns them yet. The manager supplies them as callbacks that forward to
 * its own members at call time, so a patched or overridden member is the one that
 * runs. An extraction that takes one of these over moves it onto its subsystem.
 */
export interface ManagerInternals {
  /** The shutdown latch: set exactly while a shutdown pass is running. */
  readonly isShuttingDown: boolean;
  /** Record a shutdown request that landed while a shutdown pass was already running. */
  noteShutdownRequestDuringActivePass(): void;
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
  readonly internals: ManagerInternals;
}

/**
 * The shared core every manager subsystem is built over: the manager's state, config,
 * loggers, event plumbing and registry readers, plus each subsystem, so subsystems
 * reach one another through it rather than through the manager.
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
  public readonly internals: ManagerInternals;

  // Subsystems
  public readonly loggerExit: LoggerExitHook;

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
    this.internals = parts.internals;

    this.loggerExit = new LoggerExitHook(this);
  }
}
