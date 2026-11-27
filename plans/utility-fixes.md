# Plan: fix small defects in older utility modules

Status: not started. These modules were not touched by PR #34; the review rounds on it found the defects while probing the whole library. Do this on a new branch from main (for example `fix-utility-edge-cases`), one commit per item, each with a test that fails without its fix.

## 1. `CurlyBrackets.escape` does not round-trip a lone `{{` or `}}`

- **Where:** `src/lib/curly-brackets.ts`: `escape()` (around line 500) and the renderer's unescape step (around line 333).
- **Problem:** `escape()` puts a backslash before every unescaped `{{` and `}}`. The renderer removes those backslashes only when they form a whole `\{{...\}}` placeholder, so a lone escaped `}}` or `{{` keeps its backslash. A lone `\}}` written in a template by hand does the same.
- **Repro:**
  - `CurlyBrackets(CurlyBrackets.escape('{"a":{"b":1}}'), {})` gives `{"a":{"b":1\}}`.
  - `CurlyBrackets(CurlyBrackets.escape('only close }} here'), {})` gives `only close \}} here`.
- **Fix:** the renderer turns every `\{{` into `{{` and every `\}}` into `}}`, paired or not. Test that `render(escape(s), {}) === s` for strings with lone, paired and nested braces.

## 2. `chopBeginningCharacter` / `chopEndingCharacter` always remove one UTF-16 unit

- **Where:** `src/lib/strings.ts`, around lines 270-289. `chopBothBeginningAndEndingCharacters` inherits this.
- **Problem:** they test `startsWith(char)` / `endsWith(char)` and then always do `slice(1)` / `slice(0, -1)`, whatever `char`'s length.
- **Repro:**
  - `chopBeginningCharacter('abc', '')` gives `bc`, because an empty `char` always matches.
  - `chopBeginningCharacter('😀abc', '😀')` gives a lone surrogate followed by `abc`.
  - `chopBeginningCharacter('--abc', '--')` gives `-abc`.
- **Fix:** slice by `char.length`, and return the string unchanged for an empty `char`. Alternatively, refuse a `char` that is not one character, if the name is meant literally. Decide which, and document it in `docs/strings.md`.

## 3. `splitGraphemes` in `strings.ts` mis-splits common emoji

- **Where:** `src/lib/strings.ts`, around line 144. It is used by `src/lib/ascii-tables/ascii-table-utils.ts`, so it reaches the table wrapping and `errorToString`.
- **Problem:** it is a hand-written splitter that handles ZWJ sequences but not VS16 (U+FE0F), skin-tone modifiers, regional-indicator flags, keycaps or Hangul jamo. The docs say it handles emoji correctly.
- **Repro:**
  - `'🇺🇸'` splits into two regional indicators, and `'❤️'` into `❤` and a bare U+FE0F.
  - `'👍🏽'` splits off its skin tone.
  - `ASCIITableUtils.wrapText('🇺🇸🇬🇧🇫🇷🇩🇪🇯🇵', 5)` splits the French flag across two lines.
- **Fix:** have `strings.ts`'s `splitGraphemes` delegate to `src/lib/internal/graphemes.ts`'s `splitGraphemes`. That one uses `Intl.Segmenter`, falls back to code points, and `datamask` already uses it. Keep the public signature. Add the cases above to `strings.test.ts` and an ASCII-table wrapping test.

## 4. `maskEmail` drops everything after a second `@`

- **Where:** `src/lib/datamask.ts`, around line 184: `const [user = '', domain = ''] = value.split('@')`.
- **Repro:** `maskEmail('a@b@evil.example.com')` gives `a@b`, and `maskEmail('"john@doe"@example.com')` loses the domain.
- **Fix:** split at the last `@`, since the domain part cannot contain one and a quoted local part can. Check what the original `datamask` package does first, since the docs promise its API. If it truncates too, decide whether to match it or document the difference.

## 5. `MultiColumnASCIITable` renders one column narrower than `tableWidth`

- **Where:** `src/lib/ascii-tables/multi-column-ascii-table.ts`, around lines 126 and 139: `availableWidth = tableWidth - (numColumns + 1) * 3 + 1`.
- **Problem:** a rendered line is `sum(columnWidths) + 3n + 1` wide, so the right value is `tableWidth - 3n - 1`. The effects:
  - Every table comes out at `tableWidth - 1`, while `docs/ascii-tables.md` calls `tableWidth` the total width. `KeyValueASCIITable` is exact.
  - In flex mode, tables can come out up to 6 columns short.
  - At `getMinimumWidth()` (4n+1) every column gets width 0, so the borders and rows have different lengths.
  - A table nested in a `KeyValueASCIITable` leaves a visible gap on the right.
- **Fix:** correct the formula and check that `getMinimumWidth()` agrees with it. Test every width from the minimum to 100, for 1-6 columns and both modes, and assert that every line is exactly `tableWidth` wide.

## 6. Docs and JSDoc examples that do not match the code

- **`docs/ascii-tables.md`:**
  - The flex description (around line 168) says extra width is split "proportionally based on header lengths", but the code splits it evenly. Either change the code to match, as part of item 5, or reword the docs.
  - The table example (around lines 187-196) shows column widths the code does not produce.
  - The `createSeparator([10, 20])` example (around line 235) shows 34 characters; the code returns 37.
  - Regenerate these examples from the code after item 5.
- **`src/lib/strings.ts` `characterAllowedOnly` JSDoc:**
  - The case-insensitive example (around line 225) claims `"Hello"`; the code returns `"hello"`. `docs/strings.md` already has this right.
  - The replacement example (around line 230) claims `"Hello---"`; the code returns `"Hello----"`, since four characters are disallowed.

## 7. `generateID('ulid', 0)` ignores the seed

- **Where:** `src/lib/id-helpers.ts`, around line 115: `return ulid(seedTime)`. `IDHelpers('ulid').generateID(0)` goes through the same call.
- **Problem:** ulid 3.0.2 reads its seed as `!seedTime || isNaN(seedTime) ? Date.now() : seedTime`, so a seed of `0` is replaced by the current time. The JSDoc and docs promise any non-negative finite millisecond seed is embedded, and `uuid7` and `objectID` honour `0`.
- **Repro:** `decodeTime(generateID('ulid', 0))` gives the current time, not `0`.
- **Fix:** pass a seed of `0` to ulid in a form it accepts, for example through `monotonicFactory` or by encoding the time with `encodeTime(0, 10)` plus random characters. Test that `decodeTime` returns `0`.

## 8. `generateID` seeds a format cannot hold are handled three ways

- **Where:** `src/lib/id-helpers.ts`, lines 95-117.
- **Problem:** the validation lets through any non-negative finite seed, but:
  - a fractional seed (`1500.5`) is floored by `uuid7` and `objectID`, while `ulid` throws `ULIDError: Time must be an integer`, not the documented `TypeError`;
  - a seed past the field's width wraps silently: `objectID` at 2^32 s gives timestamp field `00000001`, and `uuid7` at 2^48 ms gives `00000000-0000-…`, while `ulid` at 2^48 throws `ULIDError`.
- **Fix:** decide one rule - floor fractions, and refuse a seed past the format's maximum (2^48 - 1 ms for `uuid7` and `ulid`, 2^32 - 1 s for `objectID`) with a `TypeError`, before any library is called. Document the maximum per format in `docs/id-helpers.md` and test each boundary.

## 9. `LRUCache.set()` docs disagree on an oversized write and on expiry order

- **Where:** `docs/lru-cache.md` around lines 96, 106 and 165; code in `src/lib/lru-cache/index.ts` around lines 256-280.
- **Problem:** the code sweeps expired entries before it checks the write's size, so a skipped oversized write still removes unrelated expired entries and emits their `expired` events. The docs say the skip happens "without changing cache state" and "leaves the cache unchanged", and line 165 says expired entries are removed "after inserting the new value". The tests (`index.test.ts` around lines 734 and 820) pin the sweep-first behaviour.
- **Fix:** keep the code and reword the docs: the skip leaves the key's entry and the written value untouched, expired entries are swept at the start of every `set()`, skipped or not, and the sweep runs before inserting.

## 10. `formatJSON` returns the text `undefined`

- **Where:** `src/lib/json-helpers.ts`, line 12.
- **Problem:** for `undefined`, a function or a symbol, `JSON.stringify` returns `undefined`, and the concatenation turns it into the string `"undefined"` (or `"undefined\n"` with `isHuman`), which `JSON.parse` cannot read. The JSDoc promises "The formatted JSON string".
- **Fix:** decide whether to throw a `TypeError` for a value JSON cannot represent, or to return `undefined` with the return type widened to match. Document it and test all three inputs.

## 11. `removeEmptyStringsFromArray` docs don't say the kept strings are trimmed

- **Where:** `src/lib/arrays.ts` lines 7-17; `docs/arrays.md` line 44.
- **Problem:** the kept items come back trimmed (`['  hello  ', '', '\tworld\n']` gives `['hello', 'world']`), while the docs say only that each item "is trimmed before checking".
- **Fix:** reword the docs to say the returned strings are trimmed, and add a JSDoc to match. No code change.

## 12. `stringifyValue`'s `maxRenderLength` is not held for nested objects

- **Where:** `src/lib/internal/stringify-template-value.ts`, the object branch's truncation entry (around lines 583-610; the array branch has the same shape), and the key allowance in `src/lib/internal/render-budget.ts` (`MIN_KEY_ALLOWANCE`, 256, around lines 87 and 229). The promise is in `docs/stringify-value.md` around line 105.
- **Problem:** when the budget runs out deep in a value, every enclosing object that is still open adds one more `"<key>":"[max length exceeded]"` entry as it resumes, and each of those keys is allowed up to 256 characters. The overshoot grows with nesting depth, where the docs say the output passes the cap "by a marker or two - never by more than a small, fixed amount". `onTruncate` is called once however many markers are written.
- **Repro:** start from `o = 'x'.repeat(100000)` and wrap it `depth` times as `o = { a: o, ['k'.repeat(keyLength)]: 1 }`, then `stringifyValue(o, { maxRenderLength: 1000 })`:
  - depth 50, 1000-character keys: 15,050 characters, 101 markers.
  - depth 200, 300-character keys: 28,724 characters, 197 markers.
  - depth 50, 3-character keys: 2,500 characters, 51 markers.
  - depth 1, 1000-character key: 1,281 characters, 3 markers, which is the documented behaviour.
- **Fix:** once one container has written its truncation entry, the containers around it drop their tails without a marker of their own - a flag on the budget that says the tail is already marked - or their trailing key entries are charged and cut against the cap. Test that the output length stays within the cap plus a fixed allowance at depths 1, 50 and 200, that the result is still JSON for a plain object, and that the innermost cut still names its key. Reword the docs sentence if a bound other than "a marker or two" is the result.

## 13. `redactedKeys` normalization withholds every container at the exact entry budget

- **Where:** `src/lib/internal/redact-normalization.ts`, `normalizeAlongRedactPaths`, the `budget <= 0` test around line 385. The budget is `MAX_REDACTION_ENTRIES` (1,000,000) in `src/lib/internal/redact-paths.ts`.
- **Problem:** the budget is charged only when a container is descended into, but it is tested for every key inspected. When it reaches exactly 0 on the last descent, the next key inspected reports "normalization stopped" and withholds every frame still stacked, though none of them has anything left to descend into. It over-masks and never leaks.
- **Repro:** `redactValue({ items: Array.from({ length: 999_998 }, () => ({ x: 1 })) }, { redactedKeys: ['items[*].x.y'] })` replaces all 999,998 elements with `***REDACTION FAILED***` and reports `redactedKeys normalization stopped after 1000000 containers; every container not yet reached was withheld`. No element holds an `x` that is a container, so nothing was left to normalize.
- **To check while here:** with 999,997 elements the same call replaces only the last element and reports nothing. Find out which cap that is, and whether a withheld value with no report is intended.
- **Fix:** test the budget where it is spent - just before the `budget--` and push for a value that is a container to descend into - so a key whose value is not one cannot trip the stop. Test the boundary on both sides: a value that needs exactly the budget is normalized in full with nothing reported, and one container more stops and reports.

## 14. Comments that narrate what the code used to do

- **Where:** `src/lib/internal/`, in files PR #34 did not change:
  - `container-entries.ts` around line 147 ("a first cut ... silently dropped them");
  - `format-reporter.ts` around lines 8 and 33;
  - `mask-value-deep.ts` around line 45;
  - `render-budget.ts` around lines 77-94, 223, 243-245 and 336 ("which is what this did", "previously read");
  - `redact-normalization.ts` around lines 353 and 449 ("It used to be left at that");
  - `resolve-redaction.ts` around line 81;
  - `default-redact-function.ts` around line 28;
  - `path-utils.ts` around line 25;
  - `stringify-template-value.ts` around lines 101 and 583-596;
  - `redact-paths.ts` around lines 39, 456 and 1165.
  - The review also named `is-plain-container.ts` and `report-to-console.ts`; read them for the same wording.
- **Problem:** these comments describe an earlier version of the code and what it got wrong. The project's rule is that comments describe current behaviour and the reason for it, and history goes in the changelog.
- **Fix:** rewrite each to state the current rule and why it holds, keeping any example input that explains the rule. No code change and no test.
