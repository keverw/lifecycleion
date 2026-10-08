import type { ManagerCore } from './manager-core';
import type { StopAttempt } from './manager-state';

/**
 * Component claims: which start or stop attempt last claimed each component as
 * `starting`, `stopping` or `force-stopping`, and the state its claim replaced.
 *
 * The start and stop pipelines take, check and release claims only through here. The
 * records themselves stay on the state (`componentClaims`, `claimsTaken`), where the
 * attempts' nets and the bulk operations read them.
 */
export class ComponentClaims {
  constructor(private readonly core: ManagerCore) {}

  /** Claim `name` for the attempt holding `claim`, recording the state it replaces. */
  public take(
    name: string,
    state: 'starting' | 'stopping' | 'force-stopping',
    claim: symbol,
    stop?: StopAttempt,
  ): void {
    this.core.state.componentClaims.set(name, {
      claim,
      previousState: this.core.state.componentStates.get(name),
      ...(stop ? { stop } : {}),
    });
    this.core.state.claimsTaken.add(claim);
    this.core.state.componentStates.set(name, state);
  }

  /** Record the stop an attempt still holding `claim` runs, for the stop net. */
  public recordStop(name: string, claim: symbol, stop: StopAttempt): void {
    const entry = this.core.state.componentClaims.get(name);
    if (entry?.claim === claim) {
      this.core.state.componentClaims.set(name, { ...entry, stop });
    }
  }

  /** Whether `claim` is the attempt that last claimed `name`. */
  public owns(name: string, claim: symbol): boolean {
    return this.core.state.componentClaims.get(name)?.claim === claim;
  }

  /** Drop an attempt's claim, if it still holds it. */
  public release(name: string, claim: symbol): void {
    if (this.owns(name, claim)) {
      this.core.state.componentClaims.delete(name);
    }
  }

  /**
   * Whether a start or stop is in flight for the component - the states an attempt
   * claims. Whatever holds one writes its outcome when it settles, so nothing else may
   * start, stop, retry, or remove the component under it.
   */
  public isInFlight(name: string): boolean {
    const state = this.core.state.componentStates.get(name);

    return (
      state === 'starting' || state === 'stopping' || state === 'force-stopping'
    );
  }
}
