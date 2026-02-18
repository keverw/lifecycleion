# is-plain-object

Type guard to check if a value is a plain object.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [isPlainObject](#isplainobject)

<!-- tocstop -->

## Usage

```typescript
import { isPlainObject } from 'lifecycleion/is-plain-object';
```

## API

### isPlainObject

Returns `true` if the value is a plain object (not `null`, not an array). Narrows the type to `Record<string, unknown>`.

```typescript
isPlainObject({}); // true
isPlainObject({ a: 1 }); // true
isPlainObject([]); // false
isPlainObject(null); // false
isPlainObject(undefined); // false
isPlainObject('string'); // false
isPlainObject(42); // false
```
