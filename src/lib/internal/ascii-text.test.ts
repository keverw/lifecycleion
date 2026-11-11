import { describe, expect, it } from 'bun:test';
import {
  asciiLowercase,
  asciiUppercase,
  hasNonHTTPWhitespaceEdge,
  trimHTTPWhitespace,
} from './ascii-text';

describe('asciiLowercase and asciiUppercase', () => {
  it('change ASCII letters alone, in ASCII text and in text that is not', () => {
    expect(asciiLowercase('Content-Type')).toBe('content-type');
    expect(asciiUppercase('post')).toBe('POST');
    // Beside a character the engine's case mapping would change.
    expect(asciiLowercase('TRAC\u212A')).toBe('trac\u212A');
    expect(asciiUppercase('po\u017Ft')).toBe('PO\u017FT');
    expect(asciiLowercase('\u00C9A')).toBe('\u00C9a');
    expect(asciiLowercase('')).toBe('');
  });
});

describe('trimHTTPWhitespace', () => {
  it('trims tab, LF, CR and space from both ends and nothing else', () => {
    expect(trimHTTPWhitespace(' \t\r\n gzip \r\n\t ')).toBe('gzip');
    expect(trimHTTPWhitespace('a \t b')).toBe('a \t b');
    expect(trimHTTPWhitespace(' gzip\u000B')).toBe(' gzip\u000B');
    expect(trimHTTPWhitespace(' \t\r\n')).toBe('');
    expect(trimHTTPWhitespace('')).toBe('');
  });

  // A server's header value: a regex with an unanchored trailing-whitespace branch
  // rescans the run from each of its positions, and takes seconds on this one.
  it('returns promptly for a long whitespace run inside the text', () => {
    const text = `a${' \t'.repeat(64 * 1024)}b`;
    const startedAt = performance.now();

    expect(trimHTTPWhitespace(` ${text} `)).toBe(text);
    expect(hasNonHTTPWhitespaceEdge(text)).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
