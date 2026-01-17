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
- [Memory Management](#memory-management)
- [Testing](#testing)

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
import { EventEmitter } from './event-emitter';

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

The emitter automatically catches and reports errors from both synchronous and asynchronous event handlers using the global `reportError` event mechanism:

```typescript
// Listen for errors
globalThis.addEventListener('reportError', (event) => {
  console.error('Event handler error:', event.error);
});

// Sync error handling
emitter.on('test', () => {
  throw new Error('Something went wrong');
}); // Error will be caught and reported via reportError event

// Async error handling
emitter.on('test', async () => {
  throw new Error('Async error');
}); // Promise rejection will be caught and reported via reportError event
```

The error messages include the event name and detailed error information, making debugging easier.

## Memory Management

The library includes several features to prevent memory leaks:

1. Unsubscribe functions for manual cleanup
2. Automatic cleanup of empty event lists
3. `clear()` method for bulk cleanup
4. Auto-cleanup for `once()` handlers

## Testing

The library includes a comprehensive test suite using Bun's test framework. Run tests with:

```bash
bun test
```
