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
  readonly runningComponents: ReadonlySet<string>;
  readonly isStarting: boolean;
  readonly messageTimeoutMS: number;
  readonly logger: LoggerService;
  readonly lifecycleEvents: LifecycleManagerEvents;
  readonly nameOf: (component: BaseComponent) => string;
  readonly isComponentRunning: (name: string) => boolean;
  readonly isComponentUp: (name: string) => boolean;
  readonly getComponent: (name: string) => BaseComponent | undefined;
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
