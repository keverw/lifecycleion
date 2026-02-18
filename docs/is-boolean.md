# is-boolean

Type guard to check if a value is a boolean.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [isBoolean](#isboolean)

<!-- tocstop -->

## Usage

```typescript
import { isBoolean } from 'lifecycleion/is-boolean';
```

## API

### isBoolean

Returns `true` if the value is a boolean, `false` otherwise.

```typescript
isBoolean(true); // true
isBoolean(false); // true
isBoolean(1); // false
isBoolean('true'); // false
isBoolean(null); // false
isBoolean(undefined); // false
```
