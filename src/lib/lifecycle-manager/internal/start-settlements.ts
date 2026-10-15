import type { BaseComponent } from '../base-component';
import { StartupInterruptedByShutdownError } from '../errors';
import type { ShutdownMethod } from '../types';
import type { ManagerCore } from './manager-core';
import type { StartSettlement } from './manager-state';

/**
 * Whether the manager has given up on a start's `start()`: its deadline - its own or a
 * bulk one - or an observation failure abandoned it (`abandon()`). A shutdown's cue alone
 * is not that: the attempt still waits on `start()` after it. The one answer the shutdown
 * pass and a start that came up under a shutdown both read.
 */
export function isGivenUp(settlement: StartSettlement): boolean {
  return settlement.wasAbandoned === true;
}

/**
 * The start settlements: the record each start attempt publishes of its start, keyed by
 * its claim and by its component's name - whether `start()` itself has settled, whether
 * the attempt has, and the late-start cleanup it owns - and the reads made of them.
 *
 * `ComponentStart` publishes an attempt's settlement, records its instance and attempt
 * token on it, and marks its raw start settled here. The shutdown pass and restart's
 * preflight ask which starts are current, unregistering releases a name's settlements,
 * and hook entry asks whether a raw start is still pending.
 */
export class StartSettlements {
  constructor(private readonly core: ManagerCore) {}

  /**
   * Create a start's settlement and publish it by its claim and its component's name,
   * with the `finishSettlement()` the start net runs once the attempt has settled.
   */
  public publishStartSettlement(
    name: string,
    claim: symbol,
  ): { settlement: StartSettlement; finishSettlement: () => void } {
    let resolveSettlement!: () => void;
    let resolveRawStart!: () => void;
    let resolveRawStartSettled!: () => void;
    let abandon!: () => void;
    const finishSettlement = (): void => {
      settlement.didSettle = true;
      // An aborted start may not have actually settled raw startup. Keep its
      // dependency protection until that work finishes or ownership is released.
      if (!settlement.rawStartPending) {
        this.deleteStartSettlement(claim);
      }
      resolveSettlement();
    };
    const settlement: StartSettlement = {
      name,
      finish: () => {
        // Released ownership ends the raw start for every holder of this settlement,
        // not only the registry: a pass that captured it must stop protecting for it.
        // With the raw start ended, `finishSettlement()` withdraws the settlement too.
        settlement.rawStartPending = false;
        finishSettlement();
        resolveRawStart();
      },
      abandon: () => {
        settlement.wasAbandoned = true;
        abandon();
      },
      abandoned: new Promise<void>((resolve) => {
        abandon = resolve;
      }),
      didSettle: false,
      rawStartPending: false,
      rawStartDone: new Promise<void>((resolve) => {
        resolveRawStart = resolve;
      }),
      settleRawStart: () => {
        settlement.rawStartPending = false;
        this.core.state.runningStarts.delete(settlement);
        resolveRawStart();
        resolveRawStartSettled();
      },
      rawStartSettled: new Promise<void>((resolve) => {
        resolveRawStartSettled = resolve;
      }),
      promise: new Promise<void>((resolve) => {
        resolveSettlement = resolve;
      }),
    };
    this.addStartSettlement(claim, settlement);

    return { settlement, finishSettlement };
  }

  /**
   * An attempt that has issued its token: the settlement of every earlier attempt of
   * `name` that issued one released, and the attempt's instance and token recorded on its
   * own - unless a release before this already withdrew it, when there is none to answer.
   *
   * A settlement with no token yet is left alone: its attempt has published but not
   * claimed - still in `prepareStart()`, whose component code started this one - so it
   * tracks no raw start to end, and needs its settlement once it claims after this.
   *
   * One whose `start()` is still running - the component reported an unexpected stop
   * from inside it and a listener started it again, or this is a retry of a start the
   * manager gave up on - stays in `runningStarts` until that call settles: a shutdown
   * still does not stop the component beside it.
   */
  public recordStartAttempt(
    name: string,
    claim: symbol,
    component: BaseComponent,
    startAttemptToken: string,
  ): StartSettlement | undefined {
    for (const other of this.core.state.startSettlementsByName.get(name) ??
      []) {
      if (other.token !== undefined) {
        other.finish();
      }
    }
    const settlement = this.core.state.startSettlements.get(claim);
    if (settlement) {
      settlement.component = component;
      settlement.token = startAttemptToken;
    }
    return settlement;
  }

  /**
   * Deliver a shutdown's `abortPendingStarts` cue to a start: its signal aborted with a
   * `StartupInterruptedByShutdownError` through `interruptStart()`, and logged, unless
   * that refuses - `start()` has settled, or its signal was already aborted. Whether it
   * aborted. Shared by the shutdown pass and a start delivering a cue it missed.
   */
  public deliverShutdownCue(
    settlement: StartSettlement,
    method: ShutdownMethod,
  ): boolean {
    if (
      settlement.interruptStart?.(
        new StartupInterruptedByShutdownError({
          componentName: settlement.name,
          method,
        }),
      ) !== true
    ) {
      return false;
    }
    this.core.logger
      .entity(settlement.name)
      .info('Aborted pending start for shutdown');
    return true;
  }

  /** A raw start has settled: its settlement withdrawn if the attempt has too. */
  public markRawStartSettled(settlement: StartSettlement, claim: symbol): void {
    settlement.settleRawStart();
    if (settlement.didSettle) {
      this.deleteStartSettlement(claim);
    }
  }

  /**
   * The start settlements that still describe each component's current start: the
   * attempt holding its claim, or the registration and attempt token it last ran under.
   * Keyed by name. Shared by the shutdown pass and restart's preflight so the two agree
   * on which starts are current.
   */
  public currentStartSettlements(): Map<string, StartSettlement> {
    const currentStarts = new Map<string, StartSettlement>();
    for (const [claim, settlement] of this.core.state.startSettlements) {
      if (
        this.core.state.componentClaims.get(settlement.name)?.claim === claim ||
        this.isCurrentStartAttempt(
          settlement.name,
          settlement.component,
          settlement.token,
        )
      ) {
        currentStarts.set(settlement.name, settlement);
      }
    }
    return currentStarts;
  }

  /**
   * `currentStartSettlements().get(name)`, read for `name` alone: the last of its
   * settlements, in publication order, that holds its claim or is its current attempt.
   */
  public currentStartSettlementOf(name: string): StartSettlement | undefined {
    const heldClaim = this.core.state.componentClaims.get(name)?.claim;
    let current: StartSettlement | undefined;
    for (const settlement of this.core.state.startSettlementsByName.get(name) ??
      []) {
      if (
        (heldClaim !== undefined &&
          this.core.state.startSettlements.get(heldClaim) === settlement) ||
        this.isCurrentStartAttempt(name, settlement.component, settlement.token)
      ) {
        current = settlement;
      }
    }
    return current;
  }

  /**
   * Whether `component` is still the instance registered under `name` and
   * `startAttemptToken` the start attempt last issued for it: the attempt, or the
   * settlement that recorded both, still describes the name's current start. Shared by
   * the start pipeline's supersession checks, this map, and late-start recovery.
   */
  public isCurrentStartAttempt(
    name: string,
    component: BaseComponent | undefined,
    startAttemptToken: string | undefined,
  ): boolean {
    return (
      component !== undefined &&
      this.core.registry.getComponent(name) === component &&
      this.core.state.componentStartAttemptTokens.get(name) ===
        startAttemptToken
    );
  }

  /**
   * Release every start settlement of `name`: each ends the raw start it tracks for
   * whoever captured it, not only in the registry, and every `start()` call of it still
   * running leaves `runningStarts`.
   */
  public releaseStartSettlements(name: string): void {
    for (const settlement of this.core.state.startSettlementsByName.get(name) ??
      []) {
      settlement.finish();
    }
    for (const settlement of this.core.state.runningStarts) {
      if (settlement.name === name) {
        this.core.state.runningStarts.delete(settlement);
      }
    }
  }

  /** Whether a `start()` of the current registration of `name` has not settled yet. */
  public isRawStartPending(name: string): boolean {
    const settlements = this.core.state.startSettlementsByName.get(name);
    if (settlements === undefined) {
      return false;
    }
    // A pending raw start always has its instance recorded: `rawStartPending` is set only
    // once `recordStartAttempt()` has run.
    const component = this.core.registry.getComponent(name);
    for (const settlement of settlements) {
      if (settlement.rawStartPending && settlement.component === component) {
        return true;
      }
    }
    return false;
  }

  /** Publish a start's settlement, by its claim and by its component's name. */
  private addStartSettlement(claim: symbol, settlement: StartSettlement): void {
    this.core.state.startSettlements.set(claim, settlement);
    let byName = this.core.state.startSettlementsByName.get(settlement.name);
    if (byName === undefined) {
      byName = new Set();
      this.core.state.startSettlementsByName.set(settlement.name, byName);
    }
    byName.add(settlement);
  }

  /** Withdraw the settlement `claim` published, from both of its indexes. */
  private deleteStartSettlement(claim: symbol): void {
    const settlement = this.core.state.startSettlements.get(claim);
    if (settlement === undefined) {
      return;
    }
    this.core.state.startSettlements.delete(claim);
    const byName = this.core.state.startSettlementsByName.get(settlement.name);
    byName?.delete(settlement);
    if (byName?.size === 0) {
      this.core.state.startSettlementsByName.delete(settlement.name);
    }
  }
}
