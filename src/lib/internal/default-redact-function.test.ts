import { describe, expect, test } from 'bun:test';

import {
  maskWithConfig,
  REDACTED_PLACEHOLDER,
} from './default-redact-function';

// `maskChar` and `percent` are both caller-supplied multipliers on the size of the output,
// since `datamask` emits one mask character per masked character without stopping at the
// length of the value. The percent had a ceiling and the mask character had only a
// non-empty check, which is the gap these cover.

describe('maskWithConfig - maskChar', () => {
  test('uses the character it is given', () => {
    const masked = maskWithConfig('hunter2secret', { maskChar: '#' });

    expect(masked).toContain('#');
    expect(masked).not.toContain('*');
  });

  test('cuts a long maskChar to one character rather than multiplying the output', () => {
    // A `redactFunction` answering `{ maskChar: 'X'.repeat(100_000) }` over three
    // 200-character params wrote 54 MB to every sink - and escaped the render budget,
    // which charges the input leaf before masking and never charges the result.
    const value = 'a'.repeat(200);
    const masked = maskWithConfig(value, { maskChar: 'X'.repeat(100_000) });

    expect(masked.length).toBe(value.length);
    expect(masked).toContain('X');
  });

  test('keeps an astral mask character whole', () => {
    // The first code point, not the first UTF-16 unit, so this is never cut into a lone
    // surrogate.
    const masked = maskWithConfig('hunter2secret', { maskChar: '🙈' });

    expect(masked).toContain('🙈');
    expect(masked).not.toContain('\uD83D\uD83D');
  });

  test('falls back to the default for a maskChar that is not a usable string', () => {
    expect(maskWithConfig('hunter2secret', { maskChar: '' })).toContain('*');
    expect(
      maskWithConfig('hunter2secret', {
        maskChar: 7 as unknown as string,
      }),
    ).toContain('*');
  });

  test('replaces a value too short to mask in part', () => {
    expect(maskWithConfig('abc', { maskChar: '#' })).toBe(REDACTED_PLACEHOLDER);
  });
});

describe('maskWithConfig - percent', () => {
  test('clamps a percent above 100 rather than lengthening the output', () => {
    const value = 'a'.repeat(200);

    expect(maskWithConfig(value, { percent: 10_000 }).length).toBe(
      value.length,
    );
  });
});
