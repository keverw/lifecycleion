# stringify-value

Render any value as a display string, or return it with parts redacted. The rendering and masking every Lifecycleion module uses, exported so an application can produce the same output.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [stringifyValue](#stringifyvalue)
  - [Options](#options)
  - [redactValue](#redactvalue)
- [How values render](#how-values-render)
- [Redacting while rendering](#redacting-while-rendering)
  - [What masking reaches](#what-masking-reaches)
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

### Options

Both functions take the same options.

```typescript
interface StringifyValueOptions {
  /** Paths to mask, same syntax as the logger's `redactedKeys`. */
  redactedKeys?: string[];
  /** Decides how a matched value is replaced. */
  redactFunction?: (key: string, value: string) => RedactFunctionResult;
  /** Notified when redaction fails. Defaults to `console.error`. */
  onRedactionError?: (error: Error, key: string) => void;
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

The value passed in is never modified. Copies are built only along the branches that lead to a mask, so anything not named comes back as the value that went in — a `Date` is still that `Date`, an `Error` still carries its `message` and `stack`. A container that _was_ masked inside is rebuilt as a plain object, since the original must not be mutated and a class instance cannot be reconstructed from outside. A failure yields the redaction marker rather than the original value.

## How values render

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

A plain object or array renders as JSON, so its contents are readable and an array cannot be confused with one element containing a comma. A value **renders the same way wherever it appears** - alone, or nested any number of levels down. Only plain objects and arrays are walked; everything else is a single leaf rendered by its own string form:

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

## Redacting while rendering

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

A bare name addresses a top-level key; `user.password` and `items[0].token` address one location. Naming a plain object or array masks each value inside it and keeps the shape.

Redaction walks exactly what the renderer walks: a **plain object or an array**. Their own entries are the whole of what gets printed, so a path addresses one of them precisely, and a path naming an entry they lack reaches nothing - a misspelling, or one stale entry in a long-lived list, protects nothing rather than blanking a payload.

Everything else - an `Error`, a `Date`, a `URL`, a `Map`, a class instance - is printed whole, as `Error: boom` or `[Map]` or `[Session]`. There is no way to mask part of that, so naming anything inside one masks all of it:

```ts
redactValue({ err: new Error('boom') }, { redactedKeys: ['err.message'] });
// { err: '***REDACTED***' }
```

This is what keeps the guarantee that **redacted output differs from unredacted output only where a value was masked**. Descending into such a value instead would rebuild it as a plain object, and the renderer would then print its fields rather than its string form - so redacting one field would expose every other field beside it, which is the opposite of what was asked for.

A `toJSON` method is **not** called. `JSON.stringify` honours it; this does not. It was honoured for a plain object and ignored for a class instance, which is an arbitrary split, and it is caller code on the logging path - free to throw, to be slow, or to return something different each call. Everything is walked by this library instead, so what prints is what the value actually holds, and an object with a `toJSON` redacts like any other. To keep a field out of a log line, name it in `redactedKeys`.

Masking a value the renderer prints whole replaces it with a **string** - nothing is rebuilt for it. That is what keeps the shape stable: `"[Map]"` before, `"***REDACTED***"` after. Only plain objects and arrays are ever rebuilt, because they are the only things either walk enters.

Two cases fail closed and so do change a value nobody named, both marked rather than silently altered: a container whose keys cannot be read, and a container that holds itself once a mask has landed elsewhere in the payload. Redaction can copy around neither, and handing back the original would risk returning it unmasked. A cycle in a payload where nothing matched at all is left exactly as it came in.

### What masking reaches

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
- Pass `onRedactionError` to learn _why_ it failed. The marker says only that it did; this callback is handed the error and the `redactedKeys` entry it happened on. It defaults to `console.error`, fires at most once per call, and is deliberately not the global `'error'` channel - reporting a redaction failure there loops through any logger listening on it.
