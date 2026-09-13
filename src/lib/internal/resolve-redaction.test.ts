import { describe, expect, test } from 'bun:test';

import { resolveRedaction } from './resolve-redaction';
import { MAX_RENDER_LENGTH, TRUNCATED_LENGTH } from './render-budget';
import {
  defaultRedactValue,
  maskWithConfig,
  REDACTED_PLACEHOLDER,
  type RedactValueFunction,
} from './default-redact-function';

/** A `redactFunction` answering a value the declared type does not admit, as JavaScript can. */
function answering(value: unknown): RedactValueFunction {
  return (() => value) as RedactValueFunction;
}

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

describe('resolveRedaction branches', () => {
  // The contract gate for every redaction surface: the logger and `errorToString` both
  // route a `redactFunction`'s answer through here, so each documented return shape is
  // pinned once, against the default the same key and value would get with no function.
  const key = 'card';
  const value = '4111111111111111';
  const byDefault = defaultRedactValue(key, value);

  test('no redactFunction masks with the default, or the placeholder for a derived value', () => {
    expect(resolveRedaction(key, value, false, undefined)).toBe(byDefault);
    expect(resolveRedaction(key, value, true, undefined)).toBe(
      REDACTED_PLACEHOLDER,
    );
  });

  test('null and undefined defer to the default masking', () => {
    for (const answer of [null, undefined]) {
      expect(resolveRedaction(key, value, false, () => answer)).toBe(byDefault);
      expect(resolveRedaction(key, value, true, () => answer)).toBe(
        REDACTED_PLACEHOLDER,
      );
    }
  });

  test('an empty config lands where null does, derived-value rule included', () => {
    // `{}` must not take the `maskWithConfig` path: that skips the derived-value rule,
    // which is how a produced `URL` kept its query and a card number its BIN prefix.
    expect(resolveRedaction(key, value, false, () => ({}))).toBe(byDefault);
    expect(resolveRedaction(key, value, true, () => ({}))).toBe(
      REDACTED_PLACEHOLDER,
    );
  });

  test('an object that is not a config falls back to the default rather than printing', () => {
    for (const answer of [
      { note: 'withheld' },
      { percent: 10, note: 'mixed' },
      ['a', 'b'],
      new Date(0),
    ]) {
      expect(resolveRedaction(key, value, false, answering(answer))).toBe(
        byDefault,
      );
      expect(resolveRedaction(key, value, true, answering(answer))).toBe(
        REDACTED_PLACEHOLDER,
      );
    }
  });

  test('a finite number is shorthand for { percent }', () => {
    expect(resolveRedaction(key, value, false, () => 50)).toBe(
      maskWithConfig(value, { percent: 50 }),
    );
    expect(resolveRedaction(key, value, false, () => ({ percent: 50 }))).toBe(
      maskWithConfig(value, { percent: 50 }),
    );
  });

  test('a non-finite number names no setting and lands on the default', () => {
    // `Number(process.env.X)` reaches here as `NaN`; it used to be emitted as a literal
    // and serialize to `null`.
    for (const answer of [NaN, Infinity, -Infinity]) {
      expect(resolveRedaction(key, value, false, () => answer)).toBe(byDefault);
      expect(resolveRedaction(key, value, true, () => answer)).toBe(
        REDACTED_PLACEHOLDER,
      );
    }
  });

  test('a settings config overrides the derived-value rule on purpose', () => {
    // Asking for partial masking of a produced string is a deliberate choice, unlike
    // `{}` or `null`, so a derived value is masked with exactly those settings.
    expect(resolveRedaction(key, value, true, () => ({ percent: 50 }))).toBe(
      maskWithConfig(value, { percent: 50 }),
    );
  });

  test('any other primitive is used literally', () => {
    expect(resolveRedaction(key, value, false, answering(true))).toBe(true);
    expect(resolveRedaction(key, value, false, answering(42n))).toBe(42n);

    const symbol = Symbol('withheld');

    expect(resolveRedaction(key, value, false, answering(symbol))).toBe(symbol);
  });

  test('an Infinity limit leaves a replacement uncut for a walk that charges its own budget', () => {
    // `maskValueDeep` cuts a replacement to what is left of its budget and records the
    // cut, so it passes `Infinity` here and this backstop must not fire under it.
    const replacement = 'R'.repeat(MAX_RENDER_LENGTH + 10);

    expect(
      resolveRedaction(key, value, false, () => replacement, Infinity),
    ).toBe(replacement);
  });
});
