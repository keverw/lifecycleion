# single-event-observer

A lightweight, type-safe observer for a single event payload type.

Subscriber errors are safely handled through `safeHandleCallback` and reported via the standard `reportError` event API.

<!-- toc -->

- [Usage](#usage)
- [Choosing a class](#choosing-a-class)
- [Behavior](#behavior)
- [API](#api)
  - [SingleEventObserver](#singleeventobserver)
  - [SingleEventObserverProtected](#singleeventobserverprotected)

<!-- tocstop -->

## Usage

```typescript
import {
  SingleEventObserver,
  SingleEventObserverProtected,
} from 'lifecycleion/single-event-observer';
```

## Choosing a class

- Use `SingleEventObserver<T>` when callers should be able to both subscribe and emit (`notify` is public).
- Use `SingleEventObserverProtected<T>` when only your class should emit events (`notify` is protected).

## Behavior

- Subscribers are stored in a `Set`, so the same function cannot be added twice.
- Subscribers are called in subscription order.
- `notify` is fire-and-forget:
  - Sync subscribers run immediately.
  - Async subscribers are started, but `notify` does not wait for completion.
- Errors thrown (or promise rejections) in subscribers are reported via `reportError` instead of breaking other subscribers.

## API

### SingleEventObserver

Public observer: anyone with a reference can subscribe and call `notify`.

```typescript
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

**Methods:**

- `subscribe(fn)` — Add a subscriber.
- `unsubscribe(fn)` — Remove a subscriber.
- `hasSubscriber(fn)` — Check whether a subscriber is currently registered.
- `notify(data)` — Notify all subscribers with the provided event payload.

### SingleEventObserverProtected

Same API as `SingleEventObserver`, but `notify` is protected so only the class (or subclass) can emit events.

```typescript
class MyEventEmitter extends SingleEventObserverProtected<string> {
  public emit(data: string): void {
    this.notify(data); // Only this class can call notify
  }
}

const emitter = new MyEventEmitter();
emitter.subscribe((value) => console.log(value));
emitter.emit('hello');
```

**Methods:**

- `subscribe(fn)` — Add a subscriber.
- `unsubscribe(fn)` — Remove a subscriber.
- `hasSubscriber(fn)` — Check whether a subscriber is currently registered.
- `notify(data)` _(protected)_ — Notify all subscribers. Only accessible inside the class or subclasses.
