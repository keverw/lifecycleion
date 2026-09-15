# to-error

Coerce any thrown or rejected value into an `Error`, keeping the original on `cause`,
describe it as a string that is safe to read, or ask whether it was an error to begin
with.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [toError](#toerror)
  - [describeError](#describeerror)
  - [isErrorValue](#iserrorvalue)
  - [Which One Do I Want?](#which-one-do-i-want)

<!-- tocstop -->

## Usage

```typescript
import { toError, describeError, isErrorValue } from 'lifecycleion/to-error';
```

## API

### toError

`throw` accepts any value and a promise can reject with any value, so a failure path must
not assume it was handed an `Error`. Reading `.message` off `null` raises a `TypeError` of
its own, and on a reporting path that one escapes into the caller that was only trying to
report a failure.

`toError(value)` returns `value` unchanged when it already is an `Error`. Otherwise it
returns a new `Error` describing the value, with the original kept on `cause`. The
description is lossy, and for a value whose `toString` threw, it carries nothing at all.

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

`toError` guarantees an `Error` _object_, not a readable one. It deliberately returns an
`Error` instance unchanged, so the original identity, `stack`, and `cause` survive for a
caller that needs them. The `message` is an ordinary property that a subclass or a
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

`describeError` is the pairing for the common case. It normalizes and then reads, with both steps guarded:

```typescript
describeError(new Error('boom')); // 'boom'
describeError('nope'); // 'Non-error value thrown: nope'
describeError(null); // 'Non-error value thrown: null'
```

### isErrorValue

`isErrorValue(value)` answers whether a value is an error, and is the test `toError` itself
uses to decide whether to return a value unchanged or wrap it.

Reach for it when you need the _question_ answered rather than an `Error` in hand, for
example, in a branch that passes a genuine error through and wraps everything else.

**It recognizes errors built in another realm.** `instanceof` compares against _this_
realm's `Error.prototype`, so an error thrown out of a `vm` context, an iframe, or a jsdom
window fails it while being an error in every respect you care about. This reads the
internal brand instead, which crosses realms:

```typescript
import vm from 'node:vm';

const foreign = vm.runInNewContext('new Error("boom")');

foreign instanceof Error; // false
isErrorValue(foreign); // true
```

**It never throws.** `instanceof` walks a prototype chain, which a revoked `Proxy` refuses,
so the check is guarded. You can call it on a reporting path without a `try` of your own.

A hostile object can claim the brand with `Symbol.toStringTag` and will be reported as an
error. That is the same bargain `instanceof` already offers, since a `Proxy` can forge a
prototype chain, and it costs nothing: read anything off the result with `describeError` or
[`errorToString`](./error-to-string.md), both of which guard every read.

### Which One Do I Want?

| You need                                                      | Use                                     |
| ------------------------------------------------------------- | --------------------------------------- |
| Text for a `console.error`, a template literal, or a log line | `describeError`                         |
| The `Error` object itself, to rethrow or pass to a callback   | `toError`                               |
| The full multi-line render, with `name`, `code`, and `stack`  | [`errorToString`](./error-to-string.md) |
| To know whether a value _is_ an error, without coercing it    | `isErrorValue`                          |

All four are safe to call on a reporting path. None of them throws.

This matters most on a failure path, such as a sink's `onError`, a renderer's
`onFormatError`, or a logger diagnostic listener. Reach for `describeError` there rather
than reading `.message` yourself.
