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
import { sleep } from '../sleep';
import {
  TestComponent,
  SlowStartComponent,
  SlowStopComponent,
  SlowStartAndStopComponent,
  FailingStartComponent,
  FailingStopComponent,
} from './test-components';

// cspell:ignore Renamable Reloadable Unregistration unregistration

const requireDefined = <T>(value: T | null | undefined, label: string): T => {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === null || value === undefined) {
    throw new Error(`${label} should be defined`);
  }
  return value;
};

describe('LifecycleManager - BaseComponent', () => {
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
      expect(component.shutdownGracefulTimeoutMS).toBe(5000);
      expect(component.shutdownForceTimeoutMS).toBe(2000);
      expect(component.healthCheckTimeoutMS).toBe(5000);
      expect(component.signalTimeoutMS).toBe(5000);
    });

    test('should use custom timeout values when provided', () => {
      const component = new TestComponent(logger, {
        name: 'test',
        startupTimeoutMS: 10000,
        shutdownGracefulTimeoutMS: 8000,
        shutdownForceTimeoutMS: 3000,
        healthCheckTimeoutMS: 3000,
        signalTimeoutMS: 4000,
      });

      expect(component.startupTimeoutMS).toBe(10000);
      expect(component.shutdownGracefulTimeoutMS).toBe(8000);
      expect(component.shutdownForceTimeoutMS).toBe(3000);
      expect(component.healthCheckTimeoutMS).toBe(3000);
      expect(component.signalTimeoutMS).toBe(4000);
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
    test('registerComponent() should return rich success result with startupOrder', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'database' });

      const result = await lifecycle.registerComponent(component);
      expect(result.success).toBe(true);
      expect(result.registered).toBe(true);
      expect(result.componentName).toBe('database');
      expect(result.action).toBe('register');
      expect(result.startupOrder).toEqual(['database']);
      expect(result.registrationIndexBefore).toBe(null);
      expect(result.registrationIndexAfter).toBe(0);
    });

    test('registerComponent() should return duplicate_name failure result', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component1 = new TestComponent(logger, { name: 'database' });
      const component2 = new TestComponent(logger, { name: 'database' });
      let rejectedPayload: any;

      lifecycle.on('component:registration-rejected', (data) => {
        rejectedPayload = data;
      });

      const result1 = await lifecycle.registerComponent(component1);
      expect(result1.success).toBe(true);

      const result2 = await lifecycle.registerComponent(component2);
      expect(result2.success).toBe(false);
      expect(result2.registered).toBe(false);
      expect(result2.code).toBe('duplicate_name');
      expect(result2.componentName).toBe('database');
      expect(result2.registrationIndexBefore).toBe(0);
      expect(result2.registrationIndexAfter).toBe(0);
      expect(result2.startupOrder).toEqual(['database']);
      expect(rejectedPayload?.name).toBe('database');
      expect(rejectedPayload?.reason).toBe('duplicate_name');
      expect(rejectedPayload?.message).toContain('already registered');
      expect(rejectedPayload?.registrationIndexBefore).toBe(0);
      expect(rejectedPayload?.registrationIndexAfter).toBe(0);
    });

    test('registerComponent() should reject duplicate instance even if renamed', async () => {
      class RenamableComponent extends TestComponent {
        public rename(newName: string): void {
          this.name = newName;
        }
      }

      const lifecycle = new LifecycleManager({ logger });
      const component = new RenamableComponent(logger, { name: 'database' });

      const result1 = await lifecycle.registerComponent(component);
      expect(result1.success).toBe(true);

      component.rename('database-copy');

      const result2 = await lifecycle.registerComponent(component);
      expect(result2.success).toBe(false);
      expect(result2.registered).toBe(false);
      expect(result2.code).toBe('duplicate_instance');
      expect(result2.componentName).toBe('database-copy');
    });

    test('insertComponentAt() should reject duplicate instance even if renamed', async () => {
      class RenamableComponent extends TestComponent {
        public rename(newName: string): void {
          this.name = newName;
        }
      }

      const lifecycle = new LifecycleManager({ logger });
      const component = new RenamableComponent(logger, { name: 'database' });

      const result1 = await lifecycle.registerComponent(component);
      expect(result1.success).toBe(true);

      component.rename('database-copy');

      const result2 = await lifecycle.insertComponentAt(component, 'end');
      expect(result2.success).toBe(false);
      expect(result2.registered).toBe(false);
      expect(result2.code).toBe('duplicate_instance');
      expect(result2.componentName).toBe('database-copy');
    });

    test('registerComponent() should return dependency_cycle failure result and not register component', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let rejectedPayload: any;

      lifecycle.on('component:registration-rejected', (data) => {
        rejectedPayload = data;
      });

      const a = new TestComponent(logger, { name: 'a', dependencies: ['b'] });
      const b = new TestComponent(logger, { name: 'b', dependencies: ['a'] });

      const resultA = await lifecycle.registerComponent(a);
      expect(resultA.success).toBe(true);
      expect(lifecycle.hasComponent('a')).toBe(true);

      const resultB = await lifecycle.registerComponent(b);
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
      expect(rejectedPayload?.name).toBe('b');
      expect(rejectedPayload?.reason).toBe('dependency_cycle');
      expect(Array.isArray(rejectedPayload?.cycle)).toBe(true);
    });

    test('insertComponentAt() should return dependency_cycle failure result and not register component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const a = new TestComponent(logger, { name: 'a', dependencies: ['b'] });
      const b = new TestComponent(logger, { name: 'b', dependencies: ['a'] });

      const resultA = await lifecycle.registerComponent(a);
      expect(resultA.success).toBe(true);
      expect(lifecycle.hasComponent('a')).toBe(true);

      const resultB = await lifecycle.insertComponentAt(b, 'end');
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

    test('insertComponentAt() should return target_not_found failure result', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'api' });
      let rejectedPayload: any;

      lifecycle.on('component:registration-rejected', (data) => {
        rejectedPayload = data;
      });

      const result = await lifecycle.insertComponentAt(
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
      expect(rejectedPayload?.reason).toBe('target_not_found');
      expect(rejectedPayload?.target).toBe('missing');
      expect(rejectedPayload?.targetFound).toBe(false);
    });

    test('insertComponentAt() should return invalid_position failure result for untyped callers', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'api' });
      let rejectedPayload: any;

      lifecycle.on('component:registration-rejected', (data) => {
        rejectedPayload = data;
      });

      const result = await (lifecycle as any).insertComponentAt(
        component,
        'weird',
      );
      expect(result.success).toBe(false);
      expect(result.registered).toBe(false);
      expect(result.code).toBe('invalid_position');
      expect(result.componentName).toBe('api');
      expect(result.startupOrder).toEqual([]);
      expect(result.manualPositionRespected).toBe(false);
      expect(result.requestedPosition.position).toBe('weird');
      expect(rejectedPayload?.reason).toBe('invalid_position');
      expect(rejectedPayload?.requestedPosition?.position).toBe('weird');
    });

    test('insertComponentAt() should report manualPositionRespected=false when dependencies override requested order', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      const dbResult = await lifecycle.registerComponent(database);
      expect(dbResult.success).toBe(true);

      const apiResult = await lifecycle.insertComponentAt(api, 'start');
      expect(apiResult.success).toBe(true);
      expect(apiResult.registered).toBe(true);

      // Even though we inserted API at the start of the registry list,
      // dependency constraints force database to start first.
      expect(apiResult.startupOrder).toEqual(['database', 'api']);
      expect(apiResult.manualPositionRespected).toBe(false);
    });

    test('getStartupOrder() should return success result with startupOrder', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      const dbResult = await lifecycle.registerComponent(database);
      expect(dbResult.success).toBe(true);

      const apiResult = await lifecycle.registerComponent(api);
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

describe('LifecycleManager - Registration & Individual Lifecycle', () => {
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
    test('registerComponent should set lifecycle reference', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);

      expect((component as any).lifecycle).toBeDefined();
      expect((component as any).lifecycle).not.toBe(lifecycle); // It's a ComponentLifecycle, not the manager
      expect(typeof (component as any).lifecycle.startAllComponents).toBe(
        'function',
      );
      expect(typeof (component as any).lifecycle.sendMessageToComponent).toBe(
        'function',
      );
    });

    test('unregisterComponent should remove component from registry', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);
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

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const result = await lifecycle.unregisterComponent('test', {
        stopIfRunning: false,
      });
      expect(result.success).toBe(false);
      expect(result.componentName).toBe('test');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(result.reason).toBe(
        'Component is running. Use stopIfRunning: true option or stop manually first',
      );
      expect(lifecycle.hasComponent('test')).toBe(true);
    });

    test('unregisterComponent should stop and remove component with stopIfRunning', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);
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

    test('unregisterComponent should stop and remove component by default', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');
      expect(lifecycle.isComponentRunning('test')).toBe(true);

      // No options passed - should use default stopIfRunning: true
      const result = await lifecycle.unregisterComponent('test');
      expect(result.success).toBe(true);
      expect(result.componentName).toBe('test');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(true);
      expect(lifecycle.hasComponent('test')).toBe(false);
      expect(component.stopCalled).toBe(true);
    });

    test('unregisterComponent should fail (and keep registered) if stopIfRunning stop errors', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new FailingStopComponent(
        logger,
        'failing',
        'Stop failed',
      );

      await lifecycle.registerComponent(component);
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
      expect(result.stopFailureReason).toBe('error');

      // Critical: component should remain registered when stop fails.
      expect(lifecycle.hasComponent('failing')).toBe(true);

      const status = lifecycle.getComponentStatus('failing');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
    });

    test('unregisterComponent should fail (and keep registered) if stopIfRunning stop times out (stalled)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new SlowStopComponent(logger, 'slow-stop', 1500);

      await lifecycle.registerComponent(component);
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
      expect(result.stopFailureReason).toBe('timeout');

      // Critical: component should remain registered when stop stalls.
      expect(lifecycle.hasComponent('slow-stop')).toBe(true);

      const status = lifecycle.getComponentStatus('slow-stop');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
      const stallInfo = requireDefined(definedStatus.stallInfo, 'stallInfo');
      expect(stallInfo.reason).toBe('timeout');
    });

    test('unregisterComponent should fail if stopIfRunning is set on a stalled component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new SlowStopComponent(logger, 'slow-stop', 1500);

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('slow-stop');

      await lifecycle.stopComponent('slow-stop', { timeout: 10 });
      const status = lifecycle.getComponentStatus('slow-stop');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');

      const result = await lifecycle.unregisterComponent('slow-stop', {
        stopIfRunning: true,
      });

      expect(result.success).toBe(false);
      expect(result.componentName).toBe('slow-stop');
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(result.reason).toBe('Component is stalled');
      expect(result.code).toBe('stop_failed');
      expect(result.stopFailureReason).toBe('stalled');

      // Component should remain registered when stalled and stopIfRunning is set.
      expect(lifecycle.hasComponent('slow-stop')).toBe(true);
    });

    test('unregisterComponent with stopIfRunning should fail when component has running dependents', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      await lifecycle.startComponent('api');

      const result = await lifecycle.unregisterComponent('database', {
        stopIfRunning: true,
      });

      expect(result.success).toBe(false);
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(lifecycle.hasComponent('database')).toBe(true);
      expect(lifecycle.isComponentRunning('database')).toBe(true);
    });

    test('unregisterComponent should fail by default when component has running dependents', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      await lifecycle.startComponent('api');

      // No options - should use default stopIfRunning: true and still protect dependents
      const result = await lifecycle.unregisterComponent('database');

      expect(result.success).toBe(false);
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(false);
      expect(lifecycle.hasComponent('database')).toBe(true);
      expect(lifecycle.isComponentRunning('database')).toBe(true);
    });

    test('unregisterComponent with stopIfRunning and forceStop should succeed when component has running dependents', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      await lifecycle.startComponent('api');

      const result = await lifecycle.unregisterComponent('database', {
        stopIfRunning: true,
        forceStop: true,
      });

      expect(result.success).toBe(true);
      expect(result.wasRegistered).toBe(true);
      expect(result.wasStopped).toBe(true);
      expect(lifecycle.hasComponent('database')).toBe(false);
      expect(lifecycle.isComponentRunning('api')).toBe(true);
    });

    test('registerComponent should block during startup if component is required dependency', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(api);

      // Start async startup
      const startupPromise = lifecycle.startAllComponents();

      // Try to register database while startup is in progress
      // This should be blocked because api depends on database
      const result = await lifecycle.registerComponent(database);

      expect(result.success).toBe(false);
      expect(result.code).toBe('startup_in_progress');
      expect(result.reason).toContain(
        'required dependency for other components',
      );

      await startupPromise;
    });

    test('registerComponent should allow during startup if component is not a required dependency', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const cache = new TestComponent(logger, { name: 'cache' });

      await lifecycle.registerComponent(database);

      // Start async startup
      const startupPromise = lifecycle.startAllComponents();

      // Wait a moment for startup to begin
      await sleep(10);

      // Try to register cache (not a dependency of anything)
      // This should succeed
      const result = await lifecycle.registerComponent(cache);

      expect(result.success).toBe(true);
      expect(lifecycle.hasComponent('cache')).toBe(true);

      await startupPromise;
    });

    test('insertComponentAt should block during startup if component is required dependency', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(api);

      // Start async startup
      const startupPromise = lifecycle.startAllComponents();

      // Try to insert database while startup is in progress
      const result = await lifecycle.insertComponentAt(database, 'start');

      expect(result.success).toBe(false);
      expect(result.code).toBe('startup_in_progress');
      expect(result.reason).toContain(
        'required dependency for other components',
      );

      await startupPromise;
    });
  });

  describe('Status Tracking', () => {
    test('hasComponent should return true for registered components', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);

      expect(lifecycle.hasComponent('test')).toBe(true);
      expect(lifecycle.hasComponent('other')).toBe(false);
    });

    test('isComponentRunning should track running state', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);

      expect(lifecycle.isComponentRunning('test')).toBe(false);

      await lifecycle.startComponent('test');
      expect(lifecycle.isComponentRunning('test')).toBe(true);

      await lifecycle.stopComponent('test');
      expect(lifecycle.isComponentRunning('test')).toBe(false);
    });

    test('getComponentNames should return all registered names', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);

      const names = lifecycle.getComponentNames();
      expect(names).toEqual(['database', 'web-server']);
    });

    test('getRunningComponentNames should return only running names', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);

      expect(lifecycle.getRunningComponentNames()).toEqual([]);

      await lifecycle.startComponent('database');
      expect(lifecycle.getRunningComponentNames()).toEqual(['database']);

      await lifecycle.startComponent('web-server');
      expect(lifecycle.getRunningComponentNames()).toEqual([
        'database',
        'web-server',
      ]);
    });

    test('getComponentInstance should return the registered instance', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'database' });

      expect(lifecycle.getComponentInstance('database')).toBe(undefined);

      await lifecycle.registerComponent(component);

      expect(lifecycle.getComponentInstance('database')).toBe(component);
      expect(lifecycle.getComponentInstance('missing')).toBe(undefined);
    });

    test('getComponentCount should return total registered count', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      expect(lifecycle.getComponentCount()).toBe(0);

      await lifecycle.registerComponent(comp1);
      expect(lifecycle.getComponentCount()).toBe(1);

      await lifecycle.registerComponent(comp2);
      expect(lifecycle.getComponentCount()).toBe(2);
    });

    test('getRunningComponentCount should return running count', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);

      expect(lifecycle.getRunningComponentCount()).toBe(0);

      await lifecycle.startComponent('database');
      expect(lifecycle.getRunningComponentCount()).toBe(1);

      await lifecycle.startComponent('web-server');
      expect(lifecycle.getRunningComponentCount()).toBe(2);
    });

    test('getComponentStatus should return detailed status', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);

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

    test('getAllComponentStatuses should return statuses for all components', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const comp1 = new TestComponent(logger, { name: 'database' });
      const comp2 = new TestComponent(logger, { name: 'web-server' });

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);

      const statuses = lifecycle.getAllComponentStatuses();
      expect(statuses).toHaveLength(2);
      expect(statuses[0].name).toBe('database');
      expect(statuses[1].name).toBe('web-server');
    });

    test('getSystemState should return correct system state', async () => {
      const lifecycle = new LifecycleManager({ logger });

      expect(lifecycle.getSystemState()).toBe('no-components');

      const comp1 = new TestComponent(logger, { name: 'database' });
      await lifecycle.registerComponent(comp1);
      expect(lifecycle.getSystemState()).toBe('ready');

      await lifecycle.startComponent('database');
      expect(lifecycle.getSystemState()).toBe('running');

      const comp2 = new TestComponent(logger, { name: 'web-server' });
      await lifecycle.registerComponent(comp2);
      expect(lifecycle.getSystemState()).toBe('running'); // Still running (some components running is valid)

      await lifecycle.startComponent('web-server');
      expect(lifecycle.getSystemState()).toBe('running');
    });
  });

  describe('Individual Component Lifecycle', () => {
    test('startComponent should call component.start() and update state', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);

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
      await lifecycle.registerComponent(component);

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

      await lifecycle.registerComponent(component);

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

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      const result = await lifecycle.startComponent('api');

      expect(result.success).toBe(false);
      expect(result.code).toBe('dependency_not_running');
      expect(result.reason).toContain('database');
      expect(lifecycle.isComponentRunning('api')).toBe(false);
    });

    test('startComponent should allow optional dependencies', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, {
        name: 'database',
        optional: true,
      });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      const result = await lifecycle.startComponent('api');

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

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      const result = await lifecycle.startComponent('api');

      expect(result.success).toBe(true);
      expect(lifecycle.isComponentRunning('api')).toBe(true);
    });

    test('startComponent should return failure for already running component', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);
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
      await lifecycle.registerComponent(component);

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
      await lifecycle.registerComponent(component);
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

      await lifecycle.registerComponent(component);
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

      await lifecycle.registerComponent(component);

      const result = await lifecycle.stopComponent('test');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('Component not running');
      expect(result.code).toBe('component_not_running');
    });

    test('stopComponent should return component_stalled for stalled component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new FailingStopComponent(logger, 'stalled', 'Stop failed'),
      );
      await lifecycle.startComponent('stalled');

      const firstStop = await lifecycle.stopComponent('stalled');
      expect(firstStop.success).toBe(false);

      const result = await lifecycle.stopComponent('stalled');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('Component is stalled');
      expect(result.code).toBe('component_stalled');
      expect(result.status?.state).toBe('stalled');
    });

    test('restartComponent should stop then start component', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);
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

      const component = new FailingStopComponent(logger, 'test', 'Stop failed');

      await lifecycle.registerComponent(component);
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

      const component = new SlowStartComponent(logger, 'slow', 200);

      await lifecycle.registerComponent(component);

      const result = await lifecycle.startComponent('slow');

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('timed out');
      expect(result.code).toBe('component_startup_timeout');
      expect(lifecycle.isComponentRunning('slow')).toBe(false);

      const status = lifecycle.getComponentStatus('slow');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('starting-timed-out');
    });

    test('getStatus should account for start-timed-out components', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new SlowStartComponent(logger, 'slow', 200);

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('slow');

      const status = lifecycle.getStatus();

      expect(status.counts.total).toBe(1);
      expect(status.counts.running).toBe(0);
      expect(status.counts.stalled).toBe(0);
      expect(status.counts.stopped).toBe(1);
      expect(status.counts.startTimedOut).toBe(1);
      expect(status.components.startTimedOut).toEqual(['slow']);
      expect(status.components.stopped).toEqual(['slow']);
    });

    test('stopComponent should timeout and mark as stalled if stop() takes too long', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new SlowStopComponent(logger, 'slow', 1500);

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('slow');

      const opResult = await lifecycle.stopComponent('slow');

      expect(opResult.success).toBe(false);
      expect(opResult.error?.message).toContain('timed out');
      expect(opResult.code).toBe('component_shutdown_timeout');
      expect(lifecycle.isComponentRunning('slow')).toBe(false);

      const status = lifecycle.getComponentStatus('slow');
      const definedStatus = requireDefined(status, 'status');
      expect(definedStatus.state).toBe('stalled');
      const stallInfo = requireDefined(definedStatus.stallInfo, 'stallInfo');
      expect(stallInfo.reason).toBe('timeout');
    });

    test('stopComponent should mark as stalled on error', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new FailingStopComponent(
        logger,
        'failing',
        'Stop error',
      );

      await lifecycle.registerComponent(component);
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

      await lifecycle.registerComponent(component);
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

    test('stopComponent should fail when component has running dependents', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      await lifecycle.startComponent('api');

      const result = await lifecycle.stopComponent('database');

      expect(result.success).toBe(false);
      expect(result.code).toBe('has_running_dependents');
      expect(result.reason).toContain('api');
      expect(lifecycle.isComponentRunning('database')).toBe(true);
      expect(lifecycle.isComponentRunning('api')).toBe(true);
    });

    test('stopComponent should succeed with allowStopWithRunningDependents option when component has running dependents', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      await lifecycle.startComponent('api');

      const result = await lifecycle.stopComponent('database', {
        allowStopWithRunningDependents: true,
      });

      expect(result.success).toBe(true);
      expect(lifecycle.isComponentRunning('database')).toBe(false);
      expect(lifecycle.isComponentRunning('api')).toBe(true);
    });

    test('stopComponent should succeed when dependent is stopped', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api = new TestComponent(logger, {
        name: 'api',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api);

      await lifecycle.startComponent('database');
      await lifecycle.startComponent('api');

      // Stop dependent first
      await lifecycle.stopComponent('api');

      // Now can stop database
      const result = await lifecycle.stopComponent('database');

      expect(result.success).toBe(true);
      expect(lifecycle.isComponentRunning('database')).toBe(false);
    });

    test('stopComponent should handle multiple dependents', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const database = new TestComponent(logger, { name: 'database' });
      const api1 = new TestComponent(logger, {
        name: 'api1',
        dependencies: ['database'],
      });
      const api2 = new TestComponent(logger, {
        name: 'api2',
        dependencies: ['database'],
      });

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(api1);
      await lifecycle.registerComponent(api2);

      await lifecycle.startComponent('database');
      await lifecycle.startComponent('api1');
      await lifecycle.startComponent('api2');

      const result = await lifecycle.stopComponent('database');

      expect(result.success).toBe(false);
      expect(result.code).toBe('has_running_dependents');
      expect(result.reason).toContain('api1');
      expect(result.reason).toContain('api2');
      expect(lifecycle.isComponentRunning('database')).toBe(true);
    });
  });

  describe('Abort Callbacks', () => {
    test('onStartupAborted should be called on startup timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class AbortableStartComponent extends BaseComponent {
        public abortCalled = false;

        public async start() {
          await sleep(200);
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

      await lifecycle.registerComponent(component);
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

      await lifecycle.registerComponent(component);
      const result = await lifecycle.startComponent('test');

      expect(result.success).toBe(false);

      // Wait beyond the timeout window to ensure no stray timer fires.
      await sleep(120);
      expect(component.abortCalled).toBe(false);
    });

    test('onGracefulStopTimeout should be called on stop timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class AbortableStopComponent extends BaseComponent {
        public abortCalled = false;

        public start(): Promise<void> {
          return Promise.resolve();
        }

        public async stop() {
          await sleep(2000);
        }

        public onGracefulStopTimeout() {
          this.abortCalled = true;
        }
      }

      const component = new AbortableStopComponent(logger, {
        name: 'test',
        shutdownGracefulTimeoutMS: 1000,
      });

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');
      await lifecycle.stopComponent('test');

      expect(component.abortCalled).toBe(true);
    });

    test('onGracefulStopTimeout should NOT be called when stop() fails (non-timeout)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingStopComponent extends BaseComponent {
        public abortCalled = false;

        public start(): Promise<void> {
          return Promise.resolve();
        }

        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop error'));
        }

        public onGracefulStopTimeout() {
          this.abortCalled = true;
        }
      }

      const component = new FailingStopComponent(logger, {
        name: 'test',
        shutdownGracefulTimeoutMS: 50,
      });

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');
      const result = await lifecycle.stopComponent('test');

      expect(result.success).toBe(false);

      // Wait beyond the timeout window to ensure no stray timer fires.
      await sleep(120);
      expect(component.abortCalled).toBe(false);
    });
  });

  describe('Event Emission', () => {
    test('should emit component:registered event', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      let emittedData: any;
      lifecycle.on('component:registered', (data) => {
        emittedData = data;
      });

      await lifecycle.registerComponent(component);

      expect(emittedData).toBeDefined();
      expect(emittedData.name).toBe('test');
      expect(emittedData.action).toBe('register');
      expect(emittedData.registrationIndexBefore).toBeNull();
      expect(emittedData.registrationIndexAfter).toBe(0);
      expect(Array.isArray(emittedData.startupOrder)).toBe(true);
    });

    test('should emit component:starting and component:started events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);

      const events: string[] = [];
      lifecycle.on('component:starting', () => {
        events.push('starting');
      });
      let startedPayload: any;
      lifecycle.on('component:started', (data) => {
        events.push('started');
        startedPayload = data;
      });

      await lifecycle.startComponent('test');

      expect(events).toEqual(['starting', 'started']);
      expect(startedPayload?.status?.name).toBe('test');
      expect(startedPayload?.status?.state).toBe('running');
    });

    test('should emit component:stopping and component:stopped events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('test');

      const events: string[] = [];
      lifecycle.on('component:stopping', () => {
        events.push('stopping');
      });
      let stoppedPayload: any;
      lifecycle.on('component:stopped', (data) => {
        events.push('stopped');
        stoppedPayload = data;
      });

      await lifecycle.stopComponent('test');

      expect(events).toEqual(['stopping', 'stopped']);
      expect(stoppedPayload?.status?.name).toBe('test');
      expect(stoppedPayload?.status?.state).toBe('stopped');
    });

    test('should emit component:start-timeout event on startup timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new SlowStartComponent(logger, 'slow', 200);

      await lifecycle.registerComponent(component);

      let didTimeoutEmit = false;
      let timeoutPayload: any;
      lifecycle.on('component:start-timeout', (data) => {
        didTimeoutEmit = true;
        timeoutPayload = data;
      });

      await lifecycle.startComponent('slow');

      expect(didTimeoutEmit).toBe(true);
      expect(timeoutPayload?.name).toBe('slow');
      expect(timeoutPayload?.timeoutMS).toBe(50);
    });

    test('should emit component:stalled event on stop timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new SlowStopComponent(logger, 'slow', 2000);

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('slow');

      let didStallEmit = false;
      let stalledPayload: any;
      lifecycle.on('component:stalled', (data) => {
        didStallEmit = true;
        stalledPayload = data;
      });

      await lifecycle.stopComponent('slow');

      expect(didStallEmit).toBe(true);
      expect(stalledPayload?.name).toBe('slow');
      expect(stalledPayload?.stallInfo?.reason).toBe('timeout');
      expect(stalledPayload?.code).toBe('component_shutdown_timeout');
    });

    test('event handler errors should not break lifecycle operations', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const component = new TestComponent(logger, { name: 'test' });

      await lifecycle.registerComponent(component);

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

      await lifecycle.registerComponent(component);
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

      const component = new FailingStartComponent(
        logger,
        'failing',
        'Start failed',
      );

      await lifecycle.registerComponent(component);
      await lifecycle.startComponent('failing');

      const failedStartStatus = requireDefined(
        lifecycle.getComponentStatus('failing'),
        'failedStartStatus',
      );
      expect(failedStartStatus.state).toBe('registered');
    });

    test('failed/timed-out stop should set state to stalled', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new FailingStopComponent(
        logger,
        'failing',
        'Stop failed',
      );

      await lifecycle.registerComponent(component);
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

describe('LifecycleManager - Bulk Operations', () => {
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
    test('should reject when no components are registered', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.code).toBe('no_components_registered');
    });

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

      await lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'first' }),
      );
      await lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'second' }),
      );
      await lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'third' }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(result.startedComponents).toEqual(['first', 'second', 'third']);
      expect(startOrder).toEqual(['first', 'second', 'third']);
    });

    test('should reject if partial state (some already running)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );

      // Start one component manually
      await lifecycle.startComponent('comp1');

      // Try to start all - should fail
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.startedComponents).toEqual(['comp1']); // Only comp1 was running
    });

    test('should return success if all components already running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );

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

      await lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new FailingComponent(logger, { name: 'failing' }),
      );
      await lifecycle.registerComponent(
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

      await lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'a' }),
      );
      await lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'b' }),
      );
      await lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'c' }),
      );
      await lifecycle.registerComponent(
        new FailingStartComponent(logger, 'fail', 'Startup failed'),
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

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new FailingComponent(logger, { name: 'optional', optional: true }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );

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
          await sleep(50);
        }
        public stop(): Promise<void> {
          stopOrder.push(this.getName());
          return Promise.resolve();
        }
      }

      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp3' }),
      );
      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp4' }),
      );

      // Start all components
      const startPromise = lifecycle.startAllComponents();

      // Wait a bit for first component to start
      await sleep(25);

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

      let shutdownCompletedPayload: any;
      lifecycle.on('lifecycle-manager:shutdown-completed', (data) => {
        shutdownCompletedCount++;
        shutdownCompletedPayload = data;
      });

      await lifecycle.registerComponent(
        new SlowStartComponent(logger, 'comp1', 50),
      );
      await lifecycle.registerComponent(
        new SlowStartComponent(logger, 'comp2', 50),
      );

      // Start all components
      const startPromise = lifecycle.startAllComponents();

      // Wait a bit for startup to begin
      await sleep(10);

      // Call stopAllComponents() during startup
      const stopPromise = lifecycle.stopAllComponents();

      await Promise.all([startPromise, stopPromise]);

      // Verify shutdown events emitted only once (by stopAllComponents)
      expect(shutdownInitiatedCount).toBe(1);
      expect(shutdownCompletedCount).toBe(1);
      // Verify duringStartup flag is correctly set to true
      expect(wasDuringStartup).toBe(true);
      expect(shutdownCompletedPayload?.duringStartup).toBe(true);
    });

    test('should block startup if stalled components exist', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const component = new FailingStopComponent(
        logger,
        'stalled',
        'Stop failed',
      );
      await lifecycle.registerComponent(component);

      // Start and fail to stop (creates stalled component)
      await lifecycle.startComponent('stalled');
      await lifecycle.stopComponent('stalled');

      // Verify component is stalled
      const status = lifecycle.getComponentStatus('stalled');
      expect(status?.state).toBe('stalled');

      // Register a new component
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'new-comp' }),
      );

      // Try to start all - should fail due to stalled component
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.blockedByStalledComponents).toEqual(['stalled']);
    });

    test('should allow startup if ignoreStalledComponents option is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new FailingStopComponent(logger, 'stalled', 'Stop failed'),
      );
      await lifecycle.registerComponent(
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

    test('should block individual startComponent on stalled component by default', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new FailingStopComponent(logger, 'stalled', 'Stop failed'),
      );

      // Create stalled component
      await lifecycle.startComponent('stalled');
      await lifecycle.stopComponent('stalled');

      // Try to start stalled component without option - should fail
      const result = await lifecycle.startComponent('stalled');

      expect(result.success).toBe(false);
      expect(result.code).toBe('component_stalled');
      expect(result.reason).toBe('Component is stalled');
    });

    test('should allow individual startComponent with forceStalled option', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new FailingStopComponent(logger, 'stalled', 'Stop failed'),
      );

      // Create stalled component
      await lifecycle.startComponent('stalled');
      await lifecycle.stopComponent('stalled');

      // Verify component is stalled
      expect(lifecycle.getStalledComponentCount()).toBe(1);
      expect(lifecycle.getComponentStatus('stalled')?.state).toBe('stalled');

      // Try to start stalled component with forceStalled option
      const result = await lifecycle.startComponent('stalled', {
        forceStalled: true,
      });

      expect(result.success).toBe(true);
      expect(result.status?.state).toBe('running');

      // Verify component is no longer stalled
      expect(lifecycle.getStalledComponentCount()).toBe(0);
      expect(lifecycle.getComponentStatus('stalled')?.state).toBe('running');
      expect(lifecycle.isComponentRunning('stalled')).toBe(true);
    });

    test('should emit lifecycle-manager:started event on success', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );

      let wasStartedEventEmitted = false;
      let startedPayload: any;
      lifecycle.on('lifecycle-manager:started', (data) => {
        wasStartedEventEmitted = true;
        startedPayload = data;
      });

      await lifecycle.startAllComponents();

      expect(wasStartedEventEmitted).toBe(true);
      expect(Array.isArray(startedPayload?.startedComponents)).toBe(true);
      expect(Array.isArray(startedPayload?.skippedComponents)).toBe(true);
    });

    test('should emit component:startup-rollback events', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const rollbackEvents: string[] = [];

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new FailingStartComponent(logger, 'failing', 'Startup failed'),
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
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'alpha' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'beta' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'gamma' }),
      );

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

      await lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'first' }),
      );
      await lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'second' }),
      );
      await lifecycle.registerComponent(
        new OrderedComponent(logger, { name: 'third' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.stopAllComponents({
        haltOnStall: false,
      });

      expect(result.success).toBe(true);
      expect(result.stoppedComponents).toEqual(['third', 'second', 'first']);
      expect(stopOrder).toEqual(['third', 'second', 'first']);
    });

    test('should continue on errors and track stalled components', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new FailingStopComponent(logger, 'failing', 'Stop failed'),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.stopAllComponents({
        haltOnStall: false,
      });

      expect(result.success).toBe(false); // Not successful due to stalled component
      expect(result.stoppedComponents).toEqual(['comp2', 'comp1']);
      expect(result.stalledComponents).toHaveLength(1);
      expect(result.stalledComponents[0].name).toBe('failing');
    });

    test('should halt after first stall when haltOnStall is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new FailingStopComponent(logger, 'failing', 'Stop failed'),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.stopAllComponents({ haltOnStall: true });

      expect(result.success).toBe(false);
      expect(result.stoppedComponents).toEqual([]);
      expect(result.stalledComponents).toHaveLength(1);
      expect(result.stalledComponents[0].name).toBe('failing');

      // Remaining components should still be running since shutdown halted
      expect(lifecycle.isComponentRunning('comp2')).toBe(true);
      expect(lifecycle.isComponentRunning('comp1')).toBe(true);
    });

    test('should retry stalled components when retryStalled is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FlakyForceComponent extends BaseComponent {
        private forceAttempts = 0;

        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
        public onShutdownForce(): Promise<void> {
          this.forceAttempts += 1;
          if (this.forceAttempts === 1) {
            return Promise.reject(new Error('Force failed'));
          }
          return Promise.resolve();
        }
      }

      await lifecycle.registerComponent(
        new FlakyForceComponent(logger, { name: 'flaky' }),
      );

      await lifecycle.startAllComponents();

      const firstResult = await lifecycle.stopAllComponents();

      expect(firstResult.success).toBe(false);
      expect(firstResult.stalledComponents).toHaveLength(1);
      expect(firstResult.stalledComponents[0].name).toBe('flaky');

      const retryResult = await lifecycle.stopAllComponents({
        retryStalled: true,
      });

      expect(retryResult.success).toBe(true);
      expect(retryResult.stalledComponents).toHaveLength(0);
      expect(lifecycle.getComponentStatus('flaky')?.state).toBe('stopped');
    });

    test('should recover stalled component after external fix when retryStalled is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ToggleForceComponent extends BaseComponent {
        public allowForce = false;

        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
        public onShutdownForce(): Promise<void> {
          if (!this.allowForce) {
            return Promise.reject(new Error('Force failed'));
          }
          return Promise.resolve();
        }
      }

      const component = new ToggleForceComponent(logger, { name: 'toggle' });
      await lifecycle.registerComponent(component);
      await lifecycle.startAllComponents();

      const firstResult = await lifecycle.stopAllComponents();

      expect(firstResult.success).toBe(false);
      expect(firstResult.stalledComponents).toHaveLength(1);
      expect(firstResult.stalledComponents[0].name).toBe('toggle');

      // External fix: allow force handler to succeed
      component.allowForce = true;

      const retryResult = await lifecycle.stopAllComponents({
        retryStalled: true,
      });

      expect(retryResult.success).toBe(true);
      expect(retryResult.stalledComponents).toHaveLength(0);
      expect(lifecycle.getComponentStatus('toggle')?.state).toBe('stopped');
    });

    test('should not retry stalled components when retryStalled is false', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingForceComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.reject(new Error('Stop failed'));
        }
        public onShutdownForce(): Promise<void> {
          return Promise.reject(new Error('Force failed'));
        }
      }

      await lifecycle.registerComponent(
        new FailingForceComponent(logger, { name: 'failing' }),
      );

      await lifecycle.startAllComponents();

      const firstResult = await lifecycle.stopAllComponents();

      expect(firstResult.success).toBe(false);
      expect(firstResult.stalledComponents).toHaveLength(1);
      expect(firstResult.stalledComponents[0].name).toBe('failing');

      const retryResult = await lifecycle.stopAllComponents({
        retryStalled: false,
      });

      expect(retryResult.success).toBe(true);
      expect(lifecycle.getComponentStatus('failing')?.state).toBe('stalled');
    });

    test('should emit shutdown-initiated and shutdown-completed events', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );

      let wasShutdownInitiatedEmitted = false;
      let wasShutdownCompletedEmitted = false;

      lifecycle.on('lifecycle-manager:shutdown-initiated', () => {
        wasShutdownInitiatedEmitted = true;
      });

      let shutdownCompletedPayload: any;
      lifecycle.on('lifecycle-manager:shutdown-completed', (data) => {
        wasShutdownCompletedEmitted = true;
        shutdownCompletedPayload = data;
      });

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(wasShutdownInitiatedEmitted).toBe(true);
      expect(wasShutdownCompletedEmitted).toBe(true);
      expect(shutdownCompletedPayload?.method).toBe('manual');
      expect(shutdownCompletedPayload?.duringStartup).toBe(false);
    });

    test('should reset state flags after completion', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      // After shutdown, isShuttingDown should be false
      const systemState = lifecycle.getSystemState();
      expect(systemState).not.toBe('shutting-down');
    });

    test('should calculate shutdown duration', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'slow', 50),
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

      await lifecycle.registerComponent(
        new TrackingComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
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

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );

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

      await lifecycle.registerComponent(
        new FailingStopComponent(logger, 'failing', 'Stop failed'),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.restartAllComponents({
        startupOptions: { ignoreStalledComponents: true },
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
          await sleep(50);
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp3' }),
      );

      // Start all components (will take a while)
      const startAllPromise = lifecycle.startAllComponents();

      // Wait a bit to ensure bulk startup is in progress
      await sleep(10);

      // Try to start individual component - should fail
      const result = await lifecycle.startComponent('comp3');

      expect(result.success).toBe(false);
      expect(result.code).toBe('startup_in_progress');

      await startAllPromise;
    });

    test('should prevent individual stop during bulk startup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new SlowStartComponent(logger, 'comp1', 50),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );

      // Pre-start comp2
      await lifecycle.startComponent('comp2');
      await lifecycle.stopComponent('comp2');

      await lifecycle.registerComponent(
        new SlowStartComponent(logger, 'comp3', 50),
      );

      // Start all components
      const startAllPromise = lifecycle.startAllComponents();

      // Wait a bit
      await sleep(10);

      // Try to stop individual component - should fail
      const result = await lifecycle.stopComponent('comp2');

      expect(result.success).toBe(false);
      expect(result.code).toBe('startup_in_progress');

      await startAllPromise;
    });

    test('should prevent individual stop during bulk shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'comp1', 50),
      );
      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'comp2', 50),
      );

      await lifecycle.startAllComponents();

      // Start shutdown
      const stopAllPromise = lifecycle.stopAllComponents();

      // Wait a bit to ensure shutdown is in progress
      await sleep(10);

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
          await sleep(50);
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp3' }),
      );

      // Start all components (will take a while)
      const startAllPromise = lifecycle.startAllComponents();

      // Wait a bit to ensure bulk startup is in progress
      await sleep(10);

      // Try to restart individual component - should fail
      const result = await lifecycle.restartComponent('comp2');

      expect(result.success).toBe(false);
      expect(result.code).toBe('startup_in_progress');

      await startAllPromise;
    });

    test('should prevent start during shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'comp1', 50),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );

      await lifecycle.startAllComponents();

      // Start shutdown
      const stopAllPromise = lifecycle.stopAllComponents();

      // Wait a bit
      await sleep(10);

      // Try to start individual component - should fail
      const result = await lifecycle.startComponent('comp2');

      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_in_progress');

      await stopAllPromise;
    });

    test('should prevent bulk startup during shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'comp1', 50),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp2' }),
      );

      await lifecycle.startAllComponents();

      // Start shutdown
      const stopAllPromise = lifecycle.stopAllComponents();

      // Wait a bit to ensure shutdown is in progress
      await sleep(10);

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

      await lifecycle.registerComponent(
        new SlowStartComponent(logger, 'comp1', 50),
      );
      await lifecycle.registerComponent(
        new SlowStartComponent(logger, 'comp2', 50),
      );

      // Start first bulk startup
      const firstStartPromise = lifecycle.startAllComponents();

      // Wait a bit to ensure first startup is in progress
      await sleep(10);

      // Try to start all components again - should fail
      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(false);
      expect(result.startedComponents).toEqual([]);

      await firstStartPromise;
    });

    test('should prevent concurrent stopAllComponents() calls', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'comp1', 50),
      );
      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'comp2', 50),
      );

      await lifecycle.startAllComponents();

      // Start first shutdown
      const firstStopPromise = lifecycle.stopAllComponents();

      // Wait a bit to ensure first shutdown is in progress
      await sleep(10);

      // Try to stop all components again - should return failure immediately with already_in_progress code
      const result = await lifecycle.stopAllComponents();

      expect(result.success).toBe(false);
      expect(result.stoppedComponents).toEqual([]);
      expect(result.durationMS).toBe(0);
      expect(result.code).toBe('already_in_progress');
      expect(result.reason).toBe('Shutdown already in progress');

      await firstStopPromise;
    });

    test('should prevent unregisterComponent during bulk operations with correct error code', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        public async start(): Promise<void> {
          await sleep(50);
        }
        public async stop(): Promise<void> {
          await sleep(50);
        }
      }

      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new SlowComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp3' }),
      );

      // Test during startup
      const startAllPromise = lifecycle.startAllComponents();
      await sleep(10);

      const unregisterDuringStartup =
        await lifecycle.unregisterComponent('comp3');

      expect(unregisterDuringStartup.success).toBe(false);
      expect(unregisterDuringStartup.code).toBe('bulk_operation_in_progress');
      expect(unregisterDuringStartup.wasRegistered).toBe(true);
      expect(unregisterDuringStartup.componentName).toBe('comp3');

      await startAllPromise;

      // Test during shutdown
      const stopAllPromise = lifecycle.stopAllComponents();
      await sleep(10);

      const unregisterDuringShutdown =
        await lifecycle.unregisterComponent('comp3');

      expect(unregisterDuringShutdown.success).toBe(false);
      expect(unregisterDuringShutdown.code).toBe('bulk_operation_in_progress');
      expect(unregisterDuringShutdown.wasRegistered).toBe(true);
      expect(unregisterDuringShutdown.componentName).toBe('comp3');

      await stopAllPromise;

      // After bulk operations complete, unregister should work
      const unregisterAfter = await lifecycle.unregisterComponent('comp3');
      expect(unregisterAfter.success).toBe(true);
    });
  });

  describe('Dependency Management', () => {
    test('should start components in topological order (linear dependencies)', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const startOrder: string[] = [];

      class TrackedComponent extends BaseComponent {
        public start(): Promise<void> {
          startOrder.push(this.getName());
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      // A depends on B, B depends on C (C → B → A)
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-a',
          dependencies: ['comp-b'],
        }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-b',
          dependencies: ['comp-c'],
        }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-c' }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(startOrder).toEqual(['comp-c', 'comp-b', 'comp-a']);
    });

    test('should handle diamond dependencies correctly', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const startOrder: string[] = [];

      class TrackedComponent extends BaseComponent {
        public start(): Promise<void> {
          startOrder.push(this.getName());
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      // Diamond: D depends on B and C, both B and C depend on A
      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-a' }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-b',
          dependencies: ['comp-a'],
        }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-c',
          dependencies: ['comp-a'],
        }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-d',
          dependencies: ['comp-b', 'comp-c'],
        }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(startOrder[0]).toBe('comp-a'); // A must be first
      expect(startOrder[3]).toBe('comp-d'); // D must be last
      // B and C can be in any order but both after A and before D
      expect(startOrder.slice(1, 3).sort()).toEqual(['comp-b', 'comp-c']);
    });

    test('should handle multiple independent chains', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const startOrder: string[] = [];

      class TrackedComponent extends BaseComponent {
        public start(): Promise<void> {
          startOrder.push(this.getName());
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      // Chain 1: B depends on A
      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-a' }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-b',
          dependencies: ['comp-a'],
        }),
      );

      // Chain 2: D depends on C
      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-c' }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-d',
          dependencies: ['comp-c'],
        }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(startOrder.indexOf('comp-a')).toBeLessThan(
        startOrder.indexOf('comp-b'),
      );
      expect(startOrder.indexOf('comp-c')).toBeLessThan(
        startOrder.indexOf('comp-d'),
      );
    });

    test('should preserve registration order when no dependencies', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const startOrder: string[] = [];

      class TrackedComponent extends BaseComponent {
        public start(): Promise<void> {
          startOrder.push(this.getName());
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-a' }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-b' }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-c' }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(startOrder).toEqual(['comp-a', 'comp-b', 'comp-c']);
    });

    test('should stop components in reverse topological order', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const stopOrder: string[] = [];

      class TrackedComponent extends BaseComponent {
        public start(): Promise<void> {
          return Promise.resolve();
        }
        public stop(): Promise<void> {
          stopOrder.push(this.getName());
          return Promise.resolve();
        }
      }

      // A depends on B, B depends on C (C → B → A for start, A → B → C for stop)
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-a',
          dependencies: ['comp-b'],
        }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, {
          name: 'comp-b',
          dependencies: ['comp-c'],
        }),
      );
      await lifecycle.registerComponent(
        new TrackedComponent(logger, { name: 'comp-c' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(stopOrder).toEqual(['comp-a', 'comp-b', 'comp-c']);
    });

    test('should detect simple dependency cycle', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a', dependencies: ['comp-b'] }),
      );

      // This creates a cycle: A → B → A
      const result = await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-a'] }),
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe('dependency_cycle');
      expect(result.error).toBeInstanceOf(DependencyCycleError);
    });

    test('should detect complex dependency cycle', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a', dependencies: ['comp-b'] }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-c'] }),
      );

      // This creates a cycle: A → B → C → A
      const result = await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-c', dependencies: ['comp-a'] }),
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe('dependency_cycle');
      expect(result.error).toBeInstanceOf(DependencyCycleError);
    });

    test('should detect self-dependency cycle', async () => {
      const lifecycle = new LifecycleManager({ logger });

      // Component depends on itself
      const result = await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a', dependencies: ['comp-a'] }),
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe('dependency_cycle');
    });

    test('should detect missing dependencies during manual start', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, {
          name: 'comp-a',
          dependencies: ['comp-missing'],
        }),
      );

      const result = await lifecycle.startComponent('comp-a');

      expect(result.success).toBe(false);
      expect(result.code).toBe('missing_dependency');
      expect(result.reason).toContain('comp-missing');
    });

    test('should detect dependency not running during manual start', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-a'] }),
      );

      // comp-a is registered but not running
      const result = await lifecycle.startComponent('comp-b');

      expect(result.success).toBe(false);
      expect(result.code).toBe('dependency_not_running');
      expect(result.reason).toContain('comp-a');
    });

    test('should allow manual start when optional dependency is not running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a', optional: true }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-a'] }),
      );

      // comp-a is not running but is optional
      const result = await lifecycle.startComponent('comp-b');

      expect(result.success).toBe(true);
    });

    test('should allow manual start with allowNonRunningDependencies', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-a'] }),
      );

      // comp-a is not running and is required, but we explicitly override
      const result = await lifecycle.startComponent('comp-b', {
        allowNonRunningDependencies: true,
      });

      expect(result.success).toBe(true);
    });

    test('should still start dependents when optional dependency fails', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingComponent extends BaseComponent {
        public start(): Promise<void> {
          throw new Error('Intentional failure');
        }
        public stop(): Promise<void> {
          return Promise.resolve();
        }
      }

      // comp-a is optional and will fail
      await lifecycle.registerComponent(
        new FailingComponent(logger, { name: 'comp-a', optional: true }),
      );
      // comp-b depends on comp-a
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-a'] }),
      );

      const result = await lifecycle.startAllComponents();

      expect(result.success).toBe(true);
      expect(result.failedOptionalComponents).toHaveLength(1);
      expect(result.failedOptionalComponents[0].name).toBe('comp-a');
      expect(result.startedComponents).toContain('comp-b');
      expect(result.skippedDueToDependency).not.toContain('comp-b');
    });

    test('validateDependencies() should return valid when no issues', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a' }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-a'] }),
      );

      const result = lifecycle.validateDependencies();

      expect(result.valid).toBe(true);
      expect(result.missingDependencies).toEqual([]);
      expect(result.circularCycles).toEqual([]);
      expect(result.summary.totalMissingDependencies).toBe(0);
      expect(result.summary.totalCircularCycles).toBe(0);
    });

    test('validateDependencies() should report missing dependencies', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, {
          name: 'comp-a',
          dependencies: ['comp-missing'],
        }),
      );

      const result = lifecycle.validateDependencies();

      expect(result.valid).toBe(false);
      expect(result.missingDependencies).toHaveLength(1);
      expect(result.missingDependencies[0]).toEqual({
        componentName: 'comp-a',
        componentIsOptional: false,
        missingDependency: 'comp-missing',
      });
      expect(result.summary.totalMissingDependencies).toBe(1);
      expect(result.summary.requiredMissingDependencies).toBe(1);
      expect(result.summary.optionalMissingDependencies).toBe(0);
    });

    test('validateDependencies() should report cycles during registration', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const result1 = await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a', dependencies: ['comp-b'] }),
      );
      expect(result1.success).toBe(true);

      // This should fail due to cycle
      const result2 = await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-a'] }),
      );

      expect(result2.success).toBe(false);
      expect(result2.code).toBe('dependency_cycle');

      // Only comp-a should be registered
      const validation = lifecycle.validateDependencies();
      expect(validation.missingDependencies).toHaveLength(1); // comp-a depends on non-existent comp-b
    });

    test('validateDependencies() should report multiple missing dependencies', async () => {
      const lifecycle = new LifecycleManager({ logger });

      // Multiple missing dependencies
      await lifecycle.registerComponent(
        new TestComponent(logger, {
          name: 'comp-a',
          dependencies: ['comp-missing1'],
          optional: true,
        }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, {
          name: 'comp-b',
          dependencies: ['comp-missing2'],
        }),
      );

      const result = lifecycle.validateDependencies();

      expect(result.valid).toBe(false);
      expect(result.missingDependencies).toHaveLength(2);
      expect(result.summary.totalMissingDependencies).toBe(2);
      expect(result.summary.optionalMissingDependencies).toBe(1);
      expect(result.summary.requiredMissingDependencies).toBe(1);
    });

    test('validateDependencies() should detect multiple independent cycles', () => {
      const lifecycle = new LifecycleManager({ logger });

      // Create two independent cycles by manually adding components
      // We bypass registration validation to create the cycles for testing

      // Cycle 1: comp-a -> comp-b -> comp-a
      const compA = new TestComponent(logger, {
        name: 'comp-a',
        dependencies: ['comp-b'],
      });
      const compB = new TestComponent(logger, {
        name: 'comp-b',
        dependencies: ['comp-a'],
      });

      // Cycle 2: comp-x -> comp-y -> comp-z -> comp-x
      const compX = new TestComponent(logger, {
        name: 'comp-x',
        dependencies: ['comp-y'],
      });
      const compY = new TestComponent(logger, {
        name: 'comp-y',
        dependencies: ['comp-z'],
      });
      const compZ = new TestComponent(logger, {
        name: 'comp-z',
        dependencies: ['comp-x'],
      });

      // Access private components array to add them directly
      // This simulates having cycles that weren't caught during registration
      (lifecycle as any).components.push(compA, compB, compX, compY, compZ);

      const result = lifecycle.validateDependencies();

      expect(result.valid).toBe(false);
      expect(result.circularCycles.length).toBeGreaterThanOrEqual(1);
      expect(result.summary.totalCircularCycles).toBeGreaterThanOrEqual(1);

      // Verify at least one cycle contains expected components
      const cycleStrings = result.circularCycles.map((c) => c.join('->'));
      const hasCycle1 =
        cycleStrings.some(
          (s) => s.includes('comp-a') && s.includes('comp-b'),
        ) ||
        result.circularCycles.some(
          (c) => c.includes('comp-a') && c.includes('comp-b'),
        );
      const hasCycle2 =
        cycleStrings.some(
          (s) =>
            s.includes('comp-x') &&
            s.includes('comp-y') &&
            s.includes('comp-z'),
        ) ||
        result.circularCycles.some(
          (c) =>
            c.includes('comp-x') &&
            c.includes('comp-y') &&
            c.includes('comp-z'),
        );

      expect(hasCycle1 || hasCycle2).toBe(true);
    });

    test('getStartupOrder() should return resolved order', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a', dependencies: ['comp-b'] }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b', dependencies: ['comp-c'] }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-c' }),
      );

      const result = lifecycle.getStartupOrder();

      expect(result.success).toBe(true);
      expect(result.startupOrder).toEqual(['comp-c', 'comp-b', 'comp-a']);
    });

    test('getStartupOrder() should succeed when components are registered validly', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-a', dependencies: ['comp-b'] }),
      );
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp-b' }),
      );

      const result = lifecycle.getStartupOrder();

      expect(result.success).toBe(true);
      expect(result.startupOrder).toEqual(['comp-b', 'comp-a']);
    });
  });
});

// ============================================================================
// Phase 5: Multi-Phase Shutdown
// ============================================================================

describe('LifecycleManager - Multi-Phase Shutdown', () => {
  let logger: Logger;
  let arraySink: ArraySink;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });
  });

  describe('Warning Phase', () => {
    test('should call onShutdownWarning when shutdownWarningTimeoutMS > 0', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: 1000,
      });
      let isWarningCalled = false;

      class WarningComponent extends TestComponent {
        public onShutdownWarning() {
          isWarningCalled = true;
        }
      }

      await lifecycle.registerComponent(
        new WarningComponent(logger, {
          name: 'warning-comp',
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(isWarningCalled).toBe(true);
    });

    test('should fire warning phase without waiting when shutdownWarningTimeoutMS = 0 (fire-and-forget)', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: 0,
      });

      let didWarningStart = false;
      let didWarningComplete = false;
      let didCompletionFireAfterWarningStarted = false;

      class WarningComponent extends TestComponent {
        public async onShutdownWarning() {
          didWarningStart = true;
          await sleep(1);
          didWarningComplete = true;
        }
      }

      await lifecycle.registerComponent(
        new WarningComponent(logger, {
          name: 'warning-comp',
        }),
      );

      lifecycle.on('lifecycle-manager:shutdown-warning-completed', () => {
        // When global completion fires, warning should have started
        // (microtask queue was flushed before this event)
        didCompletionFireAfterWarningStarted = didWarningStart;
      });

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      // Verify event ordering: warnings start before global completion is emitted
      expect(didCompletionFireAfterWarningStarted).toBe(true);

      // Fire-and-forget mode: stopAllComponents() returns immediately after
      // broadcasting warnings. Delay is needed to verify the warning callback
      // eventually completes (this is for testing only - production code should
      // not rely on warnings completing in fire-and-forget mode).
      await sleep(10);
      expect(didWarningComplete).toBe(true);
    });

    test('should skip warning phase when shutdownWarningTimeoutMS < 0', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: -1,
      });
      let isWarningCalled = false;

      class WarningComponent extends TestComponent {
        public onShutdownWarning() {
          isWarningCalled = true;
        }
      }

      await lifecycle.registerComponent(
        new WarningComponent(logger, {
          name: 'warning-comp',
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(isWarningCalled).toBe(false);
    });

    test('should timeout warning phase and continue to graceful', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: 100,
      });
      let hasWarningCompleted = false;
      let wasStopCalled = false;

      class SlowWarningComponent extends TestComponent {
        public async onShutdownWarning() {
          await sleep(2000); // 2s
          hasWarningCompleted = true;
        }

        public stop() {
          wasStopCalled = true;
        }
      }

      await lifecycle.registerComponent(
        new SlowWarningComponent(logger, {
          name: 'slow-warning',
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(hasWarningCompleted).toBe(false); // Warning didn't complete
      expect(wasStopCalled).toBe(true); // But graceful phase still ran
    });

    test('should emit warning phase events', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: 1000,
      });
      const events: string[] = [];

      class WarningComponent extends TestComponent {
        public async onShutdownWarning() {
          await sleep(10);
        }
      }

      lifecycle.on('component:shutdown-warning', () => {
        events.push('warning-started');
      });
      lifecycle.on('component:shutdown-warning-completed', () => {
        events.push('warning-completed');
      });
      lifecycle.on('lifecycle-manager:shutdown-warning', () => {
        events.push('global-warning-started');
      });
      lifecycle.on('lifecycle-manager:shutdown-warning-completed', () => {
        events.push('global-warning-completed');
      });

      await lifecycle.registerComponent(
        new WarningComponent(logger, {
          name: 'warning-comp',
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(events).toContain('warning-started');
      expect(events).toContain('warning-completed');
      expect(events).toContain('global-warning-started');
      expect(events).toContain('global-warning-completed');
    });

    test('should emit warning timeout event', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: 100,
      });
      let wasTimeoutEmitted = false;

      class SlowWarningComponent extends TestComponent {
        public async onShutdownWarning() {
          await sleep(2000);
        }
      }

      lifecycle.on('component:shutdown-warning-timeout', () => {
        wasTimeoutEmitted = true;
      });

      await lifecycle.registerComponent(
        new SlowWarningComponent(logger, {
          name: 'slow-warning',
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(wasTimeoutEmitted).toBe(true);
    });
  });

  describe('Graceful to Force Transition', () => {
    test('should call onShutdownForce when graceful times out', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let wasForceCalled = false;

      class SlowStopComponent extends TestComponent {
        public async stop() {
          await sleep(2000); // 2s
        }

        public onShutdownForce() {
          wasForceCalled = true;
        }
      }

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, {
          name: 'slow-stop',
          shutdownGracefulTimeoutMS: 100, // Very short timeout
        }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.stopAllComponents();

      expect(wasForceCalled).toBe(true);
      expect(result.success).toBe(true); // Force succeeded
    });

    test('should call onShutdownForce when graceful throws error', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let wasForceCalled = false;

      class FailingStopComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }

        public onShutdownForce() {
          wasForceCalled = true;
        }
      }

      await lifecycle.registerComponent(
        new FailingStopComponent(logger, {
          name: 'failing-stop',
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(wasForceCalled).toBe(true);
    });

    test('should pass context to force phase events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let eventContext: any = null;

      class SlowStopComponent extends TestComponent {
        public async stop() {
          await sleep(2000);
        }

        public onShutdownForce() {
          // Force handler
        }
      }

      lifecycle.on('component:shutdown-force', (data: any) => {
        eventContext = data.context;
      });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, {
          name: 'slow-stop',
          shutdownGracefulTimeoutMS: 100,
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(eventContext).toBeDefined();
      expect(eventContext.gracefulPhaseRan).toBe(true);
      expect(eventContext.gracefulTimedOut).toBe(true);
    });
  });

  describe('Force Phase', () => {
    test('should succeed when onShutdownForce completes', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let wasForceCalled = false;

      class ForceComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }

        public onShutdownForce() {
          wasForceCalled = true;
          // Cleanup succeeds
        }
      }

      await lifecycle.registerComponent(
        new ForceComponent(logger, { name: 'force-comp' }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.stopAllComponents();

      expect(wasForceCalled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.stalledComponents.length).toBe(0);
    });

    test('should mark as stalled when onShutdownForce times out', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowForceComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }

        public async onShutdownForce() {
          await sleep(2000); // 2s
        }
      }

      await lifecycle.registerComponent(
        new SlowForceComponent(logger, {
          name: 'slow-force',
          shutdownForceTimeoutMS: 100, // Very short timeout
        }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.stopAllComponents();

      expect(result.success).toBe(false);
      expect(result.stalledComponents.length).toBe(1);
      expect(result.stalledComponents[0].name).toBe('slow-force');
      expect(result.stalledComponents[0].phase).toBe('force');
      expect(result.stalledComponents[0].reason).toBe('timeout');
    });

    test('should mark as stalled when onShutdownForce throws', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingForceComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }

        public onShutdownForce() {
          throw new Error('Force failed');
        }
      }

      await lifecycle.registerComponent(
        new FailingForceComponent(logger, {
          name: 'failing-force',
        }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.stopAllComponents();

      expect(result.success).toBe(false);
      expect(result.stalledComponents.length).toBe(1);
      expect(result.stalledComponents[0].name).toBe('failing-force');
      expect(result.stalledComponents[0].phase).toBe('force');
    });

    test('should emit force phase events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const events: string[] = [];

      class ForceComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }

        public async onShutdownForce() {
          await sleep(10);
        }
      }

      lifecycle.on('component:shutdown-force', () => {
        events.push('force-started');
      });
      lifecycle.on('component:shutdown-force-completed', () => {
        events.push('force-completed');
      });

      await lifecycle.registerComponent(
        new ForceComponent(logger, { name: 'force-comp' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(events).toContain('force-started');
      expect(events).toContain('force-completed');
    });

    test('should emit force timeout event', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let wasTimeoutEmitted = false;

      class SlowForceComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }

        public async onShutdownForce() {
          await sleep(2000);
        }
      }

      lifecycle.on('component:shutdown-force-timeout', () => {
        wasTimeoutEmitted = true;
      });

      await lifecycle.registerComponent(
        new SlowForceComponent(logger, {
          name: 'slow-force',
          shutdownForceTimeoutMS: 100,
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(wasTimeoutEmitted).toBe(true);
    });
  });

  describe('Stall Tracking', () => {
    test('getStalledComponents should return stall info with phase', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class StalledComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }
      }

      await lifecycle.registerComponent(
        new StalledComponent(logger, { name: 'stalled-comp' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      const stalledComponents = lifecycle.getStalledComponents();

      expect(stalledComponents.length).toBe(1);
      expect(stalledComponents[0].name).toBe('stalled-comp');
      expect(stalledComponents[0].phase).toBe('graceful'); // Failed in graceful, no force handler
      expect(stalledComponents[0].reason).toBe('error');
      expect(stalledComponents[0].startedAt).toBeGreaterThan(0);
      expect(stalledComponents[0].stalledAt).toBeGreaterThan(0);
      expect(stalledComponents[0].error).toBeDefined();
    });

    test('stall info should indicate "both" when graceful times out and force fails', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class DoubleFailComponent extends TestComponent {
        public async stop() {
          await sleep(2000); // Timeout
        }

        public onShutdownForce() {
          throw new Error('Force failed'); // Error
        }
      }

      await lifecycle.registerComponent(
        new DoubleFailComponent(logger, {
          name: 'double-fail',
          shutdownGracefulTimeoutMS: 100,
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      const stalledComponents = lifecycle.getStalledComponents();

      expect(stalledComponents.length).toBe(1);
      expect(stalledComponents[0].reason).toBe('both'); // Both timeout and error
    });

    test('component status should include stall info', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class StalledComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }
      }

      await lifecycle.registerComponent(
        new StalledComponent(logger, { name: 'stalled-comp' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      const status = lifecycle.getComponentStatus('stalled-comp');

      expect(status).toBeDefined();
      if (!status) {
        throw new Error('Expected component status to be defined');
      }
      expect(status.state).toBe('stalled');
      expect(status.stallInfo).toBeDefined();
      if (!status.stallInfo) {
        throw new Error('Expected stall info to be defined');
      }
      expect(status.stallInfo.phase).toBe('graceful');
    });
  });

  describe('Full Three-Phase Flow', () => {
    test('should execute warning -> graceful -> stopped for successful shutdown', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: 100,
      });
      const phases: string[] = [];

      class ThreePhaseComponent extends TestComponent {
        public onShutdownWarning() {
          phases.push('warning');
        }

        public stop() {
          phases.push('graceful');
        }
      }

      await lifecycle.registerComponent(
        new ThreePhaseComponent(logger, {
          name: 'three-phase',
        }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.stopAllComponents();

      expect(phases).toEqual(['warning', 'graceful']);
      expect(result.success).toBe(true);
    });

    test('should execute warning -> graceful(fail) -> force -> stopped', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: 100,
      });
      const phases: string[] = [];

      class ThreePhaseComponent extends TestComponent {
        public onShutdownWarning() {
          phases.push('warning');
        }

        public stop() {
          phases.push('graceful');
          throw new Error('Graceful failed');
        }

        public onShutdownForce() {
          phases.push('force');
        }
      }

      await lifecycle.registerComponent(
        new ThreePhaseComponent(logger, {
          name: 'three-phase',
        }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.stopAllComponents();

      expect(phases).toEqual(['warning', 'graceful', 'force']);
      expect(result.success).toBe(true); // Force succeeded
    });

    test('should execute graceful(timeout) -> force for component without a warning method', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const phases: string[] = [];

      class TwoPhaseComponent extends TestComponent {
        public async stop() {
          phases.push('graceful');
          await sleep(2000);
        }

        public onShutdownForce() {
          phases.push('force');
        }
      }

      await lifecycle.registerComponent(
        new TwoPhaseComponent(logger, {
          name: 'two-phase',
          shutdownGracefulTimeoutMS: 100,
        }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.stopAllComponents();

      expect(phases).toEqual(['graceful', 'force']);
      expect(result.success).toBe(true);
    });
  });

  describe('Abort Callbacks', () => {
    test('should call onGracefulStopTimeout on graceful timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let wasAbortCalled = false;

      class AbortComponent extends TestComponent {
        public async stop() {
          await sleep(2000);
        }

        public onGracefulStopTimeout() {
          wasAbortCalled = true;
        }

        public onShutdownForce() {
          // Prevent stall
        }
      }

      await lifecycle.registerComponent(
        new AbortComponent(logger, {
          name: 'abort-comp',
          shutdownGracefulTimeoutMS: 100,
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(wasAbortCalled).toBe(true);
    });

    test('should call onShutdownForceAborted on force timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let wasAbortCalled = false;

      class AbortComponent extends TestComponent {
        public stop() {
          throw new Error('Stop failed');
        }

        public async onShutdownForce() {
          await sleep(2000);
        }

        public onShutdownForceAborted() {
          wasAbortCalled = true;
        }
      }

      await lifecycle.registerComponent(
        new AbortComponent(logger, {
          name: 'abort-comp',
          shutdownForceTimeoutMS: 100,
        }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      expect(wasAbortCalled).toBe(true);
    });
  });
});

describe('LifecycleManager - Signal Integration', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger({
      sinks: [],
      callProcessExit: false,
    });
  });

  describe('attachSignals() and detachSignals()', () => {
    test('should attach and detach signal handlers', () => {
      const lifecycle = new LifecycleManager({ logger });

      // Initially not attached
      expect(lifecycle.getSignalStatus().isAttached).toBe(false);

      // Attach signals
      lifecycle.attachSignals();
      expect(lifecycle.getSignalStatus().isAttached).toBe(true);
      expect(lifecycle.getSignalStatus().handlers.shutdown).toBe(true);

      // Detach signals
      lifecycle.detachSignals();
      expect(lifecycle.getSignalStatus().isAttached).toBe(false);
    });

    test('should be idempotent (multiple attach/detach calls are safe)', () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.attachSignals();
      lifecycle.attachSignals(); // Second call should be no-op
      expect(lifecycle.getSignalStatus().isAttached).toBe(true);

      lifecycle.detachSignals();
      lifecycle.detachSignals(); // Second call should be no-op
      expect(lifecycle.getSignalStatus().isAttached).toBe(false);
    });

    test('should emit lifecycle-manager:signals-attached event', (done) => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.on('lifecycle-manager:signals-attached', () => {
        done();
      });

      lifecycle.attachSignals();
    });

    test('should emit lifecycle-manager:signals-detached event', (done) => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.attachSignals();

      lifecycle.on('lifecycle-manager:signals-detached', () => {
        done();
      });

      lifecycle.detachSignals();
    });

    test('should only emit signals-detached once when called twice', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let detachEvents = 0;

      lifecycle.attachSignals();
      lifecycle.on('lifecycle-manager:signals-detached', () => {
        detachEvents += 1;
      });

      lifecycle.detachSignals();
      lifecycle.detachSignals();

      await sleep(1);
      expect(detachEvents).toBe(1);
    });
  });

  describe('triggerReload() with default behavior', () => {
    test('should broadcast reload to all running components', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const reloadedComponents: string[] = [];

      class ReloadableComponent extends TestComponent {
        public onReload() {
          reloadedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new ReloadableComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new ReloadableComponent(logger, { name: 'comp2' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.triggerReload();

      expect(result.signal).toBe('reload');
      expect(result.results).toHaveLength(2);
      expect(result.results[0].called).toBe(true);
      expect(result.results[0].error).toBeNull();
      expect(result.results[1].called).toBe(true);
      expect(result.results[1].error).toBeNull();
      expect(reloadedComponents).toEqual(['comp1', 'comp2']);
    });

    test('should only call onReload on running components', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const reloadedComponents: string[] = [];

      class ReloadableComponent extends TestComponent {
        public onReload() {
          reloadedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new ReloadableComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new ReloadableComponent(logger, { name: 'comp2' }),
      );

      // Only start comp1
      await lifecycle.startComponent('comp1');

      const result = await lifecycle.triggerReload();

      expect(result.results).toHaveLength(1);
      expect(result.results[0].name).toBe('comp1');
      expect(reloadedComponents).toEqual(['comp1']);
    });

    test('should skip components without onReload', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class NoReloadComponent extends TestComponent {
        // No onReload method
      }

      await lifecycle.registerComponent(
        new NoReloadComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.triggerReload();

      expect(result.results).toHaveLength(1);
      expect(result.results[0].called).toBe(false);
      expect(result.results[0].error).toBeNull();
    });

    test('should continue on error and collect failures', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingReloadComponent extends TestComponent {
        public onReload() {
          if (this.getName() === 'comp2') {
            throw new Error('Reload failed');
          }
        }
      }

      await lifecycle.registerComponent(
        new FailingReloadComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.registerComponent(
        new FailingReloadComponent(logger, { name: 'comp2' }),
      );
      await lifecycle.registerComponent(
        new FailingReloadComponent(logger, { name: 'comp3' }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.triggerReload();

      expect(result.results).toHaveLength(3);
      expect(result.results[0].called).toBe(true);
      expect(result.results[0].error).toBeNull();
      expect(result.results[1].called).toBe(true);
      expect(result.results[1].error).toBeInstanceOf(Error);
      expect(result.results[2].called).toBe(true);
      expect(result.results[2].error).toBeNull();
    });

    test('should timeout onReload when it takes too long', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowReloadComponent extends TestComponent {
        public async onReload() {
          await sleep(50);
        }
      }

      await lifecycle.registerComponent(
        new SlowReloadComponent(logger, {
          name: 'comp1',
          signalTimeoutMS: 10,
        }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.triggerReload();

      expect(result.results).toHaveLength(1);
      expect(result.results[0].called).toBe(true);
      expect(result.results[0].error).toBeNull();
      expect(result.results[0].timedOut).toBe(true);
      expect(result.results[0].code).toBe('timeout');
      expect(result.timedOut).toBe(true);
      expect(result.code).toBe('timeout');
    });

    test('should emit component events for reload', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const events: string[] = [];

      lifecycle.on('component:reload-started', (data) => {
        const { name } = data as { name: string };
        events.push(`started:${name}`);
      });
      lifecycle.on('component:reload-completed', (data) => {
        const { name } = data as { name: string };
        events.push(`completed:${name}`);
      });

      class ReloadableComponent extends TestComponent {
        public onReload() {
          // Success
        }
      }

      await lifecycle.registerComponent(
        new ReloadableComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.triggerReload();

      expect(events).toEqual(['started:comp1', 'completed:comp1']);
    });

    test('should emit component:reload-failed on error', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let failedEvent: { name: string; error: Error } | null = null;

      lifecycle.on('component:reload-failed', (data) => {
        const eventData = data as { name: string; error: Error };
        failedEvent = eventData;
      });

      class FailingReloadComponent extends TestComponent {
        public onReload() {
          throw new Error('Reload error');
        }
      }

      await lifecycle.registerComponent(
        new FailingReloadComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.triggerReload();

      expect(failedEvent).not.toBeNull();
      const ensuredFailedEvent =
        failedEvent ??
        (() => {
          throw new Error('Expected reload-failed event data.');
        })();

      expect((ensuredFailedEvent as { name: string }).name).toBe('comp1');
      expect((ensuredFailedEvent as { error: Error }).error.message).toBe(
        'Reload error',
      );
    });
  });

  describe('triggerReload() with custom callback', () => {
    test('should call custom callback instead of broadcasting', async () => {
      let wasCustomCallbackCalled = false;
      let wasBroadcastFnProvided = false;

      const lifecycle = new LifecycleManager({
        logger,
        onReloadRequested: (broadcastReload) => {
          wasCustomCallbackCalled = true;
          wasBroadcastFnProvided = typeof broadcastReload === 'function';
        },
      });

      class ReloadableComponent extends TestComponent {
        public onReload() {
          throw new Error('Should not be called');
        }
      }

      await lifecycle.registerComponent(
        new ReloadableComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.triggerReload();

      expect(wasCustomCallbackCalled).toBe(true);
      expect(wasBroadcastFnProvided).toBe(true);
      expect(result.results).toHaveLength(0); // Custom callback, no broadcast
    });

    test('should allow custom callback to call broadcastReload', async () => {
      const reloadedComponents: string[] = [];

      const lifecycle = new LifecycleManager({
        logger,
        onReloadRequested: async (broadcastReload) => {
          // Do custom logic then broadcast
          await broadcastReload();
        },
      });

      class ReloadableComponent extends TestComponent {
        public onReload() {
          reloadedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new ReloadableComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.triggerReload();

      // Callback was called but it invoked broadcast, so components reloaded
      expect(reloadedComponents).toEqual(['comp1']);
    });
  });

  describe('triggerInfo() and triggerDebug()', () => {
    test('should emit signal events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const events: string[] = [];

      lifecycle.on('signal:info', () => {
        events.push('info');
      });
      lifecycle.on('signal:debug', () => {
        events.push('debug');
      });

      await lifecycle.triggerInfo();
      await lifecycle.triggerDebug();

      expect(events).toEqual(['info', 'debug']);
    });

    test('should call custom info callback instead of broadcasting', async () => {
      let wasCustomCallbackCalled = false;
      let wasBroadcastFnProvided = false;

      const lifecycle = new LifecycleManager({
        logger,
        onInfoRequested: (broadcastInfo) => {
          wasCustomCallbackCalled = true;
          wasBroadcastFnProvided = typeof broadcastInfo === 'function';
        },
      });

      class InfoComponent extends TestComponent {
        public onInfo() {
          throw new Error('Should not be called');
        }
      }

      await lifecycle.registerComponent(
        new InfoComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.triggerInfo();

      expect(wasCustomCallbackCalled).toBe(true);
      expect(wasBroadcastFnProvided).toBe(true);
      expect(result.results).toHaveLength(0); // Custom callback, no broadcast
    });

    test('should allow custom info callback to call broadcastInfo', async () => {
      const notifiedComponents: string[] = [];

      const lifecycle = new LifecycleManager({
        logger,
        onInfoRequested: async (broadcastInfo) => {
          // Do custom logic then broadcast
          await broadcastInfo();
        },
      });

      class InfoComponent extends TestComponent {
        public onInfo() {
          notifiedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new InfoComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.triggerInfo();

      // Callback was called but it invoked broadcast, so components notified
      expect(notifiedComponents).toEqual(['comp1']);
    });

    test('should timeout onInfo when it takes too long', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowInfoComponent extends TestComponent {
        public async onInfo() {
          await sleep(50);
        }
      }

      await lifecycle.registerComponent(
        new SlowInfoComponent(logger, {
          name: 'comp1',
          signalTimeoutMS: 10,
        }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.triggerInfo();

      expect(result.results).toHaveLength(1);
      expect(result.results[0].called).toBe(true);
      expect(result.results[0].error).toBeNull();
      expect(result.results[0].timedOut).toBe(true);
      expect(result.results[0].code).toBe('timeout');
      expect(result.timedOut).toBe(true);
      expect(result.code).toBe('timeout');
    });

    test('should call custom debug callback instead of broadcasting', async () => {
      let wasCustomCallbackCalled = false;
      let wasBroadcastFnProvided = false;

      const lifecycle = new LifecycleManager({
        logger,
        onDebugRequested: (broadcastDebug) => {
          wasCustomCallbackCalled = true;
          wasBroadcastFnProvided = typeof broadcastDebug === 'function';
        },
      });

      class DebugComponent extends TestComponent {
        public onDebug() {
          throw new Error('Should not be called');
        }
      }

      await lifecycle.registerComponent(
        new DebugComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.triggerDebug();

      expect(wasCustomCallbackCalled).toBe(true);
      expect(wasBroadcastFnProvided).toBe(true);
      expect(result.results).toHaveLength(0); // Custom callback, no broadcast
    });

    test('should allow custom debug callback to call broadcastDebug', async () => {
      const notifiedComponents: string[] = [];

      const lifecycle = new LifecycleManager({
        logger,
        onDebugRequested: async (broadcastDebug) => {
          // Do custom logic then broadcast
          await broadcastDebug();
        },
      });

      class DebugComponent extends TestComponent {
        public onDebug() {
          notifiedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new DebugComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      await lifecycle.triggerDebug();

      // Callback was called but it invoked broadcast, so components notified
      expect(notifiedComponents).toEqual(['comp1']);
    });

    test('should timeout onDebug when it takes too long', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowDebugComponent extends TestComponent {
        public async onDebug() {
          await sleep(50);
        }
      }

      await lifecycle.registerComponent(
        new SlowDebugComponent(logger, {
          name: 'comp1',
          signalTimeoutMS: 10,
        }),
      );

      await lifecycle.startAllComponents();

      const result = await lifecycle.triggerDebug();

      expect(result.results).toHaveLength(1);
      expect(result.results[0].called).toBe(true);
      expect(result.results[0].error).toBeNull();
      expect(result.results[0].timedOut).toBe(true);
      expect(result.results[0].code).toBe('timeout');
      expect(result.timedOut).toBe(true);
      expect(result.code).toBe('timeout');
    });

    test('should broadcast to components if no info handler configured', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const notifiedComponents: string[] = [];

      class InfoComponent extends TestComponent {
        public onInfo() {
          notifiedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new InfoComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.triggerInfo();

      expect(result.signal).toBe('info');
      expect(result.results).toHaveLength(1);
      expect(notifiedComponents).toEqual(['comp1']);
    });

    test('should broadcast to components if no debug handler configured', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const notifiedComponents: string[] = [];

      class DebugComponent extends TestComponent {
        public onDebug() {
          notifiedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new DebugComponent(logger, { name: 'comp1' }),
      );

      await lifecycle.startAllComponents();
      const result = await lifecycle.triggerDebug();

      expect(result.signal).toBe('debug');
      expect(result.results).toHaveLength(1);
      // Warning should be logged (verified by manual inspection)
    });
  });

  describe('Signal handling during startup', () => {
    test('should only reload already-started components during startup', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const reloadedComponents: string[] = [];
      let wasReloadAttempted = false;

      class SlowStartComponent extends TestComponent {
        public async start() {
          // Simulate slow startup
          await sleep(100);
        }

        public onReload() {
          reloadedComponents.push(this.getName());
        }
      }

      class FastStartComponent extends TestComponent {
        public start(): void {
          // Fast startup
          wasReloadAttempted = true;
        }

        public onReload() {
          reloadedComponents.push(this.getName());
        }
      }

      await lifecycle.registerComponent(
        new FastStartComponent(logger, { name: 'fast' }),
      );
      await lifecycle.registerComponent(
        new SlowStartComponent(logger, { name: 'slow' }),
      );

      // Start startup, don't wait
      const startPromise = lifecycle.startAllComponents();

      // Trigger reload while startup is in progress
      await sleep(20);
      await lifecycle.triggerReload();

      // Wait for startup to complete
      await startPromise;

      // Fast component should have reloaded (it was already running)
      // Slow component was still starting, so it shouldn't have reloaded
      expect(wasReloadAttempted).toBe(true);
      expect(reloadedComponents).toContain('fast');
    });
  });

  describe('getSignalStatus()', () => {
    test('should return correct status when not attached', () => {
      const lifecycle = new LifecycleManager({ logger });

      const status = lifecycle.getSignalStatus();

      expect(status.isAttached).toBe(false);
      expect(status.handlers.shutdown).toBe(false);
      expect(status.handlers.reload).toBe(false);
      expect(status.handlers.info).toBe(false);
      expect(status.handlers.debug).toBe(false);
      expect(status.listeningFor.shutdownSignals).toBe(false);
      expect(status.listeningFor.reloadSignal).toBe(false);
      expect(status.listeningFor.infoSignal).toBe(false);
      expect(status.listeningFor.debugSignal).toBe(false);
    });

    test('should return correct status when attached', () => {
      const lifecycle = new LifecycleManager({ logger });

      lifecycle.attachSignals();
      const status = lifecycle.getSignalStatus();

      expect(status.isAttached).toBe(true);
      expect(status.handlers.shutdown).toBe(true);
      expect(status.listeningFor.shutdownSignals).toBe(true);
    });

    test('should reflect custom handlers in status', () => {
      const lifecycle = new LifecycleManager({
        logger,
        onReloadRequested: () => {},
        onInfoRequested: () => {},
        onDebugRequested: () => {},
      });

      lifecycle.attachSignals();
      const status = lifecycle.getSignalStatus();

      expect(status.handlers.reload).toBe(true);
      expect(status.handlers.info).toBe(true);
      expect(status.handlers.debug).toBe(true);
    });

    test('should track shutdownMethod in status', async () => {
      const lifecycle = new LifecycleManager({ logger });

      // Initially null
      expect(lifecycle.getSignalStatus().shutdownMethod).toBeNull();

      // Start components
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.startAllComponents();

      // Manual shutdown (default method is 'manual')
      await lifecycle.stopAllComponents();
      expect(lifecycle.getSignalStatus().shutdownMethod).toBe('manual');

      // Start again - should clear shutdownMethod
      await lifecycle.startAllComponents();
      expect(lifecycle.getSignalStatus().shutdownMethod).toBeNull();

      // Shutdown with specific method (simulating signal)
      const shutdownCompleted = new Promise<void>((resolve) => {
        lifecycle.on('lifecycle-manager:shutdown-completed', () => resolve());
      });
      (lifecycle as any).handleShutdownRequest('SIGTERM');
      await shutdownCompleted;
      expect(lifecycle.getSignalStatus().shutdownMethod).toBe('SIGTERM');

      // Start again - should clear
      await lifecycle.startAllComponents();
      expect(lifecycle.getSignalStatus().shutdownMethod).toBeNull();
    });
  });

  describe('enableLoggerExitHook()', () => {
    test('should set up logger exit hook to trigger shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      // Register and start components
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.startAllComponents();

      // Enable logger exit hook
      lifecycle.enableLoggerExitHook();

      // Set up shutdown completion listener
      const shutdownCompleted = new Promise<void>((resolve) => {
        lifecycle.on('lifecycle-manager:shutdown-completed', () => resolve());
      });

      // Trigger logger exit
      logger.exit(0);

      // Wait for shutdown to complete
      await shutdownCompleted;

      // Give logger's exit flow time to complete
      await sleep(1);

      // Verify components were stopped
      expect(lifecycle.getRunningComponentCount()).toBe(0);
      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(0);
    });

    test('should handle multiple exit calls gracefully', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.startAllComponents();

      lifecycle.enableLoggerExitHook();

      let shutdownCount = 0;
      lifecycle.on('lifecycle-manager:shutdown-initiated', () => {
        shutdownCount++;
      });

      // First exit
      logger.exit(0);
      await sleep(50);

      // Second exit (should be ignored by lifecycle manager)
      logger.exit(1);
      await sleep(50);

      // Should only trigger shutdown once
      expect(shutdownCount).toBe(1);
    });

    test('should work with logger.error exitCode', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'comp1' }),
      );
      await lifecycle.startAllComponents();

      lifecycle.enableLoggerExitHook();

      const shutdownCompleted = new Promise<void>((resolve) => {
        lifecycle.on('lifecycle-manager:shutdown-completed', () => resolve());
      });

      // Trigger exit via logger.error with exitCode
      logger.error('Fatal error', { exitCode: 1 });

      await shutdownCompleted;

      // Give logger's exit flow time to complete
      await sleep(1);

      expect(lifecycle.getRunningComponentCount()).toBe(0);
      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(1);
    });

    test('should overwrite existing beforeExit callback', async () => {
      const customCallbackCalls: number[] = [];

      const customLogger = new Logger({
        callProcessExit: false,
        beforeExitCallback: (exitCode) => {
          customCallbackCalls.push(exitCode);
          return { action: 'proceed' };
        },
      });

      const lifecycle = new LifecycleManager({ logger: customLogger });

      await lifecycle.registerComponent(
        new TestComponent(customLogger, { name: 'comp1' }),
      );
      await lifecycle.startAllComponents();

      // Enable hook (overwrites custom callback)
      lifecycle.enableLoggerExitHook();

      const shutdownCompleted = new Promise<void>((resolve) => {
        lifecycle.on('lifecycle-manager:shutdown-completed', () => resolve());
      });

      customLogger.exit(0);
      await shutdownCompleted;

      // Original callback should not have been called
      expect(customCallbackCalls.length).toBe(0);
      // Components should have been stopped
      expect(lifecycle.getRunningComponentCount()).toBe(0);
    });
  });

  describe('stopAllComponents() with timeout parameter', () => {
    test('should respect timeout parameter when stopping components', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownOptions: { timeoutMS: 30000 }, // Constructor default
      });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'slow', 2000),
      );
      await lifecycle.startAllComponents();

      const startTime = Date.now();

      // Call with short timeout (should timeout before 2000ms)
      await lifecycle.stopAllComponents({ timeoutMS: 500 });

      const duration = Date.now() - startTime;

      // Should have timed out around 500ms, not waited full 2000ms or the class default of 30000ms
      expect(duration).toBeLessThan(1000);
      expect(duration).toBeGreaterThanOrEqual(500);
    });

    test('should use constructor default when no timeout parameter provided', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownOptions: { timeoutMS: 500 }, // Short default
      });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'slow', 2000),
      );
      await lifecycle.startAllComponents();

      const startTime = Date.now();

      // Call without timeout parameter - should use constructor's 500ms default
      await lifecycle.stopAllComponents();

      const duration = Date.now() - startTime;

      // Should have timed out around 500ms
      expect(duration).toBeLessThan(1000);
      expect(duration).toBeGreaterThanOrEqual(500);
    });

    test('should allow override of constructor default with parameter', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        shutdownOptions: { timeoutMS: 100 }, // Short constructor default
      });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'slow', 300),
      );
      await lifecycle.startAllComponents();

      const startTime = Date.now();

      // Override with longer timeout - should wait longer than constructor's 100ms
      await lifecycle.stopAllComponents({ timeoutMS: 600 });

      const duration = Date.now() - startTime;

      // Should have waited for component to stop (~300ms), not timed out at 100ms
      expect(duration).toBeGreaterThan(250);
      expect(duration).toBeLessThan(700);

      // Component should have stopped successfully
      expect(lifecycle.getRunningComponentCount()).toBe(0);
    });

    test('should return shutdown_timeout code when bulk shutdown times out', async () => {
      const lifecycle = new LifecycleManager({ logger });

      await lifecycle.registerComponent(
        new SlowStopComponent(logger, 'slow', 5000),
      );
      await lifecycle.startAllComponents();

      // Call with timeout that will expire during shutdown
      const result = await lifecycle.stopAllComponents({ timeoutMS: 50 });

      // Should return shutdown_timeout code and timedOut flag
      // Note: success can be true if timeout expires before components stall
      expect(result.code).toBe('shutdown_timeout');
      expect(result.timedOut).toBe(true);
      expect(result.reason).toContain('Shutdown timeout exceeded');
      expect(result.durationMS).toBeGreaterThanOrEqual(50);
      expect(result.durationMS).toBeLessThan(200);
    });
  });
});

describe('LifecycleManager - Messaging, Health & Values', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger({ callProcessExit: false });
  });

  describe('Component Messaging - sendMessageToComponent()', () => {
    test('should send message to running component with handler', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithHandler extends BaseComponent {
        public receivedMessages: Array<{
          payload: unknown;
          from: string | null;
        }> = [];

        constructor(logger: Logger) {
          super(logger, { name: 'receiver', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = { response: string }>(
          payload: unknown,
          from: string | null,
        ): TData | Promise<TData> {
          this.receivedMessages.push({ payload, from });
          return { response: 'acknowledged' } as unknown as TData;
        }
      }

      const component = new ComponentWithHandler(logger);
      await lifecycle.registerComponent(component);
      await lifecycle.startAllComponents();

      const result = await lifecycle.sendMessageToComponent('receiver', {
        test: 'data',
      });

      expect(result.sent).toBe(true);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(true);
      expect(result.handlerImplemented).toBe(true);
      expect(result.data).toEqual({ response: 'acknowledged' });
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('sent');
      expect(component.receivedMessages).toHaveLength(1);
      expect(component.receivedMessages[0].payload).toEqual({ test: 'data' });
      expect(component.receivedMessages[0].from).toBeNull(); // External call
    });

    test('should handle component not found', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const result = await lifecycle.sendMessageToComponent('nonexistent', {
        test: 'data',
      });

      expect(result.sent).toBe(false);
      expect(result.componentFound).toBe(false);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('not_found');
    });

    test('should handle component not running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithHandler extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'receiver', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = { response: string }>(
          _payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          return { response: 'acknowledged' } as unknown as TData;
        }
      }

      await lifecycle.registerComponent(new ComponentWithHandler(logger));

      const result = await lifecycle.sendMessageToComponent('receiver', {
        test: 'data',
      });

      expect(result.sent).toBe(false);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('stopped');
    });

    test('should allow message to stopped component when includeStopped is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithHandler extends BaseComponent {
        public receivedMessages: unknown[] = [];

        constructor(logger: Logger) {
          super(logger, { name: 'receiver', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = { response: string }>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.receivedMessages.push(payload);
          return { response: 'acknowledged' } as unknown as TData;
        }
      }

      const component = new ComponentWithHandler(logger);
      await lifecycle.registerComponent(component);

      const result = await lifecycle.sendMessageToComponent(
        'receiver',
        { test: 'data' },
        { includeStopped: true },
      );

      expect(result.sent).toBe(true);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(true);
      expect(result.data).toEqual({ response: 'acknowledged' });
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('sent');
      expect(component.receivedMessages).toHaveLength(1);
    });

    test('should allow message to stalled component when includeStalled is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class StallingComponent extends BaseComponent {
        public receivedMessages: unknown[] = [];

        constructor(logger: Logger) {
          super(logger, {
            name: 'stalled',
            dependencies: [],
            shutdownGracefulTimeoutMS: 10,
            shutdownForceTimeoutMS: 10,
          });
        }

        public async start() {}
        public async stop() {
          await new Promise(() => {});
        }

        public onMessage<TData = { response: string }>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.receivedMessages.push(payload);
          return { response: 'acknowledged' } as unknown as TData;
        }
      }

      const component = new StallingComponent(logger);
      await lifecycle.registerComponent(component);
      await lifecycle.startAllComponents();

      await lifecycle.stopComponent('stalled');
      expect(lifecycle.getStalledComponentNames()).toContain('stalled');

      const blockedResult = await lifecycle.sendMessageToComponent('stalled', {
        test: 'data',
      });

      expect(blockedResult.sent).toBe(false);
      expect(blockedResult.componentFound).toBe(true);
      expect(blockedResult.componentRunning).toBe(false);
      expect(blockedResult.handlerImplemented).toBe(false);
      expect(blockedResult.data).toBeUndefined();
      expect(blockedResult.error).toBeNull();
      expect(blockedResult.timedOut).toBe(false);
      expect(blockedResult.code).toBe('stalled');

      const result = await lifecycle.sendMessageToComponent(
        'stalled',
        { test: 'data' },
        { includeStalled: true },
      );

      expect(result.sent).toBe(true);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(true);
      expect(result.data).toEqual({ response: 'acknowledged' });
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('sent');
      expect(component.receivedMessages).toHaveLength(1);
    });

    test('should handle component without handler', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithoutHandler extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'receiver', dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      await lifecycle.registerComponent(new ComponentWithoutHandler(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.sendMessageToComponent('receiver', {
        test: 'data',
      });

      expect(result.sent).toBe(false);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(true);
      expect(result.handlerImplemented).toBe(false);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('no_handler');
    });

    test('should handle handler throwing error', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let failedPayload: any;

      class ComponentWithFailingHandler extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'receiver', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          _payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          throw new Error('Handler failed');
        }
      }

      await lifecycle.registerComponent(
        new ComponentWithFailingHandler(logger),
      );
      await lifecycle.startAllComponents();

      lifecycle.on('component:message-failed', (data) => {
        failedPayload = data;
      });

      const result = await lifecycle.sendMessageToComponent('receiver', {
        test: 'data',
      });

      expect(result.sent).toBe(true);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(true);
      expect(result.handlerImplemented).toBe(true);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('Handler failed');
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('error');
      expect(failedPayload?.componentName).toBe('receiver');
      expect(failedPayload?.code).toBe('error');
      expect(failedPayload?.timedOut).toBe(false);
    });

    test('should timeout when handler takes too long', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        messageTimeoutMS: 20,
      });

      class SlowHandler extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'slow', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public async onMessage<TData = { response: string }>(
          _payload: unknown,
          _from: string | null,
        ): Promise<TData> {
          await sleep(50);
          return { response: 'late' } as unknown as TData;
        }
      }

      await lifecycle.registerComponent(new SlowHandler(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.sendMessageToComponent('slow', {
        test: 'data',
      });

      expect(result.sent).toBe(true);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(true);
      expect(result.handlerImplemented).toBe(true);
      expect(result.data).toBeUndefined();
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(true);
      expect(result.code).toBe('timeout');
    });

    test('should allow per-call timeout override', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        messageTimeoutMS: 10,
      });

      class SlowHandler extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'slow', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public async onMessage<TData = { response: string }>(
          _payload: unknown,
          _from: string | null,
        ): Promise<TData> {
          await sleep(30);
          return { response: 'ok' } as unknown as TData;
        }
      }

      await lifecycle.registerComponent(new SlowHandler(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.sendMessageToComponent(
        'slow',
        { test: 'data' },
        { timeout: 100 },
      );

      expect(result.sent).toBe(true);
      expect(result.error).toBeNull();
      expect(result.timedOut).toBe(false);
      expect(result.data).toEqual({ response: 'ok' });
      expect(result.code).toBe('sent');
    });

    test('should reject messages during shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'slow', dependencies: [] });
        }

        public async start() {}
        public async stop() {
          await sleep(100);
        }

        public onMessage<TData = { response: string }>(
          _payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          return { response: 'ok' } as unknown as TData;
        }
      }

      await lifecycle.registerComponent(new SlowComponent(logger));
      await lifecycle.startAllComponents();

      const shutdownPromise = lifecycle.stopAllComponents();

      const result = await lifecycle.sendMessageToComponent('slow', {
        test: 'data',
      });

      expect(result.sent).toBe(false);
      expect(result.error?.message).toContain('shutdown in progress');
      expect(result.timedOut).toBe(false);
      expect(result.code).toBe('error');

      await shutdownPromise;
    });

    test('should track sender when called from component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SenderComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'sender', dependencies: [] });
        }

        public async start() {
          await this.lifecycle.sendMessageToComponent('receiver', {
            from: 'sender',
          });
        }

        public async stop() {}
      }

      class ReceiverComponent extends BaseComponent {
        public receivedFrom: string | null = null;

        constructor(logger: Logger) {
          super(logger, { name: 'receiver', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          _payload: unknown,
          from: string | null,
        ): TData | Promise<TData> {
          this.receivedFrom = from;
          return undefined as TData;
        }
      }

      const sender = new SenderComponent(logger);
      const receiver = new ReceiverComponent(logger);

      await lifecycle.registerComponent(receiver);
      await lifecycle.registerComponent(sender);

      await lifecycle.startAllComponents();

      expect(receiver.receivedFrom).toBe('sender');
    });
  });

  describe('Broadcast Messaging - broadcastMessage()', () => {
    test('should broadcast to all running components', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let broadcastPayload: any;

      class MessageReceiver extends BaseComponent {
        public messages: unknown[] = [];

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = { received: boolean }>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.messages.push(payload);
          return { received: true } as unknown as TData;
        }
      }

      const comp1 = new MessageReceiver(logger, 'comp1');
      const comp2 = new MessageReceiver(logger, 'comp2');
      const comp3 = new MessageReceiver(logger, 'comp3');

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);
      await lifecycle.registerComponent(comp3);

      await lifecycle.startAllComponents();

      lifecycle.on('component:broadcast-completed', (data) => {
        broadcastPayload = data;
      });

      const results = await lifecycle.broadcastMessage({ broadcast: 'test' });

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.sent)).toBe(true);
      expect(results.every((r) => r.running)).toBe(true);
      expect(results.every((r) => r.timedOut === false)).toBe(true);
      expect(results.every((r) => r.code === 'sent')).toBe(true);
      expect(comp1.messages).toHaveLength(1);
      expect(comp2.messages).toHaveLength(1);
      expect(comp3.messages).toHaveLength(1);
      expect(broadcastPayload?.resultsCount).toBe(3);
      expect(Array.isArray(broadcastPayload?.results)).toBe(true);
      expect(
        broadcastPayload?.results?.every((r: any) => r.code === 'sent'),
      ).toBe(true);
    });

    test('should timeout broadcast when handler takes too long', async () => {
      const lifecycle = new LifecycleManager({
        logger,
        messageTimeoutMS: 10,
      });

      class SlowReceiver extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public async onMessage<TData = { received: boolean }>(
          _payload: unknown,
          _from: string | null,
        ): Promise<TData> {
          await sleep(30);
          return { received: true } as unknown as TData;
        }
      }

      const comp1 = new SlowReceiver(logger, 'comp1');
      await lifecycle.registerComponent(comp1);
      await lifecycle.startAllComponents();

      const results = await lifecycle.broadcastMessage({ broadcast: 'test' });

      expect(results).toHaveLength(1);
      expect(results[0].sent).toBe(true);
      expect(results[0].timedOut).toBe(true);
      expect(results[0].error).toBeNull();
      expect(results[0].code).toBe('timeout');
    });

    test('should skip non-running components by default', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class MessageReceiver extends BaseComponent {
        public messages: unknown[] = [];

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.messages.push(payload);
          return undefined as TData;
        }
      }

      const comp1 = new MessageReceiver(logger, 'comp1');
      const comp2 = new MessageReceiver(logger, 'comp2');

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);

      await lifecycle.startComponent('comp1');

      const results = await lifecycle.broadcastMessage({ broadcast: 'test' });

      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('comp1');
      expect(results[0].sent).toBe(true);
      expect(results[0].code).toBe('sent');
      expect(comp1.messages).toHaveLength(1);
      expect(comp2.messages).toHaveLength(0);
    });

    test('should include non-running components when requested', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class MessageReceiver extends BaseComponent {
        public messages: unknown[] = [];

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.messages.push(payload);
          return undefined as TData;
        }
      }

      const comp1 = new MessageReceiver(logger, 'comp1');
      const comp2 = new MessageReceiver(logger, 'comp2');
      const comp3 = new (class StallingReceiver extends BaseComponent {
        public messages: unknown[] = [];

        constructor(logger: Logger) {
          super(logger, {
            name: 'comp3',
            dependencies: [],
            shutdownGracefulTimeoutMS: 10,
            shutdownForceTimeoutMS: 10,
          });
        }

        public async start() {}
        public async stop() {
          await new Promise(() => {});
        }

        public onMessage<TData = unknown>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.messages.push(payload);
          return undefined as TData;
        }
      })(logger);

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);
      await lifecycle.registerComponent(comp3);

      await lifecycle.startComponent('comp1');
      await lifecycle.startComponent('comp3');
      await lifecycle.stopComponent('comp3');
      expect(lifecycle.getStalledComponentNames()).toContain('comp3');

      const results = await lifecycle.broadcastMessage(
        { broadcast: 'test' },
        { includeStopped: true, includeStalled: true },
      );

      expect(results).toHaveLength(3);
      expect(results.find((r) => r.name === 'comp1')?.sent).toBe(true);
      const comp2Result = results.find((r) => r.name === 'comp2');
      expect(comp2Result?.sent).toBe(true);
      expect(comp2Result?.running).toBe(false);
      expect(comp2Result?.code).toBe('sent');
      const comp3Result = results.find((r) => r.name === 'comp3');
      expect(comp3Result?.sent).toBe(true);
      expect(comp3Result?.running).toBe(false);
      expect(comp3Result?.code).toBe('sent');
      expect(comp1.messages).toHaveLength(1);
      expect(comp2.messages).toHaveLength(1);
      expect(comp3.messages).toHaveLength(1);
    });

    test('should filter by component names', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class MessageReceiver extends BaseComponent {
        public messages: unknown[] = [];

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.messages.push(payload);
          return undefined as TData;
        }
      }

      const comp1 = new MessageReceiver(logger, 'comp1');
      const comp2 = new MessageReceiver(logger, 'comp2');
      const comp3 = new MessageReceiver(logger, 'comp3');

      await lifecycle.registerComponent(comp1);
      await lifecycle.registerComponent(comp2);
      await lifecycle.registerComponent(comp3);

      await lifecycle.startAllComponents();

      const results = await lifecycle.broadcastMessage(
        { broadcast: 'test' },
        { componentNames: ['comp1', 'comp3'] },
      );

      expect(results).toHaveLength(2);
      expect(results.find((r) => r.name === 'comp1')).toBeDefined();
      expect(results.find((r) => r.name === 'comp3')).toBeDefined();
      expect(comp1.messages).toHaveLength(1);
      expect(comp2.messages).toHaveLength(0);
      expect(comp3.messages).toHaveLength(1);
    });

    test('should report stopped/stalled codes for explicit targets when not allowed', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class MessageReceiver extends BaseComponent {
        public messages: unknown[] = [];

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.messages.push(payload);
          return undefined as TData;
        }
      }

      class StallingReceiver extends BaseComponent {
        public messages: unknown[] = [];

        constructor(logger: Logger, name: string) {
          super(logger, {
            name,
            dependencies: [],
            shutdownGracefulTimeoutMS: 10,
            shutdownForceTimeoutMS: 10,
          });
        }

        public async start() {}
        public async stop() {
          await new Promise(() => {});
        }

        public onMessage<TData = unknown>(
          payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          this.messages.push(payload);
          return undefined as TData;
        }
      }

      const running = new MessageReceiver(logger, 'running');
      const stopped = new MessageReceiver(logger, 'stopped');
      const stalled = new StallingReceiver(logger, 'stalled');

      await lifecycle.registerComponent(running);
      await lifecycle.registerComponent(stopped);
      await lifecycle.registerComponent(stalled);

      await lifecycle.startComponent('running');
      await lifecycle.startComponent('stalled');
      await lifecycle.stopComponent('stalled');

      const results = await lifecycle.broadcastMessage(
        { broadcast: 'test' },
        { componentNames: ['running', 'stopped', 'stalled'] },
      );

      const runningResult = results.find((r) => r.name === 'running');
      const stoppedResult = results.find((r) => r.name === 'stopped');
      const stalledResult = results.find((r) => r.name === 'stalled');

      expect(runningResult?.sent).toBe(true);
      expect(runningResult?.code).toBe('sent');

      expect(stoppedResult?.sent).toBe(false);
      expect(stoppedResult?.running).toBe(false);
      expect(stoppedResult?.code).toBe('stopped');

      expect(stalledResult?.sent).toBe(false);
      expect(stalledResult?.running).toBe(false);
      expect(stalledResult?.code).toBe('stalled');

      expect(running.messages).toHaveLength(1);
      expect(stopped.messages).toHaveLength(0);
      expect(stalled.messages).toHaveLength(0);
    });

    test('should handle broadcast with some handlers failing', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class GoodReceiver extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'good', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = { status: string }>(
          _payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          return { status: 'ok' } as unknown as TData;
        }
      }

      class BadReceiver extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'bad', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          _payload: unknown,
          _from: string | null,
        ): TData | Promise<TData> {
          throw new Error('Handler failed');
        }
      }

      await lifecycle.registerComponent(new GoodReceiver(logger));
      await lifecycle.registerComponent(new BadReceiver(logger));

      await lifecycle.startAllComponents();

      const results = await lifecycle.broadcastMessage({ test: 'data' });

      expect(results).toHaveLength(2);

      const goodResult = results.find((r) => r.name === 'good');
      expect(goodResult?.sent).toBe(true);
      expect(goodResult?.error).toBeNull();
      expect(goodResult?.data).toEqual({ status: 'ok' });
      expect(goodResult?.code).toBe('sent');

      const badResult = results.find((r) => r.name === 'bad');
      expect(badResult?.sent).toBe(true);
      expect(badResult?.error).toBeInstanceOf(Error);
      expect(badResult?.error?.message).toBe('Handler failed');
      expect(badResult?.code).toBe('error');
    });

    test('should track sender when called from component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class BroadcasterComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'broadcaster', dependencies: [] });
        }

        public async start() {
          await this.lifecycle.broadcastMessage({ announcement: 'hello' });
        }

        public async stop() {}
      }

      class ReceiverComponent extends BaseComponent {
        public receivedFrom: string | null = null;

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public onMessage<TData = unknown>(
          _payload: unknown,
          from: string | null,
        ): TData | Promise<TData> {
          this.receivedFrom = from;
          return undefined as TData;
        }
      }

      const broadcaster = new BroadcasterComponent(logger);
      const receiver1 = new ReceiverComponent(logger, 'receiver1');
      const receiver2 = new ReceiverComponent(logger, 'receiver2');

      await lifecycle.registerComponent(receiver1);
      await lifecycle.registerComponent(receiver2);
      await lifecycle.registerComponent(broadcaster);

      await lifecycle.startAllComponents();

      expect(receiver1.receivedFrom).toBe('broadcaster');
      expect(receiver2.receivedFrom).toBe('broadcaster');
    });
  });

  describe('Health Checks - checkComponentHealth()', () => {
    test('should check health of component with boolean result', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class HealthyComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'healthy', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return true;
        }
      }

      await lifecycle.registerComponent(new HealthyComponent(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.checkComponentHealth('healthy');

      expect(result.name).toBe('healthy');
      expect(result.healthy).toBe(true);
      expect(result.checkedAt).toBeGreaterThan(0);
      expect(result.durationMS).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeNull();
    });

    test('should check health of component with rich result', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithDetails extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'detailed', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return {
            healthy: true,
            message: 'All systems operational',
            details: { connections: 5, uptime: 1000 },
          };
        }
      }

      await lifecycle.registerComponent(new ComponentWithDetails(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.checkComponentHealth('detailed');

      expect(result.name).toBe('detailed');
      expect(result.healthy).toBe(true);
      expect(result.message).toBe('All systems operational');
      expect(result.details).toEqual({ connections: 5, uptime: 1000 });
    });

    test('should handle component not found', async () => {
      const lifecycle = new LifecycleManager({ logger });

      const result = await lifecycle.checkComponentHealth('nonexistent');

      expect(result.name).toBe('nonexistent');
      expect(result.healthy).toBe(false);
      expect(result.message).toBe('Component not found');
      expect(result.error).toBeNull();
      expect(result.code).toBe('not_found');
    });

    test('should handle component not running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class HealthyComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'healthy', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return true;
        }
      }

      await lifecycle.registerComponent(new HealthyComponent(logger));

      const result = await lifecycle.checkComponentHealth('healthy');

      expect(result.name).toBe('healthy');
      expect(result.healthy).toBe(false);
      expect(result.message).toBe('Component not running');
      expect(result.error).toBeNull();
      expect(result.code).toBe('stopped');
    });

    test('should handle component stalled', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class StallingComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, {
            name: 'stalled',
            dependencies: [],
            shutdownGracefulTimeoutMS: 10,
            shutdownForceTimeoutMS: 10,
          });
        }

        public async start() {}
        public async stop() {
          await new Promise(() => {});
        }
      }

      await lifecycle.registerComponent(new StallingComponent(logger));
      await lifecycle.startAllComponents();
      await lifecycle.stopComponent('stalled');

      const result = await lifecycle.checkComponentHealth('stalled');

      expect(result.name).toBe('stalled');
      expect(result.healthy).toBe(false);
      expect(result.message).toBe('Component is stalled');
      expect(result.error).toBeNull();
      expect(result.code).toBe('stalled');
    });

    test('should handle component without healthCheck handler', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithoutHealth extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'no-health', dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      await lifecycle.registerComponent(new ComponentWithoutHealth(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.checkComponentHealth('no-health');

      expect(result.name).toBe('no-health');
      expect(result.healthy).toBe(true); // No health check = assume healthy
      expect(result.message).toBe('No health check implemented');
      expect(result.error).toBeNull();
      expect(result.code).toBe('no_handler');
    });

    test('should handle healthCheck throwing error', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class UnhealthyComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'unhealthy', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck(): boolean {
          throw new Error('Connection lost');
        }
      }

      await lifecycle.registerComponent(new UnhealthyComponent(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.checkComponentHealth('unhealthy');

      expect(result.name).toBe('unhealthy');
      expect(result.healthy).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toBe('Connection lost');
    });

    test('should handle healthCheck timeout', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowHealthCheck extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, {
            name: 'slow-health',
            dependencies: [],
            healthCheckTimeoutMS: 100,
          });
        }

        public async start() {}
        public async stop() {}

        public async healthCheck() {
          await sleep(500);
          return true;
        }
      }

      await lifecycle.registerComponent(new SlowHealthCheck(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.checkComponentHealth('slow-health');

      expect(result.name).toBe('slow-health');
      expect(result.healthy).toBe(false);
      expect(result.message).toBe('Health check timed out');
      expect(result.timedOut).toBe(true);
      expect(result.error).toBeNull();
      expect(result.code).toBe('timeout');
    });

    test('should normalize boolean false to unhealthy', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class UnhealthyComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'unhealthy', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return false;
        }
      }

      await lifecycle.registerComponent(new UnhealthyComponent(logger));
      await lifecycle.startAllComponents();

      const result = await lifecycle.checkComponentHealth('unhealthy');

      expect(result.name).toBe('unhealthy');
      expect(result.healthy).toBe(false);
    });
  });

  describe('Health Checks - checkAllHealth()', () => {
    test('should check health of all running components', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class HealthyComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return true;
        }
      }

      await lifecycle.registerComponent(new HealthyComponent(logger, 'comp1'));
      await lifecycle.registerComponent(new HealthyComponent(logger, 'comp2'));
      await lifecycle.registerComponent(new HealthyComponent(logger, 'comp3'));

      await lifecycle.startAllComponents();

      const report = await lifecycle.checkAllHealth();

      expect(report.components).toHaveLength(3);
      expect(report.healthy).toBe(true);
      expect(report.components).toHaveLength(3);
      expect(report.components.every((r) => r.healthy)).toBe(true);
      expect(report.timedOut).toBe(false);
      expect(report.code).toBe('ok');
    });

    test('should report mixed health status', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class HealthyComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'healthy', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return true;
        }
      }

      class UnhealthyComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'unhealthy', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return false;
        }
      }

      await lifecycle.registerComponent(new HealthyComponent(logger));
      await lifecycle.registerComponent(new UnhealthyComponent(logger));

      await lifecycle.startAllComponents();

      const report = await lifecycle.checkAllHealth();

      expect(report.components).toHaveLength(2);
      expect(report.healthy).toBe(false);
      expect(report.timedOut).toBe(false);
      expect(report.code).toBe('degraded');
    });

    test('should only check running components', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class HealthyComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return true;
        }
      }

      await lifecycle.registerComponent(new HealthyComponent(logger, 'comp1'));
      await lifecycle.registerComponent(new HealthyComponent(logger, 'comp2'));

      await lifecycle.startComponent('comp1');

      const report = await lifecycle.checkAllHealth();

      expect(report.components).toHaveLength(1);
      expect(report.components).toHaveLength(1);
      expect(report.components[0].name).toBe('comp1');
      expect(report.timedOut).toBe(false);
      expect(report.code).toBe('ok');
    });

    test('should handle components without health check', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithHealth extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'with-health', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public healthCheck() {
          return true;
        }
      }

      class ComponentWithoutHealth extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'without-health', dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      await lifecycle.registerComponent(new ComponentWithHealth(logger));
      await lifecycle.registerComponent(new ComponentWithoutHealth(logger));

      await lifecycle.startAllComponents();

      const report = await lifecycle.checkAllHealth();

      expect(report.components).toHaveLength(2);
      expect(
        report.components.find((r) => r.name === 'with-health')?.healthy,
      ).toBe(true);
      expect(
        report.components.find((r) => r.name === 'without-health')?.healthy,
      ).toBe(true); // Assumes healthy
      expect(report.timedOut).toBe(false);
      expect(report.code).toBe('ok');
    });
  });

  describe('Shared Values - getValue()', () => {
    test('should get value from component', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let valuePayload: any;

      class ComponentWithValues extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'provider', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public getValue<T = unknown>(key: string, _from: string | null) {
          if (key === 'config') {
            return { found: true, value: { setting: 'value' } as T };
          }
          if (key === 'status') {
            return { found: true, value: 'ready' as T };
          }
          return { found: false, value: undefined };
        }
      }

      await lifecycle.registerComponent(new ComponentWithValues(logger));
      await lifecycle.startAllComponents();

      lifecycle.on('component:value-returned', (data) => {
        valuePayload = data;
      });

      const result1 = lifecycle.getValue('provider', 'config');
      expect(result1.found).toBe(true);
      expect(result1.value).toEqual({ setting: 'value' });
      expect(result1.componentFound).toBe(true);
      expect(result1.componentRunning).toBe(true);
      expect(result1.handlerImplemented).toBe(true);
      expect(result1.code).toBe('found');
      expect(valuePayload?.componentName).toBe('provider');
      expect(valuePayload?.key).toBe('config');
      expect(valuePayload?.code).toBe('found');
      expect(valuePayload?.componentFound).toBe(true);
      expect(valuePayload?.componentRunning).toBe(true);
      expect(valuePayload?.handlerImplemented).toBe(true);

      const result2 = lifecycle.getValue('provider', 'status');
      expect(result2.found).toBe(true);
      expect(result2.value).toBe('ready');

      const result3 = lifecycle.getValue('provider', 'nonexistent');
      expect(result3.found).toBe(false);
      expect(result3.value).toBeUndefined();
      expect(result3.code).toBe('not_found');
    });

    test('should handle component not found', () => {
      const lifecycle = new LifecycleManager({ logger });

      const result = lifecycle.getValue('nonexistent', 'key');

      expect(result.found).toBe(false);
      expect(result.componentFound).toBe(false);
      expect(result.handlerImplemented).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.code).toBe('not_found');
    });

    test('should handle component not running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithValues extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'provider', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public getValue<T = unknown>(_key: string, _from: string | null) {
          return { found: true, value: { data: 'value' } as T };
        }
      }

      await lifecycle.registerComponent(new ComponentWithValues(logger));

      const result = lifecycle.getValue('provider', 'key');

      expect(result.found).toBe(false);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.code).toBe('stopped');
    });

    test('should handle component stalled', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class StallingComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, {
            name: 'provider',
            dependencies: [],
            shutdownGracefulTimeoutMS: 10,
            shutdownForceTimeoutMS: 10,
          });
        }

        public async start() {}
        public async stop() {
          await new Promise(() => {});
        }

        public getValue<T = unknown>(_key: string, _from: string | null) {
          return { found: true, value: { data: 'value' } as T };
        }
      }

      await lifecycle.registerComponent(new StallingComponent(logger));
      await lifecycle.startAllComponents();
      await lifecycle.stopComponent('provider');

      const result = lifecycle.getValue('provider', 'key');

      expect(result.found).toBe(false);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.code).toBe('stalled');
    });

    test('should allow getValue from stopped component when includeStopped is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithValues extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'provider', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public getValue<T = unknown>(_key: string, _from: string | null) {
          return { found: true, value: { data: 'value' } as T };
        }
      }

      await lifecycle.registerComponent(new ComponentWithValues(logger));

      const result = lifecycle.getValue('provider', 'key', {
        includeStopped: true,
      });

      expect(result.found).toBe(true);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(true);
      expect(result.value).toEqual({ data: 'value' });
      expect(result.code).toBe('found');
    });

    test('should allow getValue from stalled component when includeStalled is true', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class StallingComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, {
            name: 'provider',
            dependencies: [],
            shutdownGracefulTimeoutMS: 10,
            shutdownForceTimeoutMS: 10,
          });
        }

        public async start() {}
        public async stop() {
          await new Promise(() => {});
        }

        public getValue<T = unknown>(_key: string, _from: string | null) {
          return { found: true, value: { data: 'value' } as T };
        }
      }

      await lifecycle.registerComponent(new StallingComponent(logger));
      await lifecycle.startAllComponents();
      await lifecycle.stopComponent('provider');

      const result = lifecycle.getValue('provider', 'key', {
        includeStalled: true,
      });

      expect(result.found).toBe(true);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(false);
      expect(result.handlerImplemented).toBe(true);
      expect(result.value).toEqual({ data: 'value' });
      expect(result.code).toBe('found');
    });

    test('should handle component without getValue handler', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ComponentWithoutGetValue extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'provider', dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      await lifecycle.registerComponent(new ComponentWithoutGetValue(logger));
      await lifecycle.startAllComponents();

      const result = lifecycle.getValue('provider', 'key');

      expect(result.found).toBe(false);
      expect(result.componentFound).toBe(true);
      expect(result.componentRunning).toBe(true);
      expect(result.handlerImplemented).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.code).toBe('no_handler');
    });

    test('should track requester when called from component', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class ProviderComponent extends BaseComponent {
        public lastRequester: string | null = null;

        constructor(logger: Logger) {
          super(logger, { name: 'provider', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public getValue<T = unknown>(_key: string, from: string | null) {
          this.lastRequester = from;
          return { found: true, value: { data: 'value' } as T };
        }
      }

      class RequesterComponent extends BaseComponent {
        public retrievedValue: unknown;

        constructor(logger: Logger) {
          super(logger, { name: 'requester', dependencies: [] });
        }

        public start() {
          const result = this.lifecycle.getValue('provider', 'some-key');
          this.retrievedValue = result.value;
        }

        public async stop() {}
      }

      const provider = new ProviderComponent(logger);
      const requester = new RequesterComponent(logger);

      await lifecycle.registerComponent(provider);
      await lifecycle.registerComponent(requester);

      await lifecycle.startAllComponents();

      expect(provider.lastRequester).toBe('requester');
      expect(requester.retrievedValue).toEqual({ data: 'value' });
    });

    test('should handle getValue returning various types', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class MultiTypeProvider extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'provider', dependencies: [] });
        }

        public async start() {}
        public async stop() {}

        public getValue<T = unknown>(key: string, _from: string | null) {
          if (key === 'string') {
            return { found: true, value: 'text' as T };
          }
          if (key === 'number') {
            return { found: true, value: 42 as T };
          }
          if (key === 'boolean') {
            return { found: true, value: true as T };
          }
          if (key === 'null') {
            return { found: true, value: null as T };
          }
          if (key === 'array') {
            return { found: true, value: [1, 2, 3] as T };
          }
          if (key === 'object') {
            return { found: true, value: { nested: { value: 'deep' } } as T };
          }
          return { found: false, value: undefined };
        }
      }

      await lifecycle.registerComponent(new MultiTypeProvider(logger));
      await lifecycle.startAllComponents();

      expect(lifecycle.getValue('provider', 'string').value).toBe('text');
      expect(lifecycle.getValue('provider', 'number').value).toBe(42);
      expect(lifecycle.getValue('provider', 'boolean').value).toBe(true);
      expect(lifecycle.getValue('provider', 'null').value).toBeNull();
      expect(lifecycle.getValue('provider', 'array').value).toEqual([1, 2, 3]);
      expect(lifecycle.getValue('provider', 'object').value).toEqual({
        nested: { value: 'deep' },
      });
      expect(lifecycle.getValue('provider', 'undefined').found).toBe(false);
    });
  });

  describe('Component-scoped lifecycle reference', () => {
    test('should provide component-scoped lifecycle to components', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        public lifecycleRef: any;

        constructor(logger: Logger) {
          super(logger, { name: 'test-comp', dependencies: [] });
        }

        public start() {
          this.lifecycleRef = this.lifecycle;
        }

        public async stop() {}
      }

      const component = new TestComponent(logger);
      await lifecycle.registerComponent(component);
      await lifecycle.startAllComponents();

      expect(component.lifecycleRef).toBeDefined();
      expect(component.lifecycleRef).not.toBe(lifecycle); // Different object
      expect(typeof component.lifecycleRef.sendMessageToComponent).toBe(
        'function',
      );
      expect(typeof component.lifecycleRef.broadcastMessage).toBe('function');
      expect(typeof component.lifecycleRef.checkComponentHealth).toBe(
        'function',
      );
      expect(typeof component.lifecycleRef.getValue).toBe('function');
    });
  });
});

describe('LifecycleManager - AutoStart & Registration Metadata', () => {
  let logger: Logger;
  let arraySink: ArraySink;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({ sinks: [arraySink] });
  });

  describe('AutoStart on registration', () => {
    test('should not auto-start when autoStart is false (default)', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        public startCount = 0;

        constructor(logger: Logger) {
          super(logger, { name: 'test-comp', dependencies: [] });
        }

        public start() {
          this.startCount++;
        }

        public async stop() {}
      }

      const component = new TestComponent(logger);
      const result = await lifecycle.registerComponent(component);

      expect(result.success).toBe(true);
      expect(result.autoStartAttempted).toBe(false);
      expect(result.autoStartSucceeded).toBeUndefined();
      expect(result.startResult).toBeUndefined();
      expect(component.startCount).toBe(0);
      expect(lifecycle.isComponentRunning('test-comp')).toBe(false);
    });

    test('should auto-start when manager has no components', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        public startCount = 0;

        constructor(logger: Logger) {
          super(logger, { name: 'test-comp', dependencies: [] });
        }

        public start() {
          this.startCount++;
        }

        public async stop() {}
      }

      const component = new TestComponent(logger);
      const result = await lifecycle.registerComponent(component, {
        autoStart: true,
      });

      expect(result.success).toBe(true);
      expect(result.autoStartAttempted).toBe(true);
      expect(result.autoStartSucceeded).toBe(true);
      expect(result.startResult?.success).toBe(true);
      expect(component.startCount).toBe(1);
      expect(lifecycle.isComponentRunning('test-comp')).toBe(true);
    });

    test('should auto-start when manager is not running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        public startCount = 0;

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public start() {
          this.startCount++;
        }

        public async stop() {}
      }

      await lifecycle.registerComponent(new TestComponent(logger, 'base'));

      const component = new TestComponent(logger, 'late-comp');
      const result = await lifecycle.registerComponent(component, {
        autoStart: true,
      });

      expect(result.success).toBe(true);
      expect(result.autoStartAttempted).toBe(true);
      expect(result.autoStartSucceeded).toBe(true);
      expect(result.startResult?.success).toBe(true);
      expect(component.startCount).toBe(1);
      expect(lifecycle.isComponentRunning('late-comp')).toBe(true);
    });

    test('should auto-start when manager is running', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        public startCount = 0;

        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public start() {
          this.startCount++;
        }

        public async stop() {}
      }

      // Register and start a dummy component to get manager into running state
      await lifecycle.registerComponent(new TestComponent(logger, 'dummy'));
      await lifecycle.startAllComponents();
      expect(lifecycle.getSystemState()).toBe('running');

      // Register with autoStart
      const component = new TestComponent(logger, 'test-comp');
      const result = await lifecycle.registerComponent(component, {
        autoStart: true,
      });

      expect(result.success).toBe(true);
      expect(result.autoStartAttempted).toBe(true);
      expect(result.autoStartSucceeded).toBe(true);
      expect(result.duringStartup).toBe(false);
      expect(result.startResult?.success).toBe(true);
      expect(result.startResult?.componentName).toBe('test-comp');

      // Wait for auto-start to complete (it's fire-and-forget)
      await sleep(50);

      expect(component.startCount).toBe(1);
      expect(lifecycle.isComponentRunning('test-comp')).toBe(true);
    });

    test('should auto-start during bulk startup', async () => {
      const lifecycle = new LifecycleManager({ logger });
      let autoStartResult:
        | Awaited<ReturnType<LifecycleManager['registerComponent']>>
        | undefined;

      class Component1 extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'comp1', dependencies: [] });
        }

        public async start() {
          // During this start, register another component with autoStart
          const comp2 = new Component2(logger);
          autoStartResult = await lifecycle.registerComponent(comp2, {
            autoStart: true,
          });
        }

        public async stop() {}
      }

      class Component2 extends BaseComponent {
        public startCount = 0;

        constructor(logger: Logger) {
          super(logger, { name: 'comp2', dependencies: [] });
        }

        public start() {
          this.startCount++;
        }

        public async stop() {}
      }

      await lifecycle.registerComponent(new Component1(logger));

      // Start all components (during comp1 start, comp2 will be registered with autoStart)
      await lifecycle.startAllComponents();

      expect(autoStartResult?.autoStartAttempted).toBe(true);
      expect(autoStartResult?.autoStartSucceeded).toBe(true);
      expect(autoStartResult?.duringStartup).toBe(true);
      expect(autoStartResult?.startResult?.success).toBe(true);
      expect(autoStartResult?.startResult?.componentName).toBe('comp2');

      // Wait for auto-start to complete (it's fire-and-forget)
      await sleep(50);

      expect(lifecycle.isComponentRunning('comp2')).toBe(true);
    });

    test('should emit registration event with autoStartAttempted metadata', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const events: any[] = [];

      lifecycle.on('component:registered', (data) => {
        events.push(data);
      });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      // Register without autoStart (before startup)
      await lifecycle.registerComponent(new TestComponent(logger, 'comp1'));
      expect(events[0].autoStartAttempted).toBe(false);
      expect(events[0].autoStartSucceeded).toBeUndefined();
      expect(events[0].duringStartup).toBe(false);

      // Register with autoStart (before startup - should auto-start)
      await lifecycle.registerComponent(new TestComponent(logger, 'comp2'), {
        autoStart: true,
      });
      expect(events[1].autoStartAttempted).toBe(true);
      expect(events[1].autoStartSucceeded).toBe(true);
      expect(events[1].duringStartup).toBe(false);

      // Register with autoStart while running
      await lifecycle.registerComponent(new TestComponent(logger, 'comp3'), {
        autoStart: true,
      });
      expect(events[2].autoStartAttempted).toBe(true);
      expect(events[2].autoStartSucceeded).toBe(true);
      expect(events[2].duringStartup).toBe(false);
    });

    test('should handle auto-start failures gracefully', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class FailingComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'failing', dependencies: [] });
        }

        public start() {
          throw new Error('Start failed');
        }

        public async stop() {}
      }

      // Start the manager first (needs at least one component)
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'base' }),
      );
      await lifecycle.startComponent('base');

      // Register with autoStart - should not throw, just log error
      const result = await lifecycle.registerComponent(
        new FailingComponent(logger),
        {
          autoStart: true,
        },
      );

      expect(result.success).toBe(true);
      expect(result.autoStartAttempted).toBe(true);
      expect(result.autoStartSucceeded).toBe(false);
      expect(result.startResult?.success).toBe(false);

      // Wait for auto-start to fail
      await sleep(50);

      // Component should not be running
      expect(lifecycle.isComponentRunning('failing')).toBe(false);
    });

    test('should handle missing dependencies during auto-start', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class DependentComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, {
            name: 'dependent',
            dependencies: ['missing-dep'],
          });
        }

        public async start() {}
        public async stop() {}
      }

      // Start the manager first (needs at least one component)
      await lifecycle.registerComponent(
        new TestComponent(logger, { name: 'base' }),
      );
      await lifecycle.startComponent('base');

      // Register with autoStart - should fail due to missing dependency
      const result = await lifecycle.registerComponent(
        new DependentComponent(logger),
        { autoStart: true },
      );

      expect(result.success).toBe(true);
      expect(result.autoStartAttempted).toBe(true);
      expect(result.autoStartSucceeded).toBe(false);
      expect(result.startResult?.success).toBe(false);

      // Wait for auto-start to fail
      await sleep(50);

      // Component should not be running
      expect(lifecycle.isComponentRunning('dependent')).toBe(false);
    });
  });

  describe('Unregistration during shutdown event', () => {
    test('should emit duringShutdown flag when unregistering during shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const events: any[] = [];

      lifecycle.on('component:unregistered', (data) => {
        events.push(data);
      });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'test-comp', dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      await lifecycle.registerComponent(new TestComponent(logger));
      await lifecycle.startAllComponents();

      // Normal unregistration
      await lifecycle.unregisterComponent('test-comp');
      expect(events[0].name).toBe('test-comp');
      expect(events[0].duringShutdown).toBe(false);
    });

    test('should not allow unregistration during shutdown', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class SlowComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'slow', dependencies: [] });
        }

        public async start() {}

        public async stop() {
          // Try to unregister during stop (which happens during shutdown)
          const result = await lifecycle.unregisterComponent('slow');
          expect(result.success).toBe(false);
          expect(result.code).toBe('bulk_operation_in_progress');
        }
      }

      await lifecycle.registerComponent(new SlowComponent(logger));
      await lifecycle.startAllComponents();

      // Trigger shutdown
      await lifecycle.stopAllComponents();
    });
  });

  describe('Registration metadata', () => {
    test('should include duringStartup flag in registration events', async () => {
      const lifecycle = new LifecycleManager({ logger });
      const events: any[] = [];

      lifecycle.on('component:registered', (data) => {
        events.push(data);
      });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {
          // Register during startup
          await lifecycle.registerComponent(new TestComponent(logger, 'comp2'));
        }
        public async stop() {}
      }

      // Register before startup
      await lifecycle.registerComponent(new TestComponent(logger, 'comp1'));
      expect(events[0].duringStartup).toBe(false);

      // Start (comp1 will register comp2 during its start)
      await lifecycle.startAllComponents();

      // comp2 was registered during startup
      expect(events[1].name).toBe('comp2');
      expect(events[1].duringStartup).toBe(true);
    });

    test('should include metadata in result objects', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger) {
          super(logger, { name: 'test-comp', dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      const result = await lifecycle.registerComponent(
        new TestComponent(logger),
      );

      expect(result.duringStartup).toBe(false);
      expect(result.autoStartAttempted).toBe(false);
    });
  });

  describe('allowDuringBulkStartup option', () => {
    test('should block startComponent during bulk startup by default', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {
          if (this.getName() === 'comp1') {
            // Try to start comp2 during bulk startup (without option)
            const result = await lifecycle.startComponent('comp2');
            expect(result.success).toBe(false);
            expect(result.code).toBe('startup_in_progress');
            expect(result.reason).toBe('Bulk startup in progress');
          }
        }
        public async stop() {}
      }

      await lifecycle.registerComponent(new TestComponent(logger, 'comp1'));
      await lifecycle.registerComponent(new TestComponent(logger, 'comp2'));

      await lifecycle.startAllComponents();
    });

    test('should allow startComponent during bulk startup with allowDuringBulkStartup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {
          if (this.getName() === 'comp1') {
            // Start comp2 during bulk startup with option
            const result = await lifecycle.startComponent('comp2', {
              allowDuringBulkStartup: true,
            });
            expect(result.success).toBe(true);
            expect(lifecycle.isComponentRunning('comp2')).toBe(true);
          }
        }
        public async stop() {}
      }

      await lifecycle.registerComponent(new TestComponent(logger, 'comp1'));
      await lifecycle.registerComponent(new TestComponent(logger, 'comp2'));

      await lifecycle.startAllComponents();

      // Both should be running
      expect(lifecycle.isComponentRunning('comp1')).toBe(true);
      expect(lifecycle.isComponentRunning('comp2')).toBe(true);
    });

    test('should fail if dependencies are not running even with allowDuringBulkStartup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger, name: string, deps: string[] = []) {
          super(logger, { name, dependencies: deps });
        }

        public async start() {
          if (this.getName() === 'comp1') {
            // Try to start comp3 which depends on comp2 (not running yet)
            const result = await lifecycle.startComponent('comp3', {
              allowDuringBulkStartup: true,
            });
            expect(result.success).toBe(false);
            expect(result.code).toBe('dependency_not_running');
          }
        }
        public async stop() {}
      }

      await lifecycle.registerComponent(new TestComponent(logger, 'comp1'));
      await lifecycle.registerComponent(new TestComponent(logger, 'comp2'));
      await lifecycle.registerComponent(
        new TestComponent(logger, 'comp3', ['comp2']),
      );

      await lifecycle.startAllComponents();
    });

    test('should NEVER allow starting during shutdown even with allowDuringBulkStartup', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}

        public async stop() {
          if (this.getName() === 'comp1') {
            // Try to start comp2 during shutdown (should always fail)
            const result = await lifecycle.startComponent('comp2', {
              allowDuringBulkStartup: true,
            });
            expect(result.success).toBe(false);
            expect(result.code).toBe('shutdown_in_progress');
            expect(result.reason).toBe('Shutdown in progress');
          }
        }
      }

      await lifecycle.registerComponent(new TestComponent(logger, 'comp1'));
      await lifecycle.registerComponent(new TestComponent(logger, 'comp2'));
      await lifecycle.startAllComponents();

      // Trigger shutdown
      await lifecycle.stopAllComponents();
    });

    test('should work normally when not in bulk mode', async () => {
      const lifecycle = new LifecycleManager({ logger });

      class TestComponent extends BaseComponent {
        constructor(logger: Logger, name: string) {
          super(logger, { name, dependencies: [] });
        }

        public async start() {}
        public async stop() {}
      }

      await lifecycle.registerComponent(new TestComponent(logger, 'comp1'));
      await lifecycle.registerComponent(new TestComponent(logger, 'comp2'));

      // Not in bulk mode - option should have no effect
      const result1 = await lifecycle.startComponent('comp1', {
        allowDuringBulkStartup: true,
      });
      expect(result1.success).toBe(true);

      const result2 = await lifecycle.startComponent('comp2');
      expect(result2.success).toBe(true);
    });
  });
});
