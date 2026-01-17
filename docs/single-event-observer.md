# single-event-observer

A lightweight, type-safe implementation of the Observer pattern in TypeScript.

<!-- toc -->

- [Overview](#overview)
- [Installation](#installation)
- [Usage](#usage)
  - [Basic Usage](#basic-usage)
  - [Protected Notify](#protected-notify)
- [API](#api)
  - [`SingleEventObserver<T>`](#singleeventobservert)
    - [Methods](#methods)
  - [`SingleEventObserverProtected<T>`](#singleeventobserverprotectedt)
- [Why use single-event-observer?](#why-use-single-event-observer)
- [Comparison to other libraries](#comparison-to-other-libraries)

<!-- tocstop -->

## Overview

`single-event-observer` provides a simple and efficient way to implement the Observer pattern for a single event type. It's designed to be a lightweight alternative to more complex event emitters when you only need to handle one type of event.

## Installation

```bash
npm install @day-mover/single-event-observer
```

## Usage

### Basic Usage

```typescript
import { SingleEventObserver } from '@day-mover/single-event-observer';

// Create an observer for string events
const observer = new SingleEventObserver<string>();

// Subscribe to events
const callback = (data: string) => console.log(`Received: ${data}`);
observer.subscribe(callback);

// Notify subscribers
observer.notify('Hello, world!');

// Unsubscribe when no longer needed
observer.unsubscribe(callback);
```

### Protected Notify

If you want to restrict the ability to emit events to only your class, you can extend `SingleEventObserverProtected`:

```typescript
import { SingleEventObserverProtected } from '@day-mover/single-event-observer';

class MyEventEmitter extends SingleEventObserverProtected<string> {
  public emitEvent(data: string) {
    this.notify(data); // Only this class can call notify
  }
}
```

## API

### `SingleEventObserver<T>`

#### Methods

- `subscribe(fn: (data: T) => void): void`
  Subscribes a function to the observer.

- `unsubscribe(fn: (data: T) => void): void`
  Unsubscribes a function from the observer.

- `hasSubscriber(fn: (data: T) => void): boolean`
  Checks if a specific function is subscribed to the observer.

- `notify(data: T): void`
  Notifies all subscribers with the provided data.

### `SingleEventObserverProtected<T>`

Identical to `SingleEventObserver<T>`, except `notify` is a protected method.

## Why use single-event-observer?

- **Lightweight**: Perfect for scenarios where you only need to handle a single event type.
- **Type-safe**: Leverages TypeScript generics to ensure type safety.
- **Simple API**: Easy to understand and use with just a few methods.
- **Protected notify option**: Allows for more controlled event emission when needed.

## Comparison to other libraries

- **universal-event-emitter**: Use `single-event-observer` when you don't need support for multiple event types or wildcard events.
- **user-and-builtin-event-emitter**: Choose `single-event-observer` when you don't need to distinguish between user and built-in events.
