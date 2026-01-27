import type {
  LifecycleCommon,
  ComponentLifecycleRef,
  ComponentOperationResult,
  ComponentStatus,
  ComponentStallInfo,
  DependencyValidationResult,
  LifecycleSignalStatus,
  RestartComponentOptions,
  RestartResult,
  ShutdownResult,
  SignalBroadcastResult,
  StartComponentOptions,
  StartupOptions,
  StartupOrderResult,
  StartupResult,
  StopComponentOptions,
  SystemState,
} from './types';

export class ComponentLifecycle implements ComponentLifecycleRef {
  private readonly manager: LifecycleCommon;
  private readonly componentName: string;

  constructor(manager: LifecycleCommon, componentName: string) {
    this.manager = manager;
    this.componentName = componentName;
  }

  public on<T = unknown>(
    event: string,
    callback: (data: T) => void | Promise<void>,
  ): () => void {
    return this.manager.on(event, callback);
  }

  public once<T = unknown>(
    event: string,
    callback: (data: T) => void | Promise<void>,
  ): () => void {
    return this.manager.once(event, callback);
  }

  public hasListener<T = unknown>(
    event: string,
    callback: (data: T) => void | Promise<void>,
  ): boolean {
    return this.manager.hasListener(event, callback);
  }

  public hasListeners(event: string): boolean {
    return this.manager.hasListeners(event);
  }

  public listenerCount(event: string): number {
    return this.manager.listenerCount(event);
  }

  public hasComponent(name: string): boolean {
    return this.manager.hasComponent(name);
  }

  public isComponentRunning(name: string): boolean {
    return this.manager.isComponentRunning(name);
  }

  public getComponentNames(): string[] {
    return this.manager.getComponentNames();
  }

  public getRunningComponentNames(): string[] {
    return this.manager.getRunningComponentNames();
  }

  public getComponentCount(): number {
    return this.manager.getComponentCount();
  }

  public getRunningComponentCount(): number {
    return this.manager.getRunningComponentCount();
  }

  public getComponentStatus(name: string): ComponentStatus | undefined {
    return this.manager.getComponentStatus(name);
  }

  public getAllComponentStatuses(): ComponentStatus[] {
    return this.manager.getAllComponentStatuses();
  }

  public getSystemState(): SystemState {
    return this.manager.getSystemState();
  }

  public getStalledComponents(): ComponentStallInfo[] {
    return this.manager.getStalledComponents();
  }

  public getStartupOrder(): StartupOrderResult {
    return this.manager.getStartupOrder();
  }

  public validateDependencies(): DependencyValidationResult {
    return this.manager.validateDependencies();
  }

  public startAllComponents(options?: StartupOptions): Promise<StartupResult> {
    return this.manager.startAllComponents(options);
  }

  public stopAllComponents(): Promise<ShutdownResult> {
    return this.manager.stopAllComponents();
  }

  public restartAllComponents(
    options?: StartupOptions,
  ): Promise<RestartResult> {
    return this.manager.restartAllComponents(options);
  }

  public startComponent(
    name: string,
    options?: StartComponentOptions,
  ): Promise<ComponentOperationResult> {
    return this.manager.startComponent(name, options);
  }

  public stopComponent(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    return this.manager.stopComponent(name, options);
  }

  public restartComponent(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult> {
    return this.manager.restartComponent(name, options);
  }

  public attachSignals(): void {
    this.manager.attachSignals();
  }

  public detachSignals(): void {
    this.manager.detachSignals();
  }

  public getSignalStatus(): LifecycleSignalStatus {
    return this.manager.getSignalStatus();
  }

  public triggerReload(): Promise<SignalBroadcastResult> {
    return this.manager.triggerReload();
  }

  public triggerInfo(): Promise<SignalBroadcastResult> {
    return this.manager.triggerInfo();
  }

  public triggerDebug(): Promise<SignalBroadcastResult> {
    return this.manager.triggerDebug();
  }
}
