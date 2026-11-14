import { asciiLowercase } from '../../internal/ascii-text';
import { headerListTokens } from './header-utils';

/**
 * The codings a `Content-Encoding` value applies, in the order it lists them: each of its
 * comma-separated tokens - an array's joined first, as one header seen twice - trimmed of
 * HTTP whitespace and ASCII-lowercased, an empty one or `identity` left out.
 */
export function contentCodings(contentEncoding: string | string[]): string[] {
  return headerListTokens(contentEncoding)
    .map(asciiLowercase)
    .filter((token) => token !== '' && token !== 'identity');
}
