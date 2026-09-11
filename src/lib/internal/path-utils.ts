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
// `-` and `@` are the two admitted with that cost accepted rather than avoided, so the
// rule above does not read as covering them: a hyphenated phrase has no space to save it,
// and `{{Hello-world}}`, `{{opt-in}}`, `{{2024-01-01}}` and `{{@mention}}` now render the
// fallback where they previously round-tripped verbatim. Admitted anyway because a key
// named `password-hash` or `@type` is ordinary and silently redacting nothing for one is
// the worse of the two failures - the reason this grammar was widened at all.
//
// Genuinely unsupported syntax is still rejected, which is what the grammar was tightened
// for: a trailing dot and an unterminated bracket both still fail to parse. A key that
// really does contain `.`, `[`, or `]` still needs the quoted bracket form, since only
// quoting can disambiguate it.
//
// `*` is not a name character here either, so a wildcard such as `users[*].password` is
// still unparseable *as a value lookup* - which is what this pattern is. Redaction admits
// it as a segment of its own; see `parsePathSegments` and `getRedactPathParts` below.
const PATH_SEGMENT_PATTERN =
  /([\p{L}\p{N}\p{M}_$@-]+)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['((?:[^'\\]|\\.)*)'\]/uy;

function unescapeQuotedPathPart(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1');
}

/**
 * The part a wildcard segment - `*` or `[*]` - parses to.
 *
 * Deliberately the literal string, and not a sentinel nothing else can produce. A
 * wildcard stands in for an array *index*, so the only container it can expand over is an
 * array; against a plain object there is nothing sensible for it to mean, and inventing
 * "every key" there would silently widen `users.*.password` from one field into the whole
 * bag. Parsing it to `'*'` gives the object case the only other reading available - the
 * key literally named `*` - for free.
 *
 * The quoted `user["*"]` parses to the same segment, so it is not an escape hatch: over an
 * array it expands like any other wildcard, and there is no spelling that addresses only a
 * named property called `*` on one. That is this grammar's existing rule rather than
 * something the wildcard introduced - quoting disambiguates a key containing a delimiter
 * and never changes what a segment means, which is why `[0]`, `["0"]`, `['0']` and `.0`
 * already collapse to the one part `'0'`, and why that part already addresses an array
 * slot and an object key named `"0"` alike. A second, quote-only segment would be the
 * novelty here, and a bad one: the two would mean the same key on an object and different
 * things on an array, so a caller could not tell which they had written without knowing
 * the shape of the payload.
 *
 * `redact-paths` is the one consumer, since only the redaction grammar admits a wildcard
 * at all. See {@link getRedactPathParts}.
 */
export const WILDCARD_PATH_SEGMENT = '*';

/** The length of the wildcard segment at `index`, or `0` when there is not one. */
function wildcardSegmentLength(path: string, index: number): number {
  if (path[index] === '*') {
    return 1;
  }

  if (path.startsWith('[*]', index)) {
    return 3;
  }

  return 0;
}

/**
 * The shared tokenizer behind both grammars below.
 *
 * `allowWildcards` only ever *adds* a segment form, and only as a whole segment: a `*`
 * touching anything else - `a.*b`, `**`, `[*` - leaves the cursor somewhere the trailing
 * check below refuses, exactly as a stray character after any other segment does. So
 * widening the grammar for redaction does not widen what counts as a name, and the quoted
 * bracket form remains the only way to address a key that contains punctuation.
 */
function parsePathSegments(
  path: string,
  allowWildcards: boolean,
): string[] | null {
  const parts: string[] = [];
  let index = 0;

  while (index < path.length) {
    if (path[index] === '.') {
      index++;

      if (index >= path.length) {
        return null;
      }
    }

    const wildcardLength = allowWildcards
      ? wildcardSegmentLength(path, index)
      : 0;

    if (wildcardLength > 0) {
      parts.push(WILDCARD_PATH_SEGMENT);
      index += wildcardLength;
    } else {
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
    }

    if (index < path.length && path[index] !== '.' && path[index] !== '[') {
      return null;
    }
  }

  return parts;
}

/**
 * Parses a mixed object/array path such as "user.roles[0].name" into lookup parts.
 *
 * The *value lookup* grammar, which is what `CurlyBrackets` resolves a placeholder with.
 * A wildcard is not admitted here, deliberately: a placeholder renders one value, so
 * there is nothing for `{{users[*].name}}` to print, and admitting the character would
 * turn prose such as `{{2*3}}` from text this leaves verbatim into a path that parses,
 * resolves to nothing, and renders the configured fallback instead.
 */
export function getPathParts(path: string): string[] | null {
  return parsePathSegments(path, false);
}

/**
 * {@link getPathParts}, plus the wildcard segments `*` and `[*]`.
 *
 * The grammar behind `redactedKeys` and `sensitiveFieldNames`, where an entry names every
 * location to mask rather than one value to print - which is the difference that makes a
 * wildcard meaningful here and meaningless above. Both spellings parse to
 * {@link WILDCARD_PATH_SEGMENT}, so `users.*.password` and `users[*].password` are one
 * rule written two ways, which is how they read.
 *
 * Everything else is unchanged, so a concrete `users[0].password` parses exactly as it
 * did, and the syntax this still rejects - a trailing dot, an unterminated bracket, a
 * partial wildcard such as `us*rs` - is still rejected.
 */
export function getRedactPathParts(path: string): string[] | null {
  return parsePathSegments(path, true);
}
