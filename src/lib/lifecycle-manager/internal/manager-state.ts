import { ulid } from 'ulid';
import type { ProcessSignalManager } from '../../process-signal-manager';
import type { BaseComponent } from '../base-component';
import type { StartupInterruptedByShutdownError } from '../errors';
import type {
  ComponentStallInfo,
  ComponentState,
  ShutdownMethod,
  ShutdownResult,
} from '../types';
import type { DependencyRead } from './dependency-policy';

/** A start and any automatic cleanup it still owns. */
export interface StartSettlement {
  readonly name: string;
  readonly promise: Promise<void>;
  /** Waiting on raw startup ended; its eventual cleanup is still owned by `promise`. */
  readonly abandoned: Promise<void>;
  readonly abandon: () => void;
  readonly finish: () => void;
  didSettle: boolean;
  rawStartPending: boolean;
  /**
   * Resolves once `start()` itself has settled, or once the manager released this
   * settlement (see `releaseStartSettlements()`). `promise` can finish first: a component
   * that owns its late-start cleanup has nothing left for the manager to own after a
   * timeout, while its `start()` may still be running.
   */
  readonly rawStartDone: Promise<void>;
  /** Clears `rawStartPending` and resolves `rawStartDone`. */
  readonly settleRawStart: () => void;
  recovery?: Promise<void>;
  isAwaitingLateStart?: boolean;
  /** An observation failure must not let unregister orphan raw startup or its cleanup. */
  didFailRawStartObservation?: boolean;
  component?: BaseComponent;
  token?: string;
  /**
   * Abort this attempt's start signal as a shutdown's cue (`abortPendingStarts`), unless
   * `start()` has settled or its signal was already aborted. Set by the attempt once it
   * has handed `start()` its signal.
   */
  interruptStart?: (reason: StartupInterruptedByShutdownError) => boolean;
}

/** Raw startup or its owned cleanup has not finished, regardless of display state. */
export function isStartUnfinished(
  settlement: StartSettlement | undefined,
): boolean {
  return (
    settlement !== undefined &&
    (settlement.rawStartPending || !settlement.didSettle)
  );
}

/** When a stop began, and whether its graceful phase timed out. */
export interface StopAttempt {
  readonly startedAt: number;
  readonly gracefulTimedOut: boolean;
}

/**
 * A shutdown pass that has been accepted and is running.
 *
 * "A shutdown was requested while this pass was running" is a property of the pass, not of
 * the manager: a request path marks the pass that refused it, and a caller that owns a
 * pass - a `restartAllComponents()` stop phase - reads its own. The two have the same
 * lifetime by construction, so there is no window to open, close, or hand over.
 */
export interface ShutdownPass {
  /**
   * Set when a shutdown request lands while this pass is running, so the restart that
   * owns the pass skips its startup phase and nothing is started again.
   */
  shutdownRequested: boolean;

  /**
   * A `restartAllComponents()` stop phase, rather than a request to stay down. It does
   * not seed escalation: nobody has asked the process to go down yet, so there is no
   * operator cycle to start. The first signal that lands on it seeds one - see
   * `answerShutdownSignalDuringPass()`.
   */
  readonly isRestartStopPhase: boolean;

  /**
   * Every component marked running while this pass is active. A start in flight as the
   * pass began counts as stopped by it only if it came up here or a stop ran on it; read
   * from this record rather than inferred from `startedAt`, which a frozen or coarse
   * clock leaves unchanged across runs.
   */
  readonly cameUp: Set<string>;

  /**
   * Configuration refusals met stopping a component for this pass, keyed by the refused
   * component, first refusal kept: the pass's own stops, and the stop a start in flight
   * as it began runs on itself once `start()` settles. Either way the pass reports the
   * refusal while that component is still left behind when it ends.
   */
  readonly invalidOptionsRefusals: Map<string, Error | undefined>;
}

/** The running bulk startup's ordering snapshot and registration boundary. */
export interface ActiveBulkStartup {
  readonly dependencyReads: Map<BaseComponent, DependencyRead>;
  // Registrations made from rollback callbacks are refused auto-start.
  isRollingBack: boolean;
  // During initial ordering, new registrations are included in the original batch.
  isOrdering: boolean;
  // Registrations from terminal notifications start independently of this pass.
  isCompleting: boolean;
  // Filled once ordering ends. Those names are this pass's to start already.
  readonly initialOrderNames: Set<string>;
  // Names the loop has taken past its deadline check, attempted or skipped.
  readonly reachedNames: Set<string>;
  // Deferred auto-starts this pass owns and has not reached yet.
  readonly frozenAutoStarts: Set<string>;
}

/** Which attempt last claimed a component, and the state its claim replaced. */
export interface ComponentClaim {
  readonly claim: symbol;
  readonly previousState: ComponentState | undefined;
  // The stop this attempt runs, once known, so the stop net can record a crash
  // as the stall that stop would have recorded.
  readonly stop?: StopAttempt;
}

/** The repeated-shutdown escalation cycle: its requests, window and armed state. */
export interface RepeatedShutdownRequestState {
  requestCount: number;
  firstMethod: ShutdownMethod | null;
  latestMethod: ShutdownMethod | null;
  firstRequestAt: number | null;
  latestRequestAt: number | null;
  repeatedWindowStartedAt: number | null;
  hasTriggeredForceShutdown: boolean;
  remainsArmedUntil: number | null;
}

/**
 * Everything `LifecycleManager` changes after construction: the registry, per-component
 * status and attempt bookkeeping, the startup and shutdown latches, escalation, and
 * signal integration.
 *
 * Plain fields, owned by no subsystem in particular: the manager and its subsystems
 * read and write them in place, so every read stays live. Bookkeeping only one
 * subsystem touches lives on that subsystem instead (the logger exit's flags on
 * `LoggerExitHook`, the stall details on `StopOutcomes`), and configuration that never
 * changes lives in the frozen `ManagerConfig`.
 */
export class LifecycleManagerState {
  // Component management
  public componentEntries: BaseComponent[] = [];

  // Operations share this committed snapshot. Publication and unregister replace
  // it once; reads during registration hooks never allocate a filtered copy.
  public components: BaseComponent[] = [];
  // `components` by name, rebuilt with it in `publishRegistry()` - its only writer - so
  // `getComponent()` and `isNameRegistered()` are lookups rather than scans of the
  // registry, which the startup loop and every dispatch made per component. A name is
  // recorded once, at registration (`nameOf()`), so it cannot drift from the snapshot.
  public componentsByName = new Map<string, BaseComponent>();

  public runningComponents: Set<string> = new Set();
  public componentStates: Map<string, ComponentState> = new Map();
  public stalledComponents: Map<string, ComponentStallInfo> = new Map();

  // State tracking for individual components
  public componentTimestamps: Map<
    string,
    { startedAt: number | null; stoppedAt: number | null }
  > = new Map();
  public componentErrors: Map<string, Error | null> = new Map();
  /**
   * Whether `reportUnexpectedStop()` was called with a real `Error`, as opposed to with
   * nothing or with an off-type value.
   *
   * Recorded separately because `componentErrors` holds a *normalized* error: `toError`
   * turns any reported value into an `Error`, which is what keeps a hostile value from
   * stranding the manager, but it also means `instanceof Error` cannot answer "did the
   * component explain why it stopped?". The overlapping-startup-failure
   * rule in `startComponent` depends on that distinction.
   */
  public componentUnexpectedStopHadError: Map<string, boolean> = new Map();
  public componentStartAttemptTokens: Map<string, string> = new Map();
  public pendingBulkStartupCleanup = new Map<string, string>();
  // The state and error a late-start cleanup's stop leaves its component in, keyed by
  // name with the cleanup's start token. Written by `markComponentStopped()` itself, so
  // the cleanup's `component:stopped` carries the status the component keeps rather than
  // a `stopped` the cleanup then rewrote without an event.
  public lateStartCleanupOutcomes = new Map<
    string,
    { token: string; state: ComponentState; error: Error | null }
  >();

  // Published before start callbacks run; settlement includes automatic stop cleanup.
  public readonly startSettlements = new Map<symbol, StartSettlement>();
  // The same settlements by component name, kept in step by `addStartSettlement()` /
  // `deleteStartSettlement()`: `isRawStartPending()` runs for every dispatch target, and
  // scanning every settlement there made a broadcast quadratic.
  public readonly startSettlementsByName = new Map<
    string,
    Set<StartSettlement>
  >();
  public readonly invokingStarts = new Set<StartSettlement>();
  // The shutdown pass that most recently began, when it asked to abort pending starts
  // (`abortPendingStarts`), keyed by its `shutdownToken`. A start whose caller code began
  // that pass after the start claimed its component - before it could be interrupted -
  // delivers the pass's cue to itself (see `ComponentStart.queueMissedShutdownCue()`),
  // unless its lifecycle handle requested the pass from a starting listener. Cleared once
  // the pass ends.
  public pendingStartAbortRequest:
    | {
        shutdownToken: string;
        method: ShutdownMethod;
        requestingStarts: ReadonlySet<StartSettlement>;
      }
    | undefined;
  // Use per-stop ULIDs instead of incrementing counters because a stalled
  // component can be unregistered and replaced by a same-name instance before
  // the old floating stop promise settles.
  public componentStopAttemptTokens: Map<string, string> = new Map();
  // The tokens of the earlier attempts of the stop a stalled component's force retry
  // continues: its original graceful/force attempt and any earlier retries. Each retry
  // issues its own token, but those attempts' hooks may still finish late, and that
  // finishes the same stop - so their late resolution still clears the stall. Reset by
  // any token issued for a new stop or run.
  public stalledStopEarlierTokens: Map<string, Set<string>> = new Map();
  public pendingForceStopWaiters: Map<string, Set<() => void>> = new Map();
  public unexpectedStopsDuringStartup: Map<string, Error | null> = new Map();

  // State flags
  public isStarting = false;
  public autoAttachedSignalsDuringStartup = false;
  // Auto-starts inherited from a restart gap, accepted during initial ordering, or
  // queued for a follow-up batch. Removed when their batch freezes its order; those
  // still pending when startup ends are reported as abandoned.
  // Only ever non-empty while `isStarting` holds, which also refuses every unregister.
  public deferredAutoStartNames = new Set<string>();
  // Accepted restart stop phases awaiting a startup latch. Each owns its gap
  // registrations until a startup claims the registry or that restart abandons them.
  public readonly pendingRestartAutoStarts = new Set<Set<string>>();
  // The running bulk startup's ordering snapshot and registration boundary.
  public activeBulkStartup: ActiveBulkStartup | null = null;
  public isStarted = false;
  // Unique token used to detect shutdowns that happened during async start().
  public shutdownToken = ulid();
  // The shutdown pass currently running, or `null` when none is. It is the shutdown
  // latch - `isShuttingDown` reads it - so a request refused as "already in progress"
  // can always be recorded against the pass that refused it. See {@link ShutdownPass}.
  public activeShutdownPass: ShutdownPass | null = null;
  // How many shutdown passes that asked the process to stay down have been accepted. A
  // restart compares it across its stop phase: see `restartAllComponentsOperation()`.
  public stayDownPassCount = 0;
  // How many requests to stay down have arrived, whether accepted as a pass or refused
  // and recorded on a running one. An individual restart owns no pass for a refusal to
  // land on, so it compares this across its stop: see `restartComponentOperation()`.
  public stayDownRequestCount = 0;
  // Each registered component's name, read once when it is committed to the registry.
  // See the manager's `nameOf()`.
  public readonly registeredNames = new WeakMap<BaseComponent, string>();

  // Registry bookkeeping exists while the component receives its lifecycle ref and
  // registration hook. Those overrides can re-enter, but may still throw and roll
  // registration back. Never let start() acquire resources for an uncommitted entry:
  // rollback would remove the only manager record capable of stopping them.
  public readonly pendingRegistrations = new Set<BaseComponent>();
  // Rollback removes registry entries before cleanup hooks, but keeps their original
  // names reserved independently until cleanup returns. Registry readers never need
  // to know about half-rolled-back entries or filter them at individual call sites.
  public readonly rollbackReservations = new Map<BaseComponent, string>();
  // Successful registrations retain their validated read for reports and checks of
  // components committed by nested hooks, without probing caller getters again.
  // Kept from the commit until the component is unregistered.
  public readonly committedDependencyReads = new WeakMap<
    BaseComponent,
    DependencyRead
  >();
  // How deep the manager is inside escalation handling - `onForceShutdown` and the
  // escalation events it emits. A shutdown request made from in there continues the
  // cycle being handled rather than starting one. See `acceptShutdownPass()`.
  public escalationHandlingDepth = 0;
  // Narrower than `escalationHandlingDepth`: only while `onForceShutdown` and the
  // `shutdown-escalation-forced` listeners run. The logger exit hook keys on this one - an
  // exit from there is the force itself - and not on the wider depth, which also covers a
  // fresh request's `signal:shutdown` listeners, where an exit must still wait.
  public forceHandlingDepth = 0;
  // Every claim an attempt still running has taken, owned or since superseded. A
  // failure is a refusal only for an attempt that never claimed - one that claimed has
  // acted, whoever holds the component now. Removed by the attempt's net as it settles.
  public readonly claimsTaken = new Set<symbol>();
  // Which attempt last claimed each component as `starting`, `stopping` or
  // `force-stopping`, and the state it replaced. The start and stop nets act on a
  // component only through a claim they own: an attempt that crashed before claiming
  // it - while another claimed it across an `await` - must leave that other attempt's
  // claim alone.
  public readonly componentClaims = new Map<string, ComponentClaim>();
  public shutdownMethod: ShutdownMethod | null = null;
  public lastShutdownResult: ShutdownResult | null = null;
  public repeatedShutdownRequestState: RepeatedShutdownRequestState = {
    requestCount: 0,
    firstMethod: null,
    latestMethod: null,
    firstRequestAt: null,
    latestRequestAt: null,
    repeatedWindowStartedAt: null,
    hasTriggeredForceShutdown: false,
    remainsArmedUntil: null,
  };

  // Signal management
  public processSignalManager: ProcessSignalManager | null = null;
}
