import { describe, expect, test } from 'bun:test';
import { renderTextEntry, renderTextLine } from './render-text-line';

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

describe('renderTextEntry', () => {
  test('keeps service and entity names on the entry line', () => {
    expect(
      renderTextEntry({
        timestamp: 0,
        type: 'info',
        serviceName: 'svc\n[error] forged',
        entityName: 'x\r\n[error] forged',
        template: 'message',
        message: 'message',
      }),
    ).toBe('[info] [svc [error] forged] [x [error] forged] message');
  });
});
