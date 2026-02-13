# arrays

Lightweight array utility functions for common operations like deduplication, filtering, comparison, and string manipulation.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [isArray](#isarray)
  - [removeEmptyStringsFromArray](#removeemptystringsfromarray)
  - [prependStringToArrayItems](#prependstringtoarrayitems)
  - [isEveryArrayItemAnString](#iseveryarrayitemanstring)
  - [areArraysEqual](#arearraysequal)
  - [pushWithoutDuplicates](#pushwithoutduplicates)

<!-- tocstop -->

## Usage

```typescript
import {
  isArray,
  removeEmptyStringsFromArray,
  prependStringToArrayItems,
  isEveryArrayItemAnString,
  areArraysEqual,
  pushWithoutDuplicates,
} from 'lifecycleion/arrays';
```

## API

### isArray

Type guard that checks if a value is an array.

```typescript
isArray([1, 2, 3]); // true
isArray('hello'); // false
```

### removeEmptyStringsFromArray

Returns a new array with empty or whitespace-only strings removed. Each item is trimmed before checking.

```typescript
removeEmptyStringsFromArray(['hello', '', '  ', 'world']);
// ['hello', 'world']
```

### prependStringToArrayItems

Returns a new array with a string prepended to each item.

```typescript
prependStringToArrayItems(['file.ts', 'index.ts'], 'src/');
// ['src/file.ts', 'src/index.ts']
```

### isEveryArrayItemAnString

Checks if a value is an array and every item in it is a string.

```typescript
isEveryArrayItemAnString(['a', 'b', 'c']); // true
isEveryArrayItemAnString(['a', 1, 'c']); // false
isEveryArrayItemAnString('not an array'); // false
```

### areArraysEqual

Performs a shallow equality check between two arrays, comparing each element by strict equality (`===`).

```typescript
areArraysEqual([1, 2, 3], [1, 2, 3]); // true
areArraysEqual([1, 2], [1, 2, 3]); // false
areArraysEqual([1, 2, 3], [1, 3, 2]); // false
```

### pushWithoutDuplicates

Pushes a value onto an array only if it doesn't already exist in the array (checked via `includes`). Mutates the original array.

```typescript
const arr = [1, 2, 3];
pushWithoutDuplicates(arr, 4); // arr is now [1, 2, 3, 4]
pushWithoutDuplicates(arr, 2); // arr is still [1, 2, 3, 4]
```
