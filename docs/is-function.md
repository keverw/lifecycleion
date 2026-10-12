# is-function

Checks whether a value is a function.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [isFunction](#isfunction)

<!-- tocstop -->

## Usage

```typescript
import { isFunction } from 'lifecycleion/is-function';
```

## API

### isFunction

Returns `true` if the value has the JavaScript function type (`typeof value === 'function'`), `false` otherwise. That covers regular, arrow, async and generator functions, classes, bound functions, and callable proxies. A non-callable object that only inherits from `Function.prototype` returns `false`. The check never throws and never runs proxy traps. Classes pass this check but require `new`; invoking one as an ordinary callback throws, and callback helpers report that failure.

```typescript
isFunction(() => {}); // true
isFunction(function () {}); // true
isFunction(async () => {}); // true
isFunction(class MyClass {}); // true
isFunction(42); // false
isFunction('hello'); // false
isFunction(null); // false
isFunction({}); // false
```
