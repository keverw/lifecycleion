import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { ConsoleSink } from './console';
import type { LogEntry } from '../types';
import { LogLevel } from '../types';

describe('ConsoleSink', () => {
  // Spy on console methods
  let consoleLogSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;
  let consoleInfoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    consoleInfoSpy = spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });

  test('should write info message to console', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TestService',
      template: 'Test message',
      message: 'Test message',
    };

    sink.write(entry);

    expect(consoleInfoSpy).toHaveBeenCalled();
    const call = consoleInfoSpy.mock.calls[0];
    expect(call[0]).toContain('Test message');
    expect(call[0]).toContain('TestService');
  });

  test('should write error message to console.error', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: 'ErrorService',
      template: 'Error occurred',
      message: 'Error occurred',
    };

    sink.write(entry);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const call = consoleErrorSpy.mock.calls[0];
    expect(call[0]).toContain('Error occurred');
  });

  test('should write warn message to console.warn', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'warn',
      serviceName: 'WarnService',
      template: 'Warning message',
      message: 'Warning message',
    };

    sink.write(entry);

    expect(consoleWarnSpy).toHaveBeenCalled();
    const call = consoleWarnSpy.mock.calls[0];
    expect(call[0]).toContain('Warning message');
  });

  test('should write success message to console.log', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'success',
      serviceName: 'SuccessService',
      template: 'Success!',
      message: 'Success!',
    };

    sink.write(entry);

    expect(consoleLogSpy).toHaveBeenCalled();
    const call = consoleLogSpy.mock.calls[0];
    expect(call[0]).toContain('Success!');
  });

  test('should write notice message to console.log', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'notice',
      serviceName: 'NoticeService',
      template: 'Notice message',
      message: 'Notice message',
    };

    sink.write(entry);

    expect(consoleLogSpy).toHaveBeenCalled();
    const call = consoleLogSpy.mock.calls[0];
    expect(call[0]).toContain('Notice message');
  });

  test('should write raw message without formatting', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'raw',
      serviceName: '',
      template: 'Raw output',
      message: 'Raw output',
    };

    sink.write(entry);

    expect(consoleLogSpy).toHaveBeenCalledWith('Raw output');
  });

  test('should include timestamps when enabled', () => {
    const sink = new ConsoleSink({ timestamps: true });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TimestampTest',
      template: 'Message with timestamp',
      message: 'Message with timestamp',
    };

    sink.write(entry);

    expect(consoleInfoSpy).toHaveBeenCalled();
    const call = consoleInfoSpy.mock.calls[0];
    // Should contain timestamp in format [MM-dd-yyyy HH:mm:ss]
    expect(call[0]).toMatch(/\[\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\]/);
  });

  test('should include type labels when enabled', () => {
    const sink = new ConsoleSink({ typeLabels: true });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'TypeLabelTest',
      template: 'Message with type label',
      message: 'Message with type label',
    };

    sink.write(entry);

    expect(consoleInfoSpy).toHaveBeenCalled();
    const call = consoleInfoSpy.mock.calls[0];
    expect(call[0]).toContain('[INFO]');
  });

  test('should include both timestamps and type labels when enabled', () => {
    const sink = new ConsoleSink({ timestamps: true, typeLabels: true });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'warn',
      serviceName: 'BothTest',
      template: 'Message with both',
      message: 'Message with both',
    };

    sink.write(entry);

    expect(consoleWarnSpy).toHaveBeenCalled();
    const call = consoleWarnSpy.mock.calls[0];
    // Should contain both timestamp and type label
    expect(call[0]).toMatch(/\[\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\]/);
    expect(call[0]).toContain('[WARN]');
  });

  test('should not include service name when empty', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: '',
      template: 'No service',
      message: 'No service',
    };

    sink.write(entry);

    expect(consoleInfoSpy).toHaveBeenCalled();
    const call = consoleInfoSpy.mock.calls[0];
    expect(call[0]).toContain('No service');
    // Should not have extra brackets for empty service name
    expect(call[0]).not.toContain('[]');
  });

  test('should disable colors when colors option is false', () => {
    const sink = new ConsoleSink({ colors: false });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: 'NoColorTest',
      template: 'Error without colors',
      message: 'Error without colors',
    };

    sink.write(entry);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const call = consoleErrorSpy.mock.calls[0];
    // When colors are disabled, should only have one argument (the message)
    expect(call.length).toBe(1);
    expect(call[0]).toContain('Error without colors');
  });

  test('should apply colors by default', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: 'ColorTest',
      template: 'Colored error',
      message: 'Colored error',
    };

    sink.write(entry);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const call = consoleErrorSpy.mock.calls[0];
    // When colors are enabled, may have style argument
    expect(call[0]).toContain('Colored error');
  });

  test('should not write after close', () => {
    const sink = new ConsoleSink();

    sink.close();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'ClosedTest',
      template: 'Should not appear',
      message: 'Should not appear',
    };

    sink.write(entry);

    // Should not have been called
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  test('should handle all log types correctly', () => {
    const sink = new ConsoleSink({ minLevel: LogLevel.DEBUG });

    const types: Array<LogEntry['type']> = [
      'error',
      'info',
      'warn',
      'success',
      'notice',
      'debug',
      'raw',
    ];

    for (const type of types) {
      const entry: LogEntry = {
        timestamp: Date.now(),
        type,
        serviceName: 'AllTypesTest',
        template: `${type} message`,
        message: `${type} message`,
      };

      sink.write(entry);
    }

    // Verify each console method was called appropriately
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).toHaveBeenCalledTimes(4); // success, notice, debug, raw
  });

  test('should format message with all options enabled', () => {
    const sink = new ConsoleSink({
      colors: true,
      timestamps: true,
      typeLabels: true,
    });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'FullTest',
      template: 'Complete message',
      message: 'Complete message',
    };

    sink.write(entry);

    expect(consoleInfoSpy).toHaveBeenCalled();
    const call = consoleInfoSpy.mock.calls[0];

    // Should have timestamp
    expect(call[0]).toMatch(/\[\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}\]/);
    // Should have type label
    expect(call[0]).toContain('[INFO]');
    // Should have service name
    expect(call[0]).toContain('[FullTest]');
    // Should have message
    expect(call[0]).toContain('Complete message');
  });

  test('should not write when muted via constructor option', () => {
    const sink = new ConsoleSink({ muted: true });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'MutedTest',
      template: 'Should not appear',
      message: 'Should not appear',
    };

    sink.write(entry);

    expect(consoleInfoSpy).not.toHaveBeenCalled();
    expect(sink.isMuted()).toBe(true);
  });

  test('should mute and unmute dynamically', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'MuteTest',
      template: 'Test message',
      message: 'Test message',
    };

    // Initial state - not muted
    expect(sink.isMuted()).toBe(false);
    sink.write(entry);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1);

    // Mute and verify no output
    sink.mute();
    expect(sink.isMuted()).toBe(true);
    sink.write(entry);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1); // Still 1, no new call

    // Unmute and verify output resumes
    sink.unmute();
    expect(sink.isMuted()).toBe(false);
    sink.write(entry);
    expect(consoleInfoSpy).toHaveBeenCalledTimes(2); // Now 2
  });

  test('should stay muted after multiple mute calls', () => {
    const sink = new ConsoleSink();

    sink.mute();
    sink.mute();
    sink.mute();

    expect(sink.isMuted()).toBe(true);

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'MultipleMuteTest',
      template: 'Should not appear',
      message: 'Should not appear',
    };

    sink.write(entry);
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  test('should stay unmuted after multiple unmute calls', () => {
    const sink = new ConsoleSink({ muted: true });

    sink.unmute();
    sink.unmute();
    sink.unmute();

    expect(sink.isMuted()).toBe(false);

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'MultipleUnmuteTest',
      template: 'Should appear',
      message: 'Should appear',
    };

    sink.write(entry);
    expect(consoleInfoSpy).toHaveBeenCalled();
  });

  test('should handle errors with colors disabled', () => {
    const sink = new ConsoleSink({ colors: false });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: 'ErrorNoColor',
      template: 'Error message',
      message: 'Error message',
    };

    sink.write(entry);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('Error message');
  });

  test('should handle info with colors disabled', () => {
    const sink = new ConsoleSink({ colors: false });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'InfoNoColor',
      template: 'Info message',
      message: 'Info message',
    };

    sink.write(entry);

    expect(consoleInfoSpy).toHaveBeenCalled();
    expect(consoleInfoSpy.mock.calls[0][0]).toContain('Info message');
  });

  test('should handle warn with colors disabled', () => {
    const sink = new ConsoleSink({ colors: false });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'warn',
      serviceName: 'WarnNoColor',
      template: 'Warn message',
      message: 'Warn message',
    };

    sink.write(entry);

    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls[0][0]).toContain('Warn message');
  });

  test('should handle success with colors disabled', () => {
    const sink = new ConsoleSink({ colors: false });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'success',
      serviceName: 'SuccessNoColor',
      template: 'Success message',
      message: 'Success message',
    };

    sink.write(entry);

    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls[0][0]).toContain('Success message');
  });

  test('should handle notice with colors disabled', () => {
    const sink = new ConsoleSink({ colors: false });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'notice',
      serviceName: 'NoticeNoColor',
      template: 'Notice message',
      message: 'Notice message',
    };

    sink.write(entry);

    expect(consoleLogSpy).toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls[0][0]).toContain('Notice message');
  });

  test('should write debug message to console.log', () => {
    const sink = new ConsoleSink({ minLevel: LogLevel.DEBUG });

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'DebugService',
      template: 'Debug message',
      message: 'Debug message',
    };

    sink.write(entry);

    expect(consoleLogSpy).toHaveBeenCalled();
    const call = consoleLogSpy.mock.calls[0];
    expect(call[0]).toContain('Debug message');
  });

  test('should filter out debug logs by default', () => {
    const sink = new ConsoleSink();

    const entry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'DebugService',
      template: 'Debug message',
      message: 'Debug message',
    };

    sink.write(entry);

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test('should filter logs based on minLevel', () => {
    const sink = new ConsoleSink({ minLevel: LogLevel.WARN });

    const errorEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'error',
      serviceName: 'Test',
      template: 'Error',
      message: 'Error',
    };

    const warnEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'warn',
      serviceName: 'Test',
      template: 'Warn',
      message: 'Warn',
    };

    const infoEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'info',
      serviceName: 'Test',
      template: 'Info',
      message: 'Info',
    };

    const debugEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'Test',
      template: 'Debug',
      message: 'Debug',
    };

    sink.write(errorEntry);
    sink.write(warnEntry);
    sink.write(infoEntry);
    sink.write(debugEntry);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleInfoSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test('should allow changing minLevel dynamically', () => {
    const sink = new ConsoleSink({ minLevel: LogLevel.INFO });

    const debugEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'debug',
      serviceName: 'Test',
      template: 'Debug',
      message: 'Debug',
    };

    sink.write(debugEntry);
    expect(consoleLogSpy).not.toHaveBeenCalled();

    sink.setMinLevel(LogLevel.DEBUG);
    sink.write(debugEntry);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  test('should get current minLevel', () => {
    const sink = new ConsoleSink({ minLevel: LogLevel.WARN });

    expect(sink.getMinLevel()).toBe(LogLevel.WARN);

    sink.setMinLevel(LogLevel.DEBUG);
    expect(sink.getMinLevel()).toBe(LogLevel.DEBUG);
  });

  test('should default to INFO level', () => {
    const sink = new ConsoleSink();

    expect(sink.getMinLevel()).toBe(LogLevel.INFO);
  });

  test('should always show raw logs regardless of minLevel', () => {
    const sink = new ConsoleSink({ minLevel: LogLevel.ERROR });

    const rawEntry: LogEntry = {
      timestamp: Date.now(),
      type: 'raw',
      serviceName: 'Test',
      template: 'Raw',
      message: 'Raw',
    };

    sink.write(rawEntry);
    expect(consoleLogSpy).toHaveBeenCalled();
  });
});
