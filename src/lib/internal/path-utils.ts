// An unquoted segment is any run of characters that are not path delimiters, rather than
// `\w+`. Ordinary key names contain hyphens, spaces, `@`, `$`, and non-ASCII letters, and
// rejecting those made a path such as `user.password-hash` unparseable - which silently
// resolved to nothing in every consumer of this grammar: it rendered a template fallback
// in `CurlyBrackets`, and redacted nothing in the logger's `redactedKeys` and in
// `errorToString`'s `sensitiveFieldNames`, with no warning either way.
//
// Genuinely unsupported syntax is still rejected, which is what the grammar was tightened
// for: a wildcard such as `users[*].password`, a trailing dot, and an unterminated
// bracket all still fail to parse. A key that really does contain `.`, `[`, or `]` still
// needs the quoted bracket form, since only quoting can disambiguate it.
const PATH_SEGMENT_PATTERN =
  /([^.[\]]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]/y;

function unescapeQuotedPathPart(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1');
}

/**
 * Parses a mixed object/array path such as "user.roles[0].name" into lookup parts.
 */
export function getPathParts(path: string): string[] | null {
  const parts: string[] = [];
  let index = 0;

  while (index < path.length) {
    if (path[index] === '.') {
      index++;

      if (index >= path.length) {
        return null;
      }
    }

    PATH_SEGMENT_PATTERN.lastIndex = index;
    const match = PATH_SEGMENT_PATTERN.exec(path);

    if (!match) {
      return null;
    }

    if (match[1] !== undefined) {
      parts.push(match[1]);
    } else if (match[2] !== undefined) {
      parts.push(match[2]);
    } else if (match[3] !== undefined) {
      parts.push(unescapeQuotedPathPart(match[3]));
    } else if (match[4] !== undefined) {
      parts.push(unescapeQuotedPathPart(match[4]));
    }

    index = PATH_SEGMENT_PATTERN.lastIndex;

    if (index < path.length && path[index] !== '.' && path[index] !== '[') {
      return null;
    }
  }

  return parts;
}
