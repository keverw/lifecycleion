# to-error

Coerce any thrown or rejected value into an `Error`, keeping the original on `cause`.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [toError](#toerror)

<!-- tocstop -->

## Usage

```typescript
import { toError } from 'lifecycleion/to-error';
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
that resists both is described as `unknown value` and still carried on `cause`.

Used internally by [safe-handle-callback](./safe-handle-callback.md) to normalize
`safeHandleCallbackAndWait`'s `error` field, and by [logger](./logger.md) for sink and
event-handler failures. Exported so callers can reproduce that same normalization.
