# constants

Common string constants for whitespace, indentation, and Python-style character sets.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [Whitespace & Formatting](#whitespace--formatting)
  - [Character Sets (Python string-style)](#character-sets-python-string-style)

<!-- tocstop -->

## Usage

```typescript
import {
  BLANK_SPACE,
  EOL,
  DOUBLE_EOL,
  INDENT,
  DOUBLE_INDENT,
  SINGLE_QUOTE,
  ASCII_LOWERCASE,
  ASCII_UPPERCASE,
  ASCII_LETTERS,
  DIGITS,
  HEX_DIGITS,
  OCT_DIGITS,
  PUNCTUATION,
  WHITESPACE,
  PRINTABLE,
} from 'lifecycleion/constants';
```

## API

### Whitespace & Formatting

| Constant        | Value            | Description                           |
| --------------- | ---------------- | ------------------------------------- |
| `BLANK_SPACE`   | `' '`            | A single space character              |
| `EOL`           | `'\n'`           | Newline character                     |
| `DOUBLE_EOL`    | `'\n\n'`         | Two newline characters                |
| `INDENT`        | `'    '` (4 sp.) | Four-space indentation                |
| `DOUBLE_INDENT` | `'        '`     | Eight-space indentation (two indents) |
| `SINGLE_QUOTE`  | `"'"`            | A single quote character              |

### Character Sets (Python string-style)

Inspired by Python's [`string`](https://docs.python.org/3/library/string.html) module.

| Constant          | Value                                               | Description                       |
| ----------------- | --------------------------------------------------- | --------------------------------- |
| `ASCII_LOWERCASE` | `'abcdefghijklmnopqrstuvwxyz'`                      | All lowercase ASCII letters       |
| `ASCII_UPPERCASE` | `'ABCDEFGHIJKLMNOPQRSTUVWXYZ'`                      | All uppercase ASCII letters       |
| `ASCII_LETTERS`   | `ASCII_LOWERCASE + ASCII_UPPERCASE`                 | All ASCII letters (lower + upper) |
| `DIGITS`          | `'0123456789'`                                      | Decimal digit characters          |
| `HEX_DIGITS`      | `'0123456789abcdefABCDEF'`                          | Hexadecimal digit characters      |
| `OCT_DIGITS`      | `'01234567'`                                        | Octal digit characters            |
| `PUNCTUATION`     | ``'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{\|}~'``           | ASCII punctuation characters      |
| `WHITESPACE`      | `' \t\n\r\v\f'`                                     | ASCII whitespace characters       |
| `PRINTABLE`       | `DIGITS + ASCII_LETTERS + PUNCTUATION + WHITESPACE` | All printable ASCII characters    |
