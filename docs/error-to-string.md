# error-to-string

Format any error (or unknown thrown value) into a readable ASCII table string, surfacing message, name, code, stack, and custom fields.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [errorToString](#errortostring)
- [Recognized Fields](#recognized-fields)
- [Additional Info & Sensitive Fields](#additional-info--sensitive-fields)
  - [Choosing How Values Are Masked](#choosing-how-values-are-masked)
- [Never Throws](#never-throws)
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
  /** Notified when redaction or rendering fails. Defaults to `console.error`. */
  onFormatError?: (
    error: Error,
    kind: 'redaction' | 'render',
    path: string,
  ) => void;
  /** Characters this call may emit. Defaults to 1,000,000; `Infinity` for no bound. */
  maxRenderLength?: number;
  /** Notified when the output was cut short. */
  onTruncate?: (info: TruncationInfo) => void;
}

interface TruncationInfo {
  /** Which bound stopped the render. */
  reason: 'length' | 'depth' | 'circular';
  /** What was being rendered when it stopped - `<error>` here. */
  subject: string;
  /** Characters known to be dropped, or `undefined` when nothing measured them. */
  dropped: number | undefined;
}
```

`maxRenderLength` is one allowance for the whole table, shared by every row and by the
masking that runs before them, so an error with a long `cause` chain costs one cap rather
than one per link. It is separate from `maxRowLength`, which sets the table's _width_;
this sets how much may be emitted in total.

Truncation does not reach `onFormatError` - that channel means a value _refused_ to render
and hands you an error, and there is none here. `onTruncate` fires at most once per call
with the first cut, and takes the same shape `curlyBrackets` and `stringifyValue` use.

| Parameter      | Type                   | Default | Description                                                              |
| -------------- | ---------------------- | ------- | ------------------------------------------------------------------------ |
| `error`        | `unknown`              | -       | The error or thrown value to format                                      |
| `maxRowLength` | `number`               | `80`    | Maximum character width for table rows                                   |
| `options`      | `ErrorToStringOptions` | -       | How sensitive values are masked, and where a masking failure is reported |

A table needs nine characters to draw its own borders and one character of each column, so
`maxRowLength` is raised to `9` if you ask for less than that. A value that names no width
at all - `0`, a negative number, `NaN` - falls back to the default `80`. It is also capped
above, at `10,000`: every row is padded out to the table width, so the width alone - not
the payload - decided the size of the output, and `errorToString(err, 10_000_000)` returned
a 120 MB string against the one-megabyte render cap. None of the three cases fails:
rendering at a clamped width is always a better answer than discarding the error's message,
name, and stack.

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

`sensitiveFieldNames` uses the **same path syntax as the logger's [`redactedKeys`](./logger.md#redaction-of-sensitive-data)**, so one mental model covers both. That extends to what a path _means_: it names a **location, not a value**, so one object sitting at two places in `additionalInfo` is masked only where it was named and is printed in full at the other. See [A Path Names a Location, Not a Value](./logger.md#a-path-names-a-location-not-a-value). A bare name addresses a top-level key of `additionalInfo`. Reaching a nested value takes a path, and array indexes and quoted bracket keys work the same way:

```typescript
const err = new Error('auth failed');
(err as any).additionalInfo = {
  apiKey: 'sk_12345',
  user: { password: 'hunter2' },
  items: [{ token: 'abc' }, { token: 'def' }],
};
(err as any).sensitiveFieldNames = [
  'apiKey',
  'user.password',
  'items[*].token',
];

// AdditionalInfo.apiKey → *******5
// AdditionalInfo.user   → password: ***REDACTED***
// AdditionalInfo.items  → every element's token masked
```

A bare name does **not** match at depth. `sensitiveFieldNames: ['password']` masks `additionalInfo.password` and leaves `additionalInfo.user.password` rendered, exactly as `redactedKeys: ['password']` does in the logger. Name the path to reach it.

An error nested inside another's `additionalInfo` starts a fresh path root: the outer error's entries address it as a whole (`['cause']` masks the nested error entirely), and the nested error's own `sensitiveFieldNames` covers its own contents.

A bare name is taken literally, so `sensitiveFieldNames: ['password-hash']` masks `additionalInfo['password-hash']`.

The rendered table and `onFormatError` spell the same location from the error - `additionalInfo.password` - and copying that spelling into `sensitiveFieldNames` is accepted too: an entry beginning `additionalInfo.` is read both as written and with that prefix removed, so `['additionalInfo.user.password']` masks `additionalInfo.user.password` exactly as `['user.password']` does. Only the dotted spelling is aliased this way, and a bag that genuinely holds a key named `additionalInfo` is masked at both readings.

An unquoted path segment is a run of name characters - letters, digits, combining marks, `_`, `$`, `@` and `-` - so ordinary key names need no quoting inside a path either: `user.password-hash`, `user.@id`, and `users[0].api-key` all work. A key that contains anything else, including a delimiter, whitespace, or any other punctuation, needs the quoted bracket form, which is the only way to disambiguate it: `user["a.b"]`, `user["my key"]`, `user["a+b"]`.

A wildcard segment addresses **every element of an array**, with `*` and `[*]` the same rule written two ways - so `users[*].password` and `users.*.password` both mask the password of every user. It stands in for an array index and only for one: against a plain object it is the key literally spelled `*`, and an array's named properties are not expanded over either. The quoted `["*"]` is the same segment rather than an escape hatch, for the reason quoting never changes a segment's meaning: `users[0]`, `users["0"]` and `users.0` are already one entry too. See [Wildcards Over Arrays](./logger.md#wildcards-over-arrays), which covers this surface too.

Entries the grammar rejects mask **nothing at all**, silently. That covers a trailing dot, an unterminated bracket, and a partial wildcard such as `us*rs`. The logger's `redactedKeys` behaves identically.

A dotted or bracketed entry is treated as ambiguous and both readings are covered, the same way the logger's `redactedKeys` does: `'user.password'` masks the nested `additionalInfo.user.password` _and_ a literal key spelled `'user.password'`, when either exists.

#### Choosing How Values Are Masked

Masked values use the same default the logger applies, so a value renders identically whether it went through a log line or a rendered error. That default masks 90% of strings that are at least 8 characters long, so a little survives at each end and the same secret can be correlated across log lines without being readable. Short strings and values rendered from other types are replaced outright, as described below.

The `redactFunction` here honours the same return contract as the logger's - a string is used literally, `null` defers to the default, a number sets the percent, and an object is always a masking request, never a replacement value. A plain object whose own keys are all masking settings (`strategy`, one of `'string' | 'email' | 'domain'`, plus `percent`, `maskChar`, `userPercent`, `domainPercent`) is masked with those. Any other object - `{}`, an unrecognized key, a mixture, an array, a class instance - falls back to the default masking, landing exactly where `null` does, the treatment of non-string values included. The value reaching your function is always a `string`, already rendered. See [the logger docs](./logger.md#controlling-how-a-value-is-masked) for the full table.

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

Pass `onFormatError` to find out why a value failed to redact - it receives the error, `kind: 'redaction'`, and the `sensitiveFieldNames` entry it happened on. The same callback also reports rendering failures under `kind: 'render'`. Both come from the same walk over the same value and address it the same way, which is why they are one callback with a discriminator rather than two. It fires at most once per kind per call, and with no handler reports on the standard global `'error'` channel so a `logger.registerReportErrorListener()` records it, falling back to `console.error` when nothing claims it. The same option is on the logger and on `stringifyValue`.

If the `redactFunction` throws, or reading the value throws, the result is `***REDACTION FAILED***` - never the original value. That is the same marker the logger uses for the same condition, and it is deliberately distinct from a successful mask so a broken `redactFunction` cannot hide behind output that looks fine.

Masking **fails closed** when the _list itself_ is unusable. A comma-joined string, a `Set`, a non-string entry, or an accessor that throws all mean the caller asked for masking and this cannot tell what for, so `additionalInfo` is dropped wholesale and replaced with `*** (sensitiveFieldNames unreadable)` rather than rendered in the clear. This does **not** extend to an individual entry: one that does not parse, or that parses but matches nothing, simply masks nothing and leaves the other entries working, exactly as an unmatched `redactedKeys` entry redacts nothing in the logger.

## Never Throws

`errorToString` runs on reporting paths. [safe-handle-callback](./safe-handle-callback.md)
calls it to render whatever a callback threw, where raising a second failure on top of the
first is the worst possible outcome. It is written so it cannot:

- Every property read off the value is guarded. `message`, `stack`, `code` and the rest are
  ordinary properties, and a subclass or a `Proxy` can turn any of them into an accessor
  that throws. Every one of them is marked rather than dropped - a conventional member,
  `stack`, `additionalInfo`, `cause`, or an entry inside `additionalInfo` - and the failure
  is reported on the `'render'` channel, so a member that refused to be read is never
  mistaken for one that was not there.
- Values that resist rendering are marked rather than propagating, and the marker names
  which half refused:

  | Marker                  | Meaning                                                                                                                                                                            |
  | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `<unrenderable: keys>`  | The container would not be enumerated because of a revoked `Proxy` or a throwing `ownKeys` trap.                                                                                   |
  | `<unrenderable: value>` | One value would not be read because of a throwing accessor or a revoked `Proxy`.                                                                                                   |
  | `<unrenderable: text>`  | The value was read but could not be turned into text. `String()` invokes `toString`/`Symbol.toPrimitive`, and `JSON.stringify` throws on a cyclic object and on a nested `BigInt`. |

  **The cause is deliberately not in the marker.** The thrown value is yours: a getter is
  free to throw `new Error('cannot read ' + this.password)`, and a marker carrying that
  message would put the value into the table, past `sensitiveFieldNames`, and into every
  sink. These three are library-authored text with nothing of yours in them, which is what
  makes them safe to render. A cause is only ever handed to a callback, never written into
  the output: pass **`onFormatError`** to receive it.

  ```ts
  errorToString(err, 80, {
    onFormatError: (error, kind, path) => {
      // kind: 'render' here; 'redaction' when a redactFunction is what threw
      // path: 'additionalInfo.items.0.token' — structural, never a value
      // error: the getter's own throw — may contain the value, which is why the
      //        table above never carries it
    },
  });
  ```

  It fires **at most once per render** (a failure is raised per value, and one report per
  value would be its own flood). With no handler it reports on the standard global `'error'` channel, so a `logger.registerReportErrorListener()` records it, falling back to `console.error` when nothing claims it. The `Logger` and its sinks never use that channel for their own work - they always supply a handler, defaulting to the console, because broadcasting from inside a log call would be logged by the listener, and logging renders. Paths keep going through a nested error's own table, so a failure inside a
  `cause` still says `cause.additionalInfo.token`.

  Note that a `BigInt` inside `additionalInfo` renders normally, since that walk handles
  each value individually rather than serializing the object whole.

- The recursive walk of `additionalInfo` tracks the objects on the current path and cuts a
  cycle with `<circular>` rather than exhausting the stack. Only a genuine cycle - an
  object contained within itself - is cut. An object merely referenced twice side by side
  renders in full both times.
- The walk is bounded in both directions, sharing its limits with the logger's template
  rendering. Past 100 levels it stops and marks the spot with `[max depth exceeded]`. Past
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
