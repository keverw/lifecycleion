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
function errorToString(
  error: unknown,
  maxRowLength?: number,
  options?: ErrorToStringOptions,
): string;

interface ErrorToStringOptions {
  /** Decides how a value named by `sensitiveFieldNames` is replaced. */
  redactFunction?: (key: string, value: string) => RedactFunctionResult;
  /** Notified when redaction fails. Defaults to `console.error`. */
  onRedactionError?: (error: Error, key: string) => void;
}
```

| Parameter      | Type                   | Default | Description                                                              |
| -------------- | ---------------------- | ------- | ------------------------------------------------------------------------ |
| `error`        | `unknown`              | -       | The error or thrown value to format                                      |
| `maxRowLength` | `number`               | `80`    | Maximum character width for table rows                                   |
| `options`      | `ErrorToStringOptions` | -       | How sensitive values are masked, and where a masking failure is reported |

`RedactFunctionResult` is the same contract the logger uses - see
[Choosing how values are masked](#choosing-how-values-are-masked). The value reaching your
`redactFunction` is always a `string`, already rendered.

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
| `cause`     | Cause       |
| `stack`     | Stack       |

A `cause` is rendered as its own nested table when it is itself an error, so a wrapped
failure shows the wrapping and the failure together. That is how a report from
[`safeHandleCallback`](./safe-handle-callback.md) carries the value a callback actually
threw. A `cause` that is not an error is rendered like any other value and is addressed by
`sensitiveFieldNames` under the `cause` root - `['cause']` masks the whole of it and
`['cause.password']` reaches one field inside it.

A value that is not a plain object or an array - a `Date`, a `Map`, a `URL`, a class
instance - is rendered by its own string form rather than walked, which is the same rule
the logger's redaction follows. Naming a path inside such a value therefore masks the whole
value: masking one field of a class instance and printing its siblings is a disclosure, and
the two must agree about what counts as structure.

## Additional Info & Sensitive Fields

If the error has an `additionalInfo` object, each key is rendered as an `AdditionalInfo.<key>` row. Nested objects and arrays are handled recursively, and nested `Error` instances produce sub-tables.

Fields listed in `sensitiveFieldNames` (a string array on the error) are masked:

```typescript
const err = new Error('auth failed');
(err as any).additionalInfo = { token: 'secret-abc', user: 'alice' };
(err as any).sensitiveFieldNames = ['token'];

console.log(errorToString(err));
// AdditionalInfo.token → *********c
// AdditionalInfo.user  → alice
```

`sensitiveFieldNames` uses the **same path syntax as the logger's [`redactedKeys`](./logger.md#redaction-of-sensitive-data)**, so one mental model covers both. That extends to what a path _means_: it names a **location, not a value**, so one object sitting at two places in `additionalInfo` is masked only where it was named and is printed in full at the other. See [A Path Names a Location, Not a Value](./logger.md#a-path-names-a-location-not-a-value). A bare name addresses a top-level key of `additionalInfo`; reaching a nested value takes a path, and array indexes and quoted bracket keys work the same way:

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

// AdditionalInfo.apiKey → *******5
// AdditionalInfo.user   → password: ***REDACTED***
// AdditionalInfo.items  → [{"key":"token","value":"***REDACTED***"}]
```

A bare name does **not** match at depth. `sensitiveFieldNames: ['password']` masks `additionalInfo.password` and leaves `additionalInfo.user.password` rendered, exactly as `redactedKeys: ['password']` does in the logger. Name the path to reach it.

An error nested inside another's `additionalInfo` starts a fresh path root: the outer error's entries address it as a whole (`['cause']` masks the nested error entirely), and the nested error's own `sensitiveFieldNames` covers its own contents.

A bare name is taken literally, so `sensitiveFieldNames: ['password-hash']` masks `additionalInfo['password-hash']`.

An unquoted path segment is a run of name characters - letters, digits, combining marks, `_`, `$`, `@` and `-` - so ordinary key names need no quoting inside a path either: `user.password-hash`, `user.@id`, and `users[0].api-key` all work. A key that contains anything else, including a delimiter, whitespace, or any other punctuation, needs the quoted bracket form, which is the only way to disambiguate it: `user["a.b"]`, `user["my key"]`, `user["a+b"]`.

Entries the grammar rejects mask **nothing at all**, silently. That covers wildcard selectors such as `users[*].password`, which are not supported, along with a trailing dot and an unterminated bracket. The logger's `redactedKeys` behaves identically.

A dotted or bracketed entry is treated as ambiguous and both readings are covered, the same way the logger's `redactedKeys` does: `'user.password'` masks the nested `additionalInfo.user.password` _and_ a literal key spelled `'user.password'`, when either exists.

#### Choosing how values are masked

Masked values use the same default the logger applies, so a value renders identically whether it went through a log line or a rendered error. That default masks 90% of a value, so a little survives at each end and the same secret can be correlated across log lines without being readable.

The `redactFunction` here honours the same return contract as the logger's - a string is used literally, `null` defers to the default, a number sets the percent, and an object is always a masking request, never a replacement value. A plain object whose own keys are all masking settings (`strategy`, one of `'string' | 'email' | 'domain'`, plus `percent`, `maskChar`, `userPercent`, `domainPercent`) is masked with those; any other object - `{}`, an unrecognized key, a mixture, an array, a class instance - falls back to the default masking, landing exactly where `null` does, the treatment of non-string values included. The value reaching your function is always a `string`, already rendered. See [the logger docs](./logger.md#controlling-how-a-value-is-masked) for the full table.

```typescript
// apiKey: 'sk_live_51H8x9QcAbCdEf'
// AdditionalInfo.apiKey → s*******************Ef
```

A value shorter than 8 characters is replaced outright with `***REDACTED***` instead, since masking a proportion of something that short hides almost nothing - a four-digit PIN would otherwise render `1**4`.

Pass a `redactFunction` to mask differently. It receives the key and the value, exactly like the logger's option, so one function serves both:

```typescript
errorToString(err, 80, { redactFunction: (key) => `[redacted ${key}]` });
```

Naming a plain object or an array masks **each value inside it** and keeps the shape, rather than replacing the whole thing with one mask.

Any **other** value whose string form is produced rather than being the value itself - an `Error`, a `Date`, a `URL`, a `Map`, a class instance, a function, a symbol, and `null` or `undefined` - has no shape worth rebuilding, so it is replaced outright with `***REDACTED***`. It is deliberately not stringified and partially masked: the default keeps a value's first and last characters, and for a `URL` or a custom `toString` that is exactly where a secret tends to sit.

Return `null` to defer to the default for that value - so you can special-case a few keys without reproducing the default masking for the rest:

```typescript
errorToString(err, 80, {
  redactFunction: (key, value) => (key === 'apiKey' ? '***' : null),
});
// apiKey renders ***, every other sensitive field gets the default masking
```

To render a literal null, return the string `'null'`. Returning **nothing** defers as well: `undefined` is read exactly as `null`, so a function that handles a few keys and falls off the end for the rest masks them by default.

The function is handed the key exactly as you wrote it in `sensitiveFieldNames` (`user.password`, not the leaf `password`) and the value already stringified, which is what the logger passes for the same field - so the same function genuinely serves both, and a mutating function cannot reach into your error object.

Pass `onRedactionError` to find out why a value failed to redact - it receives the error and the `sensitiveFieldNames` entry it happened on, defaults to `console.error`, and fires at most once per call. The same option is on the logger and on `stringifyValue`.

If the `redactFunction` throws, or reading the value throws, the result is `***REDACTION FAILED***` - never the original value. That is the same marker the logger uses for the same condition, and it is deliberately distinct from a successful mask so a broken `redactFunction` cannot hide behind output that looks fine.

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
- The walk is bounded in both directions, sharing its limits with the logger's template
  rendering. Past 100 levels it stops and marks the spot with `[max depth exceeded]`; past
  roughly a megabyte of output it stops and marks it with `[max length exceeded]`. Both
  matter because the cycle check above deliberately lets an object referenced twice render
  twice, so a payload that reuses one subtree doubles in size per level without ever being
  circular or especially deep. The masking walk is bounded the same way.
- The whole render is still wrapped as a backstop, and returns
  `<error could not be rendered>` if anything escapes. With the limits above that is no
  longer reachable through payload size alone.

For a single-line description rather than a table, see
[`describeError`](./to-error.md#describeerror), which offers the same guarantee.

## Notes

- Non-object values passed to `errorToString` return an empty table - a bordered box with no rows, not an empty string.
- The table auto-adjusts column widths when possible to minimize wasted space.
- Stack traces are rendered on a separate full-width row for readability.
