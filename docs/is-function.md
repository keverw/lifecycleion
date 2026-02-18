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

Returns `true` if the value is a function, `false` otherwise. Handles both regular functions and objects that are instances of `Function`.

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
