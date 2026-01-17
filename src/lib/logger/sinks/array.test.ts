import { describe, expect, test } from 'bun:test';
import { ArraySink } from './array';
import type { LogEntry } from '../types';

describe('ArraySink', () => {
  test('should store log entries', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    expect(sink.logs.length).toBe(1);
    expect(sink.logs[0]).toEqual(entry);
  });

  test('should store multiple log entries', () => {
    const sink = new ArraySink();

    const entries: LogEntry[] = [
      {
        timestamp: Date.now(),
        type: 'info',
        serviceName: '',
        template: 'Info message',
        message: 'Info message',
      },
      {
        timestamp: Date.now(),
        type: 'error',
        serviceName: '',
        template: 'Error message',
        message: 'Error message',
      },
      {
        timestamp: Date.now(),
        type: 'warn',
        serviceName: '',
        template: 'Warning message',
        message: 'Warning message',
      },
    ];

    for (const entry of entries) {
      sink.write(entry);
    }

    expect(sink.logs.length).toBe(3);
    expect(sink.logs).toEqual(entries);
  });

  test('should clear all logs', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);
    sink.write(entry);
    sink.write(entry);

    expect(sink.logs.length).toBe(3);

    sink.clear();

    expect(sink.logs.length).toBe(0);
  });

  test('should return snapshot friendly logs', () => {
    const sink = new ArraySink();

    const entries: LogEntry[] = [
      {
        timestamp: Date.now(),
        type: 'info',
        serviceName: '',
        template: 'Info message',
        message: 'Info message',
      },
      {
        timestamp: Date.now(),
        type: 'error',
        serviceName: '',
        template: 'Error message',
        message: 'Error message',
      },
    ];

    for (const entry of entries) {
      sink.write(entry);
    }

    const snapshot = sink.getSnapshotFriendlyLogs();

    expect(snapshot).toEqual(['info: Info message', 'error: Error message']);
  });

  test('should store params and redacted params', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'User {{userID}} logged in',
      message: 'User 456 logged in',
      params: { userID: 456, password: 'secret' },
      redactedParams: { userID: 456, password: '******' },
    };

    sink.write(entry);

    expect(sink.logs[0].params).toEqual({ userID: 456, password: 'secret' });
    expect(sink.logs[0].redactedParams).toEqual({
      userID: 456,
      password: '******',
    });
  });

  test('should store service name', () => {
    const sink = new ArraySink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    expect(sink.logs[0].serviceName).toBe('TestService');
  });

  test('should transform log entries with transformer', () => {
    const sink = new ArraySink({
      transformer: (entry) => {
        return {
          ...entry,
          message: `${entry.serviceName}: ${entry.type} - ${entry.message}`,
        };
      },
    });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    expect(sink.logs[0].message).toBe('TestService: info - Test message');
    const snapshot = sink.getSnapshotFriendlyLogs();
    expect(snapshot[0]).toBe('info: TestService: info - Test message');
  });

  test('should keep original entry when transformer returns false', () => {
    const sink = new ArraySink({
      transformer: (entry) => {
        if (entry.message === 'Keep original') {
          return false;
        }
        return { ...entry, message: `Transformed: ${entry.message}` };
      },
    });

    const entry1: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Keep original',
      message: 'Keep original',
    };

    const entry2: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'Transform this',
      message: 'Transform this',
    };

    sink.write(entry1);
    sink.write(entry2);

    expect(sink.logs[0].message).toBe('Keep original');
    expect(sink.logs[1].message).toBe('Transformed: Transform this');
  });

  test('should allow accessing error object in transformer', () => {
    const sink = new ArraySink({
      transformer: (entry) => {
        if (entry.error) {
          return { ...entry, message: `ERROR with object: ${entry.message}` };
        }
        return entry;
      },
    });

    const error = new Error('Test error');
    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: '',
      template: 'Error occurred',
      message: 'Error occurred',
      error,
    };

    sink.write(entry);

    expect(sink.logs[0].message).toBe('ERROR with object: Error occurred');
    expect(sink.logs[0].error).toBe(error);
  });
});
