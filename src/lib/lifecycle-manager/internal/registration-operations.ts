import { ulid } from 'ulid';
import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import { ComponentLifecycle } from '../component-lifecycle';
import {
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE,
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE_EXTERNAL,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
} from '../constants';
import { DependencyCycleError } from '../errors';
import type {
  BroadcastOptions,
  ComponentLifecycleRef,
  ComponentOperationResult,
  GetValueOptions,
  InsertComponentAtResult,
  InsertPosition,
  LifecycleInternalCallbacks,
  RegisterOptions,
  RegistrationFailureCode,
  RestartAllOptions,
  SendMessageOptions,
  StopAllOptions,
} from '../types';
import { type DependencyRead, tryReadDependencies } from './dependency-policy';
import type { ManagerCore } from './manager-core';
import {
  type ActiveBulkStartup,
  isStartUnfinished,
  type StartSettlement,
} from './manager-state';
import {
  snapshotRegisterOptions,
  snapshotStartOptions,
} from './operation-options';
import {
  invalidOperationOptionError,
  settleOperation,
} from './operation-policy';
import {
  type RegistrationProgress,
  committedRegistrationReport,
  defaultTargetFound,
  isInsertPosition,
  isManualPositionRespected,
  newRegistrationProgress,
  positionHasTarget,
  removedTimeoutHooksReason,
  reportedComponentName,
} from './registration-policy';
import { markComponentUnregistered } from './unregistration-operations';

/**
 * One registration call: what it was asked, what it has read of the caller's code, and
 * where its name sat before it. Created once the name has been read and validated, and
 * handed to every phase of `registerComponentInternal()`, which reads and updates it in
 * place. It runs no code of its own.
 */
class RegistrationAttempt {
  // What `readForRegistration()` read, each left at its default when a check that
  // needs no caller code - an invalid position, a shutdown - stopped the reads first.
  public shouldAutoStart = false;
  public isRegisteredWithAManager = false;
  // Why the component cannot be registered because it still defines a removed
  // timeout hook. Read first, as the component's own: a getter there is its code.
  public removedHooksReason: string | undefined;
  // Strict: a `getDependencies()` that throws, or reports an implausible length,
  // refuses the registration - once the checks ahead of it have passed. A non-string
  // entry does not - its own start fails on it - but is reported once the registration
  // commits: a refused one must not spend the report the next registration makes.
  public candidateRead: DependencyRead = { dependencies: [] };
  // Every registered component's list, and whether the reads settled. Its `reads` are
  // the dependency snapshot every check and refusal orders by.
  public registryRead: {
    reads: Map<BaseComponent, DependencyRead>;
    isSettled: boolean;
  } = { reads: new Map<BaseComponent, DependencyRead>(), isSettled: true };

  constructor(
    public readonly component: BaseComponent,
    public readonly componentName: string,
    public readonly position: InsertPosition,
    public readonly targetComponentName: string | undefined,
    public readonly isInsertAction: boolean,
    public readonly options: RegisterOptions | undefined,
    // What a committed registration has done so far, for a failure after the commit to
    // report rather than contradict: a caller told `autoStartAttempted: false` for an
    // auto-start that ran could start the component a second time. Whether it committed
    // is `progress.hasCommitted`: set by this registration's own commit, not inferred
    // from the registry, since a re-entrant registration of the same instance - from its
    // own `getDependencies()` - can put it there while this one goes on to fail before
    // committing anything.
    public readonly progress: RegistrationProgress,
    // Where the name sat before this call. Read again once the reads are done: they
    // can register the name.
    public registrationIndexBefore: number | null,
  ) {}

  /** What every refusal of this registration shares; see `refuseRegistration()`. */
  public refusal(): {
    progress: RegistrationProgress;
    componentName: string;
    registrationIndexBefore: number | null;
    position: InsertPosition;
    targetComponentName: string | undefined;
    isInsertAction: boolean;
    dependencySnapshot: ReadonlyMap<BaseComponent, DependencyRead>;
  } {
    return {
      progress: this.progress,
      componentName: this.componentName,
      registrationIndexBefore: this.registrationIndexBefore,
      position: this.position,
      targetComponentName: this.targetComponentName,
      isInsertAction: this.isInsertAction,
      dependencySnapshot: this.registryRead.reads,
    };
  }
}

/**
 * What `placeRegistration()` decided: refused, with the answer, or placed - the
 * registry's entries with the component inserted where it was asked to go, and the
 * component's own list, which a placed registration has read successfully.
 */
type RegistrationPlacement =
  | { readonly kind: 'refused'; readonly result: InsertComponentAtResult }
  | {
      readonly kind: 'placed';
      readonly nextComponents: BaseComponent[];
      readonly candidateRead: Extract<
        DependencyRead,
        { dependencies: string[] }
      >;
    };

/**
 * Registration: `registerComponent()` and `insertComponentAt()`'s bodies.
 *
 * A registration reads everything of the caller's code it needs first - its options,
 * the instance's own answers and every registered component's dependency list - then
 * decides synchronously, up to the commit: refusals, the reserved entry and the cycle
 * check. It commits provisionally, runs the component's own registration hooks while the
 * entry is invisible to startup, and rolls back if they fail or a bulk operation begins
 * meanwhile. A committed registration may then auto-start the component, or leave it to
 * the bulk startup or restart about to run. Every refusal and failure is announced once,
 * with `component:registration-rejected` or, for one that had committed,
 * `component:registered`.
 *
 * Unregistration is `UnregistrationOperations`'s. The registry's lookups and publication
 * are `core.registry`'s; the per-component handle a registration builds
 * (`ComponentLifecycle`) calls back into the manager through the callbacks made here.
 */
export class RegistrationOperations {
  constructor(private readonly core: ManagerCore) {}

  /**
   * `registerComponentInternal()` under the public-method safety net (see
   * {@link settleOperation}). Its own `catch` covers the registration body, but the name
   * and index reads ahead of it run the component's own getters.
   */
  public registerComponentSettled(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName: string | undefined,
    isInsertAction: boolean,
    options?: RegisterOptions,
  ): Promise<InsertComponentAtResult> {
    // Shared with the registration, so this net answers `registered` and the auto-start
    // fields as it would.
    const progress = newRegistrationProgress();

    return settleOperation(
      isInsertAction ? 'insertComponentAt' : 'registerComponent',
      () =>
        this.registerComponentInternal(
          component,
          position,
          targetComponentName,
          isInsertAction,
          options,
          progress,
        ),
      // Reached only for what fails before the registration's own `try` - in practice a
      // `getName()` that threw or answered a non-string: every later failure is answered
      // inside the registration by the same method, which cannot throw. Named from what `getName()` answered, never by asking again.
      (error, reason) =>
        this.answerRegistrationFailure({
          component,
          componentName: reportedComponentName(progress),
          error,
          // `settleOperation` has reported it.
          isErrorReported: true,
          reason,
          position,
          targetComponentName,
          isInsertAction,
          // Unknown: there is no name to look it up by.
          registrationIndexBefore: null,
          progress,
        }),
    );
  }

  /**
   * `registerComponent()` and `insertComponentAt()`'s body. Reads and validates the
   * name, then runs the phases in order over one `RegistrationAttempt`: the reads of the
   * caller's code (`readForRegistration()`), the checks that refuse or place the
   * component (`placeRegistration()`), the provisional commit and the component's own
   * hooks (`commitRegistration()`), the commit's log line (`logCommittedRegistration()`),
   * the auto-start (`beginAutoStart()`), and the answer (`registeredResult()`). Every
   * phase is synchronous; an auto-start's start is the one thing awaited, here, directly.
   */
  private async registerComponentInternal(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName: string | undefined,
    isInsertAction: boolean,
    options: RegisterOptions | undefined,
    // Whether this call committed, and the auto-start it attempted or deferred, kept
    // where the safety net above it can read them. Required: a call that made its own
    // would leave the net reading one that never changes.
    progress: RegistrationProgress,
  ): Promise<InsertComponentAtResult> {
    const componentName: unknown = component.getName();
    progress.nameRead = { value: componentName };

    // The name is recorded here and trusted from then on - see `nameOf()` - so a
    // `getName()` that breaks its contract is refused now rather than recorded as a
    // name every later lookup would fall through. Thrown, and answered like a throwing
    // `getName()`: with `operation_crashed`.
    if (typeof componentName !== 'string') {
      throw new TypeError(
        `Component getName() must return a string, got ${typeof componentName}`,
      );
    }

    const attempt = new RegistrationAttempt(
      component,
      componentName,
      position,
      targetComponentName,
      isInsertAction,
      options,
      progress,
      this.core.registry.getComponentIndex(componentName),
    );

    try {
      this.readForRegistration(attempt);

      const placement = this.placeRegistration(attempt);
      if (placement.kind === 'refused') {
        return placement.result;
      }

      const interruptionCode = this.commitRegistration(
        attempt,
        placement.nextComponents,
      );
      if (interruptionCode !== undefined) {
        return this.refuseRegistration({
          ...attempt.refusal(),
          code: interruptionCode,
          message:
            interruptionCode === 'shutdown_in_progress'
              ? LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS
              : LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
          logLine: 'Cannot commit component registration during bulk operation',
        });
      }

      this.logCommittedRegistration(attempt, placement.candidateRead);

      const autoStart = this.beginAutoStart(attempt);
      if (autoStart !== undefined) {
        progress.startResult = await autoStart;
      }

      return this.registeredResult(attempt);
    } catch (error) {
      // Answered by the same guarded code the safety net above uses, which cannot throw:
      // the net is then reached only for a `getName()` that failed, before this `try`.
      return this.answerRegistrationFailure({
        component,
        componentName,
        error,
        isErrorReported: false,
        reason: undefined,
        position,
        targetComponentName,
        isInsertAction,
        registrationIndexBefore: attempt.registrationIndexBefore,
        progress,
      });
    }
  }

  /**
   * Everything of the caller's code a registration needs, read first - its options,
   * whether the instance says it is registered, its own dependency list, and every
   * registered component's list - so every check that decides the registration runs
   * after, synchronously, up to the commit. Those reads can register, unregister, start
   * a bulk startup or begin a shutdown re-entrantly; checks made before them committed
   * a second component under a taken name, inserted at a stale index, and trusted a
   * cycle check made against a registry that had since changed. Then the name's index
   * again, since the reads can register it.
   */
  private readForRegistration(attempt: RegistrationAttempt): void {
    const { component, componentName } = attempt;
    // The checks that need none of the caller's code come first: a registration they
    // refuse reads nothing - no component's `getDependencies()` during a shutdown that
    // may be tearing them down - and answers with its own code, not with whatever
    // the reads would have made of it. Asked again before each read, since any read
    // can begin a shutdown; the checks refuse once one has.
    const canRead = (): boolean =>
      isInsertPosition(attempt.position) &&
      !this.core.shutdownPass.isShuttingDown;
    if (canRead()) {
      attempt.shouldAutoStart = snapshotRegisterOptions(
        attempt.options,
      ).autoStart;
    }
    // Kept as reads, as a bulk startup keeps them: one snapshot type for ordering.
    const readRegistered = (registered: BaseComponent): DependencyRead =>
      this.core.componentMetadata.readDependenciesReported(
        registered,
        'registration',
      );

    if (canRead()) {
      attempt.removedHooksReason = removedTimeoutHooksReason(
        component,
        componentName,
      );
    }

    if (canRead()) {
      attempt.candidateRead = tryReadDependencies(component);
    }

    if (canRead()) {
      // Before the registry's lists, so a component it registers is read with the
      // rest, and after the candidate's own, which could register this instance
      // elsewhere with nothing else read to ask again after.
      attempt.isRegisteredWithAManager = component._isRegisteredWithManager();
    }

    // The registry's lists, and the instance's answer each time they settle, until
    // neither brings anything new: a list read can register this instance with
    // another manager, and asking about that can register components whose lists
    // are then unread. Either answer of the instance's counts.
    if (canRead()) {
      attempt.registryRead = this.core.registryReads.readRegistry(
        readRegistered,
        attempt.registryRead.reads,
        canRead,
        () => {
          attempt.isRegisteredWithAManager =
            component._isRegisteredWithManager() ||
            attempt.isRegisteredWithAManager;
        },
        () => this.core.state.componentEntries,
      );
    }

    attempt.registrationIndexBefore =
      this.core.registry.getComponentIndex(componentName);
  }

  /**
   * The checks that decide a registration, over what `readForRegistration()` read:
   * a registry that never settled, an invalid position, a shutdown, a removed timeout
   * hook, a dependency a running startup needs, a duplicate instance or name, a missing
   * target, and a dependency cycle. Runs none of the caller's code unless it refuses.
   * Answers the refusal, or the registry entries with the component in place.
   */
  private placeRegistration(
    attempt: RegistrationAttempt,
  ): RegistrationPlacement {
    const { component, componentName, position, targetComponentName } = attempt;
    const dependencySnapshot = attempt.registryRead.reads;

    // A registry that kept changing under the reads - each read registering another
    // component whose own list then had to be read - is refused as a broken contract,
    // the way a throwing `getName()` is. Reads cut short by a shutdown are not: the
    // shutdown check below refuses those.
    if (
      !attempt.registryRead.isSettled &&
      !this.core.shutdownPass.isShuttingDown
    ) {
      throw new Error(
        `The registry kept changing while "${componentName}" was being registered; registration refused`,
      );
    }

    // What every refusal below shares; see `refuseRegistration()`.
    const refusal = attempt.refusal();
    const refused = (
      result: InsertComponentAtResult,
    ): RegistrationPlacement => ({
      kind: 'refused',
      result,
    });

    if (!isInsertPosition(position)) {
      return refused(
        this.refuseRegistration({
          ...refusal,
          code: 'invalid_position',
          message: `Invalid insert position: "${String(position)}". Expected one of: start, end, before, after.`,
          logLine: 'Invalid insertion position',
          logParams: { position },
        }),
      );
    }

    // Block registration during shutdown
    if (this.core.shutdownPass.isShuttingDown) {
      return refused(
        this.refuseRegistration({
          ...refusal,
          code: 'shutdown_in_progress',
          message: LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
          logLine: 'Cannot register component during shutdown',
        }),
      );
    }

    // A component written for the timeout hooks the abort signals replaced. Refused
    // rather than registered with those hooks silently ignored - along with, for the
    // startup one, the late-start cleanup opt-out it implied.
    if (attempt.removedHooksReason !== undefined) {
      return refused(
        this.refuseRegistration({
          ...refusal,
          code: 'invalid_options',
          message: attempt.removedHooksReason,
          logLine: 'Component defines a removed timeout hook',
          error: invalidOperationOptionError(attempt.removedHooksReason),
        }),
      );
    }

    // Block registration during startup if this component would be a dependency
    // for any already-registered component (would break dependency ordering)
    if (
      this.core.startup.isRequiredDependencyDuringStartup(
        componentName,
        dependencySnapshot,
      )
    ) {
      return refused(
        this.refuseRegistration({
          ...refusal,
          code: 'startup_in_progress',
          message:
            LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
          logLine:
            'Cannot register component during startup - it is a required dependency for other components',
        }),
      );
    }

    // Check if component instance is already registered - here, by the instance's own
    // answer, or with this manager since that answer was read
    const isRegisteredHere = this.core.registry.isInstanceReserved(component);
    if (attempt.isRegisteredWithAManager || isRegisteredHere) {
      const message = isRegisteredHere
        ? LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE
        : LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE_EXTERNAL;

      return refused(
        this.refuseRegistration({
          ...refusal,
          code: 'duplicate_instance',
          message,
          logLine: isRegisteredHere
            ? 'Component instance already registered'
            : 'Component instance already registered with another lifecycle manager',
        }),
      );
    }

    // Check if component name is already registered
    if (this.core.registry.isNameReserved(componentName)) {
      return refused(
        this.refuseRegistration({
          ...refusal,
          code: 'duplicate_name',
          message: `Component "${componentName}" is already registered.`,
          logLine: 'Component with this name already registered',
        }),
      );
    }

    // Get the insertion index for the component
    const insertIndex = this.core.registry.getInsertIndex(
      position,
      targetComponentName,
    );
    if (insertIndex === null) {
      return refused(
        this.refuseRegistration({
          ...refusal,
          code: 'target_not_found',
          message: `Target component "${targetComponentName ?? ''}" not found in registry.`,
          logLine: 'Target component not found',
          logParams: { target: targetComponentName },
          target: targetComponentName,
          targetFound: false,
        }),
      );
    }

    // Compute dependency order *before* committing registration mutations.
    // This avoids leaving the registry/state maps inconsistent if a dependency
    // cycle is detected.
    const nextComponents = [
      ...this.core.state.componentEntries.slice(0, insertIndex),
      component,
      ...this.core.state.componentEntries.slice(insertIndex),
    ];

    const { candidateRead } = attempt;
    if (!('dependencies' in candidateRead)) {
      throw candidateRead.error;
    }

    // Only the cycle check: the order a committed registration reports is computed
    // after its hooks, over the registry they left (`recordCommittedReport()`).
    try {
      this.core.startupOrdering.getStartupOrderInternal(
        nextComponents,
        {
          component,
          name: componentName,
          dependencies: candidateRead.dependencies,
        },
        dependencySnapshot,
      );
    } catch (error) {
      if (error instanceof DependencyCycleError) {
        return refused(
          this.refuseRegistration({
            ...refusal,
            code: 'dependency_cycle',
            message: error.message,
            logLine: 'Registration rejected due to dependency cycle',
            logParams: { cycle: error.additionalInfo.cycle },
            cycle: error.additionalInfo.cycle,
            error,
            targetFound: positionHasTarget(position) ? true : undefined,
          }),
        );
      }
      throw error;
    }

    return { kind: 'placed', nextComponents, candidateRead };
  }

  /**
   * Commit the registration provisionally and run the component's own registration
   * hooks: the registry entry and every state map together, before the component's own
   * code runs. Startup remains blocked until its registration hook succeeds, because
   * failure rolls these provisional writes back - as does a shutdown, or a startup
   * that needs this component, begun inside a hook, which this answers with its
   * refusal code. Publishes the registry either way, and records the committed report.
   */
  private commitRegistration(
    attempt: RegistrationAttempt,
    nextComponents: BaseComponent[],
  ): 'shutdown_in_progress' | 'startup_in_progress' | undefined {
    const { component, componentName, progress } = attempt;
    // An instance registered before keeps its old recorded name after unregistering,
    // for work still in flight; a rollback below puts that back rather than dropping
    // it.
    const previousRecordedName = this.core.state.registeredNames.get(component);
    const previousGeneration =
      this.core.registryReads.currentGeneration(component);
    // What the report-once marks held before this attempt, so a rollback clears only
    // marks it made itself.
    const previousMetadataReports =
      this.core.componentMetadata.reportMarks(component);

    let interruptionCode:
      'shutdown_in_progress' | 'startup_in_progress' | undefined;
    // Both expected bulk-operation refusals and unexpected failures undo only
    // this attempt. Keep the reservation until finally so rollback hooks cannot
    // claim its name while cleanup is still in progress.
    const rollBack = (): void => {
      this.core.state.rollbackReservations.set(component, componentName);
      this.core.state.componentEntries =
        this.core.state.componentEntries.filter(
          (registered) => registered !== component,
        );
      // Rolled back, so this registration did not commit after all.
      progress.hasCommitted = false;
      this.core.registryReads.restoreRegistration(
        component,
        previousGeneration,
      );

      this.core.state.componentStates.delete(componentName);
      this.core.state.componentTimestamps.delete(componentName);
      this.core.state.componentErrors.delete(componentName);
      this.core.state.componentStartAttemptTokens.delete(componentName);

      // The component's side too: a hook that marked it registered before throwing
      // would otherwise leave it believing it is, and its next registration refused as
      // `duplicate_instance`.
      markComponentUnregistered(
        component,
        'lifecycle-manager registration rollback',
      );
      // The separate reservation retains the attempted name while bookkeeping is
      // restored; finally releases it after cleanup has completely finished.
      if (previousRecordedName === undefined) {
        this.core.state.registeredNames.delete(component);
      } else {
        this.core.state.registeredNames.set(component, previousRecordedName);
      }

      // "Reported once per registration": this one never happened, so a report made
      // under it - by the hook's own code reading the component - does not count
      // against the next. Only such a report: a mark that was already there stays, or
      // a caller retrying a failing registration would be told the same thing each
      // time.
      this.core.componentMetadata.rollBackReports(
        component,
        previousMetadataReports,
      );
    };
    this.core.dispatcher.withTransition(() => {
      try {
        // A new array rather than a splice, as unregister does: a loop over the registry
        // that a re-entrant registration lands in keeps walking the array it started on.
        this.core.state.pendingRegistrations.add(component);
        this.core.state.componentEntries = nextComponents;
        this.core.registryReads.advanceRegistration(component);
        this.core.state.registeredNames.set(component, componentName);

        const internalCallbacks =
          this.createLifecycleInternalCallbacks(component);

        // The lifecycle setter and registration hook can both be overridden. Keep
        // the entry unavailable to startup throughout them and their rollback, and
        // release the guard on every exit before queued notifications are delivered.
        (
          component as unknown as { lifecycle: ComponentLifecycleRef }
        ).lifecycle = new ComponentLifecycle(
          this.core.manager,
          componentName,
          internalCallbacks,
        );
        component._markRegistered();
        // A hook may start shutdown while this entry is invisible to that pass.
        // It must not publish a new component into the pass after its snapshot.
        progress.wasDuringStartup = this.core.state.isStarting;
        if (this.core.shutdownPass.isShuttingDown) {
          interruptionCode = 'shutdown_in_progress';
          rollBack();
          return;
        }
        // Startup can also begin inside either hook. Its order excludes this
        // provisional entry, so publishing a dependency needed by that pass would
        // contradict the same ordering rule checked before calling the hooks.
        if (
          this.core.startup.isRequiredDependencyDuringStartup(
            componentName,
            attempt.registryRead.reads,
          )
        ) {
          interruptionCode = 'startup_in_progress';
          rollBack();
          return;
        }
        this.core.state.componentStates.set(componentName, 'registered');
        this.core.state.componentTimestamps.set(componentName, {
          startedAt: null,
          stoppedAt: null,
        });
        this.core.state.componentErrors.set(componentName, null);
        this.core.state.componentUnexpectedStopHadError.delete(componentName);
        this.core.state.componentStartAttemptTokens.set(componentName, ulid());
        progress.hasCommitted = true;
        this.core.state.committedDependencyReads.set(
          component,
          attempt.candidateRead,
        );
      } catch (error) {
        rollBack();
        throw error;
      } finally {
        this.core.state.pendingRegistrations.delete(component);
        this.core.state.rollbackReservations.delete(component);
        // Publish only after hooks succeed (or rebuild after rollback), before
        // notifications flush. Nested commits and unregisters remain in the live
        // entries; never restore the stale array captured before calling hooks.
        this.core.registry.publishRegistry();
        if (progress.hasCommitted) {
          this.recordCommittedReport(attempt);
        }
      }
    });

    return interruptionCode;
  }

  /**
   * What a committed registration reports of its placement, captured as it is
   * published, before queued listeners can change the registry: the startup order, and
   * whether the requested position survived it.
   */
  private recordCommittedReport(attempt: RegistrationAttempt): void {
    const { component, candidateRead } = attempt;
    const { committed } = attempt.progress;
    let startupOrder: string[];
    // The cycle check before the hooks ordered only the reserved entry; hooks may have
    // committed more components. Merge their validated reads into this report snapshot
    // without invoking more caller code during publication.
    try {
      const reportReads = new Map<BaseComponent, DependencyRead>();
      let hasCompleteReportReads = true;
      for (const entry of this.core.state.components) {
        const read =
          entry === component
            ? candidateRead
            : this.core.registry.currentReadOf(
                entry,
                attempt.registryRead.reads,
              );
        // Every committed entry receives metadata before publication. If
        // this invariant ever breaks, the report is unavailable: inventing
        // an empty list would report a plausible but unjustified order.
        if (read === undefined) {
          hasCompleteReportReads = false;
          break;
        }
        reportReads.set(entry, read);
      }
      startupOrder = hasCompleteReportReads
        ? this.core.startupOrdering.getStartupOrderInternal(
            this.core.state.components,
            undefined,
            reportReads,
          )
        : [];
    } catch {
      // This diagnostic cannot undo publication, regardless of why its
      // order is unavailable. Snapshots observed at different times can disagree even though
      // every registration passed its own cycle check. This is a report,
      // not a failed commit: use an unavailable order rather than throw
      // after publication or re-enter caller getters to manufacture one.
      startupOrder = [];
    }
    committed.startupOrder = startupOrder;
    committed.manualPositionRespected =
      startupOrder.length === 0
        ? undefined
        : this.isManualPositionRespected({
            componentName: attempt.componentName,
            position: attempt.position,
            targetComponentName: attempt.targetComponentName,
            startupOrder,
          });
    // As found at insertion: `getInsertIndex()` refused a relative position
    // whose target was missing. The hooks since may have unregistered the
    // target, which does not undo that this registration was placed by it.
    committed.targetFound = positionHasTarget(attempt.position)
      ? true
      : undefined;
  }

  /**
   * After the commit: report a non-string dependency entry, now that the registration
   * it would count against has happened, and log the registration.
   */
  private logCommittedRegistration(
    attempt: RegistrationAttempt,
    candidateRead: Extract<DependencyRead, { dependencies: string[] }>,
  ): void {
    const { component, componentName } = attempt;
    // Only now: a registration refused before reaching here - a dependency cycle in
    // `placeRegistration()`, a failed hook in `commitRegistration()` - used to have spent
    // this component's one report, leaving the registration that followed silent about
    // the same broken list.
    if (candidateRead.invalidEntry !== undefined) {
      this.core.componentMetadata.reportDependencyReadFailureOnce(
        component,
        'registration',
        candidateRead.invalidEntry,
        componentName,
      );
    }

    const registrationIndexAfter =
      this.core.state.components.indexOf(component);

    if (attempt.isInsertAction) {
      this.core.logger.entity(componentName).info('Component inserted', {
        params: { position: attempt.position, index: registrationIndexAfter },
      });
    } else {
      this.core.logger.entity(componentName).info('Component registered', {
        params: { index: registrationIndexAfter },
      });
    }
  }

  /**
   * A committed registration's auto-start, when its options asked for one: left to the
   * bulk startup or restart about to run, refused while a bulk startup rolls back, or
   * begun - and then answered by the start this returns, which the registration awaits.
   * Nothing is returned when no start was begun.
   */
  private beginAutoStart(
    attempt: RegistrationAttempt,
  ): Promise<ComponentOperationResult> | undefined {
    const { componentName, progress } = attempt;

    if (!attempt.shouldAutoStart) {
      return undefined;
    }

    // The log lines and dependency report since the commit ran caller code, which can
    // unregister this component and register another under its name. Every auto-start
    // branch below acts by name: it would start the replacement and report that as this
    // registration's auto-start, or reserve the name in a startup for it.
    if (!this.isStillThisRegistration(attempt)) {
      this.skipReplacedAutoStart(attempt);
      return undefined;
    }

    // Capture this pass before logging runs caller code. Its queue/rollback state
    // decides whether registration defers, refuses auto-start, or starts work
    // independently after the completion boundary.
    const bulkStartup = this.core.state.activeBulkStartup;

    // Bulk startup first: `isStarted` turns true as soon as its first component is
    // running, and a start without `allowDuringBulkStartup` is refused with
    // `startup_in_progress` for the rest of it.
    const pendingRestart = Array.from(
      this.core.state.pendingRestartAutoStarts,
    ).at(-1);
    if (!this.core.state.isStarting && pendingRestart !== undefined) {
      // The restart has released shutdown's latch but has not claimed startup's
      // yet. Its upcoming order includes this registration.
      this.deferAutoStartToRestart(attempt, pendingRestart);
    } else if (this.core.state.isStarting && bulkStartup?.isRollingBack) {
      progress.didAutoStartAttempt = true;
      progress.startResult = {
        success: false,
        componentName,
        reason: 'The bulk startup this auto-start would join is rolling back',
        code: 'startup_rolled_back',
        status: this.core.manager.getComponentStatus(componentName),
      };
    } else if (this.core.state.isStarting && !bulkStartup?.isCompleting) {
      this.deferAutoStartToBulkStartup(attempt, bulkStartup);
    } else if (this.core.state.isStarting && bulkStartup !== null) {
      // The pass has closed its queue before terminal notifications. A start from
      // those callbacks is independent, while the public bulk latch stays held.
      this.core.logger
        .entity(componentName)
        .info('AutoStart: starting component (bulk startup completing)');
      // That log line ran caller code too.
      if (this.isStillThisRegistration(attempt)) {
        progress.didAutoStartAttempt = true;
        return this.core.componentStart.startComponentInternal(
          componentName,
          snapshotStartOptions({
            // Logging runs caller code. Only the captured completion still owns
            // this permission; a replacement pass must retain its own bulk guard.
            allowDuringBulkStartup:
              this.core.state.activeBulkStartup === bulkStartup &&
              bulkStartup.isCompleting &&
              !bulkStartup.isRollingBack,
          }),
        );
      }
      this.skipReplacedAutoStart(attempt);
    } else {
      this.core.logger
        .entity(componentName)
        .info(
          this.core.state.isStarted
            ? 'AutoStart: starting component (manager is running)'
            : 'AutoStart: starting component (manager not running)',
        );
      // That log line ran caller code too. A bulk startup or restart it began owns
      // this start: started here as well, it would be refused `startup_in_progress`
      // or `shutdown_in_progress` and reported as a failed auto-start while that
      // startup started the component.
      const startupBegunByLog = this.core.state.activeBulkStartup;
      const restartBegunByLog = Array.from(
        this.core.state.pendingRestartAutoStarts,
      ).at(-1);
      if (!this.isStillThisRegistration(attempt)) {
        this.skipReplacedAutoStart(attempt);
      } else if (
        this.core.state.isStarting &&
        !startupBegunByLog?.isCompleting &&
        !startupBegunByLog?.isRollingBack
      ) {
        this.deferAutoStartToBulkStartup(attempt, startupBegunByLog);
      } else if (
        !this.core.state.isStarting &&
        restartBegunByLog !== undefined
      ) {
        this.deferAutoStartToRestart(attempt, restartBegunByLog);
      } else {
        progress.didAutoStartAttempt = true;
        return this.core.componentStart.startComponentInternal(componentName);
      }
    }

    return undefined;
  }

  /** Whether the name still holds this registration's instance. */
  private isStillThisRegistration(attempt: RegistrationAttempt): boolean {
    return (
      this.core.registry.getComponent(attempt.componentName) ===
      attempt.component
    );
  }

  private skipReplacedAutoStart(attempt: RegistrationAttempt): void {
    this.core.logger
      .entity(attempt.componentName)
      .warn(
        'AutoStart: skipped, the component was unregistered during its registration',
      );
  }

  /**
   * Leave the auto-start to the bulk startup about to run. Reserved before logging: a
   * sink can synchronously register more components. The initial order or a follow-up
   * batch owns this start and its outcome.
   */
  private deferAutoStartToBulkStartup(
    attempt: RegistrationAttempt,
    startup: ActiveBulkStartup | null,
  ): void {
    const { componentName } = attempt;
    attempt.progress.isAutoStartDeferred = true;
    // A startup this registration's own log line began has ordered it already.
    // Queued as well, it would be started twice and, after a rollback, also
    // reported as an auto-start the startup never attempted. Frozen with the
    // initial order's deferred names instead, so one the loop never reaches is.
    if (!startup?.initialOrderNames.has(componentName)) {
      this.core.state.deferredAutoStartNames.add(componentName);
    } else if (!startup.reachedNames.has(componentName)) {
      startup.frozenAutoStarts.add(componentName);
    }
    this.core.logger
      .entity(componentName)
      .info('AutoStart: left to the bulk startup about to run');
  }

  /**
   * Leave the auto-start to the restart this start would race: it has accepted its
   * stop phase, and its upcoming startup reads the registry, this registration
   * included. Reserved before logs, since sinks can synchronously take the startup
   * latch and claim the set.
   */
  private deferAutoStartToRestart(
    attempt: RegistrationAttempt,
    pendingRestart: Set<string>,
  ): void {
    pendingRestart.add(attempt.componentName);
    attempt.progress.isAutoStartDeferred = true;
    this.core.logger
      .entity(attempt.componentName)
      .info('AutoStart: left to the restart startup about to run');
  }

  /** A committed registration's answer, announced with `component:registered`. */
  private registeredResult(
    attempt: RegistrationAttempt,
  ): InsertComponentAtResult {
    const { componentName, position, targetComponentName, progress } = attempt;
    // Where it is now, not where it landed: an auto-start can register or remove
    // components around it. By instance, as the failure path reads it: one unregistered
    // and replaced under its name by a listener must not be described as the other.
    const indexOfComponent = this.core.state.components.indexOf(
      attempt.component,
    );
    const registrationIndexNow =
      indexOfComponent === -1 ? null : indexOfComponent;
    // The same report, and the same event, as a failure after the commit gives.
    const report = committedRegistrationReport(
      progress,
      position,
      this.describeRegistryPosition(registrationIndexNow),
    );

    this.emitCommittedRegistration({
      progress,
      componentName,
      index: registrationIndexNow,
      isInsertAction: attempt.isInsertAction,
      position,
      targetComponentName,
      report,
    });

    return {
      action: 'insert',
      success: true,
      registered: true,
      componentName,
      registrationIndexBefore: null,
      registrationIndexAfter: registrationIndexNow,
      requestedPosition: { position, targetComponentName },
      ...report,
      startResult: progress.startResult,
    };
  }

  /**
   * Refuse a registration: log it, announce it with `component:registration-rejected`,
   * and answer with the refused result - one input for all three, so the event and the
   * result cannot disagree. `targetFound` goes on the event only when given.
   */
  private refuseRegistration(input: {
    progress: RegistrationProgress;
    componentName: string;
    registrationIndexBefore: number | null;
    position: InsertPosition;
    targetComponentName: string | undefined;
    isInsertAction: boolean;
    dependencySnapshot: ReadonlyMap<BaseComponent, DependencyRead>;
    code: RegistrationFailureCode;
    message: string;
    logLine: string;
    logParams?: Record<string, unknown>;
    target?: string;
    cycle?: string[];
    error?: Error;
    targetFound?: boolean;
  }): InsertComponentAtResult {
    return this.core.dispatcher.withTransition(() => {
      // Built before the log: sinks still run caller code, which may register
      // something the snapshot never read, or end the startup `duringStartup` describes.
      // The event itself is queued until this refusal has its complete result.
      const result = this.buildInsertResultFailure({
        componentName: input.componentName,
        position: input.position,
        targetComponentName: input.targetComponentName,
        registrationIndexBefore: input.registrationIndexBefore,
        code: input.code,
        reason: input.message,
        error: input.error,
        targetFound: input.targetFound,
        dependencySnapshot: input.dependencySnapshot,
      });

      this.core.logger
        .entity(input.componentName)
        .warn(
          input.logLine,
          input.logParams === undefined
            ? undefined
            : { params: input.logParams },
        );

      this.emitRegistrationRejected({
        progress: input.progress,
        name: input.componentName,
        reason: input.code,
        message: input.message,
        registrationIndexBefore: input.registrationIndexBefore,
        ...('target' in input ? { target: input.target } : {}),
        ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
        ...('targetFound' in input ? { targetFound: input.targetFound } : {}),
        isInsertAction: input.isInsertAction,
        position: input.position,
        targetComponentName: input.targetComponentName,
        startupOrder: result.startupOrder,
      });

      return result;
    });
  }

  private buildInsertResultFailure(input: {
    componentName: string;
    position: InsertPosition | (string & {});
    targetComponentName?: string;
    registrationIndexBefore: number | null;
    code: RegistrationFailureCode;
    reason: string;
    error?: Error;
    targetFound?: boolean;
    // The lists the registration already read - none, for one refused before reading
    // any - so building a refusal runs no caller code. Reading them here ran every
    // component's `getDependencies()` for a refusal made during a shutdown, and a read
    // that registered again was refused the same way, recursing.
    dependencySnapshot: ReadonlyMap<BaseComponent, DependencyRead>;
  }): InsertComponentAtResult {
    let startupOrder: string[];

    try {
      // Only from a snapshot that read every registered component. One refused before
      // reading - an invalid position, a shutdown - or cut short by a shutdown has no
      // list for some of them, and ordering those as though they had no dependencies
      // reported an order that ignored them. Empty, rather than an order that is not the
      // startup order - on the result and on `registration-rejected` alike.
      const isSnapshotComplete = this.core.state.components.every((component) =>
        this.core.registryReads.isReadCurrent(
          input.dependencySnapshot,
          component,
        ),
      );

      startupOrder = isSnapshotComplete
        ? this.core.startupOrdering.getStartupOrderInternal(
            undefined,
            undefined,
            input.dependencySnapshot,
          )
        : [];
    } catch (error) {
      // Defensive: This should never happen in normal operation since we validate
      // cycles before registration. However, if this.components somehow contains
      // a cycle (e.g., due to internal bugs or direct mutations), we must not
      // throw from an error handler. Return empty array to fail gracefully.
      const err = toError(error);

      this.core.logger.warn(
        'Failed to compute startup order in error handler: {{error.message}}',
        {
          params: { error: err },
        },
      );

      startupOrder = [];
    }
    return {
      action: 'insert',
      success: false,
      registered: false,
      componentName: input.componentName,
      reason: input.reason,
      code: input.code,
      error: input.error,
      registrationIndexBefore: input.registrationIndexBefore,
      registrationIndexAfter: input.registrationIndexBefore,
      startupOrder,
      requestedPosition: {
        position: input.position,
        targetComponentName: input.targetComponentName,
      },
      manualPositionRespected: undefined,
      targetFound: input.targetFound,
      duringStartup: this.core.state.isStarting,
      autoStartAttempted: false,
      startResult: undefined,
    };
  }

  /**
   * The answer to a registration that failed unexpectedly - from its own catch, or from
   * the safety net above it for a `getName()` that failed first. One place, every step
   * guarded, so it cannot throw: the report on the global `'error'` channel, the log
   * line, the announcement - `component:registered` for one that committed,
   * `component:registration-rejected` otherwise, once - and the result, which says what
   * a committed registration had done rather than a refusal's defaults.
   */
  private answerRegistrationFailure(input: {
    component: BaseComponent;
    componentName: string;
    error: unknown;
    // Whether the error is on the global channel already - the net's is.
    isErrorReported: boolean;
    // The net's wording; the error's own when not given.
    reason: string | undefined;
    position: InsertPosition;
    targetComponentName: string | undefined;
    isInsertAction: boolean;
    registrationIndexBefore: number | null;
    progress: RegistrationProgress;
  }): InsertComponentAtResult {
    return this.core.dispatcher.withTransition(() => {
      const { componentName, position, progress } = input;
      const err = toError(input.error);
      // A step that throws is reported and skipped, never allowed to replace the answer.
      const contain = (step: string, run: () => void): void => {
        try {
          run();
        } catch (stepError) {
          reportCallbackError(
            `lifecycle-manager registerComponent ${step}`,
            stepError,
          );
        }
      };
      let cycle: string[] | undefined;

      contain('cycle', () => {
        if (err instanceof DependencyCycleError) {
          cycle = err.additionalInfo.cycle;
        }
      });

      const code: RegistrationFailureCode =
        cycle !== undefined ? 'dependency_cycle' : 'operation_crashed';

      // Reported for the reason `getStartupOrder()` reports it; a cycle is the caller's
      // configuration, answered by the result.
      if (code === 'operation_crashed' && !input.isErrorReported) {
        reportCallbackError('lifecycle-manager registerComponent', input.error);
      }

      contain('log', () => {
        this.core.logger
          .entity(componentName)
          .error(
            'Registration failed with unexpected error: {{error.message}}',
            {
              params: { error: err },
            },
          );
      });

      // `registered` is whether this call added the component, as on success: a throw
      // after the commit - from an auto-start, say - leaves it added, and both the event
      // and the result must say so. Where it is now is read back from the registry, and
      // is `null` if a listener has removed it since.
      const isRegistered = progress.hasCommitted;
      const indexOfComponent = this.core.state.components.indexOf(
        input.component,
      );
      const registrationIndexNow =
        isRegistered && indexOfComponent !== -1 ? indexOfComponent : null;
      let actualPosition: InsertComponentAtResult['actualPosition'];

      contain('position', () => {
        actualPosition = this.describeRegistryPosition(registrationIndexNow);
      });

      const report = committedRegistrationReport(
        progress,
        position,
        actualPosition,
      );
      const reason = input.reason ?? describeError(err);

      if (!progress.isAnnounced) {
        contain('event', () => {
          if (isRegistered) {
            this.emitCommittedRegistration({
              progress,
              componentName,
              index: registrationIndexNow,
              isInsertAction: input.isInsertAction,
              position,
              targetComponentName: input.targetComponentName,
              report,
            });
          } else {
            this.emitRegistrationRejected({
              progress,
              name: componentName,
              reason: code,
              message: reason,
              registrationIndexBefore: input.registrationIndexBefore,
              startupOrder: [],
              targetFound: defaultTargetFound(position),
              ...(cycle !== undefined ? { cycle } : {}),
              isInsertAction: input.isInsertAction,
              position,
              targetComponentName: input.targetComponentName,
            });
          }
        });
      }

      return {
        action: 'insert',
        success: false,
        registered: isRegistered,
        componentName,
        reason,
        code,
        error: err,
        registrationIndexBefore: input.registrationIndexBefore,
        registrationIndexAfter: isRegistered
          ? registrationIndexNow
          : input.registrationIndexBefore,
        requestedPosition: {
          position,
          targetComponentName: input.targetComponentName,
        },
        duringStartup: this.core.state.isStarting,
        ...report,
        startResult: isRegistered ? progress.startResult : undefined,
      };
    });
  }

  /**
   * `component:registration-rejected`, built in one place for every refusal and
   * failure. `registrationIndexAfter` is `registrationIndexBefore` unless given: a
   * refusal leaves the registry as it was.
   */
  private emitRegistrationRejected(input: {
    // Marked announced here once emitted, so the rule lives in one place.
    progress: RegistrationProgress;
    name: string;
    reason: RegistrationFailureCode;
    message: string;
    registrationIndexBefore: number | null;
    registrationIndexAfter?: number | null;
    target?: string;
    cycle?: string[];
    startupOrder?: string[];
    targetFound?: boolean;
    isInsertAction: boolean;
    position: InsertPosition;
    targetComponentName: string | undefined;
  }): void {
    return this.core.dispatcher.withTransition(() => {
      this.core.lifecycleEvents.componentRegistrationRejected({
        name: input.name,
        reason: input.reason,
        ...('target' in input ? { target: input.target } : {}),
        ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
        message: input.message,
        registrationIndexBefore: input.registrationIndexBefore,
        registrationIndexAfter:
          'registrationIndexAfter' in input
            ? input.registrationIndexAfter
            : input.registrationIndexBefore,
        ...(input.startupOrder !== undefined
          ? { startupOrder: input.startupOrder }
          : {}),
        requestedPosition: input.isInsertAction
          ? {
              position: input.position,
              targetComponentName: input.targetComponentName,
            }
          : undefined,
        manualPositionRespected: undefined,
        ...('targetFound' in input ? { targetFound: input.targetFound } : {}),
      });
      // Once queued: a payload builder that throws leaves it unannounced for the
      // failure path to announce. Delivery waits until this flag is consistent,
      // and listener failures cannot cause a duplicate announcement.
      input.progress.isAnnounced = true;
    });
  }

  /**
   * `component:registered` for a registration that committed, from wherever it is
   * reported - the success path, the registration's catch, or the safety net above it -
   * so the payload is built once. `registrationIndexBefore` is always `null`: a
   * registration commits only for a name that was not registered.
   */
  private emitCommittedRegistration(input: {
    // Marked announced here once emitted, so the rule lives in one place.
    progress: RegistrationProgress;
    componentName: string;
    index: number | null;
    isInsertAction: boolean;
    position: InsertPosition;
    targetComponentName: string | undefined;
    report: ReturnType<typeof committedRegistrationReport>;
  }): void {
    return this.core.dispatcher.withTransition(() => {
      this.core.lifecycleEvents.componentRegistered({
        name: input.componentName,
        index: input.index,
        action: input.isInsertAction ? 'insert' : 'register',
        registrationIndexBefore: null,
        registrationIndexAfter: input.index,
        requestedPosition: input.isInsertAction
          ? {
              position: input.position,
              targetComponentName: input.targetComponentName,
            }
          : undefined,
        ...input.report,
      });
      // Once queued: a payload builder that throws leaves it unannounced for the
      // failure path to announce. Delivery waits until this flag is consistent,
      // and listener failures cannot cause a duplicate announcement.
      input.progress.isAnnounced = true;
    });
  }

  /**
   * Where the registry entry at `index` sits, described by its neighbours, as a
   * registration reports it. Read at report time, from the registry as it is then: an
   * auto-start can register or remove components around the new one, and a position
   * captured before it described a registry that had moved on.
   */
  private describeRegistryPosition(
    index: number | null,
  ): InsertComponentAtResult['actualPosition'] {
    let positionDescription: string | undefined;

    if (index !== null) {
      const totalComponents = this.core.state.components.length;

      if (totalComponents === 1) {
        positionDescription = 'only component';
      } else if (index === 0) {
        const nextComponent = this.core.registry.nameOfAt(1);
        positionDescription = nextComponent
          ? `at start, before ${nextComponent}`
          : 'at start';
      } else if (index === totalComponents - 1) {
        const prevComponent = this.core.registry.nameOfAt(totalComponents - 2);
        positionDescription = prevComponent
          ? `at end, after ${prevComponent}`
          : 'at end';
      } else {
        const prevComponent = this.core.registry.nameOfAt(index - 1);
        const nextComponent = this.core.registry.nameOfAt(index + 1);
        if (prevComponent && nextComponent) {
          positionDescription = `after ${prevComponent}, before ${nextComponent}`;
        } else if (prevComponent) {
          positionDescription = `after ${prevComponent}`;
        } else if (nextComponent) {
          positionDescription = `before ${nextComponent}`;
        }
      }
    }

    return index !== null
      ? { index, description: positionDescription }
      : undefined;
  }

  // Kept as a method, not inlined: it is the seam tests use to fail a registration
  // right after its commit.
  private isManualPositionRespected(input: {
    componentName: string;
    position: InsertPosition;
    targetComponentName?: string;
    startupOrder: string[];
  }): boolean {
    return isManualPositionRespected(input);
  }

  /**
   * Create retained callbacks in their own activation. Creating these inside the
   * registration transaction retains its rollback closures and registry snapshots
   * on engines that share the lexical environment, making retained memory quadratic.
   * Components need only the manager, never the transaction that registered them.
   */
  private createLifecycleInternalCallbacks(
    component: BaseComponent,
  ): LifecycleInternalCallbacks {
    return {
      sendMessageInternal: (
        compName: string,
        payload: unknown,
        from: string | null,
        options?: SendMessageOptions,
      ) =>
        this.core.messaging.sendMessageSettled(
          compName,
          payload,
          from,
          options,
        ),
      broadcastMessageInternal: (
        payload: unknown,
        from: string | null,
        opts?: BroadcastOptions,
      ) => this.core.messaging.broadcastMessageSettled(payload, from, opts),
      getValueInternal: <T = unknown>(
        compName: string,
        key: string,
        from: string | null,
        options?: GetValueOptions,
      ) => this.core.messaging.getValueSettled<T>(compName, key, from, options),
      stopAllComponentsInternal: (options?: StopAllOptions) =>
        this.requestedBy(component, () =>
          this.core.manager.stopAllComponents(options),
        ),
      restartAllComponentsInternal: (options?: RestartAllOptions) =>
        this.requestedBy(component, () =>
          this.core.manager.restartAllComponents(options),
        ),
    };
  }

  /**
   * A bulk stop or restart requested through a component's own `lifecycle` handle. Its
   * unfinished start is the requester, exactly as a synchronous request from inside
   * `start()` is: the pass does not join a start that may be awaiting it. Unlike the
   * synchronous check, this still holds once the hook has yielded, which no
   * runtime-neutral check of the caller can recognise.
   */
  private requestedBy<T>(
    component: BaseComponent,
    request: () => Promise<T>,
  ): Promise<T> {
    const requesting: StartSettlement[] = [];
    for (const [claim, settlement] of this.core.state.startSettlements) {
      // An attempt records its instance only once its `component:starting` listeners
      // have run; from its claim on, the name's registered instance is the one it starts.
      const startingComponent =
        settlement.component ??
        (this.core.state.componentClaims.get(settlement.name)?.claim === claim
          ? this.core.registry.getComponent(settlement.name)
          : undefined);
      if (
        startingComponent === component &&
        isStartUnfinished(settlement) &&
        !this.core.state.invokingStarts.has(settlement)
      ) {
        requesting.push(settlement);
        this.core.state.invokingStarts.add(settlement);
      }
    }
    try {
      // The pass captures its requesters synchronously, before its first await.
      return request();
    } finally {
      for (const settlement of requesting) {
        this.core.state.invokingStarts.delete(settlement);
      }
    }
  }
}
