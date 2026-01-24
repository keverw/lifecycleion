import { describe, expect, test, beforeEach } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from '../lifecycle-manager';
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
  });
});
