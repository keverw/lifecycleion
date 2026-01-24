import { describe, expect, test, beforeEach } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import {
  InvalidComponentNameError,
  ComponentRegistrationError,
  DependencyCycleError,
  MissingDependencyError,
  ComponentStartupError,
  StartupTimeoutError,
  ComponentNotFoundError,
  lifecycleManagerErrPrefix,
  lifecycleManagerErrTypes,
  lifecycleManagerErrCodes,
} from './errors';

// Test component implementation
class TestComponent extends BaseComponent {
  public startCalled = false;
  public stopCalled = false;

  public start(): Promise<void> {
    this.startCalled = true;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.stopCalled = true;
    return Promise.resolve();
  }
}

const requireDefined = <T>(value: T | null | undefined, label: string): T => {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === null || value === undefined) {
    throw new Error(`${label} should be defined`);
  }
  return value;
};

describe('LifecycleManager - Phase 1: Foundation', () => {
  let logger: Logger;
  let arraySink: ArraySink;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });
  });

  describe('BaseComponent - Name Validation', () => {
    test('should accept valid kebab-case names', () => {
      const validNames = [
        'database',
        'web-server',
        'api-gateway',
        'cache-redis',
        'api-gateway-v2',
        'service123',
        'my-service-1',
      ];

      for (const name of validNames) {
        expect(() => {
          new TestComponent(logger, { name });
        }).not.toThrow();
      }
    });

    test('should reject invalid component names', () => {
      const invalidNames = [
        'Database', // uppercase
        'web_server', // underscore
        'WebServer', // camelCase
        'MY-SERVICE', // uppercase
        '', // empty
        'my server', // space
        '-service', // starts with hyphen
        'service-', // ends with hyphen
        '123service', // starts with number
        'my--service', // double hyphen
      ];

      for (const name of invalidNames) {
        expect(() => {
          new TestComponent(logger, { name });
        }).toThrow(InvalidComponentNameError);
      }
    });

    test('should include name in error message', () => {
      try {
        new TestComponent(logger, { name: 'InvalidName' });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidComponentNameError);
        expect((error as InvalidComponentNameError).message).toContain(
          'InvalidName',
        );
        expect((error as InvalidComponentNameError).additionalInfo).toEqual({
          name: 'InvalidName',
        });
      }
    });
  });

  describe('BaseComponent - Default Timeout Values', () => {
    test('should apply default timeout values', () => {
      const component = new TestComponent(logger, { name: 'test' });

      expect(component.startupTimeoutMS).toBe(30000);
      expect(component.shutdownWarningTimeoutMS).toBe(0);
      expect(component.shutdownGracefulTimeoutMS).toBe(5000);
      expect(component.shutdownForceTimeoutMS).toBe(2000);
      expect(component.healthCheckTimeoutMS).toBe(5000);
    });

    test('should use custom timeout values when provided', () => {
      const component = new TestComponent(logger, {
        name: 'test',
        startupTimeoutMS: 10000,
        shutdownWarningTimeoutMS: 2000,
        shutdownGracefulTimeoutMS: 8000,
        shutdownForceTimeoutMS: 3000,
        healthCheckTimeoutMS: 3000,
      });

      expect(component.startupTimeoutMS).toBe(10000);
      expect(component.shutdownWarningTimeoutMS).toBe(2000);
      expect(component.shutdownGracefulTimeoutMS).toBe(8000);
      expect(component.shutdownForceTimeoutMS).toBe(3000);
      expect(component.healthCheckTimeoutMS).toBe(3000);
    });

    test('should allow disabling startup timeout with 0', () => {
      const component = new TestComponent(logger, {
        name: 'test',
        startupTimeoutMS: 0,
      });

      expect(component.startupTimeoutMS).toBe(0);
    });
  });

  describe('BaseComponent - Timeout Minimums', () => {
    test('should enforce minimum graceful timeout of 1000ms', () => {
      const component1 = new TestComponent(logger, {
        name: 'test1',
        shutdownGracefulTimeoutMS: 500,
      });
      expect(component1.shutdownGracefulTimeoutMS).toBe(1000);

      const component2 = new TestComponent(logger, {
        name: 'test2',
        shutdownGracefulTimeoutMS: 0,
      });
      expect(component2.shutdownGracefulTimeoutMS).toBe(1000);

      const component3 = new TestComponent(logger, {
        name: 'test3',
        shutdownGracefulTimeoutMS: 2000,
      });
      expect(component3.shutdownGracefulTimeoutMS).toBe(2000);
    });

    test('should enforce minimum force timeout of 500ms', () => {
      const component1 = new TestComponent(logger, {
        name: 'test1',
        shutdownForceTimeoutMS: 100,
      });
      expect(component1.shutdownForceTimeoutMS).toBe(500);

      const component2 = new TestComponent(logger, {
        name: 'test2',
        shutdownForceTimeoutMS: 0,
      });
      expect(component2.shutdownForceTimeoutMS).toBe(500);

      const component3 = new TestComponent(logger, {
        name: 'test3',
        shutdownForceTimeoutMS: 1000,
      });
      expect(component3.shutdownForceTimeoutMS).toBe(1000);
    });
  });

  describe('BaseComponent - Logger Creation', () => {
    test('should create scoped logger with component name', () => {
      const component = new TestComponent(logger, { name: 'database' });

      // Access the protected logger field through a type assertion
      const componentLogger = (component as any).logger;

      // Log a message and verify it has the service name
      componentLogger.info('Test message');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].serviceName).toBe('database');
      expect(arraySink.logs[0].message).toBe('Test message');
    });

    test('should create separate logger scopes for different components', () => {
      const component1 = new TestComponent(logger, { name: 'database' });
      const component2 = new TestComponent(logger, { name: 'web-server' });

      (component1 as any).logger.info('Database message');
      (component2 as any).logger.info('Web server message');

      expect(arraySink.logs.length).toBe(2);
      expect(arraySink.logs[0].serviceName).toBe('database');
      expect(arraySink.logs[1].serviceName).toBe('web-server');
    });
  });

  describe('BaseComponent - Dependencies', () => {
    test('should store dependencies', () => {
      const component = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database', 'cache'],
      });

      expect(component.getDependencies()).toEqual(['database', 'cache']);
    });

    test('should default to empty dependencies array', () => {
      const component = new TestComponent(logger, { name: 'test' });

      expect(component.getDependencies()).toEqual([]);
    });

    test('should preserve dependency order', () => {
      const deps = ['service-a', 'service-b', 'service-c'];
      const component = new TestComponent(logger, {
        name: 'test',
        dependencies: deps,
      });

      expect(component.getDependencies()).toEqual(deps);
    });
  });

  describe('BaseComponent - Optional Flag', () => {
    test('should default to required (optional: false)', () => {
      const component = new TestComponent(logger, { name: 'test' });

      expect(component.isOptional()).toBe(false);
    });

    test('should respect optional: true', () => {
      const component = new TestComponent(logger, {
        name: 'test',
        optional: true,
      });

      expect(component.isOptional()).toBe(true);
    });

    test('should respect optional: false explicitly', () => {
      const component = new TestComponent(logger, {
        name: 'test',
        optional: false,
      });

      expect(component.isOptional()).toBe(false);
    });
  });

  describe('BaseComponent - Getters', () => {
    test('getName() should return component name', () => {
      const component = new TestComponent(logger, { name: 'my-service' });

      expect(component.getName()).toBe('my-service');
    });

    test('getDependencies() should return dependencies array', () => {
      const component = new TestComponent(logger, {
        name: 'test',
        dependencies: ['dep1', 'dep2'],
      });

      expect(component.getDependencies()).toEqual(['dep1', 'dep2']);
    });

    test('isOptional() should return optional flag', () => {
      const required = new TestComponent(logger, { name: 'required' });
      const optional = new TestComponent(logger, {
        name: 'optional',
        optional: true,
      });

      expect(required.isOptional()).toBe(false);
      expect(optional.isOptional()).toBe(true);
    });
  });

  describe('Error Classes', () => {
    test('InvalidComponentNameError should have correct properties', () => {
      const error = new InvalidComponentNameError({ name: 'Bad-Name' });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('InvalidComponentNameError');
      expect(error.errPrefix).toBe('LifecycleManagerErr');
      expect(error.errType).toBe('Component');
      expect(error.errCode).toBe('InvalidName');
      expect(error.additionalInfo).toEqual({ name: 'Bad-Name' });
      expect(error.message).toContain('Bad-Name');
      expect(error.message).toContain('kebab-case');
    });

    test('ComponentRegistrationError should have correct properties', () => {
      const error = new ComponentRegistrationError('Duplicate name', {
        name: 'database',
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ComponentRegistrationError');
      expect(error.errPrefix).toBe('LifecycleManagerErr');
      expect(error.errType).toBe('Component');
      expect(error.errCode).toBe('RegistrationFailed');
      expect(error.message).toBe('Duplicate name');
      expect(error.additionalInfo).toEqual({ name: 'database' });
    });

    test('DependencyCycleError should have correct properties', () => {
      const cycle = ['a', 'b', 'c'];
      const error = new DependencyCycleError({ cycle });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('DependencyCycleError');
      expect(error.errPrefix).toBe('LifecycleManagerErr');
      expect(error.errType).toBe('Dependency');
      expect(error.errCode).toBe('CyclicDependency');
      expect(error.additionalInfo).toEqual({ cycle });
      expect(error.message).toContain('a -> b -> c -> a');
    });

    test('MissingDependencyError should have correct properties', () => {
      const error = new MissingDependencyError({
        componentName: 'api',
        missingDependency: 'database',
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('MissingDependencyError');
      expect(error.errPrefix).toBe('LifecycleManagerErr');
      expect(error.errType).toBe('Dependency');
      expect(error.errCode).toBe('NotFound');
      expect(error.message).toContain('api');
      expect(error.message).toContain('database');
    });

    test('ComponentStartupError should have correct properties', () => {
      const cause = new Error('Connection failed');
      const error = new ComponentStartupError(
        { componentName: 'database' },
        cause,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ComponentStartupError');
      expect(error.errPrefix).toBe('LifecycleManagerErr');
      expect(error.errType).toBe('Component');
      expect(error.errCode).toBe('StartupFailed');
      expect(error.cause).toBe(cause);
      expect(error.message).toContain('database');
      expect(error.message).toContain('Connection failed');
    });

    test('StartupTimeoutError should have correct properties', () => {
      const error = new StartupTimeoutError({
        timeoutMS: 30000,
        startedCount: 3,
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('StartupTimeoutError');
      expect(error.errPrefix).toBe('LifecycleManagerErr');
      expect(error.errType).toBe('Lifecycle');
      expect(error.errCode).toBe('StartupTimeout');
      expect(error.message).toContain('30000ms');
      expect(error.message).toContain('3 components');
    });

    test('ComponentNotFoundError should have correct properties', () => {
      const error = new ComponentNotFoundError({ componentName: 'cache' });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ComponentNotFoundError');
      expect(error.errPrefix).toBe('LifecycleManagerErr');
      expect(error.errType).toBe('Component');
      expect(error.errCode).toBe('NotFound');
      expect(error.message).toContain('cache');
    });

    test('error constants should be defined', () => {
      expect(lifecycleManagerErrPrefix).toBe('LifecycleManagerErr');

      expect(lifecycleManagerErrTypes.Component).toBe('Component');
      expect(lifecycleManagerErrTypes.Dependency).toBe('Dependency');
      expect(lifecycleManagerErrTypes.Lifecycle).toBe('Lifecycle');

      expect(lifecycleManagerErrCodes.InvalidName).toBe('InvalidName');
      expect(lifecycleManagerErrCodes.RegistrationFailed).toBe(
        'RegistrationFailed',
      );
      expect(lifecycleManagerErrCodes.CyclicDependency).toBe(
        'CyclicDependency',
      );
      expect(lifecycleManagerErrCodes.NotFound).toBe('NotFound');
      expect(lifecycleManagerErrCodes.StartupFailed).toBe('StartupFailed');
      expect(lifecycleManagerErrCodes.StartupTimeout).toBe('StartupTimeout');
    });
  });

  describe('LifecycleManager - Registration Results', () => {
    test('registerComponent() should return rich success result with startupOrder', () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'database' });

      const result = lifecycle.registerComponent(component);
      expect(result.success).toBe(true);
      expect(result.registered).toBe(true);
      expect(result.componentName).toBe('database');
      expect(result.action).toBe('register');
      expect(result.startupOrder).toEqual(['database']);
      expect(result.registrationIndexBefore).toBe(null);
      expect(result.registrationIndexAfter).toBe(0);
    });

    test('registerComponent() should return duplicate_name failure result', () => {
      const lifecycle = new LifecycleManager({ logger });
      const component1 = new TestComponent(logger, { name: 'database' });
      const component2 = new TestComponent(logger, { name: 'database' });

      const result1 = lifecycle.registerComponent(component1);
      expect(result1.success).toBe(true);

      const result2 = lifecycle.registerComponent(component2);
      expect(result2.success).toBe(false);
      expect(result2.registered).toBe(false);
      expect(result2.code).toBe('duplicate_name');
      expect(result2.componentName).toBe('database');
      expect(result2.registrationIndexBefore).toBe(0);
      expect(result2.registrationIndexAfter).toBe(0);
      expect(result2.startupOrder).toEqual(['database']);
    });

    test('registerComponent() should return dependency_cycle failure result and not register component', () => {
      const lifecycle = new LifecycleManager({ logger });

      const a = new TestComponent(logger, { name: 'a', dependencies: ['b'] });
      const b = new TestComponent(logger, { name: 'b', dependencies: ['a'] });

      const resultA = lifecycle.registerComponent(a);
      expect(resultA.success).toBe(true);
      expect(lifecycle.hasComponent('a')).toBe(true);

      const resultB = lifecycle.registerComponent(b);
      expect(resultB.success).toBe(false);
      expect(resultB.registered).toBe(false);
      expect(resultB.code).toBe('dependency_cycle');
      expect(resultB.componentName).toBe('b');
      expect(resultB.registrationIndexBefore).toBe(null);
      expect(resultB.registrationIndexAfter).toBe(null);

      // Critically: 'b' must NOT be left in the registry/state maps.
      expect(lifecycle.hasComponent('b')).toBe(false);
      expect(lifecycle.getComponentStatus('b')).toBe(undefined);
      expect(lifecycle.getComponentNames()).toEqual(['a']);
      expect(resultB.startupOrder).toEqual(['a']);
    });

    test('insertComponentAt() should return dependency_cycle failure result and not register component', () => {
      const lifecycle = new LifecycleManager({ logger });

      const a = new TestComponent(logger, { name: 'a', dependencies: ['b'] });
      const b = new TestComponent(logger, { name: 'b', dependencies: ['a'] });

      const resultA = lifecycle.registerComponent(a);
      expect(resultA.success).toBe(true);
      expect(lifecycle.hasComponent('a')).toBe(true);

      const resultB = lifecycle.insertComponentAt(b, 'end');
      expect(resultB.success).toBe(false);
      expect(resultB.registered).toBe(false);
      expect(resultB.code).toBe('dependency_cycle');
      expect(resultB.componentName).toBe('b');
      expect(resultB.registrationIndexBefore).toBe(null);
      expect(resultB.registrationIndexAfter).toBe(null);

      // Critically: 'b' must NOT be left in the registry/state maps.
      expect(lifecycle.hasComponent('b')).toBe(false);
      expect(lifecycle.getComponentStatus('b')).toBe(undefined);
      expect(lifecycle.getComponentNames()).toEqual(['a']);
      expect(resultB.startupOrder).toEqual(['a']);
    });

    test('insertComponentAt() should return target_not_found failure result', () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'api' });

      const result = lifecycle.insertComponentAt(
        component,
        'before',
        'missing',
      );
      expect(result.success).toBe(false);
      expect(result.registered).toBe(false);
      expect(result.code).toBe('target_not_found');
      expect(result.targetFound).toBe(false);
      expect(result.componentName).toBe('api');
      expect(result.startupOrder).toEqual([]);
      expect(result.manualPositionRespected).toBe(false);
    });

    test('insertComponentAt() should return invalid_position failure result for untyped callers', () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'api' });

      const result = (lifecycle as any).insertComponentAt(component, 'weird');
      expect(result.success).toBe(false);
      expect(result.registered).toBe(false);
      expect(result.code).toBe('invalid_position');
      expect(result.componentName).toBe('api');
      expect(result.startupOrder).toEqual([]);
      expect(result.manualPositionRespected).toBe(false);
      expect(result.requestedPosition.position).toBe('weird');
    });

    test('insertComponentAt() should report manualPositionRespected=false when dependencies override requested order', () => {
      const lifecycle = new LifecycleManager({ logger });

      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      const dbResult = lifecycle.registerComponent(database);
      expect(dbResult.success).toBe(true);

      const apiResult = lifecycle.insertComponentAt(api, 'start');
      expect(apiResult.success).toBe(true);
      expect(apiResult.registered).toBe(true);

      // Even though we inserted API at the start of the registry list,
      // dependency constraints force database to start first.
      expect(apiResult.startupOrder).toEqual(['database', 'api']);
      expect(apiResult.manualPositionRespected).toBe(false);
    });

    test('getStartupOrder() should return success result with startupOrder', () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      const dbResult = lifecycle.registerComponent(database);
      expect(dbResult.success).toBe(true);

      const apiResult = lifecycle.registerComponent(api);
      expect(apiResult.success).toBe(true);

      const orderResult = lifecycle.getStartupOrder();
      expect(orderResult.success).toBe(true);
      expect(orderResult.startupOrder).toEqual(['database', 'api']);
    });

    test('getStartupOrder() should return dependency_cycle result if registry contains a cycle', () => {
      const lifecycle = new LifecycleManager({ logger });
      const a = new TestComponent(logger, { name: 'a', dependencies: ['b'] });
      const b = new TestComponent(logger, { name: 'b', dependencies: ['a'] });

      (lifecycle as any).components = [a, b];

      const orderResult = lifecycle.getStartupOrder();
      expect(orderResult.success).toBe(false);
      expect(orderResult.code).toBe('dependency_cycle');
      expect(orderResult.startupOrder).toEqual([]);
      expect(orderResult.error).toBeInstanceOf(DependencyCycleError);
    });
  });
});

describe('LifecycleManager - Phase 2: Core Registration & Individual Lifecycle', () => {
  let logger: Logger;
  let arraySink: ArraySink;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });
  });

  describe('Registration Methods', () => {
    test('registerComponent should set lifecycle reference', () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      expect((component as any).lifecycle).toBe(lifecycle);
    });

    test('unregisterComponent should remove component from registry', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      expect(lifecycle.hasComponent('test')).toBe(true);

      const result = await lifecycle.unregisterComponent('test');
      expect(result.success).toBe(true);
      expect(result.componentName).toBe('test');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(lifecycle.hasComponent('test')).toBe(false);
    });

    test('unregisterComponent should return false for non-existent component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const result = await lifecycle.unregisterComponent('non-existent');
      expect(result.success).toBe(false);
      expect(result.componentName).toBe('non-existent');
      expect(result.wasRegistered).toBe(false);
      expect(result.wasStopped).toBe(false);
      expect(result.reason).toBe('Component not found');
    });

    test('unregisterComponent should reject running component without stopIfRunning', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const result = await lifecycle.unregisterComponent('test');
      expect(result.success).toBe(false);
      expect(result.componentName).toBe('test');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(result.reason).toBe(
        'Component is running. Use stopIfRunning option or stop manually first',
      );
      expect(lifecycle.hasComponent('test')).toBe(true);
    });

    test('unregisterComponent should stop and remove component with stopIfRunning', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');
      expect(lifecycle.isComponentRunning('test')).toBe(true);

      const result = await lifecycle.unregisterComponent('test', {
        stopIfRunning: true,
      });
      expect(result.success).toBe(true);
      expect(result.componentName).toBe('test');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(true);
      expect(lifecycle.hasComponent('test')).toBe(false);
      expect(component.stopCalled).toBe(true);
    });

    test('unregisterComponent should fail (and keep registered) if stopIfRunning stop errors', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
      }

      const component = new FailingStopComponent(logger, { name: 'failing' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('failing');
      expect(lifecycle.isComponentRunning('failing')).toBe(true);

      const result = await lifecycle.unregisterComponent('failing', {
        stopIfRunning: true,
      });

      expect(result.success).toBe(false);
      expect(result.componentName).toBe('failing');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(result.reason).toBe('Stop failed');

      // Critical: component should remain registered when stop fails.
      expect(lifecycle.hasComponent('failing')).toBe(true);

      const status = lifecycle.getComponentStatus('failing');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
    });

    test('unregisterComponent should fail (and keep registered) if stopIfRunning stop times out (stalled)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop() {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      const component = new SlowStopComponent(logger, {
        name: 'slow-stop',
        shutdownGracefulTimeoutMS: 1000, // Minimum enforced
      });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('slow-stop');
      expect(lifecycle.isComponentRunning('slow-stop')).toBe(true);

      const result = await lifecycle.unregisterComponent('slow-stop', {
        stopIfRunning: true,
      });

      expect(result.success).toBe(false);
      expect(result.componentName).toBe('slow-stop');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(result.reason).toBe('Component stop timed out');

      // Critical: component should remain registered when stop stalls.
      expect(lifecycle.hasComponent('slow-stop')).toBe(true);

      const status = lifecycle.getComponentStatus('slow-stop');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
      const stallInfo = requireDefined(definedStatus.stallInfo, 'stallInfo');
      expect(stallInfo.reason).toBe('timeout');
    });
  });

  describe('Status Tracking', () => {
    test('hasComponent should return true for registered components', () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      expect(lifecycle.hasComponent('test')).toBe(true);
      expect(lifecycle.hasComponent('other')).toBe(false);
    });

    test('isComponentRunning should track running state', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      expect(lifecycle.isComponentRunning('test')).toBe(false);

      await lifecycle.startComponent('test');
      expect(lifecycle.isComponentRunning('test')).toBe(true);

      await lifecycle.stopComponent('test');
      expect(lifecycle.isComponentRunning('test')).toBe(false);
    });

    test('getComponentNames should return all registered names', () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      lifecycle.registerComponent(comp1);
      lifecycle.registerComponent(comp2);

      const names = lifecycle.getComponentNames();
      expect(names).toEqual(['database', 'web-server']);
    });

    test('getRunningComponentNames should return only running names', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      lifecycle.registerComponent(comp1);
      lifecycle.registerComponent(comp2);

      expect(lifecycle.getRunningComponentNames()).toEqual([]);

      await lifecycle.startComponent('database');
      expect(lifecycle.getRunningComponentNames()).toEqual(['database']);

      await lifecycle.startComponent('web-server');
      expect(lifecycle.getRunningComponentNames()).toEqual([
        'database',
        'web-server',
      ]);
    });

    test('getComponentCount should return total registered count', () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      expect(lifecycle.getComponentCount()).toBe(0);

      lifecycle.registerComponent(comp1);
      expect(lifecycle.getComponentCount()).toBe(1);

      lifecycle.registerComponent(comp2);
      expect(lifecycle.getComponentCount()).toBe(2);
    });

    test('getRunningComponentCount should return running count', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      lifecycle.registerComponent(comp1);
      lifecycle.registerComponent(comp2);

      expect(lifecycle.getRunningComponentCount()).toBe(0);

      await lifecycle.startComponent('database');
      expect(lifecycle.getRunningComponentCount()).toBe(1);

      await lifecycle.startComponent('web-server');
      expect(lifecycle.getRunningComponentCount()).toBe(2);
    });

    test('getComponentStatus should return detailed status', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      const status1 = lifecycle.getComponentStatus('test');
      const definedStatus1 = requireDefined(status1, 'status1');
      expect(definedStatus1.name).toBe('test');
      expect(definedStatus1.state).toBe('registered');
      expect(definedStatus1.startedAt).toBeNull();
      expect(definedStatus1.stoppedAt).toBeNull();

      await lifecycle.startComponent('test');

      const status2 = lifecycle.getComponentStatus('test');
      const definedStatus2 = requireDefined(status2, 'status2');
      expect(definedStatus2.state).toBe('running');
      expect(definedStatus2.startedAt).toBeGreaterThan(0);
    });

    test('getComponentStatus should return undefined for non-existent component', () => {
      const lifecycle = new LifecycleManager({ logger });

      const status = lifecycle.getComponentStatus('non-existent');
      expect(status).toBeUndefined();
    });

    test('getAllComponentStatuses should return statuses for all components', () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      lifecycle.registerComponent(comp1);
      lifecycle.registerComponent(comp2);

      const statuses = lifecycle.getAllComponentStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses[0].name).toBe('database');
      expect(statuses[1].name).toBe('web-server');
    });

    test('getSystemState should return correct system state', async () => {
      const lifecycle = new LifecycleManager({ logger });

      expect(lifecycle.getSystemState()).toBe('idle');

      const comp1 = new TestComponent(logger, { name: 'database' });
      lifecycle.registerComponent(comp1);
      expect(lifecycle.getSystemState()).toBe('ready');

      await lifecycle.startComponent('database');
      expect(lifecycle.getSystemState()).toBe('running');

      const comp2 = new TestComponent(logger, { name: 'web-server' });
      lifecycle.registerComponent(comp2);
      expect(lifecycle.getSystemState()).toBe('partial');

      await lifecycle.startComponent('web-server');
      expect(lifecycle.getSystemState()).toBe('running');
    });
  });

  describe('Individual Component Lifecycle', () => {
    test('startComponent should call component.start() and update state', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      const result = await lifecycle.startComponent('test');

      expect(result.success).toBe(true);
      expect(result.componentName).toBe('test');
      expect(component.startCalled).toBe(true);
      expect(lifecycle.isComponentRunning('test')).toBe(true);

      const status = lifecycle.getComponentStatus('test');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('running');
      expect(definedStatus.startedAt).toBeGreaterThan(0);
    });

    test('startComponent should support sync start/stop implementations', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let didStartCall = false;
      let didStopCall = false;

      class SyncComponent extends BaseComponent {
        public start(): void {
          didStartCall = true;
        }

        public stop(): void {
          didStopCall = true;
        }
      }

      const component = new SyncComponent(logger, { name: 'sync' });
      lifecycle.registerComponent(component);

      const startResult = await lifecycle.startComponent('sync');
      expect(startResult.success).toBe(true);
      expect(didStartCall).toBe(true);
      expect(lifecycle.isComponentRunning('sync')).toBe(true);

      const stopResult = await lifecycle.stopComponent('sync');
      expect(stopResult.success).toBe(true);
      expect(didStopCall).toBe(true);
      expect(lifecycle.isComponentRunning('sync')).toBe(false);
    });

    test('startComponent should return failure for non-existent component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const result = await lifecycle.startComponent('non-existent');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('Component not found');
      expect(result.code).toBe('component_not_found');
    });

    test('startComponent should fail when dependencies are missing', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      lifecycle.registerComponent(component);

      const result = await lifecycle.startComponent('api');

      expect(result.success).toBe(false);
      expect(result.code).toBe('missing_dependency');
      expect(result.reason).toContain('database');
      expect(lifecycle.isComponentRunning('api')).toBe(false);
    });

    test('startComponent should fail when dependencies are not running', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      lifecycle.registerComponent(database);
      lifecycle.registerComponent(api);

      const result = await lifecycle.startComponent('api');

      expect(result.success).toBe(false);
      expect(result.code).toBe('dependency_not_running');
      expect(result.reason).toContain('database');
      expect(lifecycle.isComponentRunning('api')).toBe(false);
    });

    test('startComponent should allow optional dependencies when enabled', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, {
        name: 'database',
        optional: true,
      });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      lifecycle.registerComponent(database);
      lifecycle.registerComponent(api);

      const result = await lifecycle.startComponent('api', {
        allowOptionalDependencies: true,
      });

      expect(result.success).toBe(true);
      expect(lifecycle.isComponentRunning('api')).toBe(true);
    });

    test('startComponent should allow start when dependencies are running', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      lifecycle.registerComponent(database);
      lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      const result = await lifecycle.startComponent('api');

      expect(result.success).toBe(true);
      expect(lifecycle.isComponentRunning('api')).toBe(true);
    });

    test('startComponent should return failure for already running component', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const result = await lifecycle.startComponent('test');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('Component already running');
      expect(result.code).toBe('component_already_running');
    });

    test('startComponent should reject concurrent starts while starting', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let startCalls = 0;
      let resolveStart: (() => void) | undefined;

      class SlowStartComponent extends BaseComponent {
        public start(): Promise<void> {
          startCalls += 1;
          return new Promise<void>((resolve) => {
            resolveStart = resolve;
          });
        }

        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      const component = new SlowStartComponent(logger, { name: 'test' });
      lifecycle.registerComponent(component);

      const firstStartPromise = lifecycle.startComponent('test');
      const secondResult = await lifecycle.startComponent('test');

      expect(secondResult.success).toBe(false);
      expect(secondResult.reason).toBe('Component already starting');
      expect(secondResult.code).toBe('component_already_starting');
      expect(startCalls).toBe(1);

      resolveStart?.();
      const firstResult = await firstStartPromise;

      expect(firstResult.success).toBe(true);
      expect(lifecycle.isComponentRunning('test')).toBe(true);
    });

    test('stopComponent should reject concurrent stops while stopping', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let stopCalls = 0;
      let resolveStop: (() => void) | undefined;

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }

        public stop(): Promise<void> {
          stopCalls += 1;
          return new Promise<void>((resolve) => {
            resolveStop = resolve;
          });
        }
      }

      const component = new SlowStopComponent(logger, { name: 'test' });
      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const firstStopPromise = lifecycle.stopComponent('test');
      const secondResult = await lifecycle.stopComponent('test');

      expect(secondResult.success).toBe(false);
      expect(secondResult.reason).toBe('Component is already stopping');
      expect(secondResult.code).toBe('component_already_stopping');
      expect(stopCalls).toBe(1);

      resolveStop?.();
      const firstResult = await firstStopPromise;

      expect(firstResult.success).toBe(true);
      expect(lifecycle.isComponentRunning('test')).toBe(false);
    });

    test('stopComponent should call component.stop() and update state', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const result = await lifecycle.stopComponent('test');

      expect(result.success).toBe(true);
      expect(result.componentName).toBe('test');
      expect(component.stopCalled).toBe(true);
      expect(lifecycle.isComponentRunning('test')).toBe(false);

      const status = lifecycle.getComponentStatus('test');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stopped');
      expect(definedStatus.stoppedAt).toBeGreaterThan(0);
    });

    test('stopComponent should return failure for non-existent component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const result = await lifecycle.stopComponent('non-existent');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('Component not found');
      expect(result.code).toBe('component_not_found');
    });

    test('stopComponent should return failure for non-running component', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      const result = await lifecycle.stopComponent('test');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('Component not running');
      expect(result.code).toBe('component_not_running');
    });

    test('restartComponent should stop then start component', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      component.startCalled = false;
      component.stopCalled = false;

      const result = await lifecycle.restartComponent('test');

      expect(result.success).toBe(true);
      expect(component.stopCalled).toBe(true);
      expect(component.startCalled).toBe(true);
      expect(lifecycle.isComponentRunning('test')).toBe(true);
    });

    test('restartComponent should fail if stop fails', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
      }

      const component = new FailingStopComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const result = await lifecycle.restartComponent('test');

      expect(result.success).toBe(false);
      expect(result.reason).toContain('Failed to stop');
      expect(result.code).toBe('restart_stop_failed');
    });
  });

  describe('Timeout Handling', () => {
    test('startComponent should timeout if start() takes too long', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStartComponent extends BaseComponent {
        public async start() {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      const component = new SlowStartComponent(logger, {
        name: 'slow',
        startupTimeoutMS: 50,
      });

      lifecycle.registerComponent(component);

      const result = await lifecycle.startComponent('slow');

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timed out');
      expect(result.code).toBe('start_timeout');
      expect(lifecycle.isComponentRunning('slow')).toBe(false);

      const status = lifecycle.getComponentStatus('slow');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('registered');
    });

    test('stopComponent should timeout and mark as stalled if stop() takes too long', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop() {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      const component = new SlowStopComponent(logger, {
        name: 'slow',
        shutdownGracefulTimeoutMS: 1000, // Minimum enforced
      });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('slow');

      const opResult = await lifecycle.stopComponent('slow');

      expect(opResult.success).toBe(false);
      expect(opResult.error?.message).toContain('timed out');
      expect(opResult.code).toBe('stop_timeout');
      expect(lifecycle.isComponentRunning('slow')).toBe(false);

      const status = lifecycle.getComponentStatus('slow');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
      const stallInfo = requireDefined(definedStatus.stallInfo, 'stallInfo');
      expect(stallInfo.reason).toBe('timeout');
    });

    test('stopComponent should mark as stalled on error', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop error'));
        }
      }

      const component = new FailingStopComponent(logger, { name: 'failing' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('failing');

      const result = await lifecycle.stopComponent('failing');

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Stop error');
      expect(result.code).toBe('unknown_error');

      const status = lifecycle.getComponentStatus('failing');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
      const stallInfo = requireDefined(definedStatus.stallInfo, 'stallInfo');
      expect(stallInfo.reason).toBe('error');
    });

    test('stopComponent with forceImmediate should mark as stalled when onShutdownForce throws', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingForceStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
        public onShutdownForce(): void {
          throw new Error('Force stop error');
        }
      }

      const component = new FailingForceStopComponent(logger, {
        name: 'failing-force',
      });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('failing-force');

      const result = await lifecycle.stopComponent('failing-force', {
        forceImmediate: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('Force stop error');
      expect(result.code).toBe('unknown_error');

      const status = lifecycle.getComponentStatus('failing-force');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
      expect(lifecycle.isComponentRunning('failing-force')).toBe(false);
      const stallInfo = requireDefined(definedStatus.stallInfo, 'stallInfo');
      expect(stallInfo.reason).toBe('error');
    });
  });

  describe('Abort Callbacks', () => {
    test('onStartupAborted should be called on startup timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class AbortableStartComponent extends BaseComponent {
        public abortCalled = false;

        public async start() {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        public stop(): Promise<void> {
          return Promise.resolve();
        }

        public onStartupAborted() {
          this.abortCalled = true;
        }
      }

      const component = new AbortableStartComponent(logger, {
        name: 'test',
        startupTimeoutMS: 50,
      });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      expect(component.abortCalled).toBe(true);
    });

    test('onStartupAborted should NOT be called when start() fails (non-timeout)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStartComponent extends BaseComponent {
        public abortCalled = false;

        public start(): Promise<void> {
          return Promise.reject(new Error('Start error'));
        }

        public stop(): Promise<void> {
          return Promise.resolve();
        }

        public onStartupAborted() {
          this.abortCalled = true;
        }
      }

      const component = new FailingStartComponent(logger, {
        name: 'test',
        startupTimeoutMS: 50,
      });

      lifecycle.registerComponent(component);
      const result = await lifecycle.startComponent('test');

      expect(result.success).toBe(false);

      // Wait beyond the timeout window to ensure no stray timer fires.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(component.abortCalled).toBe(false);
    });

    test('onStopAborted should be called on stop timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class AbortableStopComponent extends BaseComponent {
        public abortCalled = false;

        public start(): Promise<void> {
          return Promise.resolve();
        }

        public async stop() {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        public onStopAborted() {
          this.abortCalled = true;
        }
      }

      const component = new AbortableStopComponent(logger, {
        name: 'test',
        shutdownGracefulTimeoutMS: 1000,
      });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');
      await lifecycle.stopComponent('test');

      expect(component.abortCalled).toBe(true);
    });

    test('onStopAborted should NOT be called when stop() fails (non-timeout)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public abortCalled = false;

        public start(): Promise<void> {
          return Promise.resolve();
        }

        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop error'));
        }

        public onStopAborted() {
          this.abortCalled = true;
        }
      }

      const component = new FailingStopComponent(logger, {
        name: 'test',
        shutdownGracefulTimeoutMS: 50,
      });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');
      const result = await lifecycle.stopComponent('test');

      expect(result.success).toBe(false);

      // Wait beyond the timeout window to ensure no stray timer fires.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(component.abortCalled).toBe(false);
    });
  });

  describe('Event Emission', () => {
    test('should emit component:registered event', () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      let emittedData: any;
      lifecycle.on('component:registered', (data) => {
        emittedData = data;
      });

      lifecycle.registerComponent(component);

      expect(emittedData).toBeDefined();
      expect(emittedData.name).toBe('test');
    });

    test('should emit component:starting and component:started events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      const events: string[] = [];
      lifecycle.on('component:starting', () => {
        events.push('starting');
      });
      lifecycle.on('component:started', () => {
        events.push('started');
      });

      await lifecycle.startComponent('test');

      expect(events).toEqual(['starting', 'started']);
    });

    test('should emit component:stopping and component:stopped events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const events: string[] = [];
      lifecycle.on('component:stopping', () => {
        events.push('stopping');
      });
      lifecycle.on('component:stopped', () => {
        events.push('stopped');
      });

      await lifecycle.stopComponent('test');

      expect(events).toEqual(['stopping', 'stopped']);
    });

    test('should emit component:start-timeout event on startup timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        public async start() {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      const component = new SlowComponent(logger, {
        name: 'slow',
        startupTimeoutMS: 50,
      });

      lifecycle.registerComponent(component);

      let didTimeoutEmit = false;
      lifecycle.on('component:start-timeout', () => {
        didTimeoutEmit = true;
      });

      await lifecycle.startComponent('slow');

      expect(didTimeoutEmit).toBe(true);
    });

    test('should emit component:stalled event on stop timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop() {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      const component = new SlowStopComponent(logger, {
        name: 'slow',
        shutdownGracefulTimeoutMS: 1000,
      });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('slow');

      let didStallEmit = false;
      lifecycle.on('component:stalled', () => {
        didStallEmit = true;
      });

      await lifecycle.stopComponent('slow');

      expect(didStallEmit).toBe(true);
    });

    test('event handler errors should not break lifecycle operations', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);

      lifecycle.on('component:starting', () => {
        throw new Error('Handler error');
      });

      // Should not throw despite handler error
      const result = await lifecycle.startComponent('test');
      expect(result.success).toBe(true);
    });
  });

  describe('State Transitions', () => {
    test('component state should transition correctly through lifecycle', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      lifecycle.registerComponent(component);
      const registeredStatus = requireDefined(
        lifecycle.getComponentStatus('test'),
        'registeredStatus',
      );
      expect(registeredStatus.state).toBe('registered');

      const startPromise = lifecycle.startComponent('test');
      // Note: state might be 'starting' or 'running' depending on timing
      await startPromise;
      const runningStatus = requireDefined(
        lifecycle.getComponentStatus('test'),
        'runningStatus',
      );
      expect(runningStatus.state).toBe('running');

      const stopPromise = lifecycle.stopComponent('test');
      await stopPromise;
      const stoppedStatus = requireDefined(
        lifecycle.getComponentStatus('test'),
        'stoppedStatus',
      );
      expect(stoppedStatus.state).toBe('stopped');
    });

    test('failed start should reset state to registered', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.reject(new Error('Start failed'));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      const component = new FailingComponent(logger, { name: 'failing' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('failing');

      const failedStartStatus = requireDefined(
        lifecycle.getComponentStatus('failing'),
        'failedStartStatus',
      );
      expect(failedStartStatus.state).toBe('registered');
    });

    test('failed/timed-out stop should set state to stalled', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
      }

      const component = new FailingStopComponent(logger, { name: 'failing' });

      lifecycle.registerComponent(component);
      await lifecycle.startComponent('failing');
      await lifecycle.stopComponent('failing');

      const failedStopStatus = requireDefined(
        lifecycle.getComponentStatus('failing'),
        'failedStopStatus',
      );
      expect(failedStopStatus.state).toBe('stalled');
    });
  });
});

describe('LifecycleManager - Phase 3: Bulk Operations', () => {
  let logger: Logger;
  let arraySink: ArraySink;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });
  });

  describe('startAllComponents()', () => {
    test('should start all components in registration order', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const startOrder: string[] = [];

      class OrderedComponent extends BaseComponent {
        public start(): Promise<void> {
          startOrder.push(this.getName());
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'first' }),
      );
      lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'second' }),
      );
      lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'third' }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(result.startedComponents).toEqual(['first', 'second', 'third']);
      expect(startOrder).toEqual(['first', 'second', 'third']);
    });

    test('should reject if partial state (some already running)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));

      // Start one component manually
      await lifecycle.startComponent('comp1');

      // Try to start all - should fail
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.startedComponents).toEqual(['comp1']); // Only comp1 was running
    });

    test('should return success if all components already running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));

      // Start all components
      await lifecycle.startAllComponents();

      // Try to start all again - should succeed with no-op
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(result.startedComponents).toEqual(['comp1', 'comp2']);
    });

    test('should trigger rollback when required component fails', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const stopOrder: string[] = [];

      class TrackingComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          stopOrder.push(this.getName());
          return Promise.resolve();
        }
      }

      class FailingComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.reject(new Error('Startup failed'));
        }
        public stop(): Promise<void> {
          stopOrder.push(this.getName());
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp1' }),
      );
      lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp2' }),
      );
      lifecycle.registerComponent(
        new FailingComponent(logger, { name: 'failing' }),
      );
      lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp4' }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.startedComponents).toEqual([]);
      // Rollback should stop comp1 and comp2 in reverse order
      expect(stopOrder).toEqual(['comp2', 'comp1']);
    });

    test('should rollback in reverse order', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const startOrder: string[] = [];
      const stopOrder: string[] = [];

      class TrackingComponent extends BaseComponent {
        public start(): Promise<void> {
          startOrder.push(this.getName());
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          stopOrder.push(this.getName());
          return Promise.resolve();
        }
      }

      class FailingComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.reject(new Error('Startup failed'));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new TrackingComponent(logger, { name: 'a' }));
      lifecycle.registerComponent(new TrackingComponent(logger, { name: 'b' }));
      lifecycle.registerComponent(new TrackingComponent(logger, { name: 'c' }));
      lifecycle.registerComponent(
        new FailingComponent(logger, { name: 'fail' }),
      );

      await lifecycle.startAllComponents();

      expect(startOrder).toEqual(['a', 'b', 'c']);
      expect(stopOrder).toEqual(['c', 'b', 'a']); // Reverse order
    });

    test('should handle optional components without triggering rollback', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.reject(new Error('Optional component failed'));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(
        new FailingComponent(logger, { name: 'optional', optional: true }),
      );
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(result.startedComponents).toEqual(['comp1', 'comp2']);
      expect(result.failedOptionalComponents).toHaveLength(1);
      expect(result.failedOptionalComponents[0].name).toBe('optional');

      // Optional component should have 'failed' state
      const optionalStatus = lifecycle.getComponentStatus('optional');
      expect(optionalStatus?.state).toBe('failed');
    });

    test('should handle shutdown signal during startup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const stopOrder: string[] = [];

      class SlowComponent extends BaseComponent {
        public async start(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        public stop(): Promise<void> {
          stopOrder.push(this.getName());
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp2' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp3' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp4' }));

      // Start all components
      const startPromise = lifecycle.startAllComponents();

      // Wait a bit for first component to start
      await new Promise((resolve) => setTimeout(resolve, 25));

      // Trigger shutdown during startup (simulate by setting the flag)
      // Note: This is a bit hacky for testing, but we're testing the internal behavior
      (lifecycle as unknown as { isShuttingDown: boolean }).isShuttingDown =
        true;

      const result = await startPromise;

      expect(result.success).toBe(false);
      expect(result.startedComponents).toEqual([]);
      // Should have rolled back started components
      expect(stopOrder.length).toBeGreaterThan(0);
    });

    test('should not emit duplicate shutdown events when stopAllComponents() called during startup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      // Track shutdown events
      let shutdownInitiatedCount = 0;
      let shutdownCompletedCount = 0;
      let wasDuringStartup: boolean | undefined;

      lifecycle.on(
        'lifecycle-manager:shutdown-initiated',
        (data: { method: string; duringStartup: boolean }) => {
          shutdownInitiatedCount++;
          wasDuringStartup = data.duringStartup;
        },
      );

      lifecycle.on('lifecycle-manager:shutdown-completed', () => {
        shutdownCompletedCount++;
      });

      class SlowComponent extends BaseComponent {
        public async start(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp2' }));

      // Start all components
      const startPromise = lifecycle.startAllComponents();

      // Wait a bit for startup to begin
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Call stopAllComponents() during startup
      const stopPromise = lifecycle.stopAllComponents();

      await Promise.all([startPromise, stopPromise]);

      // Verify shutdown events emitted only once (by stopAllComponents)
      expect(shutdownInitiatedCount).toBe(1);
      expect(shutdownCompletedCount).toBe(1);
      // Verify duringStartup flag is correctly set to true
      expect(wasDuringStartup).toBe(true);
    });

    test('should block startup if stalled components exist', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
      }

      const component = new FailingStopComponent(logger, { name: 'stalled' });
      lifecycle.registerComponent(component);

      // Start and fail to stop (creates stalled component)
      await lifecycle.startComponent('stalled');
      await lifecycle.stopComponent('stalled');

      // Verify component is stalled
      const status = lifecycle.getComponentStatus('stalled');
      expect(status?.state).toBe('stalled');

      // Register a new component
      lifecycle.registerComponent(
        new TestComponent(logger, { name: 'new-comp' }),
      );

      // Try to start all - should fail due to stalled component
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.blockedByStalledComponents).toEqual(['stalled']);
    });

    test('should allow startup if ignoreStalledComponents option is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
      }

      lifecycle.registerComponent(
        new FailingStopComponent(logger, { name: 'stalled' }),
      );
      lifecycle.registerComponent(
        new TestComponent(logger, { name: 'new-comp' }),
      );

      // Create stalled component
      await lifecycle.startComponent('stalled');
      await lifecycle.stopComponent('stalled');

      // Try to start all with ignoreStalledComponents
      const result = await lifecycle.startAllComponents({
        ignoreStalledComponents: true,
      });

      expect(result.success).toBe(true);
      expect(result.startedComponents).toEqual(['new-comp']);
    });

    test('should emit lifecycle-manager:started event on success', async () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));

      let wasStartedEventEmitted = false;
      lifecycle.on('lifecycle-manager:started', () => {
        wasStartedEventEmitted = true;
      });

      await lifecycle.startAllComponents();

      expect(wasStartedEventEmitted).toBe(true);
    });

    test('should emit component:startup-rollback events', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const rollbackEvents: string[] = [];

      class FailingComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.reject(new Error('Startup failed'));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));
      lifecycle.registerComponent(
        new FailingComponent(logger, { name: 'failing' }),
      );

      lifecycle.on('component:startup-rollback', (data: { name: string }) => {
        rollbackEvents.push(data.name);
      });

      await lifecycle.startAllComponents();

      expect(rollbackEvents).toEqual(['comp2', 'comp1']);
    });

    test('should return components in consistent registration order across all scenarios', async () => {
      const lifecycle = new LifecycleManager({ logger });

      // Register components in specific order
      lifecycle.registerComponent(new TestComponent(logger, { name: 'alpha' }));
      lifecycle.registerComponent(new TestComponent(logger, { name: 'beta' }));
      lifecycle.registerComponent(new TestComponent(logger, { name: 'gamma' }));

      // Scenario 1: Start all and verify order
      const startResult = await lifecycle.startAllComponents();
      expect(startResult.success).toBe(true);
      expect(startResult.startedComponents).toEqual(['alpha', 'beta', 'gamma']);

      // Scenario 2: All running - should return same order
      const alreadyRunningResult = await lifecycle.startAllComponents();
      expect(alreadyRunningResult.success).toBe(true);
      expect(alreadyRunningResult.startedComponents).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);

      // Scenario 3: Partial state - manually stop one to create partial state
      await lifecycle.stopComponent('gamma');
      const partialResult = await lifecycle.startAllComponents();
      expect(partialResult.success).toBe(false);
      expect(partialResult.startedComponents).toEqual(['alpha', 'beta']);
    });
  });

  describe('stopAllComponents()', () => {
    test('should stop all components in reverse order', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const stopOrder: string[] = [];

      class OrderedComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          stopOrder.push(this.getName());
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'first' }),
      );
      lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'second' }),
      );
      lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'third' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.stopAllComponents();

      expect(result.success).toBe(true);
      expect(result.stoppedComponents).toEqual(['third', 'second', 'first']);
      expect(stopOrder).toEqual(['third', 'second', 'first']);
    });

    test('should continue on errors and track stalled components', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
      }

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(
        new FailingStopComponent(logger, { name: 'failing' }),
      );
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));

      await lifecycle.startAllComponents();

      const result = await lifecycle.stopAllComponents();

      expect(result.success).toBe(false); // Not successful due to stalled component
      expect(result.stoppedComponents).toEqual(['comp2', 'comp1']);
      expect(result.stalledComponents).toHaveLength(1);
      expect(result.stalledComponents[0].name).toBe('failing');
    });

    test('should emit shutdown-initiated and shutdown-completed events', async () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));

      let wasShutdownInitiatedEmitted = false;
      let wasShutdownCompletedEmitted = false;

      lifecycle.on('lifecycle-manager:shutdown-initiated', () => {
        wasShutdownInitiatedEmitted = true;
      });

      lifecycle.on('lifecycle-manager:shutdown-completed', () => {
        wasShutdownCompletedEmitted = true;
      });

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(wasShutdownInitiatedEmitted).toBe(true);
      expect(wasShutdownCompletedEmitted).toBe(true);
    });

    test('should reset state flags after completion', async () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      // After shutdown, isShuttingDown should be false
      const systemState = lifecycle.getSystemState();
      expect(systemState).not.toBe('shutting-down');
    });

    test('should calculate shutdown duration', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      lifecycle.registerComponent(
        new SlowStopComponent(logger, { name: 'slow' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.stopAllComponents();

      expect(result.durationMS).toBeGreaterThan(40); // Should take at least 50ms
    });
  });

  describe('restartAllComponents()', () => {
    test('should perform stop then start', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const events: string[] = [];

      class TrackingComponent extends BaseComponent {
        public start(): Promise<void> {
          events.push(`${this.getName()}:start`);
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          events.push(`${this.getName()}:stop`);
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp1' }),
      );
      lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp2' }),
      );

      await lifecycle.startAllComponents();

      events.length = 0; // Clear events

      const result = await lifecycle.restartAllComponents();

      expect(result.success).toBe(true);
      expect(result.shutdownResult.success).toBe(true);
      expect(result.startupResult.success).toBe(true);

      // Should have stop events followed by start events
      expect(events).toEqual([
        'comp2:stop',
        'comp1:stop',
        'comp1:start',
        'comp2:start',
      ]);
    });

    test('should return combined result', async () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp1' }));

      await lifecycle.startAllComponents();

      const result = await lifecycle.restartAllComponents();

      expect(result).toHaveProperty('shutdownResult');
      expect(result).toHaveProperty('startupResult');
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(
        result.shutdownResult.success && result.startupResult.success,
      );
    });

    test('should handle stalled components in shutdown phase', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
      }

      lifecycle.registerComponent(
        new FailingStopComponent(logger, { name: 'failing' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.restartAllComponents({
        ignoreStalledComponents: true,
      });

      expect(result.shutdownResult.success).toBe(false);
      expect(result.shutdownResult.stalledComponents).toHaveLength(1);
      // Startup should still succeed with ignoreStalledComponents
      expect(result.startupResult.success).toBe(true);
    });
  });

  describe('Concurrent Operation Prevention', () => {
    test('should prevent individual start during bulk startup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        public async start(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp2' }));
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp3' }));

      // Start all components (will take a while)
      const startAllPromise = lifecycle.startAllComponents();

      // Wait a bit to ensure bulk startup is in progress
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to start individual component - should fail
      const result = await lifecycle.startComponent('comp3');

      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_in_progress'); // Reused code

      await startAllPromise;
    });

    test('should prevent individual stop during bulk startup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        public async start(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));

      // Pre-start comp2
      await lifecycle.startComponent('comp2');
      await lifecycle.stopComponent('comp2');

      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp3' }));

      // Start all components
      const startAllPromise = lifecycle.startAllComponents();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to stop individual component - should fail
      const result = await lifecycle.stopComponent('comp2');

      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_in_progress');

      await startAllPromise;
    });

    test('should prevent individual stop during bulk shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      lifecycle.registerComponent(
        new SlowStopComponent(logger, { name: 'comp1' }),
      );
      lifecycle.registerComponent(
        new SlowStopComponent(logger, { name: 'comp2' }),
      );

      await lifecycle.startAllComponents();

      // Start shutdown
      const stopAllPromise = lifecycle.stopAllComponents();

      // Wait a bit to ensure shutdown is in progress
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to stop individual component - should fail
      const result = await lifecycle.stopComponent('comp2');

      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_in_progress');

      await stopAllPromise;
    });

    test('should prevent restart during bulk operations', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        public async start(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp2' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp3' }));

      // Start all components (will take a while)
      const startAllPromise = lifecycle.startAllComponents();

      // Wait a bit to ensure bulk startup is in progress
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to restart individual component - should fail
      const result = await lifecycle.restartComponent('comp2');

      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_in_progress');

      await startAllPromise;
    });

    test('should prevent start during shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      lifecycle.registerComponent(
        new SlowStopComponent(logger, { name: 'comp1' }),
      );
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));

      await lifecycle.startAllComponents();

      // Start shutdown
      const stopAllPromise = lifecycle.stopAllComponents();

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to start individual component - should fail
      const result = await lifecycle.startComponent('comp2');

      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_in_progress');

      await stopAllPromise;
    });

    test('should prevent bulk startup during shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      lifecycle.registerComponent(
        new SlowStopComponent(logger, { name: 'comp1' }),
      );
      lifecycle.registerComponent(new TestComponent(logger, { name: 'comp2' }));

      await lifecycle.startAllComponents();

      // Start shutdown
      const stopAllPromise = lifecycle.stopAllComponents();

      // Wait a bit to ensure shutdown is in progress
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to start all components - should fail
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.startedComponents).toEqual([]);
      expect(result.failedOptionalComponents).toEqual([]);
      expect(result.skippedDueToDependency).toEqual([]);

      await stopAllPromise;
    });

    test('should prevent concurrent startAllComponents() calls', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        public async start(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp1' }));
      lifecycle.registerComponent(new SlowComponent(logger, { name: 'comp2' }));

      // Start first bulk startup
      const firstStartPromise = lifecycle.startAllComponents();

      // Wait a bit to ensure first startup is in progress
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to start all components again - should fail
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.startedComponents).toEqual([]);

      await firstStartPromise;
    });

    test('should prevent concurrent stopAllComponents() calls', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowStopComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public async stop(): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      lifecycle.registerComponent(
        new SlowStopComponent(logger, { name: 'comp1' }),
      );
      lifecycle.registerComponent(
        new SlowStopComponent(logger, { name: 'comp2' }),
      );

      await lifecycle.startAllComponents();

      // Start first shutdown
      const firstStopPromise = lifecycle.stopAllComponents();

      // Wait a bit to ensure first shutdown is in progress
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Try to stop all components again - should return success immediately
      const result = await lifecycle.stopAllComponents();

      expect(result.success).toBe(true);
      expect(result.stoppedComponents).toEqual([]);
      expect(result.durationMS).toBe(0);

      await firstStopPromise;
    });
  });
});
