# json-helpers

JSON formatting utilities.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [formatJSON](#formatjson)

<!-- tocstop -->

## Usage

```typescript
import { formatJSON } from 'lifecycleion/json-helpers';
```

## API

### formatJSON

Formats a value as a JSON string. When `isHuman` is `true`, the output is pretty-printed with 2-space indentation and a trailing newline, suitable for human-readable output. When `false` (the default), the output is compact with no extra whitespace.

```typescript
formatJSON({ a: 1, b: [2, 3] });
// '{"a":1,"b":[2,3]}'

formatJSON({ a: 1, b: [2, 3] }, true);
// '{
//   "a": 1,
//   "b": [
//     2,
//     3
//   ]
// }\n'
```
