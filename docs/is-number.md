# is-number

Type guards to check whether a value is a valid number, with variants for excluding `NaN` only or also excluding infinite values.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [isNumber](#isnumber)
  - [isFiniteNumber](#isfinitenumber)

<!-- tocstop -->

## Usage

```typescript
import { isNumber, isFiniteNumber } from 'lifecycleion/is-number';
```

## API

### isNumber

Returns `true` if the value is of type `number` and is not `NaN`, `false` otherwise. `Infinity` and `-Infinity` are considered valid numbers. Acts as a TypeScript type guard narrowing the type to `number`.

```typescript
isNumber(42); // true
isNumber(3.14); // true
isNumber(0); // true
isNumber(Infinity); // true
isNumber(-Infinity); // true
isNumber(NaN); // false
isNumber('123'); // false
isNumber(null); // false
isNumber(undefined); // false
```

### isFiniteNumber

Returns `true` if the value is a finite number — excludes `NaN`, `Infinity`, and `-Infinity`. Acts as a TypeScript type guard narrowing the type to `number`.

```typescript
isFiniteNumber(42); // true
isFiniteNumber(3.14); // true
isFiniteNumber(0); // true
isFiniteNumber(Infinity); // false
isFiniteNumber(-Infinity); // false
isFiniteNumber(NaN); // false
isFiniteNumber('123'); // false
isFiniteNumber(null); // false
isFiniteNumber(undefined); // false
```
