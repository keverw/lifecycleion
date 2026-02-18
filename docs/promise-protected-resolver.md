# promise-protected-resolver

A wrapper around a `Promise` that exposes `resolveOnce` and `rejectOnce` methods, guaranteeing the promise can only be settled once regardless of how many times those methods are called.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [Constructor](#constructor)
  - [promise](#promise)
  - [hasResolved](#hasresolved)
  - [resolveOnce](#resolveonce)
  - [rejectOnce](#rejectonce)

<!-- tocstop -->

## Usage

```typescript
import { PromiseProtectedResolver } from 'lifecycleion/promise-protected-resolver';
```

## API

### Constructor

```typescript
new PromiseProtectedResolver<T>(options?)
```

**Options:**

- `beforeResolveOrReject?` — `(action: 'resolve' | 'reject', valueOrReason: unknown) => void | Promise<void>` — Optional callback invoked just before the promise is settled. Useful for logging or side effects. Errors in this callback are caught and reported via the global `reportError` event rather than propagating.

### promise

```typescript
resolver.promise; // Promise<T>
```

The underlying `Promise`. Await this or chain `.then()` / `.catch()` on it as you would any other promise.

```typescript
const resolver = new PromiseProtectedResolver<string>();

resolver.promise.then((value) => console.log('Resolved with:', value));
```

### hasResolved

```typescript
resolver.hasResolved; // boolean
```

Returns `true` after the promise has been settled (either resolved or rejected). Starts as `false`.

```typescript
const resolver = new PromiseProtectedResolver<number>();
console.log(resolver.hasResolved); // false

resolver.resolveOnce(42);
console.log(resolver.hasResolved); // true
```

### resolveOnce

```typescript
resolver.resolveOnce(value: T): void
```

Resolves the promise with the given value. Subsequent calls are silently ignored — the promise is only resolved the first time.

```typescript
const resolver = new PromiseProtectedResolver<string>();

resolver.resolveOnce('done');
resolver.resolveOnce('ignored'); // No effect
resolver.resolveOnce('also ignored'); // No effect

const result = await resolver.promise; // 'done'
```

### rejectOnce

```typescript
resolver.rejectOnce(reason?: unknown): void
```

Rejects the promise with the given reason. Subsequent calls are silently ignored.

```typescript
const resolver = new PromiseProtectedResolver<string>();

resolver.rejectOnce(new Error('Something failed'));
resolver.rejectOnce(new Error('Ignored')); // No effect

try {
  await resolver.promise;
} catch (err) {
  console.error(err.message); // 'Something failed'
}
```

### Example: Race between success and timeout

```typescript
const resolver = new PromiseProtectedResolver<string>({
  beforeResolveOrReject: (action, value) => {
    console.log(`Settling with ${action}:`, value);
  },
});

// Simulate work
setTimeout(() => resolver.resolveOnce('result'), 500);

// Timeout guard
setTimeout(() => resolver.rejectOnce(new Error('Timed out')), 1000);

const result = await resolver.promise; // 'result' (first one wins)
```
