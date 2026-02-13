# error-to-string

Format any error (or unknown thrown value) into a readable ASCII table string, surfacing message, name, code, stack, and custom fields.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [errorToString](#errortostring)
- [Recognized Fields](#recognized-fields)
- [Additional Info & Sensitive Fields](#additional-info--sensitive-fields)
- [Notes](#notes)

<!-- tocstop -->

## Usage

```typescript
import { errorToString } from 'lifecycleion/error-to-string';
```

## API

### errorToString

Converts an error (or any unknown value) into a formatted ASCII table string.

```typescript
function errorToString(error: unknown, maxRowLength?: number): string;
```

| Parameter      | Type      | Default | Description                            |
| -------------- | --------- | ------- | -------------------------------------- |
| `error`        | `unknown` | —       | The error or thrown value to format    |
| `maxRowLength` | `number`  | `80`    | Maximum character width for table rows |

```typescript
try {
  throw new Error('Something went wrong');
} catch (err) {
  console.log(errorToString(err));
}
// Outputs an ASCII table with Key/Value rows for Message, Name, Stack, etc.
```

Custom width:

```typescript
console.log(errorToString(err, 120));
```

## Recognized Fields

The following fields are automatically extracted from error objects when present:

| Field       | Table Label |
| ----------- | ----------- |
| `message`   | Message     |
| `name`      | Name        |
| `code`      | Code        |
| `errno`     | Errno       |
| `errPrefix` | Prefix      |
| `errType`   | errType     |
| `errCode`   | errCode     |
| `stack`     | Stack       |

## Additional Info & Sensitive Fields

If the error has an `additionalInfo` object, each key is rendered as an `AdditionalInfo.<key>` row. Nested objects and arrays are handled recursively, and nested `Error` instances produce sub-tables.

Fields listed in `sensitiveFieldNames` (a string array on the error) are masked with `***`:

```typescript
const err = new Error('auth failed');
(err as any).additionalInfo = { token: 'secret-abc', user: 'alice' };
(err as any).sensitiveFieldNames = ['token'];

console.log(errorToString(err));
// AdditionalInfo.token → ***
// AdditionalInfo.user  → alice
```

## Notes

- Non-object values passed to `errorToString` return an empty table.
- The table auto-adjusts column widths when possible to minimize wasted space.
- Stack traces are rendered on a separate full-width row for readability.
