import { describe, expect, test } from 'bun:test';

import {
  datamask,
  maskDomain,
  maskEmail,
  maskString,
  splitCharacters,
} from './datamask';

// The outputs the `datamask` npm package produced for the same calls, so a caller moving
// off it sees nothing change for a value with no astral characters.
describe('maskString', () => {
  test('matches the datamask package on its own README example', () => {
    expect(maskString("I'm a string!", '*', 30)).toBe("I'm a***ring!");
  });

  test('defaults to * and 60 percent', () => {
    expect(maskString('hunter2secret')).toBe('hun*******ret');
    expect(maskString('hunter2secret', '#')).toBe('hun#######ret');
  });

  test('hides the proportion asked for and splits the remainder shorter half first', () => {
    expect(maskString('abcdefghij', '*', 50)).toBe('ab*****hij');
    expect(maskString('abcdefghij', '*', 0)).toBe('abcdefghij');
    expect(maskString('abcdefghij', '*', 100)).toBe('**********');
  });

  test('returns an empty string for an empty value', () => {
    expect(maskString('')).toBe('');
  });

  test('rounds the hidden count down and puts the shorter visible half in front', () => {
    // One character at 60%: floor(0.6) hides nothing. Two: floor(1.2) hides one, and
    // the single visible character goes behind. Three at 50%: one hidden, in the middle.
    expect(maskString('a')).toBe('a');
    expect(maskString('ab')).toBe('*b');
    expect(maskString('abc', '*', 50)).toBe('a*c');
  });

  test('does what it is asked with settings past the usual range, as documented', () => {
    // Neither is clamped here; the logger's default redaction bounds both first.
    expect(maskString('abcd', '*', 150)).toBe('abc******');
    expect(maskString('abc', 'xy', 50)).toBe('axyc');
  });

  test('counts grapheme clusters, so a combining accent stays with its letter', () => {
    // Four characters as a reader sees them, not eight code points: two hidden, one
    // shown whole on each side, accent and all.
    const decomposed = 'e\u0301'.repeat(4);

    expect(maskString(decomposed, '*', 50)).toBe('e\u0301**e\u0301');
  });

  test('hides a multi-code-point emoji behind one mask character', () => {
    // A family, a flag and a skin-tone variant are one character each, so the mask
    // never shows a base emoji with its modifier hidden.
    const family = '👨\u200d👩\u200d👧';
    const flag = '🇺🇸';
    const thumbs = '👍🏽';
    const value = `${family}${flag}${thumbs}abcd`;

    expect(splitCharacters(value)).toHaveLength(7);
    expect(maskString(value, '*', 50)).toBe(`${family}${flag}***cd`);
  });

  test('never cuts inside a character', () => {
    const value = '😀'.repeat(10) + 'secretxx';
    const masked = maskString(value, '*', 60);

    // No lone surrogate anywhere in the output.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        masked,
      ),
    ).toBe(false);
    // Eighteen characters in, eighteen out, counted in code points.
    expect(Array.from(masked)).toHaveLength(18);
    expect(Array.from(masked)[0]).toBe('😀');
  });
});

describe('maskDomain', () => {
  test('matches the datamask package on its own README example', () => {
    expect(maskDomain('example.com', '*', 50)).toBe('ex***le.com');
  });

  test('masks every label but the last', () => {
    expect(maskDomain('mail.example.co.uk', '*', 50)).toBe(
      'm**l.ex***le.*o.uk',
    );
  });

  test('masks a value without a dot as one string', () => {
    expect(maskDomain('localhost', '*', 50)).toBe('lo****ost');
  });

  test('keeps empty labels empty', () => {
    expect(maskDomain('a..b', '*', 50)).toBe('a..b');
  });
});

describe('maskEmail', () => {
  test('matches the datamask package on its own README examples', () => {
    expect(maskEmail('test@example.com')).toBe('t**t@e****le.com');
    expect(maskEmail('test@example.com', '#', 45, 80)).toBe('t#st@e#####e.com');
  });

  test('masks a value without an @ as one string at the user percent', () => {
    expect(maskEmail('not-an-email', '*', 50)).toBe('not******ail');
  });

  test('uses only the text up to the second @', () => {
    // The same lossy reading the package had, and a safe direction to err in.
    expect(maskEmail('a@b@c.com')).toBe('a@b');
  });

  test('masks an empty local part or an empty domain as empty', () => {
    expect(maskEmail('@example.com')).toBe('@e****le.com');
    expect(maskEmail('user@')).toBe('u**r@');
  });

  test('keeps an astral local part whole', () => {
    const masked = maskEmail('😀😀😀😀😀😀@example.com');

    expect(masked.endsWith('@e****le.com')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(masked)).toBe(false);
  });
});

describe('datamask', () => {
  test('exposes the original API shape', () => {
    expect(datamask.string).toBe(maskString);
    expect(datamask.domain).toBe(maskDomain);
    expect(datamask.email).toBe(maskEmail);
    expect(datamask.email('test@example.com')).toBe('t**t@e****le.com');
  });
});
