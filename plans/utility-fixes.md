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
