import { describe, expect, test } from 'bun:test';
import { renderTextLine } from './render-text-line';

describe('renderTextLine', () => {
  test('keeps one entry on one physical line', () => {
    expect(renderTextLine('before\r\n[error] forged\u2028again\u2029end')).toBe(
      'before [error] forged again end',
    );
  });

  test('preserves non-line-breaking message controls', () => {
    expect(renderTextLine('left\tright')).toBe('left\tright');
  });
});
