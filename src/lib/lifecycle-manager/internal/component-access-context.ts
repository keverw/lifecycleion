import type { BaseComponent } from '../base-component';
import type { LifecycleManagerEvents } from '../events';
import type { LoggerService } from '../../logger/logger-service';
import type {
  ComponentState,
  ComponentStallInfo,
  HealthCheckResult,
  MessageResult,
  SendMessageOptions,
} from '../types';

/** Live manager state and callbacks used by component access operations. */
export interface ComponentAccessContext {
  readonly components: readonly BaseComponent[];
  readonly componentStates: ReadonlyMap<string, ComponentState>;
  readonly stalledComponents: ReadonlyMap<string, ComponentStallInfo>;
  readonly isStarting: boolean;
  readonly messageTimeoutMS: number;
  readonly logger: LoggerService;
  readonly lifecycleEvents: LifecycleManagerEvents;
  readonly nameOf: (component: BaseComponent) => string;
  readonly isComponentRunning: (name: string) => boolean;
  readonly getComponent: (name: string) => BaseComponent | undefined;
  /** Whether a `start()` of the component is still running, whatever its state says. */
  readonly isRawStartPending: (name: string) => boolean;
  /**
   * Whether a timed-out start that completed late is being cleaned up: the component is
   * marked running only so the normal stop path can stop it, and must not be entered.
   */
  readonly isLateStartCleanupPending: (name: string) => boolean;
  readonly sendMessageSettled: (
    componentName: string,
    payload: unknown,
    from: string | null,
    options?: SendMessageOptions,
  ) => Promise<MessageResult>;
  readonly checkComponentHealth: (name: string) => Promise<HealthCheckResult>;
  readonly observeFailureAfterTimeout: (
    promise: Promise<unknown>,
    name: string,
    message: string,
    params?: Record<string, unknown>,
  ) => void;
}
