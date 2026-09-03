import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { Logger } from './index';
import { ArraySink } from './sinks/array';
import { sleep } from '../sleep';
import { safeHandleCallback } from '../safe-handle-callback';

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

    test('should support array index access in template params', () => {
      logger.info(
        'Primary user {{users[0].name}} from {{sessions[0].ips[1]}}',
        {
          params: {
            users: [{ name: 'Alice' }],
            sessions: [{ ips: ['10.0.0.1', '10.0.0.2'] }],
          },
        },
      );

      expect(arraySink.logs[0].message).toBe(
        'Primary user Alice from 10.0.0.2',
      );
    });

    test('should support quoted bracket keys in template params', () => {
      logger.info(
        'User {{user["display-name"]}} with public ID {{metadata["public-id"]}}',
        {
          params: {
            user: { 'display-name': 'Alice' },
            metadata: { 'public-id': 'USR-12345' },
          },
        },
      );

      expect(arraySink.logs[0].message).toBe(
        'User Alice with public ID USR-12345',
      );
    });

    test('should stringify Error params in templates and support Error properties', () => {
      const error = new Error('Task failed');

      logger.error('Failure {{error}} / {{error.message}}', {
        params: { error },
      });

      expect(arraySink.logs[0].message).toBe(
        'Failure Error: Task failed / Task failed',
      );
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

    test('should render the message from redacted params when redaction is configured', () => {
      logger.info('Login attempt for {{username}} with {{password}}', {
        params: {
          username: 'john',
          password: 'secret123',
        },
        redactedKeys: ['password'],
      });

      const log = arraySink.logs[0];

      expect(log.message).toBe('Login attempt for john with ********3');
      expect(log.params?.password).toBe('secret123');
      expect(log.redactedParams?.password).not.toBe('secret123');
      expect(log.redactedParams?.password).toBe('********3');
      expect(log.redactedParams?.username).toBe('john');
    });

    test('should keep the shape of a redacted container', () => {
      logger.info('Failure {{error}} / {{users}} / {{metadata}}', {
        params: {
          error: new Error('boom'),
          users: ['a', 'b'],
          metadata: { key: 'value' },
        },
        redactedKeys: ['error', 'users', 'metadata'],
      });

      const log = arraySink.logs[0];

      // An `Error` has no shape worth rebuilding, so it is replaced outright rather than
      // stringified and partially masked - a proportional mask of a rendered object
      // keeps its ends, which is where a secret in a URL or a custom `toString` sits.
      expect(log.redactedParams?.error).toBe('***REDACTED***');

      // A plain object and an array keep their shape, with each leaf masked. Previously
      // the array was joined to 'a,b' and masked as one string, so the edges of both
      // elements survived into a single value.
      expect(log.redactedParams?.users).toEqual([
        '***REDACTED***',
        '***REDACTED***',
      ]);
      expect(log.redactedParams?.metadata).toEqual({ key: '***REDACTED***' });

      // The rendered message interpolates a container the same way it does an
      // unredacted one, so a shape that survives for a structured sink reads as
      // '[object Object]' in the message text.
      expect(log.message).toBe(
        'Failure ***REDACTED*** / ***REDACTED***,***REDACTED*** / [object Object]',
      );
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

    test('should redact array index paths', () => {
      logger.info('User {{users[0].name}} authenticated', {
        params: {
          users: [
            {
              name: 'Alice',
              password: 'secret123',
            },
          ],
        },
        redactedKeys: ['users[0].password'],
      });

      const log = arraySink.logs[0];
      const redacted = log.redactedParams as any;

      expect(log.message).toBe('User Alice authenticated');
      expect(redacted.users[0].name).toBe('Alice');
      expect(redacted.users[0].password).not.toBe('secret123');
      expect(redacted.users[0].password).toBe('********3');
    });

    test('should redact quoted bracket-key paths', () => {
      logger.info('User {{users[0]["display-name"]}} authenticated', {
        params: {
          users: [
            {
              'display-name': 'Alice',
              'password-hash': 'secret123',
            },
          ],
        },
        redactedKeys: ['users[0]["password-hash"]'],
      });

      const log = arraySink.logs[0];
      const redacted = log.redactedParams as any;

      expect(log.message).toBe('User Alice authenticated');
      expect(redacted.users[0]['display-name']).toBe('Alice');
      expect(redacted.users[0]['password-hash']).toBe('********3');
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
    test('should not depend on globalThis.reportError when event primitives exist', () => {
      const originalReportError = (globalThis as Record<string, unknown>)
        .reportError;

      try {
        (globalThis as Record<string, unknown>).reportError = undefined;

        const result = logger.registerReportErrorListener();

        expect(result).toBe('success');
        expect(logger.isReportErrorListenerRegistered()).toBe(true);
      } finally {
        logger.unregisterReportErrorListener();
        (globalThis as Record<string, unknown>).reportError =
          originalReportError;
      }
    });

    test('describes an error event that carries neither an error nor a message', () => {
      // `ErrorEvent.message` defaults to `''`, not `undefined`, so a `??` chain would
      // accept the empty string and log an `Error` with no message at all.
      const sink = new ArraySink();
      const emptyLogger = new Logger({ sinks: [sink], callProcessExit: false });

      emptyLogger.registerReportErrorListener();

      try {
        globalThis.dispatchEvent(new ErrorEvent('error', { cancelable: true }));
      } finally {
        emptyLogger.unregisterReportErrorListener();
      }

      expect(sink.logs.length).toBe(1);
      expect(sink.logs[0].error).toBeInstanceOf(Error);
      expect((sink.logs[0].error as Error).message).toBe(
        'Unknown error reported by an error event',
      );
    });

    test('survives an error event whose payload cannot be inspected', () => {
      // The payload belongs to whoever dispatched the event. `instanceof` walks a
      // prototype chain, which a revoked `Proxy` refuses, and rendering reads `stack`,
      // which can be a throwing accessor. An escaping throw here would skip the
      // cancellation below and, outside a browser, take the process down from inside the
      // error-reporting path.
      const { proxy, revoke } = Proxy.revocable({}, {});

      revoke();

      const hostileStack = new Error('hostile stack');

      Object.defineProperty(hostileStack, 'stack', {
        get(): never {
          throw new Error('stack getter boom');
        },
      });

      for (const payload of [proxy, hostileStack]) {
        const sink = new ArraySink();
        const hostileLogger = new Logger({
          sinks: [sink],
          callProcessExit: false,
        });

        hostileLogger.registerReportErrorListener();

        const originalConsoleError = console.error;
        console.error = (): void => {};

        let wasNotCancelled = true;

        try {
          expect(() => {
            wasNotCancelled = globalThis.dispatchEvent(
              new ErrorEvent('error', { error: payload, cancelable: true }),
            );
          }).not.toThrow();
        } finally {
          console.error = originalConsoleError;
          hostileLogger.unregisterReportErrorListener();
        }

        // Claimed, so the report is not written twice.
        expect(wasNotCancelled).toBe(false);
      }
    });

    test('keeps a non-Error payload reachable as a non-enumerable cause', () => {
      const sink = new ArraySink();
      const payloadLogger = new Logger({
        sinks: [sink],
        callProcessExit: false,
      });

      payloadLogger.registerReportErrorListener();

      const payload = { code: 'E42' };

      globalThis.dispatchEvent(
        new ErrorEvent('error', {
          error: payload,
          message: 'Uncaught [object Object]',
          cancelable: true,
        }),
      );

      payloadLogger.unregisterReportErrorListener();

      const logged = sink.logs[0].error as Error;

      expect(logged.cause).toBe(payload);

      // Non-enumerable, as the constructor form gives: an arbitrary payload must not
      // start appearing in a JSON-serialized log entry.
      expect(Object.keys(logged).includes('cause')).toBe(false);
    });

    test('cancels the event by default so the error is not also consoled', () => {
      logger.registerReportErrorListener();

      // Dispatched against the real global EventTarget: a stubbed dispatchEvent would
      // return whatever the stub chose and would pass even without `cancelable: true`.
      const wasNotCancelled = globalThis.dispatchEvent(
        new ErrorEvent('error', {
          error: new Error('Cancelled by the logger'),
          cancelable: true,
        }),
      );

      logger.unregisterReportErrorListener();

      expect(wasNotCancelled).toBe(false);
    });

    test('leaves the event uncancelled when preventDefault is opted out', () => {
      logger.registerReportErrorListener('Uncaught exception', {
        preventDefault: false,
      });

      const wasNotCancelled = globalThis.dispatchEvent(
        new ErrorEvent('error', {
          error: new Error('Left for the console'),
          cancelable: true,
        }),
      );

      logger.unregisterReportErrorListener();

      expect(wasNotCancelled).toBe(true);
    });

    test('logs an error event that carries only a message', () => {
      const sink = new ArraySink();
      const messageOnlyLogger = new Logger({
        sinks: [sink],
        callProcessExit: false,
      });

      messageOnlyLogger.registerReportErrorListener();

      // Resource-load failures and some uncaught browser errors arrive with no `error`
      // object at all, which must not log as `undefined`.
      globalThis.dispatchEvent(
        new ErrorEvent('error', {
          message: 'Script error.',
          cancelable: true,
        }),
      );

      messageOnlyLogger.unregisterReportErrorListener();

      expect(sink.logs.length).toBe(1);
      expect(sink.logs[0].message).toContain('Script error.');
    });

    test('stops claiming reports once the logger is closed', async () => {
      const sink = new ArraySink();
      const closingLogger = new Logger({
        sinks: [sink],
        callProcessExit: false,
      });

      closingLogger.registerReportErrorListener();

      await closingLogger.close();

      expect(closingLogger.isReportErrorListenerRegistered()).toBe(false);

      // A closed logger's handleLog is a no-op, so cancelling would leave the error with
      // nowhere to go: not a sink, and not the console either.
      const consoled: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]): void => {
        consoled.push(args[0]);
      };

      try {
        safeHandleCallback('afterCloseCallback', () => {
          throw new Error('After close boom');
        });
      } finally {
        console.error = originalConsoleError;
      }

      expect(sink.logs.length).toBe(0);
      expect(consoled.length).toBe(1);
      expect((consoled[0] as Error).message).toContain('After close boom');
    });

    test('routes logger handler failures to onEventHandlerError', () => {
      const seen: Array<{ message: string; event: string }> = [];
      const handlerLogger = new Logger({
        sinks: [new ArraySink()],
        callProcessExit: false,
        onEventHandlerError: (error, event) => {
          seen.push({ message: error.message, event });
        },
      });

      handlerLogger.on('logger', () => {
        throw new Error('handler boom');
      });

      handlerLogger.info('kick it off');

      expect(seen.length).toBe(1);
      expect(seen[0].event).toBe('logger');
      expect(seen[0].message).toContain('handler boom');
    });

    test('survives a logger handler that throws a non-Error value', () => {
      // `throw` accepts any value. Reading `.message` off it unguarded raised a
      // `TypeError` that escaped `emit()` and out of the log call itself, so a handler
      // throwing `null` took down every `logger.*()` call, not just its own report.
      const thrown: unknown[] = [
        null,
        undefined,
        'boom',
        42,
        {
          toString(): string {
            throw new Error('hostile toString');
          },
        },
      ];

      const methods = [
        'info',
        'error',
        'warn',
        'success',
        'notice',
        'debug',
        'raw',
      ] as const;

      for (const value of thrown) {
        for (const method of methods) {
          const seen: Array<{ message: string; cause: unknown }> = [];
          const nonErrorLogger = new Logger({
            sinks: [new ArraySink()],
            callProcessExit: false,
            onEventHandlerError: (error) => {
              seen.push({ message: error.message, cause: error.cause });
            },
          });

          nonErrorLogger.on('logger', () => {
            throw value;
          });

          expect(() => {
            nonErrorLogger[method]('kick it off');
          }).not.toThrow();

          expect(seen.length).toBe(1);
          expect(seen[0].message).toContain('Non-error value thrown');
          // The value actually thrown survives, reachable through the wrapper. The
          // description is lossy — for the hostile-`toString` case it is just
          // 'unknown value' — so the cause is the only way back to it.
          expect((seen[0].cause as Error).cause).toBe(value);
        }
      }
    });

    test('survives a thrown value whose prototype chain cannot be walked', () => {
      // `instanceof` is not a safe read either: it walks a prototype chain, and a
      // revoked `Proxy` throws on any operation. Guarding only `String()` left this
      // crashing out of the log call.
      const { proxy, revoke } = Proxy.revocable({}, {});

      revoke();

      const seen: string[] = [];
      const proxyLogger = new Logger({
        sinks: [new ArraySink()],
        callProcessExit: false,
        onEventHandlerError: (error) => {
          seen.push(error.message);
        },
      });

      proxyLogger.on('logger', () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
        throw proxy;
      });

      expect(() => {
        proxyLogger.info('kick it off');
      }).not.toThrow();

      expect(seen.length).toBe(1);
      expect(seen[0]).toContain('Non-error value thrown: unknown value');
    });

    test('survives a logger handler that rejects with a non-Error value', async () => {
      const seen: string[] = [];
      const rejectingLogger = new Logger({
        sinks: [new ArraySink()],
        callProcessExit: false,
        onEventHandlerError: (error) => {
          seen.push(error.message);
        },
      });

      rejectingLogger.on('logger', async () => {
        await Promise.resolve();

        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
        throw null;
      });

      rejectingLogger.info('kick it off');

      // The rejection is reported, not left as an unhandled rejection.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(seen.length).toBe(1);
      expect(seen[0]).toContain('Non-error value thrown: null');
    });

    test('falls back to the console when onEventHandlerError itself throws', () => {
      const consoled: unknown[] = [];
      const throwingLogger = new Logger({
        sinks: [new ArraySink()],
        callProcessExit: false,
        onEventHandlerError: () => {
          throw new Error('reporter boom');
        },
      });

      throwingLogger.on('logger', () => {
        throw new Error('handler boom');
      });

      const originalConsoleError = console.error;
      console.error = (...args: unknown[]): void => {
        consoled.push(args[0]);
      };

      try {
        throwingLogger.info('kick it off');
      } finally {
        console.error = originalConsoleError;
      }

      // The reporter failing must not lose the original, nor turn one failure into a loop.
      expect(consoled.length).toBe(1);
      expect(String(consoled[0])).toContain('handler boom');
    });

    test('does not cycle when an async logger event handler rejects', async () => {
      const sink = new ArraySink();
      const cyclingLogger = new Logger({
        sinks: [sink],
        callProcessExit: false,
      });

      cyclingLogger.registerReportErrorListener();

      let handlerCalls = 0;

      // An async rejection is reported in a later microtask, so it is not re-entrant and
      // the listener's guard cannot see it. Before the failure of a logger handler was
      // kept off the global channel, this cycled without bound: log, emit, reject,
      // report, log again.
      cyclingLogger.on('logger', async () => {
        handlerCalls++;

        await Promise.resolve();

        throw new Error('async handler boom');
      });

      const originalConsoleError = console.error;
      console.error = (): void => {};

      try {
        cyclingLogger.info('kick it off');

        await sleep(50);
      } finally {
        console.error = originalConsoleError;
        cyclingLogger.unregisterReportErrorListener();
      }

      expect(handlerCalls).toBe(1);
    });

    test('does not recurse when a logger event handler throws', () => {
      const sink = new ArraySink();
      const recursiveLogger = new Logger({
        sinks: [sink],
        callProcessExit: false,
      });

      recursiveLogger.registerReportErrorListener();

      let handlerCalls = 0;

      // Logging emits a 'logger' event. The failure of a 'logger' handler is kept off
      // the global 'error' channel by handleEventHandlerFailure, so it never re-enters
      // this listener: the handler runs exactly once per log call, not once more for a
      // report of its own failure.
      recursiveLogger.on('logger', () => {
        handlerCalls++;

        throw new Error('handler boom');
      });

      const originalConsoleError = console.error;
      console.error = (): void => {};

      try {
        recursiveLogger.info('kick it off');
      } finally {
        console.error = originalConsoleError;
        recursiveLogger.unregisterReportErrorListener();
      }

      // Exactly the one emit the log itself performed.
      expect(handlerCalls).toBe(1);
    });

    test('re-entrancy guard turns away a report raised by a failing sink', () => {
      // What the guard actually protects: a sink is user code, and one that drives
      // safeHandleCallback with a failing callback reports on the same 'error' channel
      // synchronously, while this listener is still logging. The nested report is left
      // uncancelled and unlogged, so safe-handle-callback's console fall-through takes
      // it once instead of feeding it back into the sink that is already failing.
      const sink = new ArraySink();
      const reentrantSink = {
        write: (entry: unknown): void => {
          sink.write(entry as Parameters<typeof sink.write>[0]);

          safeHandleCallback('innerSinkCallback', () => {
            throw new Error('inner boom');
          });
        },
      };

      const reentrantLogger = new Logger({
        sinks: [reentrantSink],
        callProcessExit: false,
      });

      reentrantLogger.registerReportErrorListener();

      const consoled: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]): void => {
        consoled.push(args[0]);
      };

      try {
        safeHandleCallback('outerCallback', () => {
          throw new Error('outer boom');
        });
      } finally {
        console.error = originalConsoleError;
        reentrantLogger.unregisterReportErrorListener();
      }

      // The outer report reached the sinks once, and did not loop.
      expect(sink.logs.length).toBe(1);
      expect(sink.logs[0].message).toContain('outer boom');

      // The nested one went to the console instead, without this logger's formatting.
      expect(consoled.length).toBe(1);
      expect(String((consoled[0] as Error).message)).toContain('inner boom');
    });

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

    test('should return closed and attach nothing after close()', async () => {
      await logger.close();

      const result = logger.registerReportErrorListener();

      // A logger is never reopened, so a listener registered here could never log or
      // cancel anything — it would just sit on globalThis keeping the logger and its
      // sinks alive while reporting 'success' to a caller capturing nothing.
      expect(result).toBe('closed');
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

    test('survives a sink that throws a non-Error value', () => {
      // Sinks are user-supplied, so `write()` can throw anything. Reading `.message` off
      // it unguarded raised a `TypeError` that escaped out of the log call itself.
      const errors: Array<{ message: string; cause: unknown }> = [];
      const nonErrorSink = {
        write: (): void => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
          throw null;
        },
      };

      const nonErrorLogger = new Logger({
        sinks: [nonErrorSink],
        callProcessExit: false,
        onSinkError: (error, context) => {
          errors.push({ message: error.message, cause: error.cause });
          expect(context).toBe('write');
        },
      });

      expect(() => {
        nonErrorLogger.info('Test message');
      }).not.toThrow();

      expect(errors.length).toBe(1);
      // `onSinkError` declares an `Error` parameter, so it is handed a real one.
      expect(errors[0].message).toBe('Non-error value thrown: null');
      expect(errors[0].cause).toBe(null);
    });

    test('survives a sink that rejects with a non-Error value', async () => {
      const errors: string[] = [];
      const rejectingSink = {
        write: async (): Promise<void> => {
          await sleep(1);

          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
          throw undefined;
        },
      };

      const rejectingLogger = new Logger({
        sinks: [rejectingSink],
        callProcessExit: false,
        onSinkError: (error) => {
          errors.push(error.message);
        },
      });

      rejectingLogger.info('Test message');

      // Reported, not left as an unhandled rejection.
      await sleep(20);

      expect(errors.length).toBe(1);
      expect(errors[0]).toBe('Non-error value thrown: undefined');
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
