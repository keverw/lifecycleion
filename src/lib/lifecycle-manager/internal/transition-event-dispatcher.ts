import { reportCallbackError } from '../../safe-handle-callback';
import type {
  LifecycleManagerEventMap,
  LifecycleManagerEventName,
} from '../events';

/** Owns synchronous notification batching, independently of lifecycle state. */
export class TransitionEventDispatcher {
  // Exposed only inside the internal implementation for the manager's test seam.
  public readonly pendingEvents: Array<() => void> = [];
  private transitionDepth = 0;
  private isFlushingEvents = false;

  constructor(
    private readonly deliverEvent: <K extends LifecycleManagerEventName>(
      event: K,
      data: LifecycleManagerEventMap[K],
    ) => void,
  ) {}

  /**
   * A transition is a synchronous piece of manager bookkeeping, never an entire
   * asynchronous operation. Holding depth across an await would hide progress events
   * behind unrelated work (or deadlock a hook waiting for an event). Nesting lets a
   * terminal component update detach signals without exposing its unfinished timestamps,
   * and lets shutdown acceptance finish its latch and escalation state before listeners
   * can request another pass. Four synchronous control checkpoints are deliberately
   * exempt: signals-attached, shutdown-initiated, signal:shutdown, and
   * shutdown-escalation-forced. Their
   * call sites commit the state needed by listeners before dispatch and retain their
   * re-entry checks afterwards; the operation must not proceed past them first.
   *
   * The finally is essential on refusals and failures too. These events describe work
   * already done, not a transaction that can be silently discarded on an exception.
   * Operation safety nets remain responsible for restoring state and reporting failure.
   * Logger sinks and component hooks remain synchronous caller code; their existing
   * re-entry checks and state-before-log ordering are still necessary.
   */
  public withTransition<T>(operation: () => T): T {
    this.transitionDepth++;
    try {
      return operation();
    } finally {
      this.transitionDepth--;
      this.flushEvents();
    }
  }

  /**
   * Schedule a decision that depends on listeners of notifications already queued.
   * It runs in the same drain after those listeners, without turning a state event
   * into a synchronous checkpoint that could expose an unfinished transition.
   */
  public afterNotifications(operation: () => void): void {
    this.pendingEvents.push(operation);
    this.flushEvents();
  }

  public emit<K extends LifecycleManagerEventName>(
    event: K,
    data: LifecycleManagerEventMap[K],
  ): void {
    // These are control checkpoints, not delayed descriptions of completed work:
    // attach listeners may refuse startup, shutdown initiation must precede hook
    // abort listeners and dependency reads, a shutdown signal must precede a force
    // callback that can exit the process, and forced listeners must run while the
    // force/escalation depth guards are still raised. They run even inside another
    // event's listener. Keeping a global non-interleaving FIFO here would require
    // deferring the control operation itself, including an immediate force exit.
    const isControlEvent =
      event === 'lifecycle-manager:signals-attached' ||
      event === 'lifecycle-manager:shutdown-initiated' ||
      event === 'signal:shutdown' ||
      event === 'lifecycle-manager:shutdown-escalation-forced';

    // The ordinary idle case needs neither a closure nor an array entry. Still raise
    // the flushing flag: notifications produced by a listener must wait until all
    // listeners of this event finish. A nested control checkpoint inherits that flag
    // and restores it instead of starting a second notification drain.
    if (
      isControlEvent ||
      (this.transitionDepth === 0 &&
        !this.isFlushingEvents &&
        this.pendingEvents.length === 0)
    ) {
      const wasFlushingEvents = this.isFlushingEvents;
      this.isFlushingEvents = true;
      try {
        this.deliverEvent(event, data);
      } catch (error) {
        reportCallbackError('lifecycle-manager event delivery', error);
      } finally {
        this.isFlushingEvents = wasFlushingEvents;
        this.flushEvents();
      }
      return;
    }

    this.pendingEvents.push(() => this.deliverEvent(event, data));
    this.flushEvents();
  }

  /**
   * One FIFO for state notifications. Keep the flushing guard raised through every
   * listener: a listener may finish another transition, but its notifications belong
   * behind those already waiting, never between listeners of the current one. Control
   * checkpoints are synchronous and may interrupt this drain; they restore its flag
   * afterwards so notifications they generate still join the same FIFO.
   * No microtask is scheduled and listener promises are not awaited; the protected
   * emitter observes their failures. An earlier listener may change live state, so
   * event payloads describe their originating transition rather than promising that
   * subsequent status reads still match that snapshot.
   */
  private flushEvents(): void {
    if (this.transitionDepth !== 0 || this.isFlushingEvents) {
      return;
    }
    this.isFlushingEvents = true;
    try {
      for (let index = 0; index < this.pendingEvents.length; index++) {
        try {
          this.pendingEvents[index]();
        } catch (error) {
          // deliverEvent contains listener/emitter failures and uses a guarded logger.
          // This final net is for an unexpected failure of delivery itself: one broken
          // entry must not discard the rest of a transition's notifications, nor leave
          // the flushing flag raised. Reporting is protected too.
          reportCallbackError('lifecycle-manager event delivery', error);
        }
      }
    } finally {
      this.pendingEvents.length = 0;
      this.isFlushingEvents = false;
    }
  }
}
