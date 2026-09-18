# stringify-value

Render any value as a display string, or return it with parts redacted. The rendering and masking every Lifecycleion module uses, exported so an application can produce the same output.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [stringifyValue](#stringifyvalue)
  - [Options](#options)
    - [Bounding and Observing the Render](#bounding-and-observing-the-render)
      - [Binary Data](#binary-data)
  - [redactValue](#redactvalue)
- [How Values Render](#how-values-render)
- [Redacting While Rendering](#redacting-while-rendering)
  - [What Masking Reaches](#what-masking-reaches)
- [Notes](#notes)

<!-- tocstop -->

## Usage

```typescript
import { redactValue, stringifyValue } from 'lifecycleion/stringify-value';
```

## API

### stringifyValue

```typescript
function stringifyValue(
  value: unknown,
  options?: StringifyValueOptions,
): string;
```

Never throws. A value that resists rendering degrades to a placeholder rather than raising an error out of whatever was trying to describe it.

`stringifyValue` is intended for display, logging, and diagnostic output. Its output is
lossy and may contain descriptive markers, so do not use it as an API payload, persistence
format, or round-trip serialization format. Use JSON for structured data interchange, or a format such as BSON or CBOR when
JSON's data model is insufficient.

### Options

Both functions take the same options.

```typescript
interface StringifyValueOptions {
  /** Paths to mask, same syntax as the logger's `redactedKeys`. */
  redactedKeys?: string[];
  /** Decides how a matched value is replaced. */
  redactFunction?: (key: string, value: string) => RedactFunctionResult;
  /**
   * Notified when redaction or rendering fails. Otherwise uses the standard host path:
   * global `'error'`, then `globalThis.reportError()` if dispatch is unavailable, then
   * guarded `console.error`.
   */
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
  /** What was being rendered when it stopped - `<value>` for a bare render. */
  subject: string;
  /** Characters known to be dropped, or `undefined` when nothing measured them. */
  dropped: number | undefined;
}

/**
 * A string is the replacement. The rest are control signals: `null` for the default
 * masking, a number for the default at that percent, a `RedactMaskConfig` for the
 * library's masking with your settings. `undefined` defers to the default too, so a
 * function that returns nothing for a key it does not handle still masks it.
 */
type RedactFunctionResult =
  string | number | RedactMaskConfig | null | undefined;
```

The value reaching your `redactFunction` is **always a `string`** - the leaf is rendered
before the function is called, whatever it started as. That is also what stops a mutating
function reaching into the value you passed in.

#### Bounding and Observing the Render

One allowance covers the whole call, shared by every level of the value - and shared by
both halves of it, so masking a value and rendering the result spend one budget between
them rather than a megabyte each:

```typescript
stringifyValue(value, { maxRenderLength: 20_000_000 });
stringifyValue(value, { maxRenderLength: Infinity }); // no bound
```

The cap bounds the _content_. Every cut leaves a short `[max length exceeded]` marker
where it stopped, and the markers are not charged against it, so the output can run past
`maxRenderLength` by a marker or two - never by more than a small, fixed amount, since a
container that has spent its allowance drops its tail rather than marking every entry.
`maxRenderLength: 1` renders a few dozen characters, not one. Set the cap for the size you
can carry and read `onTruncate` for whether it held.

`Infinity` is the only way to render unbounded. Anything else unusable - a negative, zero,
`NaN`, a non-number - takes the default rather than being honoured, because this is the
bound that makes an untrusted payload safe to render and a typo must not be what switches
it off.

Truncation is a degradation rather than a failure, so it does **not** reach
`onFormatError` - that channel means something _refused_ to render and hands you an error.
There is no error here. The walk succeeded but could not represent everything. Ask for
`onTruncate` instead:

```typescript
stringifyValue(value, {
  onTruncate: ({ reason, subject, dropped }) => {
    // reason 'length' | 'depth' | 'circular'
  },
});
```

It fires at most once per call, carrying the first cut - the one that explains the rest.
`dropped` is only ever present for `'length'`: a cycle and a depth cap drop a subtree that
was never rendered, so its size was never established.

`curlyBrackets` and `errorToString` take the same two options and report the same shape.

##### Binary Data

A `Buffer`, `TypedArray` or `DataView` is rendered as its ordinary text when it is small
enough to keep, and replaced by a `<binary: Kind, N bytes>` marker when it is not:

```typescript
stringifyValue({ body: Buffer.from('hello') }); // {"body":"hello"}
stringifyValue({ body: Buffer.alloc(8_000_000) }); // {"body":"<binary: Buffer, 8000000 bytes>"}
```

The test is the view's size against what is left of the allowance, so the decision is
about whether decoding could have produced anything you keep - not about the value being
binary. A view nested in a nearly-full container is judged against what that container has
left, so the same buffer can render at the top of a value and be summarized deeper in.

This exists because the decoded form has to be built in full before it can be measured:
`String(buffer)` on forty megabytes costs about a second and forty megabytes to produce a
couple of hundred characters of surviving output. A view too large for the allowance skips
that work entirely.

The substitution is a `'length'` truncation like any other, so `onTruncate` fires for it.
`dropped` is absent: the text was never built, so nothing ever measured what was lost.

`maxRenderLength: Infinity` has no allowance to exceed, so every view decodes - which is
what asking for an unbounded render means.

An `ArrayBuffer` or `SharedArrayBuffer` - the backing store rather than a view over one -
is always named with its size, whatever the allowance. There is no decode to skip: a buffer
has no useful string form at any size. The summary identifies its kind and byte length.
Nothing is dropped, so it is not counted as a truncation.

Every view type is recognized by its own name - `Uint8Array`, `Int16Array`, `DataView`,
Node's `Buffer` - and the size is always in bytes, not elements. Recognition uses the
intrinsic `byteLength` getters rather than `instanceof`, so a buffer or view from another
realm (an iframe, a `vm` context) is named like any other.

`serializeError` marks every view unconditionally rather than following this rule. Its
output is a JSON payload crossing a process boundary, where a `Buffer` would otherwise
arrive as one key per byte, and there is no allowance in that shape to test against.

### redactValue

```typescript
function redactValue(value: unknown, options?: StringifyValueOptions): unknown;
```

The masking half, for a caller that wants the **structure** back rather than text - to inspect it, hand it to their own sink, or serialize it themselves. Takes the same options, so the two compose:

```typescript
const options = { redactedKeys: ['user.password'] };

redactValue({ user: { password: 'hunter2secret' } }, options);
// { user: { password: 'h***********t' } }   <- an object, shape intact

// Rendering an already-masked structure is the same as masking while rendering.
stringifyValue(redactValue(value, options)) === stringifyValue(value, options);
```

The value passed in is never modified. Copies are built only along the branches that lead to a mask, so anything not named comes back as the value that went in. A `Date` is still that `Date`, and an `Error` still carries its `message` and `stack`. A container that _was_ masked inside is rebuilt as a plain object, since the original must not be mutated and a class instance cannot be reconstructed from outside. A failure yields the redaction marker rather than the original value.

## How Values Render

| Value                               | Result                   |
| ----------------------------------- | ------------------------ |
| `'text'`                            | `text`                   |
| `{ k: 'v' }`                        | `{"k":"v"}`              |
| `['a', 'b']`                        | `["a","b"]`              |
| `['a,b']`                           | `["a,b"]`                |
| `new Error('boom')`                 | `Error: boom`            |
| `new URL('https://example.test/y')` | `https://example.test/y` |
| `new Date(0)`                       | its `toString`           |
| `class FooBar {}` instance          | `[FooBar]`               |
| an instance defining `toString`     | whatever it returns      |

A plain object or array renders as JSON, so its contents are readable and an array cannot be confused with one element containing a comma. A value **renders the same way wherever it appears** - alone, or nested any number of levels down. Only plain objects and arrays are walked. Everything else is a single leaf rendered by its own string form:

| value               | renders as                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| plain object, array | `{"k":"v"}`, `["a","b"]` - walked, leaf by leaf                                 |
| `Error`             | `Error: boom`                                                                   |
| `Date`              | `2020-01-01T00:00:00.000Z` (ISO - sortable, parseable, timezone-explicit)       |
| `URL`               | `https://example.test/y`                                                        |
| `Map`, `Set`        | `[Map]`, `[Set]` - never walked, so nesting one inside another is a single leaf |
| class instance      | `[ClassName]`                                                                   |

Anything that is not walked keeps a string form of its own. A class instance that defines no `toString` inherits `Object.prototype`'s, which renders `[object Object]` and names nothing, so it renders as `[ClassName]` instead - enough to identify what was passed without dumping fields the caller never asked to print.

Being walked comes first, so a **plain object or array is rendered as JSON even when it defines its own `toString`**, and that method is never called: `{ toString: () => 'printable', v: 1 }` renders `{"toString":"[Function: toString]","v":1}`. A plain container's entries are the whole of what it holds, they are what `redactedKeys` addresses, and a `toString` on one is caller code on the rendering path for the same reasons a `toJSON` is not called. Give the value a prototype - a class instance, a `URL` - to have its string form used instead.

`undefined` renders as `[undefined]`, named the way everything else with no JSON form is. Spelling it out quoted to `"undefined"` inside a container, which is indistinguishable from a string holding that text - a distinction redaction keeps, since it masks a genuine string in part and replaces a derived value whole. `null` has a JSON form and renders unquoted, so it needs no such treatment. A `redactFunction` is handed the same spelling, because each leaf is stringified by this renderer before the function sees it.

A cycle is cut where it closes - `{"a":1,"self":"[circular]"}` - rather than losing the object around it, and an object referenced twice side by side is not a cycle and renders in full both times. A `BigInt` renders as text. One awkward value never costs you the rest of the render.

Two limits bound a render that would otherwise run away, and both leave a marker where they stopped so a truncated render never looks complete:

| marker                  | limit                                                                     |
| ----------------------- | ------------------------------------------------------------------------- |
| `[max depth exceeded]`  | nesting past 100 levels                                                   |
| `[max length exceeded]` | roughly 1 MB of output, after which the walk stops rather than continuing |

The length limit is what bounds breadth, which depth cannot. Rendering _is_ recursive over shared references - an object reached by two paths is rendered at both, deliberately, since it is not a cycle - so a graph reusing one child under two keys doubles per level. Twenty-two levels of `{ l: child, r: child }` is only 45 objects and would render to 96 MB without a cap. Both limits are far outside ordinary use: 1 MB is around 8,500 typical records or 12,000 config entries in a single line, and reaching either usually means more was passed to a log call than was meant. The length limit is approximate rather than exact - it is checked before descending into a container, so the last one entered can overshoot, by under 10% on flat data and around 30% on deeply nested data.

## Redacting While Rendering

Pass `redactedKeys` to mask parts of the value before it is rendered. Paths use the same syntax as the logger's [`redactedKeys`](./logger.md#redaction-of-sensitive-data), rooted at `value`:

```typescript
stringifyValue(
  { user: { password: 'hunter2secret' } },
  {
    redactedKeys: ['user.password'],
  },
);
// '{"user":{"password":"h***********t"}}'
```

A bare name addresses a top-level key. `user.password` and `items[0].token` address one location, while `items[*].token` and `items.*.token` address every element of an array. Naming a plain object or array masks each value inside it and keeps the shape. See [Wildcards Over Arrays](./logger.md#wildcards-over-arrays) for what a wildcard does and does not expand over.

A path names a **location, not a value**, so one object reachable by two paths is masked only where it was named: `redactValue({ a, b: { ref: a } }, { redactedKeys: ['a.secret'] })` masks `a.secret` and hands `b.ref.secret` back as it came in. Name both to mask both. See [A Path Names a Location, Not a Value](./logger.md#a-path-names-a-location-not-a-value) for why, which covers this surface too.

No path addresses `value` itself. The shortest one names an entry _of_ it, so there is nothing to write that means "mask the whole thing" - pass the mask you want instead of the value. This is why `redactValue(new Error('boom'), { redactedKeys: ['message'] })` returns the error unchanged: a bare name addresses a top-level key, and an `Error` has none to address. Nested is a different question, and the rule below still applies - `['err.message']` masks an `Error` sitting at `err`, because there the path names an entry that a container does have.

Redaction walks exactly what the renderer walks: a **plain object or an array**. Their own entries are the whole of what gets printed, so a path addresses one of them precisely, and a path naming an entry they lack reaches nothing - a misspelling, or one stale entry in a long-lived list, protects nothing rather than blanking a payload.

Everything else - an `Error`, a `Date`, a `URL`, a `Map`, a class instance - is printed whole, as `Error: boom` or `[Map]` or `[Session]`. There is no way to mask part of that, so naming anything inside one masks all of it:

```ts
redactValue({ err: new Error('boom') }, { redactedKeys: ['err.message'] });
// { err: '***REDACTED***' }
```

This is what keeps the guarantee that **redacted output differs from unredacted output only where a value was masked**. Descending into such a value instead would rebuild it as a plain object, and the renderer would then print its fields rather than its string form - so redacting one field would expose every other field beside it, which is the opposite of what was asked for.

A `toJSON` method is **not** called. `JSON.stringify` honours it, but this does not. It was honoured for a plain object and ignored for a class instance, which is an arbitrary split, and it is caller code on the logging path - free to throw, to be slow, or to return something different each call. Everything is walked by this library instead, so what prints is what the value actually holds, and an object with a `toJSON` redacts like any other. To keep a field out of a log line, name it in `redactedKeys`.

Masking a value the renderer prints whole replaces it with a **string** - nothing is rebuilt for it. That is what keeps the shape stable: `"[Map]"` before, `"***REDACTED***"` after. Only plain objects and arrays are ever rebuilt, because they are the only things either walk enters.

Unreadable keys and cycles can force changes to values nobody named: a container whose keys cannot be read, and a container that holds itself once a mask has landed elsewhere in the payload. Redaction can copy around neither, and handing back the original would risk returning it unmasked. A cycle in a payload where nothing matched at all is left exactly as it came in.

Opaque values such as errors and class instances also require inspection because template lookups can reach their properties. Each opaque graph has a 16,384-entry inspection allowance and a separate depth limit. If inspection cannot establish that a value is safe, redaction uses `***REDACTION FAILED***` and reports the failure. It does not return an unchecked reference.

### What Masking Reaches

Masking covers exactly what rendering prints: **own enumerable string-keyed properties** of plain objects and arrays. Anything `Object.entries` does not see - a non-enumerable property, a symbol key, one carried on a prototype, one a `Proxy` hides from its `ownKeys` trap - is neither masked nor printed:

```ts
const o = { visible: 1 };
Object.defineProperty(o, 'password', { value: 'secret', enumerable: false });

stringifyValue({ o }, { redactedKeys: ['o.password'] }); // {"o":{"visible":1}}  - never printed
redactValue({ o }, { redactedKeys: ['o.password'] }).o.password; // 'secret'    - still there
```

Nothing reaches a log line, because the renderer cannot see it either. But it means `redactValue`'s result is safe to **render**, not a sanitizer for an arbitrary consumer: hand it to `Object.getOwnPropertyNames`, a different serializer, or a sink that walks properties directly, and hidden state travels with it.

## Notes

- The same rendering backs template interpolation in [curly-brackets](./curly-brackets.md) and the logger's message text, so a value reads the same everywhere.
- `redactValue`, `stringifyValue` and the logger's `redactedKeys` share one implementation, so a `redactFunction` behaves identically in all three.
- Redaction fails closed. A `redactFunction` that throws, or a value that cannot be read, yields `***REDACTION FAILED***` rather than the original.
- Pass `onFormatError` to learn _why_ a value failed. The markers say only that something did. This callback is handed the error, which stage threw, and the structural path it happened on - `password`, `<value>.user.token`.
  - `kind: 'redaction'` means your `redactFunction` threw, or a value could not be read to mask it.
  - `kind: 'render'` means a value refused to be read or turned into text. Either call can raise it: `redactValue` hands back structure, but masking a leaf renders it first, so a `toString` that throws under a masked key reports here too. Render subjects are rooted at `<value>` in both, so the same leaf is named the same way whichever half reports it. It fires only when a read actually threw, never for the ordinary degradations.
  - Both come from the same walk over the same value and address it the same way, which is why they are one callback with a discriminator rather than two. Each kind carries its own once-per-call budget, so a value that fails both ways is reported both ways.
  - With no handler it first dispatches a cancelable global `'error'` event, so a `logger.registerReportErrorListener()` can record it. If event dispatch is unavailable it uses `globalThis.reportError()` when present. An unclaimed dispatch, unavailable reporting function, or reporting failure ends at guarded `console.error`. Logger-owned formatting uses the logger's separate diagnostic channel. **Pass a handler when calling this from inside a custom sink or formatter** and have that handler terminate locally. Otherwise the standalone host path can reach a registered logger while it is already writing.
  - The cause is never written into the rendered string: it comes from your own getter or `redactFunction` and may carry the value it was hiding.
