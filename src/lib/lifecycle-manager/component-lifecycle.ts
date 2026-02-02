import type {
  LifecycleCommon,
  ComponentLifecycleRef,
  ComponentOperationResult,
  ComponentStatus,
  ComponentStallInfo,
  LifecycleManagerStatus,
  DependencyValidationResult,
  LifecycleSignalStatus,
  RestartComponentOptions,
  RestartResult,
  RestartAllOptions,
  ShutdownResult,
  SignalBroadcastResult,
  StartComponentOptions,
  StartupOptions,
  StartupOrderResult,
  StartupResult,
  StopComponentOptions,
  StopAllOptions,
  SystemState,
  MessageResult,
  BroadcastResult,
  BroadcastOptions,
  SendMessageOptions,
  GetValueOptions,
  HealthCheckResult,
  HealthReport,
  ValueResult,
  LifecycleInternalCallbacks,
} from './types';

export class ComponentLifecycle implements ComponentLifecycleRef {
  private readonly manager: LifecycleCommon;
  private readonly componentName: string;
  private readonly internalCallbacks: LifecycleInternalCallbacks;

  constructor(
    manager: LifecycleCommon,
    componentName: string,
    internalCallbacks: LifecycleInternalCallbacks,
  ) {
    this.manager = manager;
    this.componentName = componentName;
    this.internalCallbacks = internalCallbacks;
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

  public getStalledComponentCount(): number {
    return this.manager.getStalledComponentCount();
  }

  public getStoppedComponentCount(): number {
    return this.manager.getStoppedComponentCount();
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

  public getStatus(): LifecycleManagerStatus {
    return this.manager.getStatus();
  }

  public getStalledComponents(): ComponentStallInfo[] {
    return this.manager.getStalledComponents();
  }

  public getStalledComponentNames(): string[] {
    return this.manager.getStalledComponentNames();
  }

  public getStoppedComponentNames(): string[] {
    return this.manager.getStoppedComponentNames();
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

  public stopAllComponents(options?: StopAllOptions): Promise<ShutdownResult> {
    return this.manager.stopAllComponents(options);
  }

  public restartAllComponents(
    options?: RestartAllOptions,
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

  // ============================================================================
  // Component Messaging (with automatic 'from' tracking)
  // ============================================================================

  /**
   * Send a message to another component
   *
   * When called from within a component, automatically tracks the sender.
   * The 'from' parameter will be set to this component's name.
   *
   * @param componentName - Target component name
   * @param payload - Message payload
   * @param options - Optional message options (timeout override)
   * @returns Result with sent status, data, and any errors
   */
  public sendMessageToComponent(
    componentName: string,
    payload: unknown,
    options?: SendMessageOptions,
  ): Promise<MessageResult> {
    // Call internal callback with automatic 'from' tracking
    // Automatically passes this component's name as 'from'
    return this.internalCallbacks.sendMessageInternal(
      componentName,
      payload,
      this.componentName,
      options,
    );
  }

  /**
   * Broadcast a message to multiple components
   *
   * When called from within a component, automatically tracks the sender.
   * The 'from' parameter will be set to this component's name.
   *
   * @param payload - Message payload
   * @param options - Filtering options and message timeout override
   * @returns Array of results, one per component
   */
  public broadcastMessage(
    payload: unknown,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    // Call internal callback with automatic 'from' tracking
    // Automatically passes this component's name as 'from'
    return this.internalCallbacks.broadcastMessageInternal(
      payload,
      this.componentName,
      options,
    );
  }

  // ============================================================================
  // Health Checks
  // ============================================================================

  /**
   * Check the health of a specific component
   *
   * @param name - Component name
   * @returns Health check result
   */
  public checkComponentHealth(name: string): Promise<HealthCheckResult> {
    return this.manager.checkComponentHealth(name);
  }

  /**
   * Check the health of all running components
   *
   * @returns Aggregate health report
   */
  public checkAllHealth(): Promise<HealthReport> {
    return this.manager.checkAllHealth();
  }

  // ============================================================================
  // Shared Values (with automatic 'from' tracking)
  // ============================================================================

  /**
   * Request a value from another component
   *
   * When called from within a component, automatically tracks the requester.
   * The 'from' parameter will be set to this component's name.
   *
   * @param componentName - Target component name
   * @param key - Value key
   * @returns Result with found status, value, and metadata
   */
  public getValue<T = unknown>(
    componentName: string,
    key: string,
    options?: GetValueOptions,
  ): ValueResult<T> {
    // Call internal callback with automatic 'from' tracking
    // Automatically passes this component's name as 'from'
    return this.internalCallbacks.getValueInternal<T>(
      componentName,
      key,
      this.componentName,
      options,
    );
  }
}
