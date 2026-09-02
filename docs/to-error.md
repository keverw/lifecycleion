# to-error

Coerce any thrown or rejected value into an `Error`, keeping the original on `cause`, or
describe it as a string that is safe to read.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [toError](#toerror)
  - [describeError](#describeerror)
  - [Which one do I want?](#which-one-do-i-want)

<!-- tocstop -->

## Usage

```typescript
import { toError, describeError } from 'lifecycleion/to-error';
```

## API

### toError

`throw` accepts any value and a promise can reject with any value, so a failure path must
not assume it was handed an `Error`. Reading `.message` off `null` raises a `TypeError` of
its own, and on a reporting path that one escapes into the caller that was only trying to
report a failure.

`toError(value)` returns `value` unchanged when it already is an `Error`. Otherwise it
returns a new `Error` describing the value, with the original kept on `cause` — the
description is lossy, and for a value whose `toString` threw it carries nothing at all.

```typescript
const original = new Error('boom');
toError(original) === original; // true

toError('nope').message; // "Non-error value thrown: nope"
toError(null).message; // "Non-error value thrown: null"
toError({ code: 'E42' }).cause; // { code: 'E42' }
```

Every step is guarded, because this runs on paths that must not raise an error of their
own: `instanceof` walks a prototype chain, which a revoked `Proxy` makes throw, and
`String()` invokes `toString`/`Symbol.toPrimitive`, which are ordinary properties. A value
that resists both yields the full message `Non-error value thrown: unknown value`, and is
still carried on `cause`.

Used internally by [safe-handle-callback](./safe-handle-callback.md) to normalize
`safeHandleCallbackAndWait`'s `error` field, and by [logger](./logger.md) for sink and
event-handler failures. Exported so callers can reproduce that same normalization.

### describeError

`describeError(value)` returns a single-line description of any thrown or rejected value,
and **never throws**.

`toError` guarantees an `Error` _object_, not a readable one. It returns an `Error`
instance unchanged — deliberately, so the original identity, `stack`, and `cause` survive
for a caller that needs them — and `message` is an ordinary property that a subclass or a
`Proxy` can turn into an accessor that throws. So `toError(value).message` is still an
unguarded read:

```typescript
const hostile = new Error('placeholder');

Object.defineProperty(hostile, 'message', {
  get() {
    throw new Error('boom');
  },
});

toError(hostile).message; // throws 'boom'
describeError(hostile); // '<error message could not be read>'
```

`describeError` is the pairing for the common case — normalize, then read, both guarded:

```typescript
describeError(new Error('boom')); // 'boom'
describeError('nope'); // 'Non-error value thrown: nope'
describeError(null); // 'Non-error value thrown: null'
```

### Which one do I want?

| You need                                                         | Use                                     |
| ---------------------------------------------------------------- | --------------------------------------- |
| Text for a `console.error`, a template literal, or a log line    | `describeError`                         |
| The `Error` object itself — to rethrow, or to pass to a callback | `toError`                               |
| The full multi-line render, with `name`, `code`, and `stack`     | [`errorToString`](./error-to-string.md) |

All three are safe to call on a reporting path; none of them throws.

This matters most inside a callback the library hands a failure to and then asks not to
throw — `logger`'s `onSinkError` and `onEventHandlerError`, for instance. Reach for
`describeError` there rather than reading `.message` yourself.
