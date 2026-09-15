# Event Emitter

A lightweight, type-safe event emitter implementation that works in both browser and Node.js environments. This library provides a simple yet powerful event handling system with memory management and error handling built-in.

<!-- toc -->

- [Classes](#classes)
  - [`EventEmitter`](#eventemitter)
  - [`EventEmitterProtected`](#eventemitterprotected)
- [Features](#features)
- [Usage](#usage)
- [API](#api)
  - [`constructor()`](#constructor)
  - [`on<T>(event: string, callback: (data: T) => void | Promise<void>): () => void`](#ontevent-string-callback-data-t--void--promisevoid---void)
  - [`once<T>(event: string, callback: (data: T) => void | Promise<void>): () => void`](#oncetevent-string-callback-data-t--void--promisevoid---void)
  - [`emit<T>(event: string, data?: T): void`](#emittevent-string-data-t-void)
  - [`hasListener(event: string, callback: Function): boolean`](#haslistenerevent-string-callback-function-boolean)
  - [`hasListeners(event: string): boolean`](#haslistenersevent-string-boolean)
  - [`listenerCount(event: string): number`](#listenercountevent-string-number)
  - [`clear(event?: string): void`](#clearevent-string-void)
- [Error Handling](#error-handling)
  - [Overriding Where Handler Failures Go](#overriding-where-handler-failures-go)
- [Memory Management](#memory-management)

<!-- tocstop -->

## Classes

### `EventEmitter`

The standard event emitter with a public `emit()` method. Use this when you want any code with access to the emitter to be able to trigger events.

### `EventEmitterProtected`

A base class with a protected `emit()` method. Extend this class when you want to control who can emit events (only your derived class can call `emit()`).

```typescript
// Example: Extending EventEmitterProtected to control event emission
class MyService extends EventEmitterProtected {
  private processData() {
    // Only this class can emit events
    this.emit('dataProcessed', { success: true });
  }
}

const service = new MyService();
service.on('dataProcessed', (data) => console.log(data));
// service.emit('dataProcessed', {}); // ❌ Error: emit is protected
```

## Features

- 🌐 Universal compatibility (works in browser and Node.js)
- 📦 Zero dependencies
- 💪 TypeScript support with generics
- 🔒 Memory leak prevention with automatic cleanup
- ⚡ Async event handler support
- 🛡️ Built-in error handling
- 🧹 Automatic event cleanup when no listeners remain

## Usage

```typescript
import { EventEmitter } from 'lifecycleion/event-emitter';

// Create a new emitter
const emitter = new EventEmitter();

// Basic subscription
const unsubscribe = emitter.on('userLoggedIn', (user) => {
  console.log(`User logged in: ${user.name}`);
});

// Type-safe subscription
emitter.on<{ name: string }>('userLoggedIn', (user) => {
  console.log(`User logged in: ${user.name}`);
});

// One-time subscription
emitter.once('startup', () => {
  console.log('Application started!');
});

// Emit events
emitter.emit('userLoggedIn', { name: 'John' });

// Async event handlers
emitter.on('dataFetch', async (id) => {
  const data = await fetchData(id);
  console.log(data);
});

// Cleanup
unsubscribe(); // Remove specific listener
emitter.clear('userLoggedIn'); // Remove all listeners for an event
emitter.clear(); // Remove all listeners
```

## API

### `constructor()`

Creates a new event emitter instance.

### `on<T>(event: string, callback: (data: T) => void | Promise<void>): () => void`

Subscribes to an event.

- Returns an unsubscribe function
- Generic type `T` for type-safe event data

### `once<T>(event: string, callback: (data: T) => void | Promise<void>): () => void`

Subscribes to an event for one-time execution.

- Automatically unsubscribes after first emission
- Returns an unsubscribe function (in case you need to remove before emission)
- Generic type `T` for type-safe event data

### `emit<T>(event: string, data?: T): void`

Emits an event with optional data.

- Handles both synchronous and asynchronous event handlers
- Catches and logs errors from handlers

### `hasListener(event: string, callback: Function): boolean`

Checks if a specific callback is registered for an event.

- Note: Returns `false` for `once()` handlers due to internal wrapping

### `hasListeners(event: string): boolean`

Checks if an event has any subscribers.

### `listenerCount(event: string): number`

Gets the number of subscribers for an event.

### `clear(event?: string): void`

Removes event listeners.

- With event name: removes all listeners for that event
- Without event name: removes all listeners for all events

## Error Handling

The emitter automatically catches and reports errors from both synchronous and asynchronous event handlers on the global `'error'` event channel:

```typescript
// Listen for errors
globalThis.addEventListener('error', (event) => {
  // Claim the report, so it is not written to the console as well
  event.preventDefault();

  console.error('Event handler error:', event.error);
});

// Sync error handling
emitter.on('test', () => {
  throw new Error('Something went wrong');
}); // Error will be caught and reported on the 'error' channel

// Async error handling
emitter.on('test', async () => {
  throw new Error('Async error');
}); // Promise rejection will be caught and reported on the 'error' channel
```

The error messages include the event name and detailed error information, making debugging easier.

### Overriding Where Handler Failures Go

The global `'error'` channel is not always the right destination. An emitter whose own
events are logged can feed its handler failures straight back into itself: a failing
`'logger'` handler would be reported, which logs, which emits again, which fails again.

`EventEmitterProtected` therefore exposes the reporting step as a `protected` hook that a
subclass can override:

```typescript
protected handleEventHandlerFailure(event: string, error: unknown): void;
```

The default calls `reportCallbackError(...)` from
[safe-handle-callback](./safe-handle-callback.md), which is what puts the failure on the
global `'error'` channel. Override it to send failures somewhere that cannot loop back:

```typescript
class MyEmitter extends EventEmitterProtected {
  protected override handleEventHandlerFailure(
    event: string,
    error: unknown,
  ): void {
    // `error` is `unknown` on purpose: `throw` and promise rejection both accept any
    // value, so an override must not assume it was handed an `Error`.
    metrics.increment('handler_failure', {
      event,
      reason: describeError(error),
    });
  }
}
```

Two rules for an override: it must not throw - it runs on the failure path and there is
nothing above it left to catch - and it must not assume `error` is an `Error`. Use
[`describeError`](./to-error.md#describeerror), which satisfies both.

[`Logger`](./logger.md) overrides this exact hook for the loop described above, routing
its own `'logger'` handler failures to its separate asynchronous diagnostic channel.

## Memory Management

The library includes several features to prevent memory leaks:

1. Unsubscribe functions for manual cleanup
2. Automatic cleanup of empty event lists
3. `clear()` method for bulk cleanup
4. Auto-cleanup for `once()` handlers
