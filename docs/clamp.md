# clamp

Utility functions for clamping numbers to a range, with safe handling for non-finite values and nullish inputs.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [clamp](#clamp-1)
  - [finiteClampMin](#finiteclampmin)

<!-- tocstop -->

## Usage

```typescript
import { clamp, finiteClampMin } from 'lifecycleion/clamp';
```

## API

### clamp

Clamps a number between a minimum and maximum value.

```typescript
clamp(5, 1, 10); // 5   (within range)
clamp(0, 1, 10); // 1   (below min, clamped up)
clamp(15, 1, 10); // 10  (above max, clamped down)
clamp(-5, -10, -1); // -5  (within negative range)
```

### finiteClampMin

Clamps a value to a minimum, returning a default if the value is not finite or is `undefined`/`null`.

Useful for config/settings validation where you want to enforce a minimum value and handle invalid inputs gracefully.

```typescript
finiteClampMin(5000, 1000, 3000); // 5000 (value > min, returned as-is)
finiteClampMin(500, 1000, 3000); // 1000 (below min, enforces min)
finiteClampMin(Infinity, 1000, 3000); // 3000 (not finite, returns default)
finiteClampMin(NaN, 1000, 3000); // 3000 (not finite, returns default)
finiteClampMin(undefined, 1000, 3000); // 3000 (undefined, returns default)
finiteClampMin(null, 1000, 3000); // 3000 (null, returns default)
```

**Parameters:**

- `value` — The value to clamp (can be `undefined` or `null`)
- `min` — The minimum allowed value
- `defaultValue` — The default to return if value is not finite or is `undefined`/`null`
