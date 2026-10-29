# deep-clone

Deep clone utility that creates a true deep copy of a value, cloning nested structures to any depth with circular reference detection.

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

Creates a deep copy of a value, cloning all nested structures.

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

- `arrayKeys` - named keys to copy from every array, at any depth, when the array holds them as its own. An array is cloned by index, and its other named entries are not copied: finding them would mean listing every key, which costs a large array many times its clone. A regex match result's `index`, `input`, `groups` and `indices` (with the `groups` it holds under the `d` flag) are copied without being listed. Each key is copied when the array holds it as its own, and its value cloned. Anything but an array of strings throws a `TypeError`. `options` itself is an object (a function included), `null` or left out, as `structuredClone` takes its options: anything else throws, so pass `deepClone` to `map` as `arr.map((item) => deepClone(item))`, since `map` passes each index as the second argument.

```typescript
const tagged = Object.assign([1, 2, 3], { meta: { source: 'cache' } });

deepClone(tagged).meta; // undefined
deepClone(tagged, { arrayKeys: ['meta'] }).meta; // { source: 'cache' }, a copy
```

## Supported Types

| Type                               | Behavior                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primitives                         | Returned as-is (`number`, `string`, `boolean`, `bigint`, `symbol`, `null`, `undefined`)                                                                                                                                                                                                                                                                |
| Plain objects                      | Cloned with their own enumerable properties, a getter's value copied as a plain value; one with a `null` prototype keeps it                                                                                                                                                                                                                            |
| Arrays                             | Cloned by index to the length they had when read - an index inherited from a prototype other than `Array.prototype` stays a hole - same length; a hole stays a hole, and a very sparse array is read by its entries rather than by every index. Named entries are copied for a match result and for keys in `arrayKeys` only (see [Options](#options)) |
| `Error`, `DOMException`            | A real error on its own prototype (a subclass stays one): `message`, `stack`, `cause` and its other own properties (a `code`, an `AggregateError`'s `errors`) cloned, each writable as every clone's properties are. A subclass's private fields are not copied                                                                                        |
| `Date`                             | New `Date` with the same time value                                                                                                                                                                                                                                                                                                                    |
| `RegExp`                           | New `RegExp` from its own source and flags, with the same numeric `lastIndex`                                                                                                                                                                                                                                                                          |
| `Map`                              | New `Map` with cloned keys and values, read by its entries                                                                                                                                                                                                                                                                                             |
| `Set`                              | New `Set` with cloned values, read by its values                                                                                                                                                                                                                                                                                                       |
| Boxed primitives                   | A new wrapper of the same value (`new Number(1)`, `new String('a')`, a `Boolean`, `BigInt` or `Symbol` wrapper)                                                                                                                                                                                                                                        |
| `ArrayBuffer`, `SharedArrayBuffer` | Copied whole into a new one of the same kind; resizable or growable as the original (a subclass's copy is fixed-length)                                                                                                                                                                                                                                |
| Typed arrays, `DataView`           | A copy of the bytes the view covers, in a new buffer of the same kind, same type (a `Buffer` stays a `Buffer`)                                                                                                                                                                                                                                         |
| Functions                          | Returned by reference (not cloned)                                                                                                                                                                                                                                                                                                                     |

## Notes

- Circular references are detected via an internal `WeakMap`: each reaches the one clone of what it pointed at, a `Map` whose key is the map and a `Set` that holds itself included.
- Nesting depth is not limited by the call stack: entries are filled from a work list, not by recursion.
- Symbol keys are **not** cloned, and neither are non-enumerable properties of a plain object. A frozen or sealed value's clone is neither.
- A `Date`, `RegExp`, `Map`, `Set` or boxed primitive is told by its internal state, so one from another realm (a `vm` context, an iframe) is cloned as this realm's type. Within this realm it is asked about only when its chain holds the type's prototype: one reparented onto another prototype (`Object.setPrototypeOf(new Date(), Map.prototype)`) clones as a plain object. Entries and getters are read in the order a recursive clone reads them, each container's as soon as it is met. A subclass's instance comes back as its base type, and other own properties it carries are not copied. An object that only inherits from one of these prototypes, or a `Proxy` around one, holds none of that state and clones as a plain object.
- Any other class instance clones as a plain object of its own enumerable properties: its prototype, and so its methods and `instanceof`, are not kept. So do `WeakMap`, `WeakSet`, `Promise`, `URL` and other host objects, which come back as `{}`.
- A match result is told by its first entry being a string and an own `index`, as lodash tells one.
- A view copies only the bytes it covers, so a small view of a large buffer does not copy the buffer behind it. Unlike `structuredClone`, two views of one buffer, or a view and its buffer, do not share memory in the clone, and a `SharedArrayBuffer`'s copy does not share memory with the original.
- A typed array or buffer subclass (a `Buffer`, a class extending `Uint8Array` or `ArrayBuffer`) is copied by `slice`, through its own constructor, so its fields are set up. `slice` calls that constructor with a length, so a subclass whose constructor takes other arguments is built from that length, and the copy is a fixed-length, unshared buffer. A `DataView` subclass comes back a `DataView`. Built-in buffers and views from another realm (a `vm` context, an iframe) are cloned as this realm's; a subclass, from any realm, through its own constructor.
- A view's copy is a fixed-length buffer of its own bytes, even under a view of a resizable buffer; a resizable buffer cloned itself stays resizable.
- A detached `ArrayBuffer`, a view over one, and a `DataView` past the end of a shrunk resizable buffer throw a `TypeError`.
