import { describe, expect, test, mock } from 'bun:test';
import { ComponentLifecycle } from './component-lifecycle';
import type { LifecycleCommon, LifecycleInternalCallbacks } from './types';

describe('ComponentLifecycle Proxy Wrapper', () => {
  const componentName = 'test-component';

  test('delegates event emitter and manager queries correctly', async () => {
    const mockManager: Record<string, any> = {
      on: mock((_event: string, _cb: any) => () => {}),
      once: mock((_event: string, _cb: any) => () => {}),
      hasListener: mock((_event: string, _cb: any) => true),
      hasListeners: mock((_event: string) => true),
      listenerCount: mock((_event: string) => 42),
      hasComponent: mock((_name: string) => true),
      isComponentRunning: mock((_name: string) => true),
      getComponentNames: mock(() => ['comp1', 'comp2']),
      getRunningComponentNames: mock(() => ['comp1']),
      getComponentCount: mock(() => 2),
      getRunningComponentCount: mock(() => 1),
      getStalledComponentCount: mock(() => 0),
      getStoppedComponentCount: mock(() => 1),
      getComponentStatus: mock((_name: string) => undefined),
      getAllComponentStatuses: mock(() => []),
      getSystemState: mock(() => 'running'),
      getStatus: mock(() => ({}) as any),
      getStalledComponents: mock(() => []),
      getStalledComponentNames: mock(() => []),
      getStoppedComponentNames: mock(() => []),
      getStartupOrder: mock(() => ({}) as any),
      validateDependencies: mock(() => ({}) as any),
      startAllComponents: mock(() => Promise.resolve({} as any)),
      stopAllComponents: mock(() => Promise.resolve({} as any)),
      restartAllComponents: mock(() => Promise.resolve({} as any)),
      startComponent: mock(() => Promise.resolve({} as any)),
      stopComponent: mock(() => Promise.resolve({} as any)),
      restartComponent: mock(() => Promise.resolve({} as any)),
      attachSignals: mock(() => {}),
      detachSignals: mock(() => {}),
      getSignalStatus: mock(() => ({}) as any),
      getShutdownEscalationStatus: mock(() => ({}) as any),
      triggerReload: mock(() => Promise.resolve({} as any)),
      triggerInfo: mock(() => Promise.resolve({} as any)),
      triggerDebug: mock(() => Promise.resolve({} as any)),
      checkComponentHealth: mock(() => Promise.resolve({} as any)),
      checkAllHealth: mock(() => Promise.resolve({} as any)),
    };

    const mockCallbacks: LifecycleInternalCallbacks = {
      sendMessageInternal: mock(() => Promise.resolve({} as any)),
      broadcastMessageInternal: mock(() => Promise.resolve({} as any)),
      getValueInternal: mock(() => ({}) as any),
    };

    const proxy = new ComponentLifecycle(
      mockManager as unknown as LifecycleCommon,
      componentName,
      mockCallbacks,
    );

    // Call and assert event emitter methods
    const cb = () => {};
    proxy.on('event', cb);
    expect(mockManager.on).toHaveBeenCalledWith('event', cb);

    proxy.once('event', cb);
    expect(mockManager.once).toHaveBeenCalledWith('event', cb);

    proxy.hasListener('event', cb);
    expect(mockManager.hasListener).toHaveBeenCalledWith('event', cb);

    proxy.hasListeners('event');
    expect(mockManager.hasListeners).toHaveBeenCalledWith('event');

    proxy.listenerCount('event');
    expect(mockManager.listenerCount).toHaveBeenCalledWith('event');

    // Call and assert component checks
    proxy.hasComponent('comp1');
    expect(mockManager.hasComponent).toHaveBeenCalledWith('comp1');

    proxy.isComponentRunning('comp1');
    expect(mockManager.isComponentRunning).toHaveBeenCalledWith('comp1');

    expect(proxy.getComponentNames()).toEqual(['comp1', 'comp2']);
    expect(mockManager.getComponentNames).toHaveBeenCalled();

    expect(proxy.getRunningComponentNames()).toEqual(['comp1']);
    expect(mockManager.getRunningComponentNames).toHaveBeenCalled();

    expect(proxy.getComponentCount()).toBe(2);
    expect(mockManager.getComponentCount).toHaveBeenCalled();

    expect(proxy.getRunningComponentCount()).toBe(1);
    expect(mockManager.getRunningComponentCount).toHaveBeenCalled();

    expect(proxy.getStalledComponentCount()).toBe(0);
    expect(mockManager.getStalledComponentCount).toHaveBeenCalled();

    expect(proxy.getStoppedComponentCount()).toBe(1);
    expect(mockManager.getStoppedComponentCount).toHaveBeenCalled();

    proxy.getComponentStatus('comp1');
    expect(mockManager.getComponentStatus).toHaveBeenCalledWith('comp1');

    proxy.getAllComponentStatuses();
    expect(mockManager.getAllComponentStatuses).toHaveBeenCalled();

    // Call and assert state queries
    proxy.getSystemState();
    expect(mockManager.getSystemState).toHaveBeenCalled();

    proxy.getStatus();
    expect(mockManager.getStatus).toHaveBeenCalled();

    proxy.getStalledComponents();
    expect(mockManager.getStalledComponents).toHaveBeenCalled();

    proxy.getStalledComponentNames();
    expect(mockManager.getStalledComponentNames).toHaveBeenCalled();

    proxy.getStoppedComponentNames();
    expect(mockManager.getStoppedComponentNames).toHaveBeenCalled();

    proxy.getStartupOrder();
    expect(mockManager.getStartupOrder).toHaveBeenCalled();

    proxy.validateDependencies();
    expect(mockManager.validateDependencies).toHaveBeenCalled();

    // Call and assert operations
    const startupOpts = { timeoutMS: 100 };
    await proxy.startAllComponents(startupOpts);
    expect(mockManager.startAllComponents).toHaveBeenCalledWith(startupOpts);

    const stopOpts = { timeoutMS: 200 };
    await proxy.stopAllComponents(stopOpts);
    expect(mockManager.stopAllComponents).toHaveBeenCalledWith(stopOpts);

    const restartOpts = { shutdownTimeoutMS: 300 };
    await proxy.restartAllComponents(restartOpts);
    expect(mockManager.restartAllComponents).toHaveBeenCalledWith(restartOpts);

    const startCompOpts = { allowNonRunningDependencies: true };
    await proxy.startComponent('comp1', startCompOpts);
    expect(mockManager.startComponent).toHaveBeenCalledWith(
      'comp1',
      startCompOpts,
    );

    const stopCompOpts = { forceImmediate: true };
    await proxy.stopComponent('comp1', stopCompOpts);
    expect(mockManager.stopComponent).toHaveBeenCalledWith(
      'comp1',
      stopCompOpts,
    );

    const restartCompOpts = { stopOptions: { forceImmediate: true } };
    await proxy.restartComponent('comp1', restartCompOpts);
    expect(mockManager.restartComponent).toHaveBeenCalledWith(
      'comp1',
      restartCompOpts,
    );

    // Call and assert signal/health methods
    proxy.attachSignals();
    expect(mockManager.attachSignals).toHaveBeenCalled();

    proxy.detachSignals();
    expect(mockManager.detachSignals).toHaveBeenCalled();

    proxy.getSignalStatus();
    expect(mockManager.getSignalStatus).toHaveBeenCalled();

    proxy.getShutdownEscalationStatus();
    expect(mockManager.getShutdownEscalationStatus).toHaveBeenCalled();

    await proxy.triggerReload();
    expect(mockManager.triggerReload).toHaveBeenCalled();

    await proxy.triggerInfo();
    expect(mockManager.triggerInfo).toHaveBeenCalled();

    await proxy.triggerDebug();
    expect(mockManager.triggerDebug).toHaveBeenCalled();

    await proxy.checkComponentHealth('comp1');
    expect(mockManager.checkComponentHealth).toHaveBeenCalledWith('comp1');

    await proxy.checkAllHealth();
    expect(mockManager.checkAllHealth).toHaveBeenCalled();
  });

  test('delegates internal callbacks with auto-sender tracking correctly', async () => {
    const mockManager = {} as LifecycleCommon;
    const mockCallbacks: LifecycleInternalCallbacks = {
      sendMessageInternal: mock(() => Promise.resolve({} as any)),
      broadcastMessageInternal: mock(() => Promise.resolve({} as any)),
      getValueInternal: mock(() => ({}) as any),
    };

    const proxy = new ComponentLifecycle(
      mockManager,
      componentName,
      mockCallbacks,
    );

    const payload = { foo: 'bar' };
    const sendOpts = { timeout: 500 };
    await proxy.sendMessageToComponent('other-component', payload, sendOpts);
    expect(mockCallbacks.sendMessageInternal).toHaveBeenCalledWith(
      'other-component',
      payload,
      componentName,
      sendOpts,
    );

    const broadcastOpts = { timeout: 1000 };
    await proxy.broadcastMessage(payload, broadcastOpts);
    expect(mockCallbacks.broadcastMessageInternal).toHaveBeenCalledWith(
      payload,
      componentName,
      broadcastOpts,
    );

    const getValOpts = { includeStopped: true };
    proxy.getValue('other-component', 'some-key', getValOpts);
    expect(mockCallbacks.getValueInternal).toHaveBeenCalledWith(
      'other-component',
      'some-key',
      componentName,
      getValOpts,
    );
  });
});
