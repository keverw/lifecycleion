import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { Logger } from './index';
import { ArraySink } from './sinks/array';
import { sleep } from '../sleep';

describe('Logger', () => {
  let arraySink: ArraySink;
  let logger: Logger;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });
  });

  describe('Basic Logging', () => {
    test('should log info message', () => {
      logger.info('Test info message');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('info');
      expect(arraySink.logs[0].message).toBe('Test info message');
      expect(arraySink.logs[0].serviceName).toBeUndefined();
      expect(arraySink.logs[0].entityName).toBeUndefined();
    });

    test('should log error message', () => {
      logger.error('Test error message');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('error');
      expect(arraySink.logs[0].message).toBe('Test error message');
    });

    test('should log warn message', () => {
      logger.warn('Test warning');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('warn');
    });

    test('should log success message', () => {
      logger.success('Operation successful');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('success');
    });

    test('should log notice message', () => {
      logger.notice('Important notice');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('notice');
    });

    test('should log debug message', () => {
      logger.debug('Debug info');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('debug');
    });

    test('should log raw message', () => {
      logger.raw('Raw output');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('raw');
    });
  });

  describe('Template Strings', () => {
    test('should process template with params', () => {
      logger.info('User {{userID}} logged in', {
        params: { userID: 456 },
      });

      expect(arraySink.logs[0].message).toBe('User 456 logged in');
      expect(arraySink.logs[0].template).toBe('User {{userID}} logged in');
      expect(arraySink.logs[0].params).toEqual({ userID: 456 });
    });

    test('should handle multiple params', () => {
      logger.info('User {{userID}} from {{ip}}', {
        params: { userID: 789, ip: '10.0.0.15' },
      });

      expect(arraySink.logs[0].message).toBe('User 789 from 10.0.0.15');
    });

    test('should work without params', () => {
      logger.info('Simple message without params');

      expect(arraySink.logs[0].message).toBe('Simple message without params');
      expect(arraySink.logs[0].params).toBeUndefined();
    });

    test('should support nested object params with dot notation', () => {
      logger.info('User {{user.name}} ({{user.id}}) from {{session.ip}}', {
        params: {
          user: {
            id: 123,
            name: 'Alice',
            role: 'admin',
          },
          session: {
            ip: '192.168.1.1',
            duration: 3600,
          },
        },
      });

      expect(arraySink.logs[0].message).toBe(
        'User Alice (123) from 192.168.1.1',
      );
      expect(arraySink.logs[0].params).toEqual({
        user: {
          id: 123,
          name: 'Alice',
          role: 'admin',
        },
        session: {
          ip: '192.168.1.1',
          duration: 3600,
        },
      });
    });
  });

  describe('Redaction', () => {
    test('should redact specified keys', () => {
      logger.info('Login attempt', {
        params: {
          username: 'john',
          password: 'secret123',
        },
        redactedKeys: ['password'],
      });

      const log = arraySink.logs[0];
      expect(log.params?.password).toBe('secret123'); // Original param
      expect(log.redactedParams?.password).not.toBe('secret123'); // Redacted
      expect(log.redactedParams?.username).toBe('john'); // Not redacted
    });

    test('should use custom redaction function', () => {
      const customLogger = new Logger({
        sinks: [arraySink],
        redactFunction: (key, _value) => `[HIDDEN-${key}]`,
        callProcessExit: false,
      });

      customLogger.info('API call', {
        params: { apiKey: 'sk_12345' },
        redactedKeys: ['apiKey'],
      });

      expect(arraySink.logs[0].redactedParams?.apiKey).toBe('[HIDDEN-apiKey]');
    });

    test('should redact nested keys using dot notation', () => {
      logger.info('Auth attempt', {
        params: {
          user: {
            id: 123,
            name: 'Alice',
            password: 'secret123',
          },
          credentials: {
            username: 'alice',
            apiKey: 'sk_12345',
          },
        },
        redactedKeys: ['user.password', 'credentials.apiKey'],
      });

      const log = arraySink.logs[0];

      // Original params should be unchanged
      expect(log.params).toEqual({
        user: {
          id: 123,
          name: 'Alice',
          password: 'secret123',
        },
        credentials: {
          username: 'alice',
          apiKey: 'sk_12345',
        },
      });

      // Redacted params should have nested keys redacted
      const redacted = log.redactedParams as any;
      expect(redacted.user.id).toBe(123);
      expect(redacted.user.name).toBe('Alice');
      expect(redacted.user.password).not.toBe('secret123'); // Redacted
      expect(redacted.credentials.username).toBe('alice');
      expect(redacted.credentials.apiKey).not.toBe('sk_12345'); // Redacted
    });

    test('should handle deeply nested redaction', () => {
      logger.info('Deep nested data', {
        params: {
          data: {
            auth: {
              token: 'secret-token-123',
              refreshToken: 'refresh-456',
            },
            user: {
              name: 'Bob',
              ssn: '123-45-6789',
            },
          },
        },
        redactedKeys: ['data.auth.token', 'data.user.ssn'],
      });

      const log = arraySink.logs[0];
      const redacted = log.redactedParams as any;

      expect(redacted.data.auth.token).not.toBe('secret-token-123');
      expect(redacted.data.auth.refreshToken).toBe('refresh-456');
      expect(redacted.data.user.name).toBe('Bob');
      expect(redacted.data.user.ssn).not.toBe('123-45-6789');
    });

    test('should handle both top-level and nested redaction', () => {
      logger.info('Mixed redaction', {
        params: {
          password: 'top-level-secret',
          user: {
            name: 'Charlie',
            apiKey: 'nested-secret',
          },
        },
        redactedKeys: ['password', 'user.apiKey'],
      });

      const log = arraySink.logs[0];
      const redacted = log.redactedParams as any;

      expect(redacted.password).not.toBe('top-level-secret');
      expect(redacted.user.name).toBe('Charlie');
      expect(redacted.user.apiKey).not.toBe('nested-secret');
    });

    test('should include redactedKeys in log entry', () => {
      logger.info('Test with redacted keys', {
        params: {
          username: 'test',
          password: 'secret',
          user: { apiKey: 'key123', name: 'John' },
        },
        redactedKeys: ['password', 'user.apiKey', 'data.ssn'],
      });

      const log = arraySink.logs[0];

      // Should include the list of redacted keys
      expect(log.redactedKeys).toEqual(['password', 'user.apiKey', 'data.ssn']);
    });

    test('should not include redactedKeys when no params', () => {
      logger.info('Test without params', {
        redactedKeys: ['password'],
      });

      const log = arraySink.logs[0];

      // Should not have redactedKeys when no params
      expect(log.redactedKeys).toBeUndefined();
    });

    test('should not include redactedKeys when no redacted keys configured', () => {
      logger.info('Test with params', {
        params: { username: 'test', password: 'secret' },
      });

      const log = arraySink.logs[0];

      // Should not have redactedKeys when no redaction configured
      expect(log.redactedKeys).toBeUndefined();
    });
  });

  describe('Error Objects', () => {
    test('should log error object', () => {
      const error = new Error('Test error');

      logger.errorObject('Error occurred', error);

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].type).toBe('error');
      expect(arraySink.logs[0].message).toContain('Error occurred');
      expect(arraySink.logs[0].message).toContain('Test error');
    });

    test('should log error object without prefix', () => {
      const error = new Error('Test error');

      logger.errorObject('', error);

      expect(arraySink.logs[0].message).toContain('Test error');
      expect(arraySink.logs[0].message).not.toContain('Error occurred');
    });
  });

  describe('Service Loggers', () => {
    test('should create service logger', () => {
      const service = logger.service('TestService');

      service.info('Service message');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].serviceName).toBe('TestService');
      expect(arraySink.logs[0].message).toBe('Service message');
    });

    test('should support multiple service loggers', () => {
      const auth = logger.service('Auth');
      const db = logger.service('Database');

      auth.info('Auth message');
      db.info('DB message');

      expect(arraySink.logs.length).toBe(2);
      expect(arraySink.logs[0].serviceName).toBe('Auth');
      expect(arraySink.logs[1].serviceName).toBe('Database');
    });

    test('should support all log levels in service logger', () => {
      const service = logger.service('TestService');

      service.error('Error');
      service.info('Info');
      service.warn('Warning');
      service.success('Success');
      service.notice('Notice');
      service.debug('Debug');
      service.raw('Raw');

      expect(arraySink.logs.length).toBe(7);
      expect(arraySink.logs.map((l) => l.type)).toEqual([
        'error',
        'info',
        'warn',
        'success',
        'notice',
        'debug',
        'raw',
      ]);
    });

    test('should support templates in service logger', () => {
      const service = logger.service('Auth');

      service.info('User {{userID}} logged in', {
        params: { userID: 542 },
      });

      expect(arraySink.logs[0].message).toBe('User 542 logged in');
      expect(arraySink.logs[0].serviceName).toBe('Auth');
    });

    test('should support error objects in service logger', () => {
      const service = logger.service('TestService');
      const error = new Error('Service error');

      service.errorObject('Error prefix', error);

      expect(arraySink.logs[0].message).toContain('Error prefix');
      expect(arraySink.logs[0].message).toContain('Service error');
    });
  });

  describe('Multiple Sinks', () => {
    test('should write to multiple sinks', () => {
      const sink1 = new ArraySink();
      const sink2 = new ArraySink();

      const multiLogger = new Logger({
        sinks: [sink1, sink2],
        callProcessExit: false,
      });

      multiLogger.info('Test message');

      expect(sink1.logs.length).toBe(1);
      expect(sink2.logs.length).toBe(1);
      expect(sink1.logs[0].message).toBe('Test message');
      expect(sink2.logs[0].message).toBe('Test message');
    });

    test('should handle sink errors gracefully', () => {
      // Spy on console.error to suppress error output during test
      const consoleErrorSpy = spyOn(console, 'error').mockImplementation(
        () => {},
      );

      const errorSink = {
        write: () => {
          throw new Error('Sink error');
        },
      };

      const errorLogger = new Logger({
        sinks: [errorSink, arraySink],
        callProcessExit: false,
      });

      // Should not throw, should continue to other sinks
      errorLogger.info('Test message');

      expect(arraySink.logs.length).toBe(1);

      // Verify error was logged
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('EventEmitter', () => {
    test('should emit log events', () => {
      const events: any[] = [];

      logger.on('logger', (event) => {
        events.push(event);
      });

      logger.info('Test message');

      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe('log');
      expect(events[0].logType).toBe('info');
      expect(events[0].message).toBe('Test message');
    });

    test('should emit exit-called event', () => {
      const events: any[] = [];

      logger.on('logger', (event) => {
        if ((event as { eventType: string }).eventType === 'exit-called') {
          events.push(event);
        }
      });

      logger.exit(0);

      expect(events.length).toBe(1);
      expect(events[0].code).toBe(0);
      expect(events[0].isFirstExit).toBe(true);
    });

    test('should track exit state', () => {
      expect(logger.didExit).toBe(false);
      expect(logger.isPendingExit).toBe(false);

      logger.exit(1);

      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(1);
      expect(logger.isPendingExit).toBe(false);
    });
  });

  describe('Exit Handling', () => {
    test('should handle exit with error code 1', () => {
      logger.error('Fatal error', { exitCode: 1 });

      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(1);
    });

    test('should handle exit with code 0', () => {
      logger.info('Done', { exitCode: 0 });

      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(0);
    });

    test('should handle exit with custom exit codes', () => {
      logger.error('Custom error', { exitCode: 2 });

      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(2);
    });

    test('should not exit by default', () => {
      logger.error('Error without exit');

      expect(logger.didExit).toBe(false);
    });

    test('should not exit when exitCode is null', () => {
      logger.error('Error with null', { exitCode: null as any });

      expect(logger.didExit).toBe(false);
    });

    test('should not exit when exitCode is undefined', () => {
      logger.error('Error with undefined', { exitCode: undefined });

      expect(logger.didExit).toBe(false);
    });

    test('should not exit when exitCode is NaN', () => {
      logger.error('Error with NaN', { exitCode: NaN });

      expect(logger.didExit).toBe(false);
    });

    test('should include exitCode in LogEntry', () => {
      logger.error('Fatal error', { exitCode: 1 });

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].exitCode).toBe(1);
    });

    test('should not include exitCode in LogEntry when not specified', () => {
      logger.error('Error without exit');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].exitCode).toBeUndefined();
    });

    test('should not include exitCode in LogEntry when invalid', () => {
      logger.error('Error with null', { exitCode: null as any });

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].exitCode).toBeUndefined();
    });
  });

  describe('setBeforeExitCallback', () => {
    test('should set beforeExit callback after construction', async () => {
      const callbackCalls: Array<{ exitCode: number; isFirstExit: boolean }> =
        [];

      logger.setBeforeExitCallback((exitCode, isFirstExit) => {
        callbackCalls.push({ exitCode, isFirstExit });
        return { action: 'proceed' };
      });

      logger.exit(0);

      // Wait for async callback
      await sleep(10);

      expect(callbackCalls.length).toBe(1);
      expect(callbackCalls[0].exitCode).toBe(0);
      expect(callbackCalls[0].isFirstExit).toBe(true);
    });

    test('should overwrite existing beforeExit callback', async () => {
      const firstCalls: number[] = [];
      const secondCalls: number[] = [];

      const firstLogger = new Logger({
        callProcessExit: false,
        beforeExitCallback: (exitCode) => {
          firstCalls.push(exitCode);
          return { action: 'proceed' };
        },
      });

      // Overwrite with new callback
      firstLogger.setBeforeExitCallback((exitCode) => {
        secondCalls.push(exitCode);
        return { action: 'proceed' };
      });

      firstLogger.exit(1);

      await sleep(10);

      expect(firstCalls.length).toBe(0); // Original callback should not be called
      expect(secondCalls.length).toBe(1); // New callback should be called
      expect(secondCalls[0]).toBe(1);
    });

    test('should remove callback when passed undefined', async () => {
      const callbackCalls: number[] = [];

      const testLogger = new Logger({
        callProcessExit: false,
        beforeExitCallback: (exitCode) => {
          callbackCalls.push(exitCode);
          return { action: 'proceed' };
        },
      });

      // Remove callback
      testLogger.setBeforeExitCallback(undefined);

      testLogger.exit(0);

      await sleep(10);

      expect(callbackCalls.length).toBe(0); // Callback should not be called
      expect(testLogger.didExit).toBe(true); // Exit should still happen
    });

    test('should work with async callback', async () => {
      const callbackCalls: number[] = [];

      logger.setBeforeExitCallback(async (exitCode) => {
        await sleep(5);
        callbackCalls.push(exitCode);
        return { action: 'proceed' };
      });

      logger.exit(2);

      await sleep(20);

      expect(callbackCalls.length).toBe(1);
      expect(callbackCalls[0]).toBe(2);
      expect(logger.didExit).toBe(true);
    });

    test('should handle callback errors gracefully', async () => {
      logger.setBeforeExitCallback(() => {
        throw new Error('Callback error');
      });

      logger.exit(1);

      await sleep(10);

      // Should still exit despite callback error
      expect(logger.didExit).toBe(true);
      expect(logger.exitCode).toBe(1);
    });
  });

  describe('reportError Listener', () => {
    test('should register reportError listener', () => {
      const result = logger.registerReportErrorListener();

      expect(result).toBe('success');
      expect(logger.isReportErrorListenerRegistered()).toBe(true);
    });

    test('should return already_registered on second call', () => {
      logger.registerReportErrorListener();
      const result = logger.registerReportErrorListener();

      expect(result).toBe('already_registered');
    });

    test('should unregister reportError listener', () => {
      logger.registerReportErrorListener();
      const result = logger.unregisterReportErrorListener();

      expect(result).toBe('success');
      expect(logger.isReportErrorListenerRegistered()).toBe(false);
    });

    test('should check if reportError is available', () => {
      const isAvailable = logger.isReportErrorAvailable();

      expect(typeof isAvailable).toBe('boolean');
    });
  });

  describe('Static Methods', () => {
    test('should create test optimized logger', () => {
      const { logger, arraySink } = Logger.createTestOptimizedLogger();

      expect(logger.isLoggerClass).toBe(true);
      expect(logger.didExit).toBe(false);
      expect(arraySink.logs).toEqual([]);
    });

    test('should create test optimized logger with transformer', () => {
      const { logger, arraySink } = Logger.createTestOptimizedLogger({
        arrayLogTransformer: (entry) => {
          if (entry.message === 'Keep original') {
            return false;
          }
          return {
            ...entry,
            message: `[${entry.serviceName || 'ROOT'}] ${entry.message}`,
          };
        },
      });

      logger.info('Keep original');
      logger.info('Transform this');

      const service = logger.service('TestService');
      service.info('Service message');

      expect(arraySink.logs.length).toBe(3);
      expect(arraySink.logs[0].message).toBe('Keep original');
      expect(arraySink.logs[1].message).toBe('[ROOT] Transform this');
      expect(arraySink.logs[2].message).toBe('[TestService] Service message');

      const snapshot = arraySink.getSnapshotFriendlyLogs();
      expect(snapshot[0]).toBe('info: Keep original');
      expect(snapshot[1]).toBe('info: [ROOT] Transform this');
      expect(snapshot[2]).toBe('info: [TestService] Service message');
    });

    test('should create frontend optimized logger', () => {
      const { logger: frontendLogger, consoleSink } =
        Logger.createFrontendOptimizedLogger();

      expect(frontendLogger.isLoggerClass).toBe(true);
      expect(frontendLogger.didExit).toBe(false);
      expect(consoleSink).toBeDefined();
      expect(consoleSink.isMuted()).toBe(false);
    });

    test('should create frontend optimized logger with muted console', () => {
      const { consoleSink } = Logger.createFrontendOptimizedLogger({
        muteConsole: true,
      });

      expect(consoleSink.isMuted()).toBe(true);

      // Console should be muted, so we can unmute it
      consoleSink.unmute();
      expect(consoleSink.isMuted()).toBe(false);
    });

    test('should allow muting/unmuting console in test logger', () => {
      const { consoleSink } = Logger.createTestOptimizedLogger({
        includeConsoleSink: true,
      });

      expect(consoleSink).toBeDefined();
      if (!consoleSink) {
        throw new Error('consoleSink should be defined');
      }
      expect(consoleSink.isMuted()).toBe(true); // Default is muted for tests

      consoleSink.unmute();
      expect(consoleSink.isMuted()).toBe(false);

      consoleSink.mute();
      expect(consoleSink.isMuted()).toBe(true);
    });

    test('should create test logger with unmuted console', () => {
      const { consoleSink } = Logger.createTestOptimizedLogger({
        includeConsoleSink: true,
        muteConsole: false,
      });

      expect(consoleSink).toBeDefined();
      if (!consoleSink) {
        throw new Error('consoleSink should be defined');
      }
      expect(consoleSink.isMuted()).toBe(false);
    });

    test('should not include console sink in test logger by default', () => {
      const { consoleSink } = Logger.createTestOptimizedLogger();

      expect(consoleSink).toBeUndefined();
    });
  });

  describe('Close', () => {
    test('should close all sinks', async () => {
      let wasCloseCalled = false;

      const customSink = {
        write: () => {},
        close: () => {
          wasCloseCalled = true;
        },
      };

      const closeLogger = new Logger({
        sinks: [customSink],
        callProcessExit: false,
      });

      await closeLogger.close();

      expect(wasCloseCalled).toBe(true);
    });

    test('should emit close event', async () => {
      const events: any[] = [];

      logger.on('logger', (event) => {
        if ((event as { eventType: string }).eventType === 'close') {
          events.push(event);
        }
      });

      await logger.close();

      expect(events.length).toBe(1);
    });
  });

  describe('Sink Error Handling', () => {
    test('should handle synchronous errors from sinks', () => {
      const errors: any[] = [];
      const syncErrorSink = {
        write: () => {
          throw new Error('Sync write error');
        },
      };

      const loggerWithErrorHandler = new Logger({
        sinks: [syncErrorSink],
        callProcessExit: false,
        onSinkError: (error, context, sink) => {
          errors.push({ error, context, sink });
        },
      });

      loggerWithErrorHandler.info('Test message');

      expect(errors.length).toBe(1);
      expect(errors[0].error.message).toBe('Sync write error');
      expect(errors[0].context).toBe('write');
    });

    test('should handle asynchronous errors from sinks via rejected promises', async () => {
      const errors: any[] = [];
      const asyncErrorSink = {
        write: async () => {
          await sleep(1);
          throw new Error('Async write error');
        },
      };

      const loggerWithErrorHandler = new Logger({
        sinks: [asyncErrorSink],
        callProcessExit: false,
        onSinkError: (error, context, sink) => {
          errors.push({ error, context, sink });
        },
      });

      loggerWithErrorHandler.info('Test message');

      // Wait for promise rejection to be handled
      await sleep(10);

      expect(errors.length).toBe(1);
      expect(errors[0].error.message).toBe('Async write error');
      expect(errors[0].context).toBe('write');
    });

    test('should handle mixed sync and async sinks with errors', async () => {
      const errors: any[] = [];
      const syncErrorSink = {
        write: () => {
          throw new Error('Sync error');
        },
      };
      const asyncErrorSink = {
        write: async () => {
          await sleep(1);
          throw new Error('Async error');
        },
      };
      const workingSink = new ArraySink();

      const loggerWithErrorHandler = new Logger({
        sinks: [syncErrorSink, asyncErrorSink, workingSink],
        callProcessExit: false,
        onSinkError: (error, context, sink) => {
          errors.push({ error, context, sink });
        },
      });

      loggerWithErrorHandler.info('Test message');

      // Wait for async promise rejection to be handled
      await sleep(10);

      // Should have caught both errors
      expect(errors.length).toBe(2);
      expect(errors[0].error.message).toBe('Sync error');
      expect(errors[1].error.message).toBe('Async error');

      // Working sink should still have logged the message
      expect(workingSink.logs.length).toBe(1);
      expect(workingSink.logs[0].message).toBe('Test message');
    });

    test('should fallback to console.error when no onSinkError is provided', async () => {
      const consoleErrorSpy = spyOn(console, 'error');
      const asyncErrorSink = {
        write: async () => {
          await sleep(1);
          throw new Error('Unhandled async error');
        },
      };

      const loggerWithoutErrorHandler = new Logger({
        sinks: [asyncErrorSink],
        callProcessExit: false,
      });

      loggerWithoutErrorHandler.info('Test message');

      // Wait for promise rejection to be handled
      await sleep(10);

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain(
        'Unhandled async error',
      );
    });
  });

  describe('Tags', () => {
    test('should add tags to log entry', () => {
      logger.info('Tagged message', { tags: ['auth', 'security'] });

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].tags).toEqual(['auth', 'security']);
    });

    test('should support tags with all log levels', () => {
      logger.error('Error', { tags: ['critical'] });
      logger.warn('Warning', { tags: ['performance'] });
      logger.success('Success', { tags: ['deploy'] });
      logger.notice('Notice', { tags: ['reminder'] });
      logger.raw('Raw', { tags: ['debug'] });

      expect(arraySink.logs[0].tags).toEqual(['critical']);
      expect(arraySink.logs[1].tags).toEqual(['performance']);
      expect(arraySink.logs[2].tags).toEqual(['deploy']);
      expect(arraySink.logs[3].tags).toEqual(['reminder']);
      expect(arraySink.logs[4].tags).toEqual(['debug']);
    });

    test('should support multiple tags', () => {
      logger.info('Multi-tag message', {
        tags: ['api', 'slow-query', 'database', 'production'],
      });

      expect(arraySink.logs[0].tags).toEqual([
        'api',
        'slow-query',
        'database',
        'production',
      ]);
    });

    test('should not include tags field when empty array', () => {
      logger.info('Empty tags', { tags: [] });

      expect(arraySink.logs[0].tags).toBeUndefined();
    });

    test('should not include tags field when not provided', () => {
      logger.info('No tags');

      expect(arraySink.logs[0].tags).toBeUndefined();
    });

    test('should work with tags and params together', () => {
      logger.info('User {{userID}} action', {
        params: { userID: 123 },
        tags: ['auth', 'user-action'],
      });

      expect(arraySink.logs[0].message).toBe('User 123 action');
      expect(arraySink.logs[0].params).toEqual({ userID: 123 });
      expect(arraySink.logs[0].tags).toEqual(['auth', 'user-action']);
    });

    test('should work with tags and exitCode together', () => {
      logger.error('Fatal error', {
        exitCode: 1,
        tags: ['critical', 'shutdown'],
      });

      expect(arraySink.logs[0].exitCode).toBe(1);
      expect(arraySink.logs[0].tags).toEqual(['critical', 'shutdown']);
      expect(logger.didExit).toBe(true);
    });

    test('should work with errorObject and tags', () => {
      const testError = new Error('Test error');
      logger.errorObject('Error occurred', testError, {
        tags: ['exception', 'unhandled'],
      });

      expect(arraySink.logs[0].error).toBe(testError);
      expect(arraySink.logs[0].tags).toEqual(['exception', 'unhandled']);
    });

    test('should work with service logger and tags', () => {
      const authService = logger.service('auth');
      authService.info('Login successful', { tags: ['login', 'success'] });

      expect(arraySink.logs[0].serviceName).toBe('auth');
      expect(arraySink.logs[0].tags).toEqual(['login', 'success']);
    });
  });

  describe('Entity Loggers', () => {
    test('should create entity logger from service', () => {
      const service = logger.service('component-lifecycle');
      const entity = service.entity('audio-component-123');

      entity.info('Component initialized');

      expect(arraySink.logs.length).toBe(1);
      expect(arraySink.logs[0].serviceName).toBe('component-lifecycle');
      expect(arraySink.logs[0].entityName).toBe('audio-component-123');
      expect(arraySink.logs[0].message).toBe('Component initialized');
    });

    test('should support multiple entities under same service', () => {
      const service = logger.service('scripting');
      const door = service.entity('objects/door-main');
      const enemy = service.entity('objects/enemy-goblin-5');

      door.info('Door opened');
      enemy.warn('Enemy spotted player');

      expect(arraySink.logs.length).toBe(2);
      expect(arraySink.logs[0].serviceName).toBe('scripting');
      expect(arraySink.logs[0].entityName).toBe('objects/door-main');
      expect(arraySink.logs[1].serviceName).toBe('scripting');
      expect(arraySink.logs[1].entityName).toBe('objects/enemy-goblin-5');
    });

    test('should support all log levels in entity logger', () => {
      const service = logger.service('game-engine');
      const entity = service.entity('player-1');

      entity.error('Health depleted');
      entity.info('Picked up item');
      entity.warn('Low health');
      entity.success('Level completed');
      entity.notice('Checkpoint reached');
      entity.raw('Debug info');

      expect(arraySink.logs.length).toBe(6);
      expect(arraySink.logs.map((l) => l.type)).toEqual([
        'error',
        'info',
        'warn',
        'success',
        'notice',
        'raw',
      ]);

      for (const log of arraySink.logs) {
        expect(log.serviceName).toBe('game-engine');
        expect(log.entityName).toBe('player-1');
      }
    });

    test('should support templates in entity logger', () => {
      const service = logger.service('database');
      const entity = service.entity('connection-pool-1');

      entity.info('Connection {{connID}} established', {
        params: { connID: 'conn_xyz123' },
      });

      expect(arraySink.logs[0].message).toBe(
        'Connection conn_xyz123 established',
      );
      expect(arraySink.logs[0].serviceName).toBe('database');
      expect(arraySink.logs[0].entityName).toBe('connection-pool-1');
    });

    test('should support error objects in entity logger', () => {
      const service = logger.service('worker-pool');
      const entity = service.entity('worker-42');
      const error = new Error('Task failed');

      entity.errorObject('Processing error', error);

      expect(arraySink.logs[0].message).toContain('Processing error');
      expect(arraySink.logs[0].message).toContain('Task failed');
      expect(arraySink.logs[0].serviceName).toBe('worker-pool');
      expect(arraySink.logs[0].entityName).toBe('worker-42');
    });

    test('should support tags in entity logger', () => {
      const service = logger.service('api');
      const entity = service.entity('request-abc123');

      entity.warn('Slow response time', {
        tags: ['performance', 'monitoring'],
      });

      expect(arraySink.logs[0].serviceName).toBe('api');
      expect(arraySink.logs[0].entityName).toBe('request-abc123');
      expect(arraySink.logs[0].tags).toEqual(['performance', 'monitoring']);
    });

    test('should support UUID as entity name', () => {
      const service = logger.service('session-manager');
      const entity = service.entity('550e8400-e29b-41d4-a716-446655440000');

      entity.info('Session created');

      expect(arraySink.logs[0].entityName).toBe(
        '550e8400-e29b-41d4-a716-446655440000',
      );
    });

    test('should not include entityName when logging from service directly', () => {
      const service = logger.service('test-service');

      service.info('Service level message');

      expect(arraySink.logs[0].serviceName).toBe('test-service');
      expect(arraySink.logs[0].entityName).toBeUndefined();
    });

    test('should convert empty/whitespace service names to undefined', () => {
      const emptyService = logger.service('');
      const whitespaceService = logger.service('   ');

      emptyService.info('Empty service');
      whitespaceService.info('Whitespace service');

      expect(arraySink.logs[0].serviceName).toBeUndefined();
      expect(arraySink.logs[1].serviceName).toBeUndefined();
    });

    test('should convert empty/whitespace entity names to undefined', () => {
      const service = logger.service('test-service');
      const emptyEntity = service.entity('');
      const whitespaceEntity = service.entity('   ');

      emptyEntity.info('Empty entity');
      whitespaceEntity.info('Whitespace entity');

      expect(arraySink.logs[0].serviceName).toBe('test-service');
      expect(arraySink.logs[0].entityName).toBeUndefined();
      expect(arraySink.logs[1].serviceName).toBe('test-service');
      expect(arraySink.logs[1].entityName).toBeUndefined();
    });
  });
});
