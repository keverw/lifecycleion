// An unquoted segment is a run of name characters - letters, digits, combining marks,
// `_`, `$`, `@`, `-` - rather than `\w+`. Ordinary key names contain hyphens, `@`, `$`,
// and non-ASCII letters, and rejecting those made a path such as `user.password-hash`
// unparseable - which silently resolved to nothing in every consumer of this grammar: it
// rendered the literal placeholder in `CurlyBrackets`, and redacted nothing in the
// logger's `redactedKeys` and in `errorToString`'s `sensitiveFieldNames`, with no warning
// either way.
//
// An allowlist, deliberately, rather than "anything that is not a delimiter or
// whitespace". That exclusion is load-bearing rather than fussy, and excluding only
// whitespace does not achieve it. A placeholder is written by hand into prose, and
// `CurlyBrackets` leaves one it cannot parse exactly as the author wrote it, but renders
// the configured fallback for one that parses and resolves to nothing. So every character
// admitted here is a character that turns a brace-wrapped phrase into a silent `(null)`:
// `Note: {{Hello world}} done` is safe because of the space, but `{{Hello,world}}` and
// `{{oops!}}` are not, and prose punctuation is exactly what a phrase is made of. That is
// reachable without anyone writing a template: `LifecycleManager` interpolates a
// component's own error message into one, with params, before rendering it. A key that
// genuinely contains a space - or a comma, or any other punctuation - takes the quoted
// bracket form, `u['my key']`, for the same reason a key containing a delimiter does.
//
// Genuinely unsupported syntax is still rejected, which is what the grammar was tightened
// for: a wildcard such as `users[*].password`, a trailing dot, and an unterminated
// bracket all still fail to parse. A key that really does contain `.`, `[`, or `]` still
// needs the quoted bracket form, since only quoting can disambiguate it.
const PATH_SEGMENT_PATTERN =
  /([\p{L}\p{N}\p{M}_$@-]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]/uy;

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
