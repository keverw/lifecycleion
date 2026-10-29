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

#### Options

`deepClone(value, options?)` takes:

- `arrayKeys` - named keys to copy from every array, at any depth, when the array holds them as its own. An array is cloned by index, and its other named entries are not copied: finding them would mean listing every key, which costs a large array many times its clone. A regex match result's `index`, `input`, `groups` and `indices` (with the `groups` it holds under the `d` flag) are copied without being listed. Each key is copied when the array holds it as its own, and its value cloned. Anything but an array of strings throws a `TypeError`, as does an `options` that is not an object.

```typescript
const tagged = Object.assign([1, 2, 3], { meta: { source: 'cache' } });

deepClone(tagged).meta; // undefined
deepClone(tagged, { arrayKeys: ['meta'] }).meta; // { source: 'cache' }, a copy
```

## Supported Types

| Type                               | Behavior                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primitives                         | Returned as-is (`number`, `string`, `boolean`, `null`, `undefined`)                                                                                                                                                                                             |
| Plain objects                      | Recursively cloned (own enumerable properties); one with a `null` prototype keeps it                                                                                                                                                                            |
| Arrays                             | Recursively cloned by index, same length; a hole stays a hole. Named entries are copied for a match result and for keys in `arrayKeys` only (see [Options](#options))                                                                                           |
| `Error`, `DOMException`            | A real error on its own prototype (a subclass stays one): `message`, `stack`, `cause` and its other own properties (a `code`, an `AggregateError`'s `errors`) cloned, each writable as every clone's properties are. A subclass's private fields are not copied |
| `Date`                             | New `Date` instance with same time value                                                                                                                                                                                                                        |
| `RegExp`                           | New `RegExp` with same source, flags, and `lastIndex`                                                                                                                                                                                                           |
| `Map`                              | New `Map` with deep-cloned keys and values                                                                                                                                                                                                                      |
| `Set`                              | New `Set` with deep-cloned values                                                                                                                                                                                                                               |
| `ArrayBuffer`, `SharedArrayBuffer` | Copied whole into a new one of the same kind; resizable or growable as the original (a subclass's copy is fixed-length)                                                                                                                                         |
| Typed arrays, `DataView`           | A copy of the bytes the view covers, in a new buffer of the same kind, same type (a `Buffer` stays a `Buffer`)                                                                                                                                                  |
| Functions                          | Returned by reference (not cloned)                                                                                                                                                                                                                              |

## Notes

- Circular references are detected via an internal `WeakMap` and handled gracefully - no infinite recursion.
- Symbol keys are **not** cloned.
- Any other class instance clones as a plain object of its own enumerable properties: its prototype, and so its methods and `instanceof`, are not kept.
- A view copies only the bytes it covers, so a small view of a large buffer does not copy the buffer behind it. Unlike `structuredClone`, two views of one buffer, or a view and its buffer, do not share memory in the clone, and a `SharedArrayBuffer`'s copy does not share memory with the original.
- A typed array or buffer subclass (a `Buffer`, a class extending `Uint8Array` or `ArrayBuffer`) is copied by `slice`, through its own constructor, so its fields are set up. `slice` calls that constructor with a length, so a subclass whose constructor takes other arguments is built from that length, and the copy is a fixed-length, unshared buffer. A `DataView` subclass comes back a `DataView`. Built-in buffers and views from another realm (a `vm` context, an iframe) are cloned as this realm's; a subclass, from any realm, through its own constructor.
- A view's copy is a fixed-length buffer of its own bytes, even under a view of a resizable buffer; a resizable buffer cloned itself stays resizable.
- A detached `ArrayBuffer` throws a `TypeError`.
