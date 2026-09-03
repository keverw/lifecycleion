# stringify-value

Render any value as a display string, optionally redacting parts of it first. The rendering every Lifecycleion module uses, exported so an application can produce the same text.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [stringifyValue](#stringifyvalue)
- [How values render](#how-values-render)
- [Redacting while rendering](#redacting-while-rendering)
- [Notes](#notes)

<!-- tocstop -->

## Usage

```typescript
import { stringifyValue } from 'lifecycleion/stringify-value';
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

A plain object or array renders as JSON, so its contents are readable and an array cannot be confused with one element containing a comma.

Anything with a string form of its own keeps it. A class instance that defines no `toString` inherits `Object.prototype`'s, which renders `[object Object]` and names nothing, so it renders as `[ClassName]` instead - enough to identify what was passed without dumping fields the caller never asked to print.

A cyclic value, or one holding a `BigInt`, renders as `[object]` or `[array]` rather than throwing.

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

`redactFunction` takes the same return contract as the logger's, so one function works with both:

```typescript
stringifyValue(payload, {
  redactedKeys: ['email', 'apiKey'],
  redactFunction: (key) => (key === 'email' ? { strategy: 'email' } : null),
});
```

See [Controlling how a value is masked](./logger.md#controlling-how-a-value-is-masked) for the full table of return values.

The value you pass is never modified - redaction builds a copy.

## Notes

- The same rendering backs template interpolation in [curly-brackets](./curly-brackets.md) and the logger's message text, so a value reads the same everywhere.
- Redaction fails closed. A `redactFunction` that throws, or a value that cannot be read, yields `***REDACTION FAILED***` rather than the original.
