# error-to-string

Format any error (or unknown thrown value) into a readable ASCII table string, surfacing message, name, code, stack, and custom fields.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [errorToString](#errortostring)
- [Recognized Fields](#recognized-fields)
- [Additional Info & Sensitive Fields](#additional-info--sensitive-fields)
- [Never throws](#never-throws)
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
| `error`        | `unknown` | -       | The error or thrown value to format    |
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

The following fields are automatically extracted from error objects when present and truthy. A falsy value produces no row at all, so `errno: 0`, `code: 0`, or `message: ''` are omitted rather than rendered:

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

`sensitiveFieldNames` uses the **same path syntax as the logger's [`redactedKeys`](./logger.md#redaction-of-sensitive-data)**, so one mental model covers both. A bare name addresses a top-level key of `additionalInfo`; reaching a nested value takes a path, and array indexes and quoted bracket keys work the same way:

```typescript
const err = new Error('auth failed');
(err as any).additionalInfo = {
  apiKey: 'sk_12345',
  user: { password: 'hunter2' },
  items: [{ token: 'abc' }],
};
(err as any).sensitiveFieldNames = [
  'apiKey',
  'user.password',
  'items[0].token',
];

// AdditionalInfo.apiKey → ***
// AdditionalInfo.user   → password: ***
// AdditionalInfo.items  → token: ***
```

A bare name does **not** match at depth. `sensitiveFieldNames: ['password']` masks `additionalInfo.password` and leaves `additionalInfo.user.password` rendered, exactly as `redactedKeys: ['password']` does in the logger. Name the path to reach it.

An error nested inside another's `additionalInfo` starts a fresh path root: the outer error's entries address it as a whole (`['cause']` masks the nested error entirely), and the nested error's own `sensitiveFieldNames` covers its own contents.

Masking **fails closed**. If `sensitiveFieldNames` is present but is not a usable list of paths - a comma-joined string, a `Set`, a non-string entry, a malformed path such as `'a.'`, or an accessor that throws - the caller has asked for masking somewhere this cannot locate, so `additionalInfo` is dropped wholesale and replaced with `*** (sensitiveFieldNames unreadable)` rather than rendered in the clear.

## Never throws

`errorToString` runs on reporting paths — [safe-handle-callback](./safe-handle-callback.md)
calls it to render whatever a callback threw — where raising a second failure on top of the
first is the worst possible outcome. It is written so it cannot:

- Every property read off the value is guarded. `message`, `stack`, `code` and the rest are
  ordinary properties, and a subclass or a `Proxy` can turn any of them into an accessor
  that throws. An unreadable member is treated as absent.
- Values that resist rendering become `<unrenderable>` rather than propagating. `String()`
  invokes `toString`/`Symbol.toPrimitive`, and `JSON.stringify` - used for an object-valued
  field such as `code` - throws on a cyclic object and on a nested `BigInt`. Note that a
  `BigInt` inside `additionalInfo` renders normally, since that walk handles each value
  individually rather than serializing the object whole.
- The recursive walk of `additionalInfo` tracks the objects on the current path and cuts a
  cycle with `<circular>` rather than exhausting the stack. Only a genuine cycle - an
  object contained within itself - is cut; an object merely referenced twice side by side
  renders in full both times.
- The whole render is wrapped as a backstop. A payload nested deeply enough can still
  exhaust the stack, and the resulting `RangeError` is caught and returned as
  `<error could not be rendered>`.

For a single-line description rather than a table, see
[`describeError`](./to-error.md#describeerror), which offers the same guarantee.

## Notes

- Non-object values passed to `errorToString` return an empty table - a bordered box with no rows, not an empty string.
- The table auto-adjusts column widths when possible to minimize wasted space.
- Stack traces are rendered on a separate full-width row for readability.
