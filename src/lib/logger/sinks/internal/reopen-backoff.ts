/** How much each failure in a run lengthens the next wait. */
const BACKOFF_FACTOR = 2;

export interface BackoffOptions {
  /** The first wait after a run of failures begins. */
  initialMS: number;
  /** The longest wait, however long the run goes on. */
  maxMS: number;
}

/**
 * Bounded exponential backoff: `initialMS`, doubling on each failure up to `maxMS`, back
 * to the start once the caller says the thing it was waiting for worked.
 *
 * Only the arithmetic. The caller owns the timer or the timestamp the delay feeds, and
 * when a success resets it, since those differ between a rotation retried on the next
 * write and a reopen retried on its own timer. Configured with `initialMS === maxMS` it is
 * a flat cooldown.
 */
export class Backoff {
  private readonly initialMS: number;
  private readonly maxMS: number;
  /** The wait last handed out, or 0 when no run of failures is under way. */
  private currentMS = 0;

  constructor(options: BackoffOptions) {
    this.initialMS = options.initialMS;
    this.maxMS = options.maxMS;
  }

  /**
   * Whether no failure has been counted since construction or the last {@link reset}: the
   * next {@link next} starts a run rather than continuing one.
   */
  public get isAtRest(): boolean {
    return this.currentMS === 0;
  }

  /** The wait {@link next} would hand out, without counting a failure. */
  public peek(): number {
    return Math.min(
      this.currentMS === 0 ? this.initialMS : this.currentMS * BACKOFF_FACTOR,
      this.maxMS,
    );
  }

  /** Count a failure and return how long to wait before the next attempt. */
  public next(): number {
    this.currentMS = this.peek();

    return this.currentMS;
  }

  /** The thing waited for worked: the next failure starts a run again. */
  public reset(): void {
    this.currentMS = 0;
  }
}
