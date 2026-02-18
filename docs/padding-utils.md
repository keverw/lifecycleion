# padding-utils

String padding utilities for left, right, and center alignment with a configurable pad character.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [padLeft](#padleft)
  - [padRight](#padright)
  - [padCenter](#padcenter)
  - [padCenterPreferLeft](#padcenterpreferLeft)
  - [padCenterPreferRight](#padcenterpreferRight)

<!-- tocstop -->

## Usage

```typescript
import {
  padLeft,
  padRight,
  padCenter,
  padCenterPreferLeft,
  padCenterPreferRight,
} from 'lifecycleion/padding-utils';
```

## API

### padLeft

Pads a string on the left side until it reaches the given length. Defaults to a blank space if no pad character is provided.

```typescript
padLeft('Hey', 6, '*'); // '***Hey'
padLeft('Hi', 5); // '   Hi'
```

### padRight

Pads a string on the right side until it reaches the given length. Defaults to a blank space if no pad character is provided.

```typescript
padRight('Hey', 6, '*'); // 'Hey***'
padRight('Hi', 5); // 'Hi   '
```

### padCenter

Centers a string within a given length by padding both sides. When the required padding is odd, the `prefer` parameter controls which side gets the extra character (`'left'` by default).

```typescript
padCenter('Hi', 6, 'left', '*'); // '**Hi**'
padCenter('Hi', 7, 'left', '*'); // '***Hi**'  (extra on left)
padCenter('Hi', 7, 'right', '*'); // '**Hi***'  (extra on right)
```

**Parameters:**

- `str` — The string to center
- `length` — The total target length
- `prefer` — Which side gets the extra pad character when odd: `'left'` (default) or `'right'`
- `padStr` — The character(s) to pad with (default: space)

### padCenterPreferLeft

Shorthand for `padCenter` with `prefer = 'left'`. When the required padding is odd, the extra character is added to the left.

```typescript
padCenterPreferLeft('Hi', 7, '*'); // '***Hi**'
```

### padCenterPreferRight

Shorthand for `padCenter` with `prefer = 'right'`. When the required padding is odd, the extra character is added to the right.

```typescript
padCenterPreferRight('Hi', 7, '*'); // '**Hi***'
```
