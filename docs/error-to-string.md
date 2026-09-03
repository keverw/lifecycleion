# error-to-string

Format any error (or unknown thrown value) into a readable ASCII table string, surfacing message, name, code, stack, and custom fields.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [errorToString](#errortostring)
- [Recognized Fields](#recognized-fields)
- [Additional Info & Sensitive Fields](#additional-info--sensitive-fields)
  - [Choosing how values are masked](#choosing-how-values-are-masked)
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

A bare name is taken literally, so `sensitiveFieldNames: ['password-hash']` masks `additionalInfo['password-hash']`.

A path segment is delimited by `.`, `[` and `]` only, so ordinary key names need no quoting inside a path either: `user.password-hash`, `u.my key`, and `users[0].api-key` all work. A key that genuinely contains a delimiter needs the quoted bracket form, which is the only way to disambiguate it: `user["a.b"]`.

Entries the grammar rejects mask **nothing at all**, silently. That covers wildcard selectors such as `users[*].password`, which are not supported, along with a trailing dot and an unterminated bracket. The logger's `redactedKeys` behaves identically.

A dotted or bracketed entry is treated as ambiguous and both readings are covered, the same way the logger's `redactedKeys` does: `'user.password'` masks the nested `additionalInfo.user.password` _and_ a literal key spelled `'user.password'`, when either exists.

#### Choosing how values are masked

Masked values use the same default the logger applies, so a value renders identically whether it went through a log line or a rendered error. That default is **partial**: roughly the middle 60% is masked, so the first and last characters survive and the same secret can be correlated across log lines. That means a long value leaves a proportionally long prefix and suffix readable - if that is not acceptable for your data, pass a `redactFunction` returning a constant. A value too short for proportional masking to hide anything falls back to `***REDACTED***` rather than being returned unmasked.

```typescript
// AdditionalInfo.username → j****oe
```

Pass a `redactFunction` to mask differently. It receives the key and the value, exactly like the logger's option, so one function serves both:

```typescript
errorToString(err, 80, { redactFunction: (key) => `[redacted ${key}]` });
```

Return `null` to defer to the default for that value - so you can special-case a few keys without reproducing the default masking for the rest:

```typescript
errorToString(err, 80, {
  redactFunction: (key, value) => (key === 'apiKey' ? '***' : null),
});
// apiKey renders ***, every other sensitive field gets the default masking
```

To render a literal null, return the string `'null'`. Returning **nothing** is not a deferral: `undefined` is used literally, which drops the value.

The function is handed the key exactly as you wrote it in `sensitiveFieldNames` (`user.password`, not the leaf `password`) and the value already stringified, which is what the logger passes for the same field - so the same function genuinely serves both, and a mutating function cannot reach into your error object.

If the `redactFunction` throws, or reading the value throws, the result falls back to `***` - never to the original value.

Masking **fails closed** when the _list itself_ is unusable. A comma-joined string, a `Set`, a non-string entry, or an accessor that throws all mean the caller asked for masking and this cannot tell what for, so `additionalInfo` is dropped wholesale and replaced with `*** (sensitiveFieldNames unreadable)` rather than rendered in the clear. This does **not** extend to an individual entry: one that does not parse, or that parses but matches nothing, simply masks nothing and leaves the other entries working, exactly as an unmatched `redactedKeys` entry redacts nothing in the logger.

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
