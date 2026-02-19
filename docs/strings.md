# strings

String type guards and utilities for case conversion, grapheme splitting, character filtering, and trimming matched edge characters.

<!-- toc -->

- [Usage](#usage)
- [Overview](#overview)
- [API](#api)
  - [isString](#isstring)
  - [toPascalCase](#topascalcase)
  - [toCamelCase](#tocamelcase)
  - [toCamelCaseWithPascalOverride](#tocamelcasewithpascaloverride)
  - [toConstantCase](#toconstantcase)
  - [splitGraphemes](#splitgraphemes)
  - [skipTrailingNewLines](#skiptrailingnewlines)
  - [characterAllowedOnly](#characterallowedonly)
  - [chopBeginningCharacter](#chopbeginningcharacter)
  - [chopEndingCharacter](#chopendingcharacter)
  - [chopBothBeginningAndEndingCharacters](#chopbothbeginningandendingcharacters)

<!-- tocstop -->

## Usage

```typescript
import {
  isString,
  toPascalCase,
  toCamelCase,
  toCamelCaseWithPascalOverride,
  toConstantCase,
  splitGraphemes,
  skipTrailingNewLines,
  characterAllowedOnly,
  chopBeginningCharacter,
  chopEndingCharacter,
  chopBothBeginningAndEndingCharacters,
} from 'lifecycleion/strings';
```

## Overview

`toPascalCase`, `toCamelCase`, `toCamelCaseWithPascalOverride`, and `toConstantCase` all share the same normalization approach:

- They accept either a `string` or `string[]`.
- They remove all characters except `a-z`, `A-Z`, `0-9`, and `-`.
- Hyphens are treated as word boundaries.
- Empty segments (for example from `--`) are ignored.

## API

### isString

Type guard that returns `true` when a value is a primitive `string`.

```typescript
isString('hello'); // true
isString(42); // false
```

### toPascalCase

Converts a string or array of strings to PascalCase. Non-alphanumeric characters (except hyphens) are removed, and hyphens act as word separators.

```typescript
toPascalCase('hello-world-123!$'); // "HelloWorld123"
toPascalCase(['hello', 'world-123!$']); // "HelloWorld123"
toPascalCase('-leading-trailing-'); // "LeadingTrailing"
```

### toCamelCase

Converts a string or array of strings to camelCase. Non-alphanumeric characters (except hyphens) are removed, and hyphens act as word separators.

```typescript
toCamelCase('hello-world-123!$'); // "helloWorld123"
toCamelCase(['hello', 'world-123!$']); // "helloWorld123"
toCamelCase('-leading-trailing-'); // "leadingTrailing"
```

### toCamelCaseWithPascalOverride

Same as `toCamelCase`, except it switches to `toPascalCase` when input starts with `-`.

- For `string[]`, only the first element is checked for the leading `-`.

```typescript
toCamelCaseWithPascalOverride('hello-world'); // "helloWorld"
toCamelCaseWithPascalOverride('-hello-world'); // "HelloWorld"
toCamelCaseWithPascalOverride(['-hello', 'world']); // "HelloWorld"
```

### toConstantCase

Converts a string or array of strings to `CONSTANT_CASE` (all uppercase, words separated by underscores).

```typescript
toConstantCase('hello-world'); // "HELLO_WORLD"
toConstantCase('a!b$c-d'); // "ABC_D"
toConstantCase(['---a-b-c----', '--d-e-f-g--']); // "A_B_C_D_E_F_G"
```

### splitGraphemes

Splits a string into an array of grapheme clusters, correctly handling combining marks, surrogate pairs, and ZWJ emoji sequences.

```typescript
splitGraphemes('café'); // ["c", "a", "f", "é"]
splitGraphemes('e\u0301'); // ["é"]
splitGraphemes('👨‍👩‍👧‍👦'); // ["👨‍👩‍👧‍👦"]
splitGraphemes('สวัสดี'); // ["ส", "วั", "ส", "ดี"]
```

### skipTrailingNewLines

Removes trailing `\n` characters from the end of a string.

```typescript
skipTrailingNewLines('hello\n\n'); // "hello"
skipTrailingNewLines('hello\nworld\n'); // "hello\nworld"
```

### characterAllowedOnly

Keeps only characters included in `list`. Characters not in `list` are removed, or replaced with `replacementChar`.

| Parameter         | Type       | Default | Description                                                     |
| ----------------- | ---------- | ------- | --------------------------------------------------------------- |
| `str`             | `string`   |         | Input string                                                    |
| `list`            | `string[]` |         | Allowed characters                                              |
| `caseInsensitive` | `boolean`  | `false` | If `true`, compares in lowercase                                |
| `replacementChar` | `string`   | `''`    | Replacement for disallowed chars, where `''` means remove chars |

Notes:

- With `caseInsensitive: true`, output is lowercased.

```typescript
characterAllowedOnly('Hello123!', ['H', 'e', 'l', 'o']); // "Hello"
characterAllowedOnly('ABC.def', ['A', 'B', 'C', 'D', 'E', 'F'], true); // "abcdef"
characterAllowedOnly(
  'ABC.DEF#GHI',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  false,
  '-',
);
// "ABC-DEF-GHI"
```

### chopBeginningCharacter

Removes the leading `char` if present (at most one occurrence).

```typescript
chopBeginningCharacter('/foo/bar', '/'); // "foo/bar"
chopBeginningCharacter('foo/bar', '/'); // "foo/bar"
```

### chopEndingCharacter

Removes the trailing `char` if present (at most one occurrence).

```typescript
chopEndingCharacter('foo/bar/', '/'); // "foo/bar"
chopEndingCharacter('foo/bar', '/'); // "foo/bar"
```

### chopBothBeginningAndEndingCharacters

Removes a matching `char` from both ends of `str` (at most one from each end).

```typescript
chopBothBeginningAndEndingCharacters('/foo/bar/', '/'); // "foo/bar"
```
