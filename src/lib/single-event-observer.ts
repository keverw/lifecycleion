import { safeHandleCallback } from './safe-handle-callback';

/**
 * Instead of using `SingleEventObserver`, you could extend `SingleEventObserverProtected`
 * if you want the notify method to be protected, and allow only your class to emit events.
 *
 * A base class for implementing the observer pattern with protected notify method.
 * This class allows subscription to a single type of event and notifies all subscribers
 * when the event occurs.
 *
 * @template T The type of data that will be passed to subscribers when notifying.
 */

export class SingleEventObserverProtected<T> {
  /**
   * Set of subscriber functions.
   */

  private subscribers = new Set<(data: T) => void | Promise<void>>();

  /**
   * Subscribes a function to the observer.
   * @param fn The function to be subscribed.
   */

  public subscribe(fn: (data: T) => void | Promise<void>): void {
    this.subscribers.add(fn);
  }

  /**
   * Unsubscribes a function from the observer.
   * @param fn The function to be unsubscribed.
   */

  public unsubscribe(fn: (data: T) => void | Promise<void>): void {
    this.subscribers.delete(fn);
  }

  /**
   * Checks if a specific function is subscribed to the observer.
   * @param fn The function to check.
   * @returns A boolean indicating if the function is subscribed.
   */

  public hasSubscriber(fn: (data: T) => void | Promise<void>): boolean {
    return this.subscribers.has(fn);
  }

  /**
   * Notifies all subscribers with the given data.
   * This method is protected to allow only derived classes to trigger notifications.
   * @param data The data to pass to all subscribers.
   */

  protected notify(data: T): void {
    for (const subscriber of this.subscribers) {
      safeHandleCallback(
        `SingleEventObserver_${(subscriber as EventListener).name || 'anonymous'}`,
        subscriber,
        data,
      );
    }
  }
}

/**
 * A class that implements the observer pattern with public notify method.
 * This class extends SingleEventObserverProtected and makes the notify method public.
 *
 * @template T The type of data that will be passed to subscribers when notifying.
 */

export class SingleEventObserver<T> extends SingleEventObserverProtected<T> {
  /**
   * Notifies all subscribers with the given data.
   * This method is public, allowing any code with access to the observer to trigger notifications.
   * @param data The data to pass to all subscribers.
   */

  public notify(data: T): void {
    super.notify(data);
  }
}
