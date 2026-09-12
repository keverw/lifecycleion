import { describe, expect, test } from 'bun:test';

import { resolveRedaction } from './resolve-redaction';
import { MAX_RENDER_LENGTH, TRUNCATED_LENGTH } from './render-budget';

describe('resolveRedaction output length', () => {
  test('caps a replacement string at the render allowance', () => {
    // A replacement escapes the render budget exactly as a long `maskChar` did: the budget
    // charges the *input* leaf before `mask` runs and never charges what comes back, so a
    // `redactFunction` answering ten megabytes for a two-hundred-character param wrote all
    // ten to every sink, per param, per line, while `MAX_RENDER_LENGTH` saw two hundred
    // characters of it.
    const replacement = 'R'.repeat(10 * 1024 * 1024);

    const resolved = resolveRedaction(
      'token',
      'x'.repeat(200),
      false,
      () => replacement,
    );

    expect(typeof resolved).toBe('string');
    expect(resolved as string).toHaveLength(
      MAX_RENDER_LENGTH + TRUNCATED_LENGTH.length,
    );

    // Capped rather than refused: a replacement is what the caller asked to appear, and a
    // marker on the end says where it stopped.
    expect(resolved as string).toStartWith('RRR');
    expect(resolved as string).toEndWith(TRUNCATED_LENGTH);
  });

  test('leaves a replacement inside the allowance exactly as written', () => {
    // The cap is a ceiling, not a rewrite: an ordinary replacement must come back
    // byte-for-byte, including one right at the limit.
    expect(resolveRedaction('token', 'secret', false, () => '[withheld]')).toBe(
      '[withheld]',
    );

    const atLimit = 'R'.repeat(MAX_RENDER_LENGTH);

    expect(resolveRedaction('token', 'secret', false, () => atLimit)).toBe(
      atLimit,
    );
  });
});
