/**
 * Instead of using `EventEmitter`, you could extend `EventEmitterProtected`
 * if you want the emit method to be protected, and allow only your class to emit events.
 *
 * A simplified event emitter implementation that works in both browser and Node.js environments.
 * This provides basic event handling functionality with type safety and memory management.
 */

import { safeHandleCallback } from './safe-handle-callback';

type EventCallback<T = unknown> = (data: T) => void | Promise<void>;

export class EventEmitterProtected {
  private events: Map<string, Set<EventCallback<unknown>>>;

  constructor() {
    this.events = new Map();
  }

  /**
   * Subscribe to an event
   * @param event The event name to subscribe to
   * @param callback The callback function to be called when the event is emitted
   * @returns A function to unsubscribe from the event
   */
  public on<T = unknown>(
    event: string,
    callback: EventCallback<T>,
  ): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    const callbacks = this.events.get(event);

    if (callbacks) {
      callbacks.add(callback as EventCallback<unknown>);
    }

    // Return unsubscribe function for cleanup
    return () => {
      const callbacks = this.events.get(event);
      if (callbacks) {
        callbacks.delete(callback as EventCallback<unknown>);

        if (callbacks.size === 0) {
          this.events.delete(event);
        }
      }
    };
  }

  /**
   * Subscribe to an event once - automatically unsubscribes after first emission
   * @param event The event name to subscribe to
   * @param callback The callback function to be called when the event is emitted
   * @returns A function to unsubscribe from the event before it's called
   */
  public once<T = unknown>(
    event: string,
    callback: EventCallback<T>,
  ): () => void {
    const unsubscribe = this.on(event, (data: T) => {
      unsubscribe();
      return callback(data);
    });

    return unsubscribe;
  }

  /**
   * Check if a specific callback is registered for an event.
   * Note: For 'once' handlers, this will return true for the wrapper function, not the original callback.
   * This means hasListener will return false when checking for the original callback of a 'once' subscription.
   *
   * @param event The event name to check
   * @param callback The callback function to look for
   * @returns true if the exact callback is registered, false otherwise
   */
  public hasListener<T = unknown>(
    event: string,
    callback: EventCallback<T>,
  ): boolean {
    const callbacks = this.events.get(event);
    return callbacks?.has(callback as EventCallback<unknown>) ?? false;
  }

  /**
   * Check if an event has any subscribers
   * @param event The event name to check
   * @returns true if the event has subscribers, false otherwise
   */
  public hasListeners(event: string): boolean {
    const callbacks = this.events.get(event);
    return callbacks !== undefined && callbacks.size > 0;
  }

  /**
   * Get the number of subscribers for an event
   * @param event The event name to check
   * @returns The number of subscribers
   */
  public listenerCount(event: string): number {
    const callbacks = this.events.get(event);
    return callbacks ? callbacks.size : 0;
  }

  /**
   * Remove all event listeners
   * @param event Optional event name. If not provided, removes all listeners for all events
   */
  public clear(event?: string): void {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
  }

  /**
   * Emit an event with optional data
   * This method is protected to allow only derived classes to trigger events.
   * @param event The event name to emit
   * @param data Optional data to pass to the event handlers
   */
  protected emit<T = unknown>(event: string, data?: T): void {
    const callbacks = this.events.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        safeHandleCallback(`event handler for ${event}`, callback, data);
      }
    }
  }
}

/**
 * A class that implements the event emitter pattern with public emit method.
 * This class extends EventEmitterProtected and makes the emit method public.
 *
 * Use this when you want any code with access to the emitter to be able to trigger events.
 * If you want to control who can emit events, extend EventEmitterProtected instead.
 */

export class EventEmitter extends EventEmitterProtected {
  /**
   * Emit an event with optional data
   * This method is public, allowing any code with access to the emitter to trigger events.
   * @param event The event name to emit
   * @param data Optional data to pass to the event handlers
   */

  public emit<T = unknown>(event: string, data?: T): void {
    super.emit(event, data);
  }
}
