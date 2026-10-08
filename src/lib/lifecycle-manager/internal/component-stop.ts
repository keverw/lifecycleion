import { ulid } from 'ulid';
import { isNullish } from '../../internal/is-nullish';
import { adoptPromise } from '../../internal/adopt-promise';
import { observeRejection } from '../../internal/intrinsics';
import { optionalValidatedTimerDelayMS } from '../../internal/timer-limits';
import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import {
  LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
  LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
} from '../constants';
import {
  ComponentForceTimeoutError,
  ComponentStopTimeoutError,
  ForceShutdownSupersededError,
} from '../errors';
import type {
  ComponentOperationResult,
  ComponentStallInfo,
  ComponentStatus,
  StopComponentOptions,
} from '../types';
import { abortHookSignal, createHookAbortController } from './hook-abort';
import type { ManagerCore } from './manager-core';
import { isStartUnfinished, type StopAttempt } from './manager-state';
import {
  crashedComponentResult,
  isLinkedToAbort,
  takeSettledFailureCode,
  toOperationTimerDelayMS,
} from './operation-policy';
import {
  snapshotStopOptions,
  type StopOptionsSnapshot,
} from './operation-options';
import { createStopPhaseObserver } from './stop-phase-observer';

/** Call-local policy and claim history for an individual stop or restart. */
export interface IndividualStopContext {
  readonly operation: 'stop' | 'restart';
  /** Stays true after this attempt claims, even if its claim is later released. */
  claimed: boolean;
  /** The caller's override, from the operation's options snapshot. */
  readonly allowStopWithRunningDependents?: boolean;
  isStartupRollback?: boolean;
  /** Components this startup's rollback has already reached; see dependents check. */
  rolledBackNames?: ReadonlySet<string>;
  hasShutdownBegun?: () => boolean;
}

/** What a dependent is doing that keeps an individual stop from removing its dependency. */
type DependentWork = 'running' | 'starting' | 'pending' | 'stalled';

/** Refusal wording per kind of dependent work, in reporting order. */
const DEPENDENT_WORK_LABELS: Record<DependentWork, string> = {
  running: 'running dependents',
  starting: 'starting dependents',
  pending: 'dependents with pending startup work',
  stalled: 'stalled dependents',
};

/** A component's force handler and budget, read together before any stop phase runs. */
interface ForceShutdownPreparation {
  onShutdownForce: unknown;
  timeoutMS: number;
}

/**
 * What a stop hands its graceful phase, and what that phase hands back. Internal
 * attempt-local handoff, never the caller's options object.
 */
interface GracefulPreparation {
  readonly timeoutMS: number;
  readonly startedAt: number;
  // The token of a stop that succeeded once its deadline fired, recorded for the
  // graceful result's caller to consume before escalating.
  lateResolution?: string;
}

/**
 * The stop a force phase continues: an escalation from a graceful phase that failed, a
 * `forceImmediate` stop, or a stalled component's retry.
 */
interface ForceStopContext {
  readonly gracefulPhaseRan: boolean;
  readonly gracefulTimedOut: boolean;
  readonly gracefulError?: Error;
  readonly startedAt: number;
  // A stalled component's force-phase retry: a new stop attempt, which issues its
  // own token - see below.
  readonly isStalledRetry?: boolean;
}

/** A force phase's wait for another path to mark its component stopped. */
interface PendingForceStopWaiter {
  promise: Promise<void>;
  cleanup: () => void;
  // Whether another path has marked the component stopped since the waiter was made.
  hasResolved: () => boolean;
}

type StopPhaseObserver = ReturnType<typeof createStopPhaseObserver>;

const ABANDONED_FORCE_MESSAGE =
  'Force shutdown failed after graceful stop completed';

/**
 * One graceful phase attempt, from its claim on: what it was prepared with, its stop
 * token, outcome observer and abort controller, and what its race has seen so far.
 * Created once the phase holds its claim and has read `stop`, and handed to every step
 * of `shutdownComponentGraceful()`; its deadline's callbacks read and update it in
 * place. It runs no code of its own.
 */
class GracefulStopRun {
  // Only this attempt's deadline is a timeout. A hook may reject with the same
  // exported error class and component name for an unrelated reason.
  public gracefulTimeoutError: ComponentStopTimeoutError | undefined;
  // Set once that rejection has been delivered to the race - a macrotask after the
  // deadline fired (see `rejectAfterAbort()`), as in the force phase. A stop
  // rejection before then still settles the race as a graceful failure.
  public didDeadlineReject = false;
  // Set when `stop()` rejected once the deadline fired, linked to that abort (see
  // `isLinkedToAbort()`): a stop that honored its signal by rejecting is the timeout
  // it was told of, even when its rejection beats the deferred deadline to the race.
  public didRejectForDeadline = false;
  public timeoutHandle: NodeJS.Timeout | undefined;
  // Set once `stop()` has resolved: a throw after that is the bookkeeping's, not the
  // stop's, and must not be answered as a failed graceful phase and escalated.
  public didStopResolve = false;
  // Set once this attempt recorded the stop: a throw after that is only reporting.
  public didMarkStopped = false;

  constructor(
    public readonly name: string,
    public readonly claim: symbol,
    public readonly preparation: GracefulPreparation,
    public readonly stopAttemptToken: string,
    public readonly outcomeObserver: StopPhaseObserver,
    public readonly stopAbort: AbortController,
  ) {}
}

/**
 * One force phase attempt that has a handler to run, from its claim on: the stop it
 * continues, its budget and token, the waiter that tells when another path stopped the
 * component, its outcome observer and abort controller, and what its race has seen so
 * far. Created once the phase holds its claim, and handed to every step of
 * `shutdownComponentForce()`; its deadline's callbacks read and update it in place. It
 * runs no code of its own.
 */
class ForceStopRun {
  // Severity follows the recorded outcome, not whether the deadline fired.
  // Once a failed foreground returns, its released claim alone must not make
  // that real failure look abandoned. Pending attempts may already have lost
  // ownership to late graceful completion before their continuation resumes.
  public forceOutcome: 'pending' | 'failed' | 'abandoned' = 'pending';
  // This attempt's own timeout rejection, so the `catch` can tell it apart from
  // anything `onShutdownForce()` rejects with.
  public forceTimeoutError: ComponentForceTimeoutError | undefined;
  // Set once that rejection has been delivered to the race - a macrotask after the
  // deadline fired (see `rejectAfterAbort()`). A hook rejection before then still
  // settles the race as the hook's own failure, and is reported as one.
  public didDeadlineReject = false;
  // Set when `onShutdownForce()` rejected once the deadline fired, linked to that
  // abort, as in the graceful phase: the timeout it was told of, not its own failure.
  public didRejectForDeadline = false;
  // Set once the force race has settled without a failure: a throw after that is the
  // bookkeeping's, not the hook's, as in the graceful phase.
  public didForceResolve = false;
  // Set once the component is marked stopped, as in the graceful phase: a throw after
  // that - the success log, say - fails only the notification, not the stop. The
  // status both carry is read guarded (`readStatusOfStopped()`).
  public didMarkStopped = false;
  // Set once `onShutdownForce()`'s own promise has settled, either way: a call that
  // finished is not aborted, even when a late graceful completion ends the phase in the
  // same moment.
  public didForceHookSettle = false;
  public timeoutHandle: NodeJS.Timeout | undefined;

  constructor(
    public readonly name: string,
    public readonly component: BaseComponent,
    public readonly claim: symbol,
    public readonly context: ForceStopContext,
    public readonly timeoutMS: number,
    public readonly forceAttemptToken: string | undefined,
    public readonly waiter: PendingForceStopWaiter,
    public readonly outcomeObserver: StopPhaseObserver,
    public readonly forceAbort: AbortController,
  ) {}
}

/**
 * The per-component stop pipeline: an individual stop's refusals, the net under every
 * stop, the graceful and force phases, a stalled component's force retry, and the
 * bookkeeping a stop leaves - stopped or stalled, its attempt token, the force-stop
 * waiters, and a stop that settles after its deadline.
 *
 * Every per-component stop runs through here: `stopComponent()`, a restart's stop, a
 * shutdown pass and its stalled retries, startup rollback, and late-start cleanup. Those
 * callers own their bulk policy and pass it in (`IndividualStopContext`); claims are
 * taken through `core.claims`. Owns the stall details it keeps beside each stall record,
 * which nothing else reads.
 */
export class ComponentStop {
  // What each stall record cannot say itself, kept beside the record object rather than
  // on the record callers receive: whether its stop had already timed out gracefully - a
  // force timeout reports `reason: 'timeout'` - so a retry that fails can still report
  // `'both'`, and whether the stop net recorded it after a crash. Written only by
  // `markComponentStalled()`; keyed by the record, so it goes when the record does.
  private readonly stallDetails = new WeakMap<
    ComponentStallInfo,
    { readonly gracefulTimedOut: boolean; readonly crashed: boolean }
  >();

  constructor(private readonly core: ManagerCore) {}

  /**
   * The body of the manager's public `stopComponent()`: refused during bulk work and
   * with active dependents, then run through `stopComponentInternal()`.
   */
  public async stopComponentOperation(
    name: string,
    options: StopComponentOptions | undefined,
  ): Promise<ComponentOperationResult> {
    const bulkRefusal = this.checkIndividualBulkPreconditions(name, 'stop');
    if (bulkRefusal) {
      return bulkRefusal;
    }

    // Every option is read here, once, before the dependents refusal and the claim, and
    // the getters are caller code: the bulk check is made again after them.
    const stopOptions = snapshotStopOptions(options);
    const afterOptionsRefusal = this.checkIndividualBulkPreconditions(
      name,
      'stop',
    );
    if (afterOptionsRefusal) {
      return afterOptionsRefusal;
    }
    const stopContext: IndividualStopContext = {
      operation: 'stop',
      claimed: false,
      allowStopWithRunningDependents:
        stopOptions.allowStopWithRunningDependents,
    };

    // Checked here as well as by `checkIndividualStopClaim()` right before the claim,
    // not instead of it. This one gives the refusal precedence: a stop - or restart -
    // refused for its running dependents answers so without reading the component's
    // timeouts and force handler, whose getters would otherwise run - and an invalid
    // value there answer `invalid_options` - for a stop that was never going to happen.
    // The second catches a dependent those getters started.
    const dependentRefusal = this.checkIndividualStopDependents(
      name,
      stopContext,
    );
    if (dependentRefusal) {
      return dependentRefusal;
    }

    return await this.stopComponentInternal(name, stopOptions, stopContext);
  }

  /** Snapshot the refusal before a guarded logger can re-enter either operation. */
  public checkIndividualBulkPreconditions(
    name: string,
    operation: 'stop' | 'restart',
  ): ComponentOperationResult | undefined {
    const isStarting = this.core.state.isStarting;
    const isShuttingDown = this.core.shutdownPass.isShuttingDown;
    if (!isStarting && !isShuttingDown) {
      // A late start's cleanup marks its component running only to stop it, and
      // restores the timed-out state afterwards. A plain stop that claimed it first
      // would leave the cleanup refused and that state lost. A restart may still
      // claim the cleanup's stop: it starts the component again either way.
      if (
        operation === 'stop' &&
        this.core.state.pendingBulkStartupCleanup.has(name)
      ) {
        this.core.logger
          .entity(name)
          .warn('Cannot stop component during timed-out startup cleanup');
        return {
          success: false,
          componentName: name,
          reason: LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
          code: 'component_already_stopping',
        };
      }
      return undefined;
    }
    const result: ComponentOperationResult = {
      success: false,
      componentName: name,
      reason: isStarting
        ? LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS
        : LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
      code: isStarting ? 'startup_in_progress' : 'shutdown_in_progress',
    };
    let message: string;
    let params: Record<string, boolean>;
    if (operation === 'restart') {
      message = 'Cannot restart component during bulk operation';
      params = { isStarting, isShuttingDown };
    } else if (isStarting) {
      message = 'Cannot stop component during bulk startup';
      params = { isStarting };
    } else {
      message = 'Cannot stop component during shutdown';
      params = { isShuttingDown };
    }
    this.core.logger.entity(name).warn(message, { params });
    return result;
  }

  /**
   * Prepared hook and timeout getters can start a dependent before this stop owns
   * its component. Include start claims as well as running membership: a dependent
   * awaiting start() already relies on this component, even before it is published
   * as running. Keep the caller's override in the call-local context so checking
   * again does not re-read an option getter. Dependency reads are caller code too,
   * so the phase must still check bulk and component ownership after this helper.
   */
  public checkIndividualStopDependents(
    name: string,
    context: IndividualStopContext,
  ): ComponentOperationResult | undefined {
    if (context.allowStopWithRunningDependents) {
      return undefined;
    }
    // Re-read at each claim boundary: dependency getters can change their answers
    // without a registration-generation change, so prior reads cannot be reused.
    // A dependency getter can also register a new dependent. Use the settled
    // registry read rather than an array captured before those getters ran. If
    // caller code keeps changing registrations beyond the bounded read, an unread
    // active component is not evidence that stopping its dependency is safe.
    const { reads } = this.core.registryReads.readRegistry(
      (component) =>
        this.core.componentMetadata.readDependencies(component, 'dependents'),
      undefined,
      undefined,
      undefined,
      // Refresh each round: a dependency getter can start an idle component.
      () => [...this.readDependentWork(name, context).keys()],
    );
    const activeWork = this.readDependentWork(name, context);
    const dependents = this.core.state.components.filter(
      (component) =>
        activeWork.has(component) &&
        (!this.core.registryReads.isReadCurrent(reads, component) ||
          reads.get(component)?.includes(name) === true),
    );
    if (dependents.length === 0) {
      return undefined;
    }
    const byWork: Record<DependentWork, string[]> = {
      running: [],
      starting: [],
      pending: [],
      stalled: [],
    };
    for (const component of dependents) {
      // Always set: `dependents` holds only components with active work.
      const work = activeWork.get(component);
      if (work !== undefined) {
        byWork[work].push(this.core.registry.nameOf(component));
      }
    }
    const activity = (Object.keys(DEPENDENT_WORK_LABELS) as DependentWork[])
      .filter((work) => byWork[work].length > 0)
      .map(
        (work) => `${DEPENDENT_WORK_LABELS[work]}: ${byWork[work].join(', ')}`,
      )
      .join('; ');
    const result: ComponentOperationResult = {
      success: false,
      componentName: name,
      reason: `Component has ${activity}. Use { allowStopWithRunningDependents: true } option to bypass.`,
      code: 'has_running_dependents',
    };
    this.core.logger
      .entity(name)
      .warn('Cannot stop component with active dependents', {
        params: {
          runningDependents: byWork.running,
          startingDependents: byWork.starting,
          pendingStartupDependents: byWork.pending,
          ...(byWork.stalled.length
            ? { stalledDependents: byWork.stalled }
            : {}),
        },
      });
    return result;
  }

  /**
   * Internal stop component method - bypasses bulk operation checks
   * Implements individual component graceful -> force shutdown (global warning handled elsewhere).
   * The public stop entry explicitly opts into bulk rechecks; bulk shutdown and
   * cleanup call this internal entry under their own ownership. Keep that policy
   * call-local instead of maintaining another per-claim registry to infer it.
   */
  public stopComponentInternal(
    name: string,
    options?: StopOptionsSnapshot,
    stopContext?: IndividualStopContext,
  ): Promise<ComponentOperationResult> {
    return this.withComponentStopNet(name, (claim) =>
      this.stopComponentAttempt(name, options, claim, stopContext),
    );
  }

  /**
   * Retry shutdown for a stalled component: the force phase directly, to avoid re-running
   * a failing `stop()`. Under the same net as any other stop, so a failure outside the
   * component's own hooks marks it stalled rather than taking the whole shutdown pass
   * down with it.
   */
  public retryStalledComponent(
    name: string,
  ): Promise<ComponentOperationResult> {
    return this.withComponentStopNet(name, (claim) =>
      this.retryStalledComponentAttempt(name, claim),
    );
  }

  /**
   * The stop preconditions, checked without reading component-owned properties. Each
   * phase checks again after reading its timeout and hooks: getters
   * may stop, unregister, or replace the component synchronously. Taking the claim
   * from that newer stop would call stop() twice and let either completion overwrite
   * the other's state. A replacement must not inherit the old instance's outcome.
   */
  public checkStopPreconditions(
    name: string,
    expected?: BaseComponent,
    force?: { claim: symbol; isStalledRetry: boolean },
  ): ComponentOperationResult | { component: BaseComponent } {
    const component = this.core.registry.getComponent(name);

    if (!component || (expected !== undefined && component !== expected)) {
      return {
        success: false,
        componentName: name,
        reason:
          expected === undefined
            ? LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND
            : `Component "${name}" was unregistered or replaced while its stop was being prepared`,
        code: 'component_not_found',
      };
    }

    // A force phase may continue its own graceful claim, or retry an idle stall.
    // It may never replace another in-flight claim, including a forceStalled start.
    // Do this before the stall check because retries retain the stall record while
    // their force handler runs.
    if (force && this.core.claims.isInFlight(name)) {
      const state = this.core.state.componentStates.get(name);
      if (state === 'stopping' && this.core.claims.owns(name, force.claim)) {
        return { component };
      }
      const isStarting = state === 'starting';
      return {
        success: false,
        componentName: name,
        reason: isStarting
          ? 'Component is starting'
          : 'Component is already stopping',
        code: isStarting
          ? 'component_already_starting'
          : 'component_already_stopping',
        status: this.core.registry.statusOf(name),
      };
    }
    if (force?.isStalledRetry && this.core.state.stalledComponents.has(name)) {
      return { component };
    }

    // Check if stalled
    if (this.core.state.stalledComponents.has(name)) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
        code: 'component_stalled',
        status: this.core.registry.statusOf(name),
      };
    }

    // Check if not running
    if (!this.core.state.runningComponents.has(name)) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
        code: 'component_not_running',
        status: this.core.registry.statusOf(name),
      };
    }

    // Check if already stopping to prevent concurrent stop operations
    const currentState = this.core.state.componentStates.get(name);
    if (currentState === 'stopping' || currentState === 'force-stopping') {
      return {
        success: false,
        componentName: name,
        reason: `Component is already ${currentState}`,
        code: 'component_already_stopping',
        status: this.core.registry.statusOf(name),
      };
    }

    return { component };
  }

  /**
   * Issues and returns a unique stop attempt token for a component.
   *
   * Each stop attempt (graceful or force-retry) gets a unique token.
   * The late-resolution handler captures this token in its closure so it can
   * skip any stall entries that were created by a *later* stop attempt — e.g. a
   * force-retry that also timed out after the original graceful promise floated
   * in the background.
   */
  public issueStopAttemptToken(
    name: string,
    // A stalled component's force retry: the attempt it supersedes belongs to the same
    // stop, so its token joins `stalledStopEarlierTokens` instead of being retired.
    isContinuingStalledStop = false,
  ): string {
    const previous = this.core.state.componentStopAttemptTokens.get(name);
    if (isContinuingStalledStop && previous !== undefined) {
      const earlier =
        this.core.state.stalledStopEarlierTokens.get(name) ?? new Set();
      earlier.add(previous);
      this.core.state.stalledStopEarlierTokens.set(name, earlier);
    } else {
      this.core.state.stalledStopEarlierTokens.delete(name);
    }
    const next = ulid();
    this.core.state.componentStopAttemptTokens.set(name, next);
    return next;
  }

  /**
   * The status of a component already recorded as stopped, for its `component:stopped`
   * event and its result. Read guarded: `getComponentStatus()` is public and can be
   * overridden, and a throw from it must not cost a stop that happened its notification,
   * nor turn it into a crash. Reported, and left out.
   */
  public readStatusOfStopped(
    name: string,
    context = 'lifecycle-manager component stop',
  ): ComponentStatus | undefined {
    try {
      return this.core.manager.getComponentStatus(name);
    } catch (error) {
      reportCallbackError(context, error);
      return undefined;
    }
  }

  /**
   * What each committed component other than `name` is doing that keeps a stop of
   * `name` from removing a dependency it may rely on. Read afresh at each call: caller
   * code between two reads can start or register components.
   */
  private readDependentWork(
    name: string,
    context: IndividualStopContext,
  ): Map<BaseComponent, DependentWork> {
    const activity = new Map<BaseComponent, DependentWork>();
    for (const component of this.core.state.components) {
      const dependent = this.core.registry.nameOf(component);
      // The component being stopped is active itself, but it is not its own
      // dependent: registration refuses a self-dependency as a cycle. Left in, its
      // dependency getter would run every round for nothing.
      if (dependent === name) {
        continue;
      }
      if (this.core.manager.isComponentRunning(dependent)) {
        activity.set(component, 'running');
      } else if (
        this.core.state.componentStates.get(dependent) === 'starting'
      ) {
        activity.set(component, 'starting');
      } else if (this.hasPendingStart(dependent, component)) {
        activity.set(component, 'pending');
      } else if (
        // Rollback leaves dependencies of unfinished cleanup running: a dependent
        // whose rollback stop stalled may still be using this component. A stall
        // from before this startup does not hold back what this startup started.
        context.rolledBackNames?.has(dependent) === true &&
        this.core.state.stalledComponents.has(dependent)
      ) {
        activity.set(component, 'stalled');
      }
    }
    return activity;
  }

  // An unfinished start of this registration, under its current attempt token. Looked
  // up by name, and only for a component neither running nor starting: this runs
  // every round of the registry read in `checkIndividualStopDependents()`.
  private hasPendingStart(
    dependent: string,
    component: BaseComponent,
  ): boolean {
    const settlements =
      this.core.state.startSettlementsByName.get(dependent) ?? [];
    for (const settlement of settlements) {
      if (
        isStartUnfinished(settlement) &&
        settlement.component === component &&
        settlement.token ===
          this.core.state.componentStartAttemptTokens.get(dependent)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * The net under every per-component stop - `stopComponentInternal()` and a stalled
   * component's force-phase retry alike.
   */
  private async withComponentStopNet(
    name: string,
    run: (claim: symbol) => Promise<ComponentOperationResult>,
  ): Promise<ComponentOperationResult> {
    const startedAt = Date.now();
    const claim = Symbol(name);

    // Released once this attempt settles, however it settled: a claim outlived the attempt
    // that took it, keeping a stale `previousState` until the next attempt overwrote it.
    try {
      try {
        return await run(claim);
      } catch (error) {
        return this.answerStopCrash(name, claim, startedAt, error);
      }
    } finally {
      this.core.state.claimsTaken.delete(claim);
      this.core.claims.release(name, claim);
    }
  }

  /**
   * What the stop net answers for an attempt that threw: `invalid_options` for an
   * option refusal met before the attempt claimed anything, and otherwise a crash,
   * stalling the component first when the crash left this attempt's own stop in
   * progress.
   */
  private answerStopCrash(
    name: string,
    claim: symbol,
    startedAt: number,
    error: unknown,
  ): ComponentOperationResult {
    // Classified as the start net does, and the brand dropped for the same reason:
    // bulk shutdown and rollback log a failed stop's error before they settle.
    if (
      takeSettledFailureCode(error) === 'invalid_options' &&
      !this.core.state.claimsTaken.has(claim)
    ) {
      return crashedComponentResult(
        name,
        error as Error,
        `Stop refused: ${describeError(error)}`,
        'invalid_options',
      );
    }

    // Once an attempt claims `stopping` / `force-stopping`, subsequent hook calls
    // and result bookkeeping can still throw outside the phase's own `try`.
    // Left alone, a throw there held that state for good: every later
    // start or stop answered `component_already_stopping`, and it could never be
    // unregistered. Nobody can vouch for what the component did stop, which is what
    // `stalled` means, and a stalled component can be retried or unregistered.
    const err = toError(error);
    const state = this.core.state.componentStates.get(name);
    // Set only once this crash is recorded as the stop's stall below.
    let stall: { gracefulTimedOut: boolean } | undefined;

    // Only a stop this attempt claimed: a `stopping` it did not claim belongs to a
    // concurrent stop - one that got in while this attempt was awaiting, before its
    // own claim - and must not be stalled by this attempt's crash.
    if (
      (state === 'stopping' || state === 'force-stopping') &&
      this.core.claims.owns(name, claim)
    ) {
      // A crash describes the stop the attempt runs - when it began and whether
      // its graceful phase timed out - as that stop's own failure would, whether it
      // escalated from `stop()` or retried a stall.
      const stop = this.core.state.componentClaims.get(name)?.stop ?? {
        startedAt,
        gracefulTimedOut: false,
      };
      const stallInfo = this.stopStallInfo(
        name,
        state === 'stopping' ? 'graceful' : 'force',
        stop,
        err,
      );

      this.markComponentStalled(name, stallInfo, {
        error: err,
        gracefulTimedOut: stop.gracefulTimedOut,
        crashed: true,
      });
      stall = { gracefulTimedOut: stop.gracefulTimedOut };
      // Signals stay attached, as they do for every other stall: a stalled component
      // was not confirmed stopped, and during a shutdown the operator's next Ctrl+C
      // still has to reach escalation. No force-stop waiter is left to release here:
      // the only one this claim could hold is its own force attempt's, which that
      // attempt's `finally` removed before the crash reached this net, and a waiter
      // of an attempt superseded earlier was released when the component was marked
      // stopped.
      this.core.lifecycleEvents.componentStalled(name, stallInfo, {
        reason: stallInfo.reason,
        // Paired with the reason as every other stall is: a crash still in the graceful
        // phase after it timed out stays a timeout; otherwise - including a force-phase
        // crash after a graceful timeout (`both`) - it was the crash.
        code:
          stallInfo.reason === 'timeout'
            ? 'component_shutdown_timeout'
            : 'operation_crashed',
      });
    }

    reportCallbackError('lifecycle-manager component stop', error);

    return this.crashedStopResult(name, err, stall);
  }

  private async retryStalledComponentAttempt(
    name: string,
    claim: symbol,
  ): Promise<ComponentOperationResult> {
    // A stale retry request may now name an ordinary in-progress start. Preserve
    // its former not-running result; only an actual stalled retry reports the
    // more specific in-flight refusal from the force preconditions below.
    if (
      this.core.registry.getComponent(name) !== undefined &&
      !this.core.state.stalledComponents.has(name) &&
      !this.core.manager.isComponentRunning(name)
    ) {
      return {
        success: false,
        componentName: name,
        code: 'component_not_running',
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
        status: this.core.manager.getComponentStatus(name),
      };
    }
    const preconditions = this.checkStopPreconditions(name, undefined, {
      claim,
      isStalledRetry: true,
    });
    if ('success' in preconditions) {
      return preconditions;
    }
    const { component } = preconditions;

    // The pass asks for a retry only of a stall, but caller code since can have cleared
    // it - a forced start that is running now. That is an ordinary stop, run under this
    // net and claim rather than nesting another net inside this one.
    const priorStall = this.core.state.stalledComponents.get(name);
    if (!priorStall) {
      return await this.stopComponentAttempt(name, undefined, claim, undefined);
    }

    // A retry continues the stop that stalled: it keeps when that stop began and
    // whether its graceful phase timed out, for any new stall.
    return await this.shutdownComponentForce(
      name,
      component,
      {
        gracefulPhaseRan: false,
        gracefulTimedOut: this.didStallGracefulTimeOut(name),
        gracefulError: undefined,
        startedAt: priorStall.startedAt,
        isStalledRetry: true,
      },
      claim,
    );
  }

  private async stopComponentAttempt(
    name: string,
    options: StopOptionsSnapshot | undefined,
    claim: symbol,
    stopContext: IndividualStopContext | undefined,
  ): Promise<ComponentOperationResult> {
    const preconditions = this.checkStopPreconditions(name);
    if ('success' in preconditions) {
      return preconditions;
    }
    const { component } = preconditions;

    // Handle forceImmediate option - skip all phases and go straight to force
    if (options?.forceImmediate === true) {
      return await this.shutdownComponentForce(
        name,
        component,
        {
          gracefulPhaseRan: false,
          gracefulTimedOut: false,
          gracefulError: undefined,
          startedAt: Date.now(),
        },
        claim,
        undefined,
        stopContext,
      );
    }

    // Run three-phase shutdown
    return await this.shutdownComponent(
      name,
      component,
      options,
      claim,
      stopContext,
    );
  }

  /**
   * Two-phase shutdown: graceful -> force (global warning handled by stopAllComponents)
   *
   * Phase 1: Graceful (always - calls stop())
   * Phase 2: Force (if Phase 1 failed - calls onShutdownForce())
   */
  private async shutdownComponent(
    name: string,
    component: BaseComponent,
    options: StopOptionsSnapshot | undefined,
    claim: symbol,
    stopContext: IndividualStopContext | undefined,
  ): Promise<ComponentOperationResult> {
    const shutdownStartedAt = Date.now();
    // Prepare both phases before claiming the component or calling stop(). An invalid
    // force budget must not first shut down part of the component. Keep the values we
    // validated: a getter or stop() can change the component before escalation.
    const requestedTimeoutMS = options?.timeout;
    const isUsingComponentTimeout = isNullish(requestedTimeoutMS);
    const timeoutMS = toOperationTimerDelayMS(
      isUsingComponentTimeout
        ? component.shutdownGracefulTimeoutMS
        : requestedTimeoutMS,
      isUsingComponentTimeout
        ? `${name}.shutdownGracefulTimeoutMS`
        : 'stopComponent timeout',
    );
    const forcePreparation = this.prepareForceShutdown(name, component);

    // ============================================================================
    // Phase 1: Graceful (always)
    // ============================================================================
    // Internal attempt-local handoff, never the caller's options object. The
    // observer records a resolution that the foreground race must consume.
    const gracefulPreparation: GracefulPreparation = {
      timeoutMS,
      startedAt: shutdownStartedAt,
      lateResolution: undefined,
    };
    const gracefulResult = await this.shutdownComponentGraceful(
      name,
      component,
      gracefulPreparation,
      claim,
      stopContext,
    );

    // Only an attempt that claimed the graceful phase may escalate it. A refusal
    // after a re-entrant getter owns no stop, and the current claim may belong to
    // the nested attempt. Its refusal is the result, not a reason to force that
    // other attempt's component. The same applies if our claim was superseded while
    // awaiting the graceful result.
    if (gracefulResult.success || !this.core.claims.owns(name, claim)) {
      return gracefulResult;
    }

    // The timeout notification can resolve a bare stop promise before the force
    // claim. Its observer must not finalize while the foreground race is undecided;
    // now that it returned, consume the retained resolution under the same token.
    if (
      gracefulPreparation.lateResolution !== undefined &&
      this.core.state.componentStopAttemptTokens.get(name) ===
        gracefulPreparation.lateResolution &&
      this.core.registry.getComponent(name) === component &&
      this.core.state.componentStates.get(name) === 'stopping'
    ) {
      if (
        this.handleLateStopResolution(
          name,
          gracefulPreparation.lateResolution,
          'graceful',
          true,
        )
      ) {
        return this.successfulStopResult(name);
      }
    }

    // ============================================================================
    // Phase 2: Force (graceful failed)
    // ============================================================================
    const didGracefulTimeOut =
      gracefulResult.code === 'component_shutdown_timeout';
    // Before the force phase reads its hooks: a crash there still describes this stop.
    this.core.claims.recordStop(name, claim, {
      startedAt: shutdownStartedAt,
      gracefulTimedOut: didGracefulTimeOut,
    });
    this.core.logger
      .entity(name)
      .warn('Graceful shutdown failed, proceeding to force phase', {
        params: {
          reason: gracefulResult.reason,
          code: gracefulResult.code,
        },
      });

    return await this.shutdownComponentForce(
      name,
      component,
      {
        gracefulPhaseRan: true,
        gracefulTimedOut: didGracefulTimeOut,
        gracefulError: gracefulResult.error,
        startedAt: shutdownStartedAt,
      },
      claim,
      forcePreparation,
      stopContext,
    );
  }

  private checkIndividualStopClaim(
    name: string,
    stopContext: IndividualStopContext,
  ): ComponentOperationResult | undefined {
    const dependentRefusal = this.checkIndividualStopDependents(
      name,
      stopContext,
    );
    if (dependentRefusal) {
      return dependentRefusal;
    }
    // Rollback may bypass its own startup latch, never a newer shutdown
    // accepted by one of the preparation/dependency getters just read.
    if (stopContext.hasShutdownBegun?.()) {
      return {
        success: false,
        componentName: name,
        code: 'shutdown_in_progress',
        reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
      };
    }
    const bulkRefusal = stopContext.isStartupRollback
      ? undefined
      : this.checkIndividualBulkPreconditions(name, stopContext.operation);
    if (bulkRefusal) {
      return bulkRefusal;
    }
    return undefined;
  }

  /**
   * Phase 2: Graceful shutdown
   * Calls stop() with timeout
   *
   * Claims the component (`claimGracefulStop()`), then runs one `GracefulStopRun`:
   * `stop()` raced against its deadline (`armGracefulDeadline()`), then the stop recorded
   * (`completeGracefulStop()`) or the failure answered (`gracefulFailureResult()`). Every
   * step is synchronous; the race is the one thing awaited, here, directly.
   */
  private async shutdownComponentGraceful(
    name: string,
    component: BaseComponent,
    preparation: GracefulPreparation,
    claim: symbol,
    stopContext: IndividualStopContext | undefined,
  ): Promise<ComponentOperationResult> {
    const refusal = this.claimGracefulStop(
      name,
      component,
      preparation,
      claim,
      stopContext,
    );
    if (refusal) {
      return refusal;
    }

    const stopAttemptToken = this.issueStopAttemptToken(name);
    const outcomeObserver = this.createStopPhaseObserver(name);

    // Read apart from the call, after the claim: a `stop` getter that throws has not
    // run `stop()`, so it reaches the stop net as a crash (`operation_crashed`,
    // reported) rather than a failed graceful phase (`error`).
    const stopHook: unknown = Reflect.get(component, 'stop');
    // One controller per graceful attempt, its signal handed to `stop()`. Aborted only
    // at this attempt's graceful deadline - the timer below - never because `stop()`
    // settled, either way, and never by the force phase that may follow.
    const stopAbort = createHookAbortController(name, 'stop');
    const run = new GracefulStopRun(
      name,
      claim,
      preparation,
      stopAttemptToken,
      outcomeObserver,
      stopAbort,
    );

    try {
      // Race against graceful timeout
      // Adopted, for the reason `startComponentAttempt()` adopts `start()`'s.
      const stopPromise = adoptPromise(
        Reflect.apply(stopHook as (signal: AbortSignal) => unknown, component, [
          stopAbort.signal,
        ]),
        {
          // A stop that succeeds once its deadline has fired - a bare promise the
          // timeout notification itself resolved - is recorded by the reaction that
          // settles adoption, where the stop settled, so the graceful result's caller
          // finds it before escalating. The deadline observer below records it too,
          // a reaction later, and reconciles it.
          onSettled: (didFulfill) => {
            if (didFulfill && run.gracefulTimeoutError !== undefined) {
              preparation.lateResolution = stopAttemptToken;
            }
          },
        },
      );

      const delayMS = optionalValidatedTimerDelayMS(preparation.timeoutMS);
      if (delayMS !== undefined) {
        const timeoutPromise = this.armGracefulDeadline(
          run,
          stopPromise,
          delayMS,
        );

        await Promise.race([stopPromise, timeoutPromise]);
      } else {
        await stopPromise;
      }
      run.didStopResolve = true;

      return this.completeGracefulStop(run);
    } catch (error) {
      // The component did stop and its state says so; only the notification failed.
      // Reported, but answered as the stop it was, so a bulk pass does not halt on a
      // component it stopped.
      if (run.didMarkStopped) {
        reportCallbackError('lifecycle-manager component stop', error);
        return { success: true, componentName: name };
      }
      // Left to the stop net, which answers `operation_crashed`.
      if (run.didStopResolve) {
        throw error;
      }

      return this.gracefulFailureResult(run, error);
    } finally {
      if (run.timeoutHandle) {
        clearTimeout(run.timeoutHandle);
      }
    }
  }

  /**
   * The graceful phase's refusals and its claim: a refusal, or `undefined` once this
   * attempt holds the component as `stopping` and has announced it.
   */
  private claimGracefulStop(
    name: string,
    component: BaseComponent,
    preparation: GracefulPreparation,
    claim: symbol,
    stopContext: IndividualStopContext | undefined,
  ): ComponentOperationResult | undefined {
    if (stopContext) {
      const refusal = this.checkIndividualStopClaim(name, stopContext);
      if (refusal) {
        return refusal;
      }
    }

    // All prepared getters are caller code and may already have started another stop.
    const recheck = this.checkStopPreconditions(name, component);
    if ('success' in recheck) {
      return recheck;
    }

    // Nothing between the recheck and claim runs caller code. Claim first, then
    // clear the unexpected-stop handler: even the clearing hook can be overridden
    // to re-enter. It must find this stop already in progress. Both happen before
    // any async work, so reports of an unexpected stop are ignored from here on.
    // The stop is recorded with the claim, so a crash anywhere in this phase reaches
    // the stop net with the time this stop began; its timeout updates it below.
    this.core.claims.take(name, 'stopping', claim, {
      startedAt: preparation.startedAt,
      gracefulTimedOut: false,
    });
    if (stopContext) {
      stopContext.claimed = true;
    }
    this.core.unexpectedStops.clearUnexpectedStopHandler(component, 'stop');
    this.core.logger.entity(name).info('Graceful shutdown started');
    this.core.lifecycleEvents.componentStopping(name);

    return undefined;
  }

  /**
   * The graceful deadline, as a promise that only rejects: its timer records the
   * timeout on the run, aborts `stop()`'s signal, hands the stop's late outcome to the
   * run's observer, and rejects a macrotask later.
   */
  private armGracefulDeadline(
    run: GracefulStopRun,
    stopPromise: Promise<unknown>,
    delayMS: number,
  ): Promise<never> {
    const { name, preparation, stopAttemptToken, outcomeObserver, stopAbort } =
      run;
    const { timeoutMS } = preparation;

    return new Promise<never>((_, reject) => {
      run.timeoutHandle = setTimeout(() => {
        run.gracefulTimeoutError = new ComponentStopTimeoutError({
          componentName: name,
          timeoutMS,
        });
        // Listeners that release `stop()` win the race below: the timeout's
        // rejection waits a macrotask (see `rejectAfterAbort()`).
        abortHookSignal(stopAbort, run.gracefulTimeoutError, name, 'stop');

        // Attached ahead of both the observer below and the `catch`, so each
        // reads the link as decided once: the error's members are the caller's.
        const deadlineReason = run.gracefulTimeoutError;
        observeRejection(stopPromise, (error: unknown) => {
          run.didRejectForDeadline = isLinkedToAbort(error, deadlineReason);
        });

        // Detect if stop() eventually resolves after the timeout so the stall
        // can be cleared automatically without a manual retry. From here on
        // this observer owns rejection reporting, even if an abort listener makes
        // stop() reject before the deferred deadline wins the foreground race.
        outcomeObserver.observe(
          stopPromise,
          'Component stop failed after deadline fired',
          {
            // Labelled as the result records it: a rejection unrelated to the
            // abort that beat the deferred deadline is the graceful phase's own
            // failure (`error`), not one after a timeout.
            getReport: () => ({
              message:
                run.didDeadlineReject || run.didRejectForDeadline
                  ? 'Component stop failed after deadline fired'
                  : 'Graceful shutdown threw error: {{error.message}}',
              level: 'warn',
            }),
            onResolved: () => {
              preparation.lateResolution = stopAttemptToken;
              this.handleLateStopResolution(name, stopAttemptToken, 'graceful');
            },
          },
        );
        run.timeoutHandle = this.rejectAfterAbort((timeoutError) => {
          run.didDeadlineReject = true;
          reject(timeoutError);
        }, run.gracefulTimeoutError);
      }, delayMS);
    });
  }

  /** Record a graceful stop that succeeded, and answer it. */
  private completeGracefulStop(run: GracefulStopRun): ComponentOperationResult {
    const { name } = run;

    return this.core.dispatcher.withTransition(() => {
      // Update state - graceful succeeded
      this.markComponentStopped(name);
      run.didMarkStopped = true;

      this.core.logger.entity(name).success('Component stopped gracefully');
      this.core.lifecycleEvents.componentStopped(
        name,
        this.readStatusOfStopped(name),
      );

      // Read again, after the event's listeners: the result reports the state they
      // left, and omits `status` when that read fails.
      return this.successfulStopResult(name);
    });
  }

  /**
   * Answer a graceful phase that failed before `stop()` resolved: its deadline, or the
   * stop's own failure.
   */
  private gracefulFailureResult(
    run: GracefulStopRun,
    error: unknown,
  ): ComponentOperationResult {
    const { name, claim, preparation, outcomeObserver } = run;
    const { timeoutMS, startedAt } = preparation;

    // A timeout: the deadline's own rejection, or a stop that rejected because that
    // deadline aborted its signal. Either way answered with the deadline's error - the
    // one the signal was aborted with; the stop's own rejection is the observer's to
    // report.
    const timeoutError =
      run.gracefulTimeoutError !== undefined &&
      (error === run.gracefulTimeoutError || run.didRejectForDeadline)
        ? run.gracefulTimeoutError
        : undefined;
    const err = timeoutError ?? toError(error);

    // Store error
    this.core.state.componentErrors.set(name, err);

    if (timeoutError !== undefined) {
      // Recorded for the stop net before anything below runs caller code - the log's
      // sinks, the event's listeners, an overridden `getComponentStatus()`. Recorded
      // only once escalation began, a throw building this result reached the net
      // with no stop on the claim, and the timeout was stalled as an `error`.
      this.core.claims.recordStop(name, claim, {
        startedAt,
        gracefulTimedOut: true,
      });
      this.core.logger
        .entity(name)
        .warn(LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT);
      this.core.lifecycleEvents.componentStopTimeout(name, err, {
        timeoutMS,
        reason: LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT,
      });

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT,
        code: 'component_shutdown_timeout',
        error: err,
        status: this.core.manager.getComponentStatus(name),
      };
    } else {
      // Keep the failure result even when the timeout observer owns its log.
      // Otherwise a rejection caused by an abort listener is reported by both paths.
      outcomeObserver.reportForeground(
        err,
        'Graceful shutdown threw error: {{error.message}}',
      );

      return {
        success: false,
        componentName: name,
        // Guarded: this runs inside the `catch`, and `toError` returns a
        // brand-claiming value unchanged, so a `message` accessor that throws
        // here escapes as a rejection instead of this failure result.
        reason: describeError(err),
        code: 'error',
        error: err,
        status: this.core.manager.getComponentStatus(name),
      };
    }
  }

  /**
   * Capture the force handler and its budget together before any stop phase runs.
   * Immediate and stalled-retry force attempts prepare themselves at their own entry.
   */
  private prepareForceShutdown(
    name: string,
    component: BaseComponent,
  ): ForceShutdownPreparation {
    const onShutdownForce: unknown = Reflect.get(component, 'onShutdownForce');
    const hasForceHandler = typeof onShutdownForce === 'function';
    const timeoutMS = hasForceHandler
      ? toOperationTimerDelayMS(
          component.shutdownForceTimeoutMS,
          `${name}.shutdownForceTimeoutMS`,
        )
      : 0;
    return { onShutdownForce, timeoutMS };
  }

  /**
   * Phase 3: Force shutdown
   * Calls onShutdownForce() with timeout, or marks as stalled if not implemented
   *
   * Claims the component (`claimForceStop()`), stalls one with no handler to run
   * (`stallWithoutForceHandler()`), and otherwise runs one `ForceStopRun`:
   * `onShutdownForce()` raced against its deadline (`armForceDeadline()`) and against
   * another path stopping the component, then answered as superseded
   * (`answerSupersededForce()`), recorded (`completeForceStop()`), or stalled
   * (`stallFailedForce()`). Every step is synchronous; the race is the one thing
   * awaited, here, directly.
   */
  private async shutdownComponentForce(
    name: string,
    component: BaseComponent,
    context: ForceStopContext,
    claim: symbol,
    preparation?: ForceShutdownPreparation,
    stopContext?: IndividualStopContext,
  ): Promise<ComponentOperationResult> {
    const { onShutdownForce, timeoutMS } =
      preparation ?? this.prepareForceShutdown(name, component);
    const hasForceHandler = typeof onShutdownForce === 'function';

    const claimed = this.claimForceStop(
      name,
      component,
      context,
      claim,
      hasForceHandler,
      stopContext,
    );
    if ('success' in claimed) {
      return claimed;
    }

    // If component doesn't implement onShutdownForce, mark as stalled immediately
    if (!hasForceHandler) {
      return this.stallWithoutForceHandler(name, context);
    }

    const waiter = this.createPendingForceStopWaiter(name);
    const outcomeObserver = this.createStopPhaseObserver(name);
    // One controller per force attempt - an escalation, a `forceImmediate` stop, or a
    // stalled retry - its signal handed to `onShutdownForce()`. Aborted where the manager
    // no longer needs that still-pending call: at this attempt's force deadline - the
    // timer below - or when another path stopped the component first and ended the phase
    // (see the superseded return below). Never because the hook itself settled.
    const forceAbort = createHookAbortController(name, 'force');
    const run = new ForceStopRun(
      name,
      component,
      claim,
      context,
      timeoutMS,
      claimed.forceAttemptToken,
      waiter,
      outcomeObserver,
      forceAbort,
    );

    try {
      // The value read and checked above, not a second read. A synchronous throw races
      // a graceful completion it caused exactly as the same rejection returned would.
      let forceReturn: unknown;
      try {
        forceReturn = Reflect.apply(
          onShutdownForce as (signal: AbortSignal) => unknown,
          component,
          [forceAbort.signal],
        );
      } catch (hookError) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        forceReturn = Promise.reject(hookError);
      }
      // Adopted, for the reason `startComponentAttempt()` adopts `start()`'s.
      const forcePromise = adoptPromise(forceReturn);
      // Attached before the races below, so it runs before their continuation does.
      const markForceHookSettled = (): void => {
        run.didForceHookSettle = true;
      };
      void forcePromise.then(markForceHookSettled, markForceHookSettled);

      // Both races attach rejection handlers in this turn, including when the
      // timeout is disabled or graceful completion wins. No separate no-op catch
      // is needed; the outcome observer below adds the abandoned hook's report.
      const delayMS = optionalValidatedTimerDelayMS(timeoutMS);
      if (delayMS !== undefined) {
        const timeoutPromise = this.armForceDeadline(
          run,
          forcePromise,
          delayMS,
        );

        await Promise.race([forcePromise, timeoutPromise, waiter.promise]);
      } else {
        await Promise.race([forcePromise, waiter.promise]);
      }
      run.didForceResolve = true;

      if (this.isForceAttemptSuperseded(run)) {
        return this.answerSupersededForce(run, forcePromise);
      }

      return this.completeForceStop(run);
    } catch (error) {
      // The component did stop; answered as the stop it was, so a bulk pass does not
      // halt on a component it stopped.
      if (run.didMarkStopped) {
        reportCallbackError('lifecycle-manager component stop', error);
        return { success: true, componentName: name };
      }
      // Left to the stop net, which answers `operation_crashed`.
      if (run.didForceResolve) {
        throw error;
      }
      if (this.isForceAttemptSuperseded(run)) {
        run.forceOutcome = 'abandoned';
        // A real force rejection can race graceful completion, but this attempt's
        // deadline is not a hook failure. Once the deadline observer is installed,
        // it alone reports any real late rejection, including a same-turn rejection.
        if (
          run.forceTimeoutError === undefined ||
          error !== run.forceTimeoutError
        ) {
          outcomeObserver.reportForeground(error, ABANDONED_FORCE_MESSAGE);
        }
        return this.successfulStopResult(name);
      }

      return this.stallFailedForce(run, error);
    } finally {
      waiter.cleanup();
      if (run.timeoutHandle) {
        clearTimeout(run.timeoutHandle);
      }
    }
  }

  /**
   * The force phase's refusals and its claim: a refusal, the answer of a stalled retry
   * with no handler to retry, or - once this attempt holds the component as
   * `force-stopping` and has announced it - the attempt's token.
   */
  private claimForceStop(
    name: string,
    component: BaseComponent,
    context: ForceStopContext,
    claim: symbol,
    hasForceHandler: boolean,
    stopContext: IndividualStopContext | undefined,
  ): ComponentOperationResult | { forceAttemptToken: string | undefined } {
    // An individual attempt must respect bulk work started by prepared getters.
    // An already claimed graceful stop still owns its escalation during bulk work.
    if (stopContext && !this.core.claims.owns(name, claim)) {
      const refusal = this.checkIndividualStopClaim(name, stopContext);
      if (refusal) {
        return refusal;
      }
    }

    // Hook and timeout getters can synchronously start another stop, restart a
    // stalled component, or unregister and replace it. Recheck after all reads and
    // before changing either ownership or the stop generation. In particular, a
    // refused outer attempt must not orphan a nested attempt's late completion.
    const recheck = this.checkStopPreconditions(name, component, {
      claim,
      isStalledRetry: context.isStalledRetry === true,
    });
    if ('success' in recheck) {
      return recheck;
    }

    // A stalled retry without a handler attempts nothing new, so the stall it found
    // stands as recorded: no claim, no force-start notification that nothing would
    // end, and no second `component:stalled`. It answers as the stop that recorded it.
    const priorStall = context.isStalledRetry
      ? this.core.state.stalledComponents.get(name)
      : undefined;
    if (!hasForceHandler && priorStall) {
      this.core.logger
        .entity(name)
        .warn('Stalled component has no force handler to retry', {
          params: { phase: priorStall.phase, reason: priorStall.reason },
        });
      return this.stalledStopResult(name, priorStall);
    }
    if (priorStall) {
      this.core.logger
        .entity(name)
        .warn('Retrying stalled component shutdown (force phase)');
    }

    this.core.claims.take(name, 'force-stopping', claim, {
      startedAt: context.startedAt,
      gracefulTimedOut: context.gracefulTimedOut,
    });
    if (stopContext) {
      stopContext.claimed = true;
    }
    // A fresh force-immediate stop or stalled retry needs a token. Graceful
    // escalation keeps its token.
    const forceAttemptToken = !context.gracefulPhaseRan
      ? this.issueStopAttemptToken(name, context.isStalledRetry === true)
      : this.core.state.componentStopAttemptTokens.get(name);

    // The internal claim is not a force-start notification. If bookkeeping is
    // broken, the stop safety net records this attempt as stalled and releases its
    // claim; a stall describes unconfirmed cleanup, not proof that a hook ran.
    // Validate before publishing a force start or invoking any caller code.
    // A stop without a handler observes no promise and needs no token.
    if (hasForceHandler && forceAttemptToken === undefined) {
      throw new Error('Force stop attempt is missing its stop token');
    }

    // Claim before calling this overridable hook, just as in the graceful phase.
    // Property-read failures above still leave the unexpected-stop handler intact.
    this.core.unexpectedStops.clearUnexpectedStopHandler(
      component,
      'force stop',
    );
    // Describes this attempt: a stalled retry runs no graceful phase, so none timed out
    // here, even when the stop it continues timed out gracefully.
    const forceStartContext = {
      gracefulPhaseRan: context.gracefulPhaseRan,
      gracefulTimedOut: context.gracefulPhaseRan && context.gracefulTimedOut,
    };
    this.core.logger
      .entity(name)
      .info('Force shutdown started', { params: { ...forceStartContext } });

    this.core.lifecycleEvents.componentShutdownForce({
      name,
      context: forceStartContext,
    });

    return { forceAttemptToken };
  }

  /** Stall a component whose force phase has no handler to run, and answer it. */
  private stallWithoutForceHandler(
    name: string,
    context: ForceStopContext,
  ): ComponentOperationResult {
    // After a graceful phase, that phase is what failed: there was nothing to escalate
    // to. A direct `forceImmediate` stop ran no graceful phase - a stalled retry without
    // a handler returned above - so what failed is the force phase it asked for, which
    // had no handler to run; the stall says so rather than blame a graceful phase.
    const isForceImmediate = !context.gracefulPhaseRan;
    const stallInfo = isForceImmediate
      ? this.stopStallInfo(
          name,
          'force',
          context,
          new Error(
            `Component "${name}" has no onShutdownForce() handler for a forceImmediate stop`,
          ),
        )
      : this.stopStallInfo(name, 'graceful', context, context.gracefulError);

    this.markComponentStalled(name, stallInfo, {
      error: isForceImmediate ? stallInfo.error : undefined,
      gracefulTimedOut: context.gracefulTimedOut,
    });

    this.core.logger
      .entity(name)
      .error(
        isForceImmediate
          ? 'Component stalled - no force handler for a forceImmediate stop'
          : 'Component stalled - graceful shutdown failed',
        {
          params: {
            reason: stallInfo.reason,
            hasForceHandler: false,
          },
        },
      );

    this.core.lifecycleEvents.componentStalled(name, stallInfo, {
      reason: stallInfo.reason,
      code:
        stallInfo.reason === 'timeout' ? 'component_shutdown_timeout' : 'error',
    });

    // Answers with the original graceful phase error, if it ran
    return this.stalledStopResult(name, stallInfo);
  }

  /**
   * The force deadline, as a promise that only rejects: its timer records the timeout
   * on the run, aborts `onShutdownForce()`'s signal, hands the hook's late outcome to the
   * run's observer, and rejects a macrotask later.
   */
  private armForceDeadline(
    run: ForceStopRun,
    forcePromise: Promise<unknown>,
    delayMS: number,
  ): Promise<never> {
    const { name, timeoutMS, forceAttemptToken, outcomeObserver, forceAbort } =
      run;

    return new Promise<never>((_, reject) => {
      run.timeoutHandle = setTimeout(() => {
        run.forceTimeoutError = new ComponentForceTimeoutError({
          componentName: name,
          timeoutMS,
        });
        abortHookSignal(
          forceAbort,
          run.forceTimeoutError,
          name,
          'onShutdownForce',
        );

        // Ahead of the observer below and the `catch`, as in the graceful phase.
        const deadlineReason = run.forceTimeoutError;
        observeRejection(forcePromise, (error: unknown) => {
          run.didRejectForDeadline = isLinkedToAbort(error, deadlineReason);
        });

        // Detect if onShutdownForce() eventually resolves after the timeout
        // so the stall can be cleared automatically, same as stop().
        outcomeObserver.observe(
          forcePromise,
          'Force shutdown failed after deadline fired',
          {
            getReport: () =>
              run.forceOutcome === 'abandoned' ||
              (run.forceOutcome === 'pending' &&
                this.isForceAttemptSuperseded(run))
                ? { message: ABANDONED_FORCE_MESSAGE, level: 'warn' }
                : {
                    // Labelled as the result records it: a rejection unrelated
                    // to the abort that beat the deferred deadline is the stall's
                    // own failure, not one after a timeout.
                    message:
                      run.didDeadlineReject || run.didRejectForDeadline
                        ? 'Force shutdown failed after deadline fired'
                        : 'Force shutdown failed - stalled: {{error.message}}',
                    level: 'error',
                  },
            onResolved: () =>
              this.handleLateStopResolution(
                name,
                forceAttemptToken as string,
                'force',
              ),
          },
        );
        run.timeoutHandle = this.rejectAfterAbort((timeoutError) => {
          run.didDeadlineReject = true;
          reject(timeoutError);
        }, run.forceTimeoutError);
      }, delayMS);
    });
  }

  /**
   * Answer a force race another path won by stopping the component: the stop happened,
   * so it succeeds, and a hook still pending hears through its signal that its work is
   * no longer needed.
   */
  private answerSupersededForce(
    run: ForceStopRun,
    forcePromise: Promise<unknown>,
  ): ComponentOperationResult {
    const { name, outcomeObserver, forceAbort } = run;

    run.forceOutcome = 'abandoned';
    // Graceful completion won. Report abandoned cleanup failures without
    // changing this or a subsequent run's state.
    // The phase ended before its deadline with `onShutdownForce()` still pending:
    // the manager no longer needs that call's work, so it hears so through its
    // signal below, as it would at the deadline. A deadline that fired already
    // aborted it.
    const supersededReason =
      !run.didForceHookSettle && run.forceTimeoutError === undefined
        ? new ForceShutdownSupersededError({ componentName: name })
        : undefined;
    // A fired deadline already installed the late-outcome reporter. Keeping
    // both would report the same subsequent hook rejection twice. A rejection
    // linked to the abort below is the hook honoring it, not a failure.
    outcomeObserver.observe(
      supersededReason === undefined
        ? forcePromise
        : forcePromise.catch((error: unknown) => {
            if (!isLinkedToAbort(error, supersededReason)) {
              throw error;
            }
          }),
      ABANDONED_FORCE_MESSAGE,
    );
    try {
      return this.successfulStopResult(name);
    } finally {
      // Snapshot first because abort listeners run caller code, but always abort
      // the abandoned force work even if building or reporting that snapshot fails.
      if (supersededReason !== undefined) {
        abortHookSignal(forceAbort, supersededReason, name, 'onShutdownForce');
      }
    }
  }

  /** Record a force stop that succeeded, and answer it. */
  private completeForceStop(run: ForceStopRun): ComponentOperationResult {
    const { name } = run;

    return this.core.dispatcher.withTransition(() => {
      // A stalled retry clears its stall here; announce that as the late paths do.
      const clearedStall = this.core.state.stalledComponents.get(name);

      // Update state - force succeeded
      this.markComponentStopped(name);
      run.didMarkStopped = true;

      this.core.logger.entity(name).success('Component force stopped');
      this.core.lifecycleEvents.componentShutdownForceCompleted(name);
      if (clearedStall) {
        this.core.lifecycleEvents.componentStalledResolved(
          name,
          clearedStall,
          Date.now() - clearedStall.stalledAt,
        );
      }
      this.core.lifecycleEvents.componentStopped(
        name,
        this.readStatusOfStopped(name),
      );

      // Read again, after the event's listeners: the result reports the state they
      // left, and omits `status` when that read fails.
      return this.successfulStopResult(name);
    });
  }

  /**
   * Stall a component whose force phase failed - its deadline, or the hook's own
   * failure - and answer it.
   */
  private stallFailedForce(
    run: ForceStopRun,
    error: unknown,
  ): ComponentOperationResult {
    const { name, context, timeoutMS, outcomeObserver } = run;

    run.forceOutcome = 'failed';
    // Determine if timeout or error - by identity, not by message: an
    // `onShutdownForce()` that rejected with the same text is still an error. One
    // that rejected because the deadline aborted its signal is that timeout, answered
    // with the deadline's error as in the graceful phase.
    const timeoutError =
      run.forceTimeoutError !== undefined &&
      (error === run.forceTimeoutError || run.didRejectForDeadline)
        ? run.forceTimeoutError
        : undefined;
    const isTimeout = timeoutError !== undefined;
    const err = timeoutError ?? toError(error);

    return this.core.dispatcher.withTransition<ComponentOperationResult>(() => {
      // Mark as stalled - force phase failed
      const stallInfo = this.stopStallInfo(
        name,
        'force',
        context,
        err,
        isTimeout,
      );
      this.markComponentStalled(name, stallInfo, {
        error: err,
        gracefulTimedOut: context.gracefulTimedOut,
      });

      if (isTimeout) {
        this.core.logger
          .entity(name)
          .error('Force shutdown timed out - stalled', {
            params: { timeoutMS },
          });
        this.core.lifecycleEvents.componentShutdownForceTimeout(
          name,
          timeoutMS,
        );
      } else {
        outcomeObserver.reportForeground(
          err,
          'Force shutdown failed - stalled: {{error.message}}',
          'error',
        );
      }

      this.core.lifecycleEvents.componentStalled(name, stallInfo, {
        reason: stallInfo.reason,
        code: isTimeout ? 'component_shutdown_timeout' : 'error',
      });

      return this.stalledStopResult(name, stallInfo);
    });
  }

  /**
   * Whether a force attempt resuming after its `await` no longer owns the component.
   *
   * The graceful stop it was escalating from finished late, and something claimed the
   * component since - a `component:stopped` listener that started it again, say - or it
   * is no longer the registered instance. The stop did happen, so the attempt answers
   * as one whose graceful completion won, without writing its outcome over that newer
   * state: marking a running component stopped, or a replacement stalled.
   */
  private isForceAttemptSuperseded(run: ForceStopRun): boolean {
    const { name, component, claim } = run;

    // Stopped by another path: the waiter tells, since only `markComponentStopped()`
    // releases it - and a late-start cleanup's stop leaves its own state there rather
    // than `stopped`.
    return (
      !this.core.claims.owns(name, claim) ||
      this.core.registry.getComponent(name) !== component ||
      run.waiter.hasResolved() ||
      (this.core.state.componentStates.get(name) === 'stopped' &&
        !this.core.state.runningComponents.has(name))
    );
  }

  /**
   * Reject a stop's timeout one macrotask after its signal aborted, not at once.
   *
   * An abort listener that releases what `stop()` or `onShutdownForce()` awaits settles
   * it synchronously, but the settlement reaches the race through several promise hops -
   * the component's own `async` function, then `adoptPromise()` - while a rejection made
   * in the same turn gets there in one. The stop finished, yet the timeout won, and the
   * component was stalled or sent on to a force phase it no longer needed. Past a
   * macrotask every such hop has run, so a released stop wins the race as the success it
   * is, however many hops it took. This is the one mechanism for that race.
   *
   * Returns the timer, which the caller keeps as its timeout handle so its `finally`
   * clears it once the stop has settled either way.
   *
   * Stops only. A start's timeout still rejects at once: its signal exists to abort the
   * start, and a `start()` it released is a timed-out start, not a successful one.
   */
  private rejectAfterAbort(
    reject: (error: Error) => void,
    error: Error,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      reject(error);
    }, 0);
  }

  private createStopPhaseObserver(
    name: string,
  ): ReturnType<typeof createStopPhaseObserver> {
    return createStopPhaseObserver((error, message, level) => {
      this.core.logger.entity(name)[level](message, {
        params: { error: toError(error) },
      });
    });
  }

  private createPendingForceStopWaiter(name: string): PendingForceStopWaiter {
    let isResolved = false;
    let waiters = this.core.state.pendingForceStopWaiters.get(name);

    if (!waiters) {
      waiters = new Set();
      this.core.state.pendingForceStopWaiters.set(name, waiters);
    }

    let resolveWaiter!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWaiter = () => {
        if (isResolved) {
          return;
        }

        isResolved = true;
        resolve();
      };
    });

    waiters.add(resolveWaiter);

    return {
      promise,
      hasResolved: () => isResolved,
      cleanup: () => {
        const pending = this.core.state.pendingForceStopWaiters.get(name);
        if (!pending) {
          return;
        }

        pending.delete(resolveWaiter);
        if (pending.size === 0) {
          this.core.state.pendingForceStopWaiters.delete(name);
        }
      },
    };
  }

  private resolvePendingForceStopWaiters(name: string): void {
    const waiters = this.core.state.pendingForceStopWaiters.get(name);
    if (!waiters || waiters.size === 0) {
      return;
    }

    this.core.state.pendingForceStopWaiters.delete(name);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * Called when a stop promise eventually resolves after its timeout path already fired.
   *
   * Usually this means a previously stalled component's original stop() or
   * onShutdownForce() promise finally resolved, so the manager can clear the
   * stall and transition the component to stopped without a manual retry.
   *
   * There is one extra overlap case for graceful stop(): stop() can resolve
   * after the graceful timeout but before onShutdownForce() itself times out.
   * In that window no stall entry exists yet, but the component still finished
   * stopping cleanly, so we finalize it here and let the later force-timeout
   * path observe the already-stopped state and no-op. This overlap fix is
   * scoped to the same stop token and will not cross a later retry attempt.
   *
   * Two guards prevent stale floating promises from incorrectly clearing state:
   *
   * 1. token guard — if a newer stop attempt has started since this promise was
   *    launched, its token won't match and we bail out immediately. A stalled
   *    component's force retry is the exception: it continues the stop that
   *    stalled, so a late resolution of any earlier attempt of that stop still
   *    clears the stall (see `stalledStopEarlierTokens`).
   *
   * 2. state/stall guard — if the component was unregistered, restarted, or
   *    already cleared by another path, there will be neither a matching stall
   *    entry nor the post-graceful-race overlap state, so we bail out.
   */
  private handleLateStopResolution(
    name: string,
    token: string,
    source: 'graceful' | 'force',
    hasGracefulRaceFinished = false,
  ): boolean {
    return this.core.dispatcher.withTransition(() => {
      // Guard 1: bail if a newer stop attempt has superseded this one. The newer
      // attempt owns any stop/stall state and must manage its own late resolution -
      // unless it is a force retry of the stall this attempt left: that continues the
      // same stop, and this attempt's hook finishing late finishes it.
      const isCurrentAttempt =
        this.core.state.componentStopAttemptTokens.get(name) === token;
      const isEarlierAttemptOfStalledStop =
        !isCurrentAttempt &&
        this.core.state.stalledStopEarlierTokens.get(name)?.has(token) === true;
      if (!isCurrentAttempt && !isEarlierAttemptOfStalledStop) {
        return false;
      }

      const currentState = this.core.state.componentStates.get(name);
      const stallInfo = this.core.state.stalledComponents.get(name);

      // The stalled stop's force retry is still running when an earlier attempt's hook
      // finishes: the component did stop, so it is finalized here, as a graceful stop
      // that finishes during its own escalation is. Marking it stopped releases the
      // retry's force race, which then finds it stopped and ends as superseded.
      const isCompletedDuringStallRetry =
        isEarlierAttemptOfStalledStop &&
        stallInfo !== undefined &&
        currentState === 'force-stopping';

      // Once the graceful race has lost, a successful stop can be finalized before
      // or during force escalation, even without a stall record. Only the caller
      // that consumed the graceful result can admit the pre-force stopping state.
      const isCompletedAfterGracefulRace =
        source === 'graceful' &&
        !stallInfo &&
        (currentState === 'force-stopping' ||
          (hasGracefulRaceFinished && currentState === 'stopping'));

      // Still in flight for this very attempt - it settled as its timeout fired. The
      // attempt decides how it ended: its timeout rejects a macrotask after the abort
      // (`rejectAfterAbort()`), so a stop that settled then wins the race. Ahead of
      // Guard 2, which would take a stalled component's force retry - `force-stopping`,
      // with the old stall entry still in place - for a newer attempt and discard the
      // stall under it.
      if (
        !isCompletedAfterGracefulRace &&
        !isCompletedDuringStallRetry &&
        (currentState === 'stopping' || currentState === 'force-stopping')
      ) {
        return false;
      }

      // Guard 2: once the component is no longer in the stalled state because a
      // newer lifecycle attempt changed its state, the old stop promise no longer
      // owns the component state. Clear the stale stall bookkeeping, but do not
      // emit stopped or overwrite the newer state. It may have been the last stall
      // holding process signals attached, so the last-stop detach check still runs.
      // The stall did end - its own stop finished - so it is announced as any late
      // resolution is: otherwise a forced start that then fails leaves a component
      // whose `component:stalled` never ended.
      if (
        stallInfo &&
        currentState !== 'stalled' &&
        !isCompletedDuringStallRetry
      ) {
        this.core.state.stalledComponents.delete(name);
        this.core.registry.updateStartedFlag();
        this.core.lifecycleEvents.componentStalledResolved(
          name,
          stallInfo,
          Date.now() - stallInfo.stalledAt,
        );
        this.core.signals.detachSignalsAfterLastStop();
        return false;
      }

      // Guard 3: bail if neither a stall entry nor the post-graceful-race overlap
      // exists. This covers unregistered, restarted, or already-cleared paths.
      if (!stallInfo && !isCompletedAfterGracefulRace) {
        return false;
      }

      const stalledDurationMS = stallInfo
        ? Date.now() - stallInfo.stalledAt
        : undefined;

      this.markComponentStopped(name);

      this.core.logger.entity(name).info(
        stallInfo
          ? 'Stalled component completed stop late, stall cleared'
          : hasGracefulRaceFinished
            ? 'Graceful stop completed before force phase started'
            : 'Graceful stop completed after force phase started',
        // A stall cleared within the same millisecond lasted 0ms, which is still a
        // duration to report.
        stalledDurationMS !== undefined
          ? { params: { stalledDurationMS } }
          : undefined,
      );

      // If the force promise itself completed late, preserve the same "force
      // finished" signal that a normal in-time force shutdown would have emitted.
      if (source === 'force') {
        this.core.lifecycleEvents.componentShutdownForceCompleted(name);
      }

      if (stallInfo && stalledDurationMS !== undefined) {
        // Late resolution is modeled as: stalled -> stall cleared -> stopped.
        // Emit both events so observers can distinguish "the stall ended" from
        // "the component is now fully stopped".
        this.core.lifecycleEvents.componentStalledResolved(
          name,
          stallInfo,
          stalledDurationMS,
        );
      }

      this.core.lifecycleEvents.componentStopped(
        name,
        this.readStatusOfStopped(name),
      );
      return true;
    });
  }

  /**
   * The bookkeeping every path that finds a component stopped shares: a graceful or
   * force stop that succeeded, and a stalled one that finished late. The caller logs and
   * emits.
   */
  private markComponentStopped(name: string): void {
    return this.core.dispatcher.withTransition(() => {
      // A late-start cleanup's stop leaves the state the cleanup recorded - usually
      // `starting-timed-out` with the timeout error - not `stopped`: the start that
      // brought the component up timed out, and the status says so.
      const lateCleanup = this.core.state.lateStartCleanupOutcomes.get(name);
      const isLateStartCleanupStop =
        lateCleanup !== undefined &&
        this.core.state.componentStartAttemptTokens.get(name) ===
          lateCleanup.token;
      this.core.state.componentStates.set(
        name,
        isLateStartCleanupStop ? lateCleanup.state : 'stopped',
      );
      this.core.state.runningComponents.delete(name);
      this.core.state.stalledComponents.delete(name);
      // The stop is over, so no earlier attempt of it is left to finish it.
      this.core.state.stalledStopEarlierTokens.delete(name);
      // Clear the stall/timeout error so lastError reflects a clean stop.
      this.core.state.componentErrors.set(
        name,
        isLateStartCleanupStop ? lateCleanup.error : null,
      );
      this.core.state.lateStartCleanupOutcomes.delete(name);
      this.core.state.componentUnexpectedStopHadError.delete(name);
      this.core.registry.updateStartedFlag();
      this.resolvePendingForceStopWaiters(name);

      this.core.signals.detachSignalsAfterLastStop();

      this.core.registry.stampTimestamp(name, 'stoppedAt');
    });
  }

  /**
   * Record a stall: the bookkeeping every path that stalls a component shares. The
   * caller emits `component:stalled` and anything particular to its path.
   *
   * A stop that settles after the stall is recorded clears it through
   * `handleLateStopResolution()`; one released by its own abort listener never gets here,
   * since its timeout rejects a macrotask later (`rejectAfterAbort()`).
   */
  private markComponentStalled(
    name: string,
    stallInfo: ComponentStallInfo,
    options: { error?: Error; gracefulTimedOut: boolean; crashed?: boolean },
  ): void {
    const { error } = options;

    return this.core.dispatcher.withTransition(() => {
      this.core.state.stalledComponents.set(name, stallInfo);
      this.stallDetails.set(stallInfo, {
        gracefulTimedOut: options.gracefulTimedOut,
        crashed: options.crashed === true,
      });
      this.core.state.componentStates.set(name, 'stalled');
      this.core.state.runningComponents.delete(name);

      if (error !== undefined) {
        this.core.state.componentErrors.set(name, error);
      }

      this.core.registry.updateStartedFlag();
    });
  }

  /**
   * A confirmed stop remains successful even if its diagnostic status cannot be read.
   * Late graceful completion and superseded force attempts share this boundary.
   */
  private successfulStopResult(name: string): ComponentOperationResult {
    const result: ComponentOperationResult = {
      success: true,
      componentName: name,
    };
    const status = this.readStatusOfStopped(name);
    if (status !== undefined) {
      result.status = status;
    }
    return result;
  }

  /**
   * The stall record a stop leaves when `phase` fails. A graceful timeout is the reason
   * while the graceful phase is what stalled, and `'both'` once a force phase failed
   * after it; a force phase's own timeout is `'timeout'`.
   */
  private stopStallInfo(
    name: string,
    phase: 'graceful' | 'force',
    stop: StopAttempt,
    error: Error | undefined,
    didForceTimeOut = false,
  ): ComponentStallInfo {
    return {
      name,
      phase,
      reason: didForceTimeOut
        ? 'timeout'
        : stop.gracefulTimedOut
          ? phase === 'force'
            ? 'both'
            : 'timeout'
          : 'error',
      startedAt: stop.startedAt,
      stalledAt: Date.now(),
      error,
    };
  }

  /**
   * The result a stop that crashed answers with. The code is always `operation_crashed`,
   * even for a timeout validation error, since the crash is reported and the stop may
   * have changed state; the reason says when the graceful phase had
   * already timed out, and `status` carries the stall the crash left. Read guarded: the
   * crash may have come from reading state, and this runs where nothing above is left to
   * catch, so a status that cannot be read is left out.
   */
  private crashedStopResult(
    name: string,
    error: Error,
    stall: { gracefulTimedOut: boolean } | undefined,
  ): ComponentOperationResult {
    const result = crashedComponentResult(
      name,
      error,
      stall?.gracefulTimedOut === true
        ? `Stop failed unexpectedly after its graceful phase timed out: ${describeError(error)}`
        : `Stop failed unexpectedly: ${describeError(error)}`,
      // Every caller has reported this failure: a crash, even for a branded option
      // refusal - one the attempt met unclaimed is answered `invalid_options` before
      // it gets here - and even more so once it left a stall.
      'operation_crashed',
    );

    try {
      const status = this.core.manager.getComponentStatus(name);
      if (status !== undefined) {
        result.status = status;
      }
    } catch {
      // Left out, as `crashedComponentResult()` leaves it out everywhere else.
    }

    return result;
  }

  /**
   * The result a stop that stalled answers with, derived from its stall record so a
   * retry that attempts nothing answers exactly as the stop that recorded it did.
   */
  private stalledStopResult(
    name: string,
    stallInfo: ComponentStallInfo,
  ): ComponentOperationResult {
    const isForcePhase = stallInfo.phase === 'force';
    const didTimeOut = stallInfo.reason === 'timeout';
    const error = stallInfo.error;

    // The stop net recorded this stall after a crash, and answered with its crash result.
    const details = this.stallDetails.get(stallInfo);
    if (details?.crashed === true && error !== undefined) {
      return this.crashedStopResult(name, error, details);
    }

    return {
      success: false,
      componentName: name,
      // A graceful-phase timeout is worded as its `component:stop-timeout` event and log
      // line word it.
      reason: didTimeOut
        ? isForcePhase
          ? LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT
          : LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT
        : // Guarded: the stall error is a `toError` result, so its `message` can be
          // an accessor that throws.
          error !== undefined
          ? describeError(error)
          : isForcePhase
            ? 'Force shutdown failed'
            : 'Graceful shutdown failed',
      code: didTimeOut ? 'component_shutdown_timeout' : 'error',
      error,
      status: this.core.manager.getComponentStatus(name),
    };
  }

  /** Whether the stop that left `name` stalled had its graceful phase time out. */
  private didStallGracefulTimeOut(name: string): boolean {
    const stallInfo = this.core.state.stalledComponents.get(name);
    return (
      stallInfo !== undefined &&
      this.stallDetails.get(stallInfo)?.gracefulTimedOut === true
    );
  }
}
