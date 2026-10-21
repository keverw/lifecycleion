# deep-clone

Deep clone utility that creates a true deep copy of a value, recursively cloning nested structures with circular reference detection.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [deepClone](#deepclone)
- [Supported Types](#supported-types)
- [Notes](#notes)

<!-- tocstop -->

## Usage

```typescript
import { deepClone } from 'lifecycleion/deep-clone';
```

## API

### deepClone

Creates a deep copy of a value, recursively cloning all nested structures.

```typescript
const original = {
  name: 'config',
  values: [1, 2, 3],
  nested: { deep: true },
  date: new Date('2024-01-01'),
};

const cloned = deepClone(original);

cloned.values.push(4); // original.values is still [1, 2, 3]
cloned.nested.deep = false; // original.nested.deep is still true
```

Handles circular references safely:

```typescript
const obj: any = { a: 1 };
obj.self = obj;

const cloned = deepClone(obj);
cloned.self === cloned; // true (circular ref preserved in clone)
cloned !== obj; // true (distinct object)
```

## Supported Types

| Type                               | Behavior                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Primitives                         | Returned as-is (`number`, `string`, `boolean`, `null`, `undefined`)                                            |
| Plain objects                      | Recursively cloned (own enumerable properties)                                                                 |
| Arrays                             | Recursively cloned                                                                                             |
| `Date`                             | New `Date` instance with same time value                                                                       |
| `RegExp`                           | New `RegExp` with same source, flags, and `lastIndex`                                                          |
| `Map`                              | New `Map` with deep-cloned keys and values                                                                     |
| `Set`                              | New `Set` with deep-cloned values                                                                              |
| `ArrayBuffer`, `SharedArrayBuffer` | Copied whole into a new one of the same kind; resizable or growable as the original                            |
| Typed arrays, `DataView`           | A copy of the bytes the view covers, in a new buffer of the same kind, same type (a `Buffer` stays a `Buffer`) |
| Functions                          | Returned by reference (not cloned)                                                                             |

## Notes

- Circular references are detected via an internal `WeakMap` and handled gracefully - no infinite recursion.
- Symbol keys are **not** cloned (they are not enumerable by `for...in`).
- A view copies only the bytes it covers, so a small view of a large buffer does not copy the buffer behind it. Unlike `structuredClone`, two views of one buffer, or a view and its buffer, do not share memory in the clone, and a `SharedArrayBuffer`'s copy does not share memory with the original.
- A typed array or buffer subclass (a `Buffer`, a class extending `Uint8Array` or `ArrayBuffer`) is copied through its own constructor, so its fields are set up; a `DataView` subclass comes back a `DataView`. Buffers and views from another realm (a `vm` context, an iframe) are cloned as this realm's.
- A view's copy is a fixed-length buffer of its own bytes, even under a view of a resizable buffer; a resizable buffer cloned itself stays resizable.
- A detached `ArrayBuffer` throws a `TypeError`.
