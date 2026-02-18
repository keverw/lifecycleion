# is-promise

Thenable/promise detection following the Promises/A+ specification.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [isPromise](#ispromise)

<!-- tocstop -->

## Usage

```typescript
import { isPromise } from 'lifecycleion/is-promise';
```

## API

### isPromise

Returns `true` if the value is a thenable — an object or function with a `then` method — which is the Promises/A+ definition of a promise. Returns `false` otherwise.

This means native `Promise` instances, custom thenables, and any function with a `then` method are all considered promises. A plain `{}` or `{ then: true }` (non-function `then`) are not.

```typescript
isPromise(Promise.resolve(42)); // true
isPromise(fetch('https://example.com')); // true
isPromise({ then: function () {} }); // true  (thenable)

isPromise({}); // false
isPromise({ then: true }); // false  (then is not a function)
isPromise(() => {}); // false  (function without then)
isPromise(42); // false
isPromise(null); // false
isPromise(undefined); // false
```
