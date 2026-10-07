import { snapshotSet } from './internal/intrinsics';
import { readMember } from './internal/read-member';
import { isConsoleReportActive } from './internal/report-to-console';
import { reportCallbackError, runCallbackSafely } from './safe-handle-callback';

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
   * @throws {TypeError} When `fn` is not a function.
   */

  public subscribe(fn: (data: T) => void | Promise<void>): void {
    if (typeof fn !== 'function') {
      throw new TypeError(
        `SingleEventObserver subscriber must be a function, got: ${fn === null ? 'null' : typeof fn}`,
      );
    }
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
    const shouldSuppressDiagnostics = isConsoleReportActive();
    // Snapshot at the start of this notification, as `EventEmitter.emit` does: a
    // subscriber added (or removed and re-added) midway through runs from the next
    // notification, not this one, so it cannot extend this pass - or loop it forever.
    for (const subscriber of snapshotSet(this.subscribers)) {
      // The report's name is read only once the subscriber has failed, so a notify that
      // succeeds never reads `name` - which can be a getter - or builds a label for it.
      // `subscribe` admits only functions, so the fixed name below is never reported.
      runCallbackSafely(
        'SingleEventObserver subscriber',
        subscriber,
        [data],
        (error: unknown) => {
          if (shouldSuppressDiagnostics) {
            return;
          }
          reportCallbackError(
            `SingleEventObserver_${readSubscriberName(subscriber)}`,
            error,
          );
        },
      );
    }
  }
}

/**
 * The subscriber's `name` for its report, or `'anonymous'`. Read on the failure path,
 * where a throw would replace the report it was building: `name` is an ordinary
 * property a getter (or a proxy) can throw from, or redefine as a symbol.
 */
function readSubscriberName(subscriber: object): string {
  const name = readMember(subscriber, 'name');
  return typeof name === 'string' && name !== '' ? name : 'anonymous';
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
