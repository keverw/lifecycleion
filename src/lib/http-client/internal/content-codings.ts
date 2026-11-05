import { asciiLowercase, trimHTTPWhitespace } from '../../internal/ascii-text';

/**
 * The codings a `Content-Encoding` value applies, in the order it lists them: each of its
 * comma-separated tokens - an array's joined first, as one header seen twice - trimmed of
 * HTTP whitespace and ASCII-lowercased, an empty one or `identity` left out.
 */
export function contentCodings(contentEncoding: string | string[]): string[] {
  return (
    Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding
  )
    .split(',')
    .map((token) => asciiLowercase(trimHTTPWhitespace(token)))
    .filter((token) => token !== '' && token !== 'identity');
}
