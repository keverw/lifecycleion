/**
 * Tests for event handler error handling
 *
 * Verifies that errors thrown by event handlers are caught and logged
 * without breaking lifecycle operations.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import { BaseComponent } from './base-component';

class TestComponent extends BaseComponent {
  public startCalled = false;
  public stopCalled = false;

  public start(): void {
    this.startCalled = true;
  }

  public stop(): void {
    this.stopCalled = true;
  }
}

describe('LifecycleManager - Event Handler Error Handling', () => {
  let logger: Logger;
  let arraySink: ArraySink;
  let lifecycle: LifecycleManager;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });
    lifecycle = new LifecycleManager({
      logger,
      name: 'test-lifecycle',
    });
  });

  test('should catch errors from component:registered event handler and dispatch as ErrorEvent', async () => {
    const component = new TestComponent(logger, { name: 'test' });
    const errors: ErrorEvent[] = [];

    // Listen for ErrorEvent dispatches
    const errorListener = (event: Event) => {
      if (event instanceof ErrorEvent) {
        errors.push(event);
      }
    };
    globalThis.addEventListener('reportError', errorListener);

    // Register error-throwing event handler
    lifecycle.on('component:registered', () => {
      throw new Error('Event handler error');
    });

    // Registration should succeed despite handler error
    const result = await lifecycle.registerComponent(component);
    expect(result.success).toBe(true);
    expect(lifecycle.hasComponent('test')).toBe(true);

    // Check that error was dispatched as ErrorEvent
    expect(errors.length).toBe(1);
    expect(errors[0].error.message).toContain('Event handler error');
    expect(errors[0].error.message).toContain(
      'event handler for component:registered',
    );

    // Cleanup
    globalThis.removeEventListener('reportError', errorListener);
  });

  test('should catch errors from component:started event handler and dispatch as ErrorEvent', async () => {
    const component = new TestComponent(logger, { name: 'test' });
    await lifecycle.registerComponent(component);

    const errors: ErrorEvent[] = [];
    const errorListener = (event: Event) => {
      if (event instanceof ErrorEvent) {
        errors.push(event);
      }
    };
    globalThis.addEventListener('reportError', errorListener);

    // Register error-throwing event handler
    lifecycle.on('component:started', () => {
      throw new Error('Started handler error');
    });

    // Start should succeed despite handler error
    const result = await lifecycle.startComponent('test');
    expect(result.success).toBe(true);
    expect(lifecycle.isComponentRunning('test')).toBe(true);

    // Check that error was dispatched as ErrorEvent
    expect(errors.length).toBe(1);
    expect(errors[0].error.message).toContain('Started handler error');

    globalThis.removeEventListener('reportError', errorListener);
  });

  test('should catch errors from component:stopped event handler and dispatch as ErrorEvent', async () => {
    const component = new TestComponent(logger, { name: 'test' });
    await lifecycle.registerComponent(component);
    await lifecycle.startComponent('test');

    const errors: ErrorEvent[] = [];
    const errorListener = (event: Event) => {
      if (event instanceof ErrorEvent) {
        errors.push(event);
      }
    };
    globalThis.addEventListener('reportError', errorListener);

    // Register error-throwing event handler
    lifecycle.on('component:stopped', () => {
      throw new Error('Stopped handler error');
    });

    // Stop should succeed despite handler error
    const result = await lifecycle.stopComponent('test');
    expect(result.success).toBe(true);
    expect(lifecycle.isComponentRunning('test')).toBe(false);

    // Check that error was dispatched as ErrorEvent
    expect(errors.length).toBe(1);
    expect(errors[0].error.message).toContain('Stopped handler error');

    globalThis.removeEventListener('reportError', errorListener);
  });

  test('should catch errors from lifecycle-manager:shutdown-initiated event handler and dispatch as ErrorEvent', async () => {
    const component = new TestComponent(logger, { name: 'test' });
    await lifecycle.registerComponent(component);
    await lifecycle.startComponent('test');

    const errors: ErrorEvent[] = [];
    const errorListener = (event: Event) => {
      if (event instanceof ErrorEvent) {
        errors.push(event);
      }
    };
    globalThis.addEventListener('reportError', errorListener);

    // Register error-throwing event handler
    lifecycle.on('lifecycle-manager:shutdown-initiated', () => {
      throw new Error('Shutdown initiated handler error');
    });

    // Shutdown should succeed despite handler error
    const result = await lifecycle.stopAllComponents();
    expect(result.success).toBe(true);

    // Check that error was dispatched as ErrorEvent
    expect(errors.length).toBe(1);
    expect(errors[0].error.message).toContain(
      'Shutdown initiated handler error',
    );

    globalThis.removeEventListener('reportError', errorListener);
  });

  test('should handle multiple failing event handlers for same event', async () => {
    const component = new TestComponent(logger, { name: 'test' });

    const errors: ErrorEvent[] = [];
    const errorListener = (event: Event) => {
      if (event instanceof ErrorEvent) {
        errors.push(event);
      }
    };
    globalThis.addEventListener('reportError', errorListener);

    // Register multiple error-throwing event handlers
    lifecycle.on('component:registered', () => {
      throw new Error('First handler error');
    });
    lifecycle.on('component:registered', () => {
      throw new Error('Second handler error');
    });

    // Registration should succeed despite both handler errors
    const result = await lifecycle.registerComponent(component);
    expect(result.success).toBe(true);
    expect(lifecycle.hasComponent('test')).toBe(true);

    // Check that both errors were dispatched as ErrorEvents
    expect(errors.length).toBe(2);
    expect(
      errors.some((e) => e.error.message.includes('First handler error')),
    ).toBe(true);
    expect(
      errors.some((e) => e.error.message.includes('Second handler error')),
    ).toBe(true);

    globalThis.removeEventListener('reportError', errorListener);
  });

  test('should handle async event handler errors', async () => {
    const component = new TestComponent(logger, { name: 'test' });

    const errors: ErrorEvent[] = [];
    const errorListener = (event: Event) => {
      if (event instanceof ErrorEvent) {
        errors.push(event);
      }
    };
    globalThis.addEventListener('reportError', errorListener);

    // Register async error-throwing event handler
    lifecycle.on('component:registered', async () => {
      await Promise.resolve();
      throw new Error('Async handler error');
    });

    // Registration should succeed despite async handler error
    const result = await lifecycle.registerComponent(component);
    expect(result.success).toBe(true);

    // Wait a bit for async handler to complete and error to be dispatched
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Check that error was dispatched as ErrorEvent
    expect(errors.length).toBe(1);
    expect(errors[0].error.message).toContain('Async handler error');

    globalThis.removeEventListener('reportError', errorListener);
  });

  test('should continue with other handlers even if one fails', async () => {
    const component = new TestComponent(logger, { name: 'test' });
    let wasSuccessHandlerCalled = false;

    // Register handlers in sequence: error, success, error
    lifecycle.on('component:registered', () => {
      throw new Error('First error');
    });
    lifecycle.on('component:registered', () => {
      wasSuccessHandlerCalled = true;
    });
    lifecycle.on('component:registered', () => {
      throw new Error('Second error');
    });

    // Registration should succeed
    const result = await lifecycle.registerComponent(component);
    expect(result.success).toBe(true);

    // Success handler should have been called despite surrounding errors
    expect(wasSuccessHandlerCalled).toBe(true);
  });
});
