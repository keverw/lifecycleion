import { describe, expect, test } from 'bun:test';

import {
  defaultRedactValue,
  maskWithConfig,
  REDACTED_PLACEHOLDER,
} from './default-redact-function';

// `maskChar` and `percent` are both caller-supplied multipliers on the size of the output,
// since the masking emits one mask character per masked character without stopping at the
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

describe('masking cuts between characters, never inside one', () => {
  // The masking used to index the value by UTF-16 code unit, so an emoji-heavy value came
  // back cut through a surrogate pair: a lone `\uD83D` at the seam, `isWellFormed()`
  // false, and the same broken text written to every sink. The rule everywhere else in
  // this library is that a cut never lands inside a character.
  //
  // `isWellFormed` would say it, but it is ES2024 and this project targets ES2022, so
  // this asks the same question against the ES2022 lib.
  const hasLoneSurrogate = (text: string): boolean =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      text,
    );

  test('the default mask of an emoji-heavy value is well-formed', () => {
    const masked = defaultRedactValue('token', '😀'.repeat(10) + 'secretxx');

    expect(typeof masked).toBe('string');
    expect(hasLoneSurrogate(masked as string)).toBe(false);
    expect(masked).not.toContain('secret');
  });

  test('the visible prefix and suffix are counted in characters, not code units', () => {
    // Eighteen characters at 90%: sixteen hidden, one shown at each end - and the one at
    // the front is a whole emoji, where a code-unit cut left half of one.
    const masked = maskWithConfig('😀'.repeat(10) + 'secretxx', {});
    const characters = Array.from(masked);

    expect(characters).toHaveLength(18);
    expect(characters[0]).toBe('😀');
    expect(characters.slice(1, 17).every((c) => c === '*')).toBe(true);
    expect(characters[17]).toBe('x');
  });

  test('email and domain strategies are well-formed too', () => {
    const email = maskWithConfig('😀😀😀😀user@😀😀😀mail.example', {
      strategy: 'email',
    });
    const domain = maskWithConfig('😀😀😀😀host.example', {
      strategy: 'domain',
    });

    expect(hasLoneSurrogate(email)).toBe(false);
    expect(hasLoneSurrogate(domain)).toBe(false);
    expect(email).toContain('@');
    expect(email.endsWith('.example')).toBe(true);
    expect(domain.endsWith('.example')).toBe(true);
  });

  test('a value too short in characters is replaced outright, whatever its unit length', () => {
    // Four emoji are eight code units. Measured in units they were masked in part, and the
    // cut landed inside one of them.
    expect(maskWithConfig('😀😀😀😀', {})).toBe(REDACTED_PLACEHOLDER);
  });

  test('a value with no astral characters masks exactly as it always did', () => {
    // The arithmetic is unchanged; only the unit is. These are the outputs the previous
    // implementation produced for the same inputs.
    expect(maskWithConfig('hunter2secret', {})).toBe('h***********t');
    expect(maskWithConfig('hunter2secret', { percent: 50 })).toBe(
      'hun******cret',
    );
    expect(maskWithConfig('a'.repeat(200), {})).toBe(
      'a'.repeat(10) + '*'.repeat(180) + 'a'.repeat(10),
    );
    expect(
      maskWithConfig('someone@mail.example.com', { strategy: 'email' }),
    ).toBe('******e@***l.******e.com');
    expect(maskWithConfig('api.internal.example', { strategy: 'domain' })).toBe(
      '**i.*******l.example',
    );
  });
});

test('lone surrogate mask characters fall back to a well-formed mask', () => {
  expect(
    maskWithConfig('secret-value', { maskChar: '\ud800', percent: 100 }),
  ).toBe('*'.repeat(12));
  expect(
    maskWithConfig('secret-value', { maskChar: '\udc00', percent: 100 }),
  ).toBe('*'.repeat(12));
});
