import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../internal/console-test-utils';
import { Logger } from './index';
import { ArraySink } from './sinks/array';
import { sleep } from '../sleep';
import { safeHandleCallback } from '../safe-handle-callback';
import { stringifyValue } from '../stringify-value';

// These suites deliberately drive the paths that fall through to `console.error` when
// nothing claims the report. Captured rather than printed so a real failure in the run
// output still stands out; flip `DEBUG` in the helper to see them.
beforeEach(() => {
  muteConsoleError();
});

afterEach(() => {
  restoreConsoleError();
});

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
    test('should fail closed when redactedKeys is not an array', () => {
      // The gate used to ask a caller-supplied list how long it was before asking what it
      // was. A `Set`, or anything else without a numeric `length`, answered `undefined`,
      // and `undefined > 0` read as "no redaction requested" - so the params went to every
      // sink in the clear and `applyRedaction`'s own `Array.isArray` guard never ran,
      // because nothing called it.
      const failures: string[] = [];
      const strictLogger = new Logger({
        sinks: [arraySink],
        onFormatError: (error, _kind, key) => {
          failures.push(key);
        },
      });

      strictLogger.info('pw={{password}}', {
        params: { password: 'hunter2' },
        redactedKeys: new Set(['password']) as unknown as string[],
      });

      const log = arraySink.logs[0];

      expect(log.message).not.toContain('hunter2');
      expect(log.redactedParams?.password).not.toBe('hunter2');
      expect(failures.length).toBeGreaterThan(0);
    });

    test('should not hand a sink a redactedKeys it cannot read', () => {
      // The copy is what makes `entry.redactedKeys` inert. When the copy itself fails,
      // the caller's object used to be put on the entry with its traps still attached, so
      // a sink reading `.length` or `.join(',')` threw inside `sink.write`.
      const hostile = new Proxy(['password'], {
        get(target, key, receiver) {
          if (key === 'length') {
            throw new Error('no length');
          }

          return Reflect.get(target, key, receiver);
        },
      });

      const strictLogger = new Logger({
        sinks: [arraySink],
        onFormatError: () => {},
      });

      strictLogger.info('pw={{password}}', {
        params: { password: 'hunter2' },
        redactedKeys: hostile,
      });

      const log = arraySink.logs[0];

      expect(log.message).not.toContain('hunter2');
      expect(log.redactedKeys).toBeUndefined();
    });

    test('should fail closed on a falsy redactedKeys that is not an array', () => {
      // `undefined` is the caller saying nothing about redaction. `null`, `0`, `''` and
      // `false` are a supplied list that cannot name a key, which has to fail closed and
      // say so - not hand the params back untouched under a name claiming they were masked.
      for (const bogus of [null, 0, '', false]) {
        const sink = new ArraySink();
        let reports = 0;
        const strictLogger = new Logger({
          sinks: [sink],
          onFormatError: () => {
            reports++;
          },
        });

        strictLogger.info('pw={{password}}', {
          params: { password: 'hunter2' },
          redactedKeys: bogus as unknown as string[],
        });

        const log = sink.logs[0];

        expect(log.message).not.toContain('hunter2');
        expect(log.redactedParams?.password).toBeUndefined();
        expect(reports).toBeGreaterThan(0);
      }
    });

    test('should treat an absent or empty redactedKeys as no redaction', () => {
      for (const empty of [undefined, []]) {
        const sink = new ArraySink();
        const plainLogger = new Logger({ sinks: [sink] });

        plainLogger.info('pw={{password}}', {
          params: { password: 'hunter2' },
          redactedKeys: empty,
        });

        expect(sink.logs[0].message).toBe('pw=hunter2');
        expect(sink.logs[0].redactedParams).toBeUndefined();
      }
    });

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
      // unredacted one - as JSON - so the masked leaves are visible in the message
      // text rather than hidden behind '[object Object]'.
      expect(log.message).toBe(
        'Failure ***REDACTED*** / ["***REDACTED***","***REDACTED***"] / {"key":"***REDACTED***"}',
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

    test('should redact every array element named by a wildcard', () => {
      for (const entry of ['users[*].password', 'users.*.password']) {
        arraySink.logs.length = 0;

        logger.info('User {{users[1].name}} authenticated', {
          params: {
            users: [
              { name: 'Alice', password: 'secret123' },
              { name: 'Bob', password: 'secret456' },
            ],
          },
          redactedKeys: [entry],
        });

        const redacted = arraySink.logs[0].redactedParams as any;

        expect(arraySink.logs[0].message).toBe('User Bob authenticated');
        expect(redacted.users[0].name).toBe('Alice');
        expect(redacted.users[1].name).toBe('Bob');
        expect(redacted.users[0].password).toBe('********3');
        expect(redacted.users[1].password).toBe('********6');
      }
    });

    test('should widen a wildcard element the way a concrete index does', () => {
      // Every container a path descends through is normalized before the walk, so the
      // walk and the template renderer are handed one set of keys rather than two - a key
      // only property lookup can reach is dropped instead of being printed unmasked. That
      // normalization follows the parsed path, so a wildcard has to reach the same
      // containers a concrete index does, or it would cover strictly less than the path it
      // generalizes.
      for (const entry of ['users[*].password', 'users[0].password']) {
        arraySink.logs.length = 0;

        const hidden = new Proxy(
          { name: 'Alice', password: 'secret123' },
          { ownKeys: () => ['name'] },
        );

        logger.info('User {{users[0].name}} authenticated', {
          params: { users: [hidden] },
          redactedKeys: [entry],
        });

        const redacted = arraySink.logs[0].redactedParams as any;

        expect(redacted.users[0].name).toBe('Alice');
        // The element is replaced by a copy carrying exactly the keys enumeration can
        // see, so the hidden one is neither masked nor printed. Left un-normalized, the
        // original is handed back by reference and a sink reads `'secret123'` off it.
        expect(redacted.users[0].password).toBeUndefined();
        expect(arraySink.logs[0].message).not.toContain('secret123');
      }
    });

    test('should read a wildcard over a plain object as the key spelled *', () => {
      logger.info('Bag', {
        params: {
          users: {
            '*': { password: 'secret123' },
            alice: { password: 'secret456' },
          },
        },
        redactedKeys: ['users.*.password'],
      });

      const redacted = arraySink.logs[0].redactedParams as any;

      expect(redacted.users['*'].password).toBe('********3');
      // Never widened across an object's keys: naming one field must not quietly mask
      // the bag it sits in.
      expect(redacted.users.alice.password).toBe('secret456');
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
      // `reportCallbackError` renders at the console rung, so the fall-through carries
      // the rendered text rather than the wrapper error.
      expect(String(consoled[0])).toContain('After close boom');
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
      expect(String(consoled[0])).toContain('inner boom');
    });

    test('re-entrancy guard is shared when multiple loggers trigger render failures', () => {
      const hostileValue = (): Record<string, unknown> => {
        const value: Record<string, unknown> = {};

        Object.defineProperty(value, 'token', {
          get() {
            throw new Error('accessor refused');
          },
          enumerable: true,
        });

        return value;
      };
      const capturedSinks = [new ArraySink(), new ArraySink()];
      const listeners = capturedSinks.map((capturedSink) => {
        const listener = new Logger({
          sinks: [
            {
              write: (entry): void => {
                capturedSink.write(entry);
                stringifyValue({ user: hostileValue() });
              },
            },
          ],
          callProcessExit: false,
        });

        listener.registerReportErrorListener();
        return listener;
      });

      const consoled: unknown[] = [];
      const originalConsoleError = console.error;
      console.error = (...args: unknown[]): void => {
        consoled.push(args[0]);
      };

      try {
        for (const message of ['outer boom one', 'outer boom two']) {
          safeHandleCallback('outerCallback', () => {
            throw new Error(message);
          });
        }
      } finally {
        console.error = originalConsoleError;

        for (const listener of listeners) {
          listener.unregisterReportErrorListener();
        }
      }

      // Both top-level reports reach both listeners exactly once. Without a shared
      // cross-logger guard, each sink's nested report re-enters the other logger too.
      for (const capturedSink of capturedSinks) {
        expect(capturedSink.logs.map((entry) => entry.message)).toEqual([
          expect.stringContaining('outer boom one'),
          expect.stringContaining('outer boom two'),
        ]);
      }

      // Each listener's standalone render raises one nested report per top-level report.
      // They terminate at the console, and the second top-level report proves the lease
      // was released.
      expect(consoled).toHaveLength(4);
      expect(
        consoled.every((entry) => String(entry).includes('Render failed')),
      ).toBe(true);
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

    test('closes the sinks even when removeEventListener is gone', async () => {
      // `close()` gives up the global listener before it closes the sinks. That call was
      // unguarded, so a global that was usable at register time and is not at close time
      // rejected `close()` before any sink saw it, leaving a file or pipe sink holding
      // its handle for the life of the process.
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

      closeLogger.registerReportErrorListener();

      const original = globalThis.removeEventListener;

      globalThis.removeEventListener = () => {
        throw new Error('removeEventListener gone');
      };

      try {
        await closeLogger.close();
      } finally {
        globalThis.removeEventListener = original;
      }

      expect(wasCloseCalled).toBe(true);
      expect(closeLogger.isReportErrorListenerRegistered()).toBe(false);
    });

    test('keeps the registration when a live unregister could not take it off', async () => {
      // Clearing the state unconditionally was right only on the `close()` path, where the
      // listener is inert because `_closed` is set first. On a live logger it left the
      // closure attached and still cancelling events while
      // `isReportErrorListenerRegistered()` answered `false`, so the next `register` put a
      // *second* one on and every reported error was logged twice.
      const liveLogger = new Logger({ sinks: [], callProcessExit: false });

      liveLogger.registerReportErrorListener();

      const original = globalThis.removeEventListener;

      globalThis.removeEventListener = () => {
        throw new Error('removeEventListener gone');
      };

      let result: string;

      try {
        result = liveLogger.unregisterReportErrorListener();
      } finally {
        globalThis.removeEventListener = original;
      }

      // And said so. `'success'` claimed the listener was off while the closure went on
      // receiving every global `'error'` and cancelling it, and it contradicted
      // `isReportErrorListenerRegistered()` below - so a caller had no way to tell a
      // removal that happened from one that did not. `'not_available'` is what the
      // matching `register` answers for the same refusal.
      expect(result).toBe('not_available');
      expect(liveLogger.isReportErrorListenerRegistered()).toBe(true);

      await liveLogger.close();
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

describe('Logger - redaction and non-plain params', () => {
  test('renders a Date and an Error param beside a redacted one', () => {
    // The message is rendered from the redacted params, so a param flattened by
    // redaction is a param the template cannot read. `{{error.message}}` going blank the
    // moment any key is redacted is the case that matters most.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.info('{{when}} / {{failure.message}} / {{password}}', {
      params: {
        password: 'hunter2secret',
        when: new Date('2020-01-01T00:00:00Z'),
        failure: new Error('boom'),
      },
      redactedKeys: ['password'],
    });

    const entry = sink.logs[0];

    expect(entry?.message).toContain('2020');
    expect(entry?.message).toContain('boom');
    expect(entry?.message).not.toContain('hunter2secret');

    // The structured view a sink reads agrees with the rendered text.
    expect(
      (entry?.redactedParams?.['failure'] as Error | undefined)?.message,
    ).toBe('boom');
  });
});

describe('Logger - errorObject redaction reaches the caller, not the console', () => {
  // `prepareErrorObjectLog` rendered the error with the library defaults, so the logger's
  // own `redactFunction` did not apply and a redaction failure went to `console.error`
  // even when the caller had supplied a handler - and did so *alongside* the params
  // report, twice for one call, one of them uninterceptable.
  test('a redaction failure while rendering the error reaches onFormatError', () => {
    const keys: string[] = [];
    const consoleLines: string[] = [];
    const realError = console.error;

    console.error = (...args: unknown[]): void => {
      consoleLines.push(String(args[0]));
    };

    try {
      const error = new Error('boom') as Error & {
        additionalInfo: unknown;
        sensitiveFieldNames: unknown;
      };

      error.additionalInfo = { token: 'x' };
      error.sensitiveFieldNames = 'not-a-list';

      const logger = new Logger({
        sinks: [new ArraySink()],
        onFormatError: (_error, _kind, key) => keys.push(key),
      });

      logger.errorObject('prefix', error);

      expect(keys).toEqual(['<sensitiveFieldNames>']);
      expect(consoleLines).toEqual([]);
    } finally {
      console.error = realError;
    }
  });

  test('the logger redactFunction applies to a rendered error too', () => {
    // Otherwise the same value masks one way as a param and another way inside an error.
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      redactFunction: () => '[CUSTOM]',
    });

    const error = new Error('boom') as Error & {
      additionalInfo: unknown;
      sensitiveFieldNames: unknown;
    };

    error.additionalInfo = { token: 'hunter2secret' };
    error.sensitiveFieldNames = ['token'];

    logger.errorObject('prefix', error);

    expect(sink.logs[0]?.message).toContain('[CUSTOM]');
    expect(sink.logs[0]?.message).not.toContain('hunter2secret');
  });

  test('a service or entity logger renders an error the same way', () => {
    // `LoggerService.errorObject` called the shared helper directly, which left it the
    // one surface rendering with the library defaults: the same value masked one way
    // through `logger.errorObject` and another through `logger.service(...).errorObject`,
    // and a failure there went to the console the caller had replaced.
    const keys: string[] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      redactFunction: () => '[CUSTOM]',
      onFormatError: (_error, _kind, key) => keys.push(key),
    });

    const makeError = (): Error => {
      const error = new Error('boom') as Error & {
        additionalInfo: unknown;
        sensitiveFieldNames: unknown;
      };

      error.additionalInfo = { token: 'hunter2secret' };
      error.sensitiveFieldNames = ['token'];

      return error;
    };

    logger.service('api').errorObject('prefix', makeError());
    logger.service('api').entity('users').errorObject('prefix', makeError());

    for (const entry of sink.logs) {
      expect(entry.message).toContain('[CUSTOM]');
      expect(entry.message).not.toContain('hunter2secret');
    }

    const broken = new Error('boom') as Error & {
      additionalInfo: unknown;
      sensitiveFieldNames: unknown;
    };

    broken.additionalInfo = { token: 'x' };
    broken.sensitiveFieldNames = 'not-a-list';

    logger.service('api').errorObject('prefix', broken);

    expect(keys).toEqual(['<sensitiveFieldNames>']);
  });
});

describe('Logger - a redactedKeys list that will not be read twice', () => {
  const SECRET = 'hunter2secret';

  /**
   * A `redactedKeys` whose `length` answers differently each time it is read.
   *
   * `redactedKeys` is caller-supplied, so `length` need not be a data property: a `Proxy`
   * answers it from a trap, which is free to throw or to lie. It was read at four points
   * across one log call, and each of them believing something different is what the
   * copy taken in `handleLog` exists to stop.
   */
  const lyingLength = (answers: (number | 'throw')[]): string[] => {
    let read = 0;

    return new Proxy(['password'], {
      get(target, property, receiver): unknown {
        if (property === 'length') {
          const answer = answers[Math.min(read++, answers.length - 1)];

          if (answer === 'throw') {
            throw new Error('length is not for you');
          }

          return answer;
        }

        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  };

  test('a list that later reads as empty does not hand back the params in the clear', () => {
    // The leak this closes: `handleLog` saw one key and asked for redaction,
    // `applyRedaction` read the same list as empty and returned `params` untouched - so
    // the value redaction was asked to hide was rendered into the message and written to
    // every sink.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.info('login {{password}}', {
      params: { password: SECRET },
      redactedKeys: lyingLength([1, 0]),
    });

    const entry = sink.logs[0];

    expect(entry?.message).not.toContain(SECRET);
    expect(entry?.redactedParams?.['password']).not.toBe(SECRET);
    expect(entry?.redactedKeys).toEqual(['password']);
  });

  test('a list that refuses a later read fails closed instead of throwing', () => {
    // The second read was outside every guard, so a list that answered once and then
    // refused threw straight out of `logger.info()` - after redaction had already
    // succeeded. An unreadable list counts as *requested*: it was supplied, and this
    // cannot tell what for, so nothing of the params is rendered.
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: () => {},
    });

    expect(() => {
      logger.info('login {{password}}', {
        params: { password: SECRET },
        redactedKeys: lyingLength([1, 'throw']),
      });
    }).not.toThrow();

    const entry = sink.logs[0];

    expect(entry?.message).not.toContain(SECRET);
    expect(entry?.redactedParams?.['password']).not.toBe(SECRET);
    // The params themselves are still the caller's own object, by reference, as they are
    // on every other log call.
    expect(entry?.params?.['password']).toBe(SECRET);
  });

  test('an under-reporting list is refused rather than read as empty', () => {
    // The lie every guard here used to miss, because every guard was built for a list that
    // *throws*. A `Proxy` over a real array whose `length` reads `0` passes
    // `Array.isArray`, spreads to `[]`, and reports a count of zero - so the gate concluded
    // no redaction was requested, `applyRedaction` was never called, and the secret went to
    // every sink in clear text with `redactedKeys` reading `undefined` and nothing
    // reported. Not one exception was raised anywhere in that path.
    //
    // It is caught by the one invariant a real array cannot break: an own index key at or
    // beyond its own `length`.
    const failures: [string, string][] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: (error, _kind, key) => failures.push([key, error.message]),
    });

    const underReporting = new Proxy(['password'], {
      get(target, property, receiver): unknown {
        if (property === 'length') {
          return 0;
        }

        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    logger.info('login {{password}}', {
      params: { password: SECRET },
      redactedKeys: underReporting,
    });

    expect(failures.length).toBe(1);
    expect(failures[0]?.[0]).toBe('<redactedKeys>');
    expect(sink.logs[0]?.message).not.toContain(SECRET);
    expect(JSON.stringify(sink.logs[0]?.redactedParams)).not.toContain(SECRET);
  });

  test('a params pass that fails both ways reports both, not one of them', () => {
    // `applyRedaction` keeps two reporters on purpose - a container that refuses to
    // enumerate is `'redaction'`, a leaf whose `toString` throws on its way to the mask is
    // `'render'` - because each fires once per operation and sharing one let an
    // unrenderable value consume the report a genuinely broken redaction still needed.
    // Funnelling both into one backstop here re-collapsed exactly that: the logger called
    // `onFormatError` once, with the kind rewritten to `'redaction'`, and the other failure
    // was mentioned to nobody.
    const seen: [string, string][] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: (_error, kind, key) => seen.push([kind, key]),
    });

    class Token {
      public toString(): string {
        throw new Error('toString refused');
      }
    }

    const unreadable = new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new Error('ownKeys refused');
        },
      },
    );

    logger.info('login {{token}}', {
      params: { token: new Token(), bag: unreadable },
      redactedKeys: ['token', 'bag.a'],
    });

    const kinds = seen.map(([kind]) => kind);

    expect(kinds).toContain('redaction');
    expect(kinds).toContain('render');

    // Still once per kind, never once per value.
    expect(kinds.filter((kind) => kind === 'redaction').length).toBe(1);
    expect(kinds.filter((kind) => kind === 'render').length).toBe(1);
  });

  test('a genuinely empty list is still read as "nothing was asked for"', () => {
    // The counterpart the check above must not break: an empty array has no index keys at
    // all, so it passes cleanly and means what it says. A sparse array passes too - its
    // keys are always below its length - and its holes are refused further down as
    // non-strings, which is unchanged.
    const failures: [string, string][] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: (error, _kind, key) => failures.push([key, error.message]),
    });

    logger.info('login {{password}}', {
      params: { password: SECRET },
      redactedKeys: [],
    });

    expect(failures.length).toBe(0);
    expect(sink.logs[0]?.message).toContain(SECRET);
    expect(sink.logs[0]?.redactedKeys).toBeUndefined();
  });

  test('a list holding a non-string never reaches a sink as one', () => {
    // `snapshotList` reports what the list *holds*, not what its elements are, so the
    // snapshot was cast straight to `string[]` and stored - putting a number, and the
    // caller's own object with its traps still attached, exactly where the copy exists to
    // remove them. A sink then does the ordinary thing with the field it is handed,
    // `.join(',')` or `.map(k => k.toUpperCase())`, and throws inside `sink.write`: one
    // bad list became an `onSinkError` for every registered sink on that call.
    const caller = { a: 1 };
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: () => {},
    });

    logger.info('login {{password}}', {
      params: { password: SECRET },
      redactedKeys: [123, caller] as unknown as string[],
    });

    const entry = sink.logs[0];

    // Nothing this field could honestly name: redaction has already failed closed, and
    // the caller's object must not travel to a sink on it either way.
    expect(entry?.redactedKeys).toBeUndefined();
    expect(entry?.message).not.toContain(SECRET);
    expect(JSON.stringify(entry?.redactedParams)).not.toContain(SECRET);
  });

  test('a list of strings is still handed to the sink as an inert copy', () => {
    // The counterpart the check above must not break. The copy is also what keeps the
    // caller's own array off the entry, so a later mutation of it cannot rewrite what a
    // sink already recorded.
    const requested = ['password'];
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    logger.info('login {{password}}', {
      params: { password: SECRET },
      redactedKeys: requested,
    });

    requested[0] = 'rewritten';

    expect(sink.logs[0]?.redactedKeys).toEqual(['password']);
  });

  test('a list that cannot be read at all reaches onFormatError', () => {
    // The fail-closed guards used to swallow the cause, which broke the promise
    // `onFormatError` keeps on every other surface that redacts - `applyRedaction` for
    // params, `errorToString` for an error's `sensitiveFieldNames`, `redactValue` and
    // `stringifyValue`. All of those hand a failure to the handler; these guards, which
    // exist precisely for input nothing below them can read, left an operator with a
    // blanked message and nothing to trace it with.
    const failures: [string, string][] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: (error, _kind, key) => failures.push([key, error.message]),
    });

    logger.info('login {{password}}', {
      params: { password: SECRET },
      // Refuses the very first read, so there is no snapshot to be had. A list that
      // answers once and refuses later is a different case and now succeeds, since it is
      // only ever asked once - see the sibling test above.
      redactedKeys: lyingLength(['throw']),
    });

    // Once, not once per guard the one unreadable list trips.
    expect(failures.length).toBe(1);
    expect(failures[0]?.[0]).toBe('<redactedKeys>');
    expect(sink.logs[0]?.message).not.toContain(SECRET);
  });

  test('a list that reads cleanly reports no failure', () => {
    const failures: [string, string][] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: (error, _kind, key) => failures.push([key, error.message]),
    });

    logger.info('login {{password}}', {
      params: { password: SECRET },
      redactedKeys: ['password'],
    });

    expect(failures).toEqual([]);
    expect(sink.logs[0]?.message).not.toContain(SECRET);
  });

  test('an ordinary list is still reported as the caller wrote it', () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const keys = ['password'];

    logger.info('login {{password}}', {
      params: { password: SECRET },
      redactedKeys: keys,
    });

    expect(sink.logs[0]?.redactedKeys).toEqual(keys);
  });
});

describe('Logger - what the global error listener does with the payload', () => {
  test('passes a cross-realm Error through rather than wrapping it', async () => {
    const vm = await import('node:vm');
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink] });

    expect(logger.registerReportErrorListener()).toBe('success');

    try {
      // An error from a `vm` context has a different `Error` constructor, so it fails
      // this realm's `instanceof` while being an error in every way a consumer cares
      // about. A bare `instanceof` replaced it with a wrapper, discarding its identity
      // and stack in both the sink entry and the `'logger'` event - the case `toError`
      // documents itself as handling and this listener had opted out of.
      const foreign = vm.default.runInNewContext(
        'new Error("from another realm")',
      ) as Error;

      expect(foreign instanceof Error).toBe(false);

      const seen: unknown[] = [];

      logger.on('logger', (data: unknown) => {
        // Logging emits a `'logger'` event of its own, so filter to the report.
        const payload = data as { eventType?: string; error: unknown };

        if (payload.eventType === 'uncaughtException') {
          seen.push(payload.error);
        }
      });

      globalThis.dispatchEvent(
        new ErrorEvent('error', {
          error: foreign,
          message: 'from another realm',
          cancelable: true,
        }),
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(foreign);
      expect(sink.logs[sink.logs.length - 1]?.error).toBe(foreign);
    } finally {
      logger.unregisterReportErrorListener();
      await logger.close();
    }
  });

  test('treats a reported null as no payload, not as a thrown null', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink] });

    expect(logger.registerReportErrorListener()).toBe('success');

    try {
      // `ErrorEventInit.error` is declared `any error = null` by WHATWG, so `null` is
      // what the platform supplies when no error was given - Bun and browsers both
      // answer `null` for `new ErrorEvent('error', { message })`. A genuine `throw null`
      // is therefore indistinguishable from a payload-less event, so keeping it would
      // only put a meaningless `cause: null` on every one of them.
      expect(new ErrorEvent('error', { message: 'x' }).error).toBeNull();

      globalThis.dispatchEvent(
        new ErrorEvent('error', {
          error: null,
          message: 'Uncaught null',
          cancelable: true,
        }),
      );

      const reported = sink.logs[sink.logs.length - 1]?.error as Error;

      expect('cause' in reported).toBe(false);
      expect(reported.message).toContain('Uncaught null');
    } finally {
      logger.unregisterReportErrorListener();
      await logger.close();
    }
  });

  test('keeps a non-null non-Error payload on cause', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink] });

    expect(logger.registerReportErrorListener()).toBe('success');

    try {
      const thrown = { code: 'E42' };

      globalThis.dispatchEvent(
        new ErrorEvent('error', {
          error: thrown,
          message: 'Uncaught [object Object]',
          cancelable: true,
        }),
      );

      const reported = sink.logs[sink.logs.length - 1]?.error as Error;

      expect(reported.cause).toBe(thrown);
    } finally {
      logger.unregisterReportErrorListener();
      await logger.close();
    }
  });
});
describe('Logger - where an unhandled render failure goes', () => {
  const hostile = (): Record<string, unknown> => {
    const bag: Record<string, unknown> = { safe: 'kept' };

    Object.defineProperty(bag, 'token', {
      get() {
        throw new Error('accessor refused');
      },
      enumerable: true,
    });

    return bag;
  };

  test('a bare render with no handler reaches a listening logger', () => {
    // The point of the arrangement. `stringifyValue()` called on its own has no handler
    // and no logger of its own, and a console line nobody reads is a poor consolation
    // prize. Nothing is logging, so there is no loop to worry about: it takes the standard
    // global `'error'` channel and a registered listener records it properly.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    expect(logger.registerReportErrorListener('Reported')).toBe('success');

    try {
      stringifyValue({ user: hostile() });
    } finally {
      logger.unregisterReportErrorListener();
    }

    expect(sink.logs.length).toBe(1);
    expect(sink.logs[0]?.message).toContain('Render failed');
    expect(sink.logs[0]?.message).toContain('<value>.user.token');
  });

  test("the logger's own render failures never take that channel", () => {
    // The other half, and the one that would loop. Everything the logger renders runs
    // inside a log call, so it supplies a handler unconditionally - the caller's, or a
    // console-writing one - and never reaches the broadcast rung. Left to the default, the
    // listener would log what it hears, that logging would render, and round it goes.
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });

    expect(logger.registerReportErrorListener('Reported')).toBe('success');

    const consoleError = console.error;
    const lines: string[] = [];

    console.error = (...args: unknown[]): void => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };

    try {
      logger.info('{{u}}', { params: { u: hostile() } });
    } finally {
      console.error = consoleError;
      logger.unregisterReportErrorListener();
    }

    // One entry - the log call itself. Nothing was fed back through the listener.
    expect(sink.logs.length).toBe(1);
    expect(sink.logs[0]?.message).not.toContain('Render failed');

    // It went to the console rung instead, which cannot re-enter anything.
    expect(lines.some((line) => line.includes('Render failed'))).toBe(true);
  });

  test('a caller-supplied handler wins over both', () => {
    const seen: string[] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: (error, _kind, path) =>
        seen.push(`${path}|${error.message}`),
    });

    logger.info('{{u}}', { params: { u: hostile() } });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('u.token');
  });
});
describe('Logger - a failure handler may never raise a failure of its own', () => {
  // One home for a rule that spans four separate callbacks and was only ever asserted a
  // channel at a time. Every one of them runs on a path whose whole job is to keep a
  // failure from escaping - `handleLog`'s synchronous `catch`, a sink's `result.catch`, a
  // stream `'error'` handler - so a throw out of a handler would replace the failure being
  // reported with a second one, raised from the reporter. And the rung beneath is
  // `reportToConsole`, so it holds even when `console.error` is itself broken: a closed
  // stdout during shutdown is exactly when these run.
  const explode = (): never => {
    throw new Error('handler exploded');
  };

  const hostile = (): Record<string, unknown> => {
    const bag: Record<string, unknown> = {};

    Object.defineProperty(bag, 'token', {
      get() {
        throw new Error('accessor refused');
      },
      enumerable: true,
    });

    return bag;
  };

  const cases: [string, () => void][] = [
    [
      'onSinkError',
      () => {
        new Logger({
          sinks: [
            {
              write() {
                throw new Error('sink refused');
              },
            },
          ],
          callProcessExit: false,
          onSinkError: explode,
        }).info('x');
      },
    ],
    [
      'onEventHandlerError',
      () => {
        const logger = new Logger({
          sinks: [new ArraySink()],
          callProcessExit: false,
          onEventHandlerError: explode,
        });

        logger.on('logger', () => {
          throw new Error('handler refused');
        });
        logger.info('x');
      },
    ],
    [
      'onFormatError',
      () => {
        new Logger({
          sinks: [new ArraySink()],
          callProcessExit: false,
          onFormatError: explode,
        }).info('x', {
          params: { u: hostile() },
          redactedKeys: ['u.token'],
        });
      },
    ],
    [
      'onFormatError',
      () => {
        new Logger({
          sinks: [new ArraySink()],
          callProcessExit: false,
          onFormatError: explode,
        }).info('{{u}}', { params: { u: hostile() } });
      },
    ],
  ];

  for (const [name, trigger] of cases) {
    test(`${name} that throws does not escape, and falls to the console`, () => {
      const consoleError = console.error;
      const lines: string[] = [];

      console.error = (...args: unknown[]): void => {
        lines.push(args.map((arg) => String(arg)).join(' '));
      };

      try {
        expect(trigger).not.toThrow();
        expect(lines.length).toBeGreaterThan(0);
      } finally {
        console.error = consoleError;
      }
    });

    test(`${name} that throws survives a broken console too`, () => {
      const consoleError = console.error;

      console.error = (): never => {
        throw new Error('stdout gone');
      };

      try {
        expect(trigger).not.toThrow();
      } finally {
        console.error = consoleError;
      }
    });
  }
});
describe('Logger - a param that cannot be read is reported, not only marked', () => {
  test('an unreadable param reaches onFormatError', () => {
    // The one redaction failure that reached no channel at all. `normalizeParamsBag`
    // carried the key out so the marker could be put back, and dropped the thrown value on
    // the floor - so the output said `***REDACTION FAILED***` and the handler documented
    // to explain exactly that never fired.
    const failures: [string, string][] = [];
    const sink = new ArraySink();
    const logger = new Logger({
      sinks: [sink],
      callProcessExit: false,
      onFormatError: (error, _kind, key) => failures.push([key, error.message]),
    });

    const bag: Record<string, unknown> = { keep: 'visible' };

    Object.defineProperty(bag, 'oops', {
      get() {
        throw new Error('accessor refused');
      },
      enumerable: true,
    });

    logger.info('x {{keep}}', { params: bag, redactedKeys: ['keep'] });

    expect(failures).toHaveLength(1);
    expect(failures[0]?.[0]).toBe('oops');
    expect(failures[0]?.[1]).toContain('accessor refused');

    // Unchanged: the marker still stands, and the readable siblings still redact.
    const stored = JSON.stringify(sink.logs[0]?.redactedParams);

    expect(stored).toContain('***REDACTION FAILED***');
    expect(stored).toContain('***REDACTED***');
  });
});
