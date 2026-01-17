import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { colorize } from './color';

describe('colorize', () => {
  describe('Node.js environment (default)', () => {
    test('should return chalk-colored text for error type', () => {
      const result = colorize('error', 'Error message');

      expect(result.coloredText).toContain('Error message');
      expect(result.style).toBeUndefined();
    });

    test('should return chalk-colored text for info type', () => {
      const result = colorize('info', 'Info message');

      expect(result.coloredText).toContain('Info message');
      expect(result.style).toBeUndefined();
    });

    test('should return chalk-colored text for warn type', () => {
      const result = colorize('warn', 'Warning message');

      expect(result.coloredText).toContain('Warning message');
      expect(result.style).toBeUndefined();
    });

    test('should return chalk-colored text for success type', () => {
      const result = colorize('success', 'Success message');

      expect(result.coloredText).toContain('Success message');
      expect(result.style).toBeUndefined();
    });

    test('should return chalk-colored text for note type', () => {
      const result = colorize('note', 'Note message');

      expect(result.coloredText).toContain('Note message');
      expect(result.style).toBeUndefined();
    });
  });

  describe('Browser environment (simulated)', () => {
    const originalWindow = (globalThis as any).window;
    const originalDocument = (globalThis as any).document;

    beforeEach(() => {
      // Simulate browser environment
      (globalThis as any).window = {};
      (globalThis as any).document = {};
    });

    afterEach(() => {
      // Restore original environment
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
      if (originalDocument === undefined) {
        delete (globalThis as any).document;
      } else {
        (globalThis as any).document = originalDocument;
      }
    });

    test('should return browser-formatted text for error type', () => {
      const result = colorize('error', 'Error message');

      expect(result.coloredText).toBe('%cError message');
      expect(result.style).toBe('color: #a95450;');
    });

    test('should return browser-formatted text for info type', () => {
      const result = colorize('info', 'Info message');

      expect(result.coloredText).toBe('%cInfo message');
      expect(result.style).toBe('color: #ffffff;');
    });

    test('should return browser-formatted text for warn type', () => {
      const result = colorize('warn', 'Warning message');

      expect(result.coloredText).toBe('%cWarning message');
      expect(result.style).toBe('color: #f5f566;');
    });

    test('should return browser-formatted text for success type', () => {
      const result = colorize('success', 'Success message');

      expect(result.coloredText).toBe('%cSuccess message');
      expect(result.style).toBe('color: #56b97f;');
    });

    test('should return browser-formatted text for note type', () => {
      const result = colorize('note', 'Note message');

      expect(result.coloredText).toBe('%cNote message');
      expect(result.style).toBe('color: #5883bf;');
    });
  });
});
