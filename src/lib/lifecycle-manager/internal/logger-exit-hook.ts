import { LIFECYCLE_MANAGER_LOG_LOGGER_EXIT_DURING_SHUTDOWN } from '../constants';
import type { BeforeExitResult } from '../../logger';
import type { ManagerCore } from './manager-core';
import { isObjectLike } from '../../internal/is-object-like';
import { toError } from '../../to-error';

/**
 * The logger exit hook: `logger.exit()` stops the components before the process exits,
 * and a logger exit that has proceeded keeps starts refused until it finishes.
 *
 * Owns the exit's own bookkeeping - which exit leads, whether it is in hand, whether the
 * process is committed to ending - and nothing else. The shutdown it runs is the
 * manager's public `stopAllComponents()`, called on the manager at call time, and the
 * shutdown pass settles a pending exit through `finalizePendingLoggerExit()` when its
 * latch comes down.
 */
export class LoggerExitHook {
  // Settles the leading logger.exit() once the shutdown pass it depends on ends: resolves
  // one deferred during an already-running shutdown, and releases `isHandlingLoggerExit`
  // for either kind. See `enable()`.
  private pendingLoggerExitResolve:
    ((result: BeforeExitResult) => void) | null = null;
  // Whether a leading logger.exit() is still being handled - stopping components, or
  // deferred behind a running shutdown. See `enable()`.
  private isHandlingLoggerExit = false;
  // Set once a logger exit that ends the process has been told to proceed. The logger
  // still closes its sinks before calling `process.exit()`, and nothing may start in that
  // window: it would be killed by the exit without a graceful stop. Never cleared - the
  // process is ending. That holds even if `process.exit` is removed or replaced after
  // this is set and the logger ends the exit as simulated: the app asked to exit, so
  // staying down is the safer failure than restarting. See `proceedWithLoggerExit()`.
  private isProcessExitCommitted = false;
  // Set once a simulated logger exit (`callProcessExit: false`) has been told to proceed,
  // covering the window before the logger publishes `exit-process` - from then on its
  // `isFinishingExit` answers until `exit-completed`. Cleared when that `exit-process` is
  // published, so it cannot outlive its exit and refuse starts while a later one is
  // pending; failing that (a logger that cannot be subscribed to, or whose `emit` is
  // overridden), by the first read that finds the logger neither pending nor finishing an
  // exit. See `markSimulatedExitProceeding()` and `isLoggerExitInProgress()`.
  private isSimulatedLoggerExitProceeding = false;
  // Held while a forced logger exit logs that it is exiting, so a sink that exits from
  // that line waits instead of re-entering the forced branch without bound.
  private isProceedingForcedExit = false;

  constructor(private readonly core: ManagerCore) {}

  /**
   * Register the root logger's `beforeExit` callback, replacing any earlier one. The
   * body of the manager's public `enableLoggerExitHook()`, which documents it.
   */
  public enable(): void {
    this.core.rootLogger.setBeforeExitCallback(async (exitCode: number) => {
      // An exit that ends the process has already proceeded, or a forced one is logging
      // that it is about to, and the logger is on its way to `process.exit()`. A later
      // exit - one a sink makes from its own `close()` or from the forced exit's log line
      // - must not run a second shutdown, proceed on its own, or re-enter here from a log
      // line without bound. Its code is the logger's to settle: a failure still replaces
      // the pending code until the logger publishes it in `exit-process`.
      if (this.isProcessExitCommitted || this.isProceedingForcedExit) {
        return { action: 'wait' as const };
      }

      // Called from inside escalation handling - `onForceShutdown` calling
      // `logger.exit(1)`, the documented way to force - it is the force itself, so it
      // proceeds at once. Deferred like any other exit, it waited out the running pass
      // (its whole timeout, for the stall that prompted the force) or, from the armed
      // window, started and waited out a new one.
      if (this.core.state.forceHandlingDepth > 0) {
        if (this.core.shutdownPass.isShuttingDown) {
          this.core.shutdownPass.noteShutdownRequestDuringActivePass();
        }

        // Committed before the log line, so a sink behind it cannot start anything.
        const result = this.proceedWithLoggerExit();
        this.isProceedingForcedExit = true;

        try {
          this.core.logger.info(
            'Logger exit during forced shutdown, exiting now',
            {
              params: { exitCode },
            },
          );
        } finally {
          this.isProceedingForcedExit = false;
        }

        return result;
      }

      // An exit leads when no earlier one is still being handled. The logger's own
      // `isFirstExit` is not enough: a logger that does not end the process
      // (`callProcessExit: false`) reports every exit after its first as a repeat,
      // even once that first exit has long finished, and each later exit must still
      // stop the components and keep a restart down.
      //
      // A repeat that arrives while a leading exit is still in hand waits, so it cannot
      // exit ahead of the leading exit or start a second shutdown. That holds before
      // the leading exit's shutdown has started too: a sink behind its "stopping
      // components" log line that calls `logger.exit()` synchronously would otherwise
      // be told to proceed, and exit with every component still running.
      //
      // Waiting does not drop the repeat's code. The logger recorded it when the repeat
      // was made, and a failure replaces the pending code: a component that fails while
      // stopping and logs `exitCode: 1` turns a SIGTERM's `exit(0)` into a non-zero exit.
      //
      // Not logged: this runs synchronously inside the repeat's `logger.exit()`, so a
      // sink that exits from the lines it writes would re-enter here from the log line
      // without bound - and before the leading exit's shutdown starts, there is no
      // shutdown for the line to describe. `logger.exit()` is a one-time request, and the
      // leading exit is already handling it. `isFirstExit` is not consulted: the logger
      // marks an exit requested before calling this, so a first exit never finds one
      // in hand.
      if (this.isHandlingLoggerExit) {
        return { action: 'wait' as const };
      }

      // This exit stops being in hand when the pass it depends on releases its latch -
      // `finalizePendingLoggerExit()` calls `pendingLoggerExitResolve` from there - not
      // when this hook resumes, a microtask or more later. A `shutdown-completed`
      // listener can queue a start into that gap, and a repeat made there was told to
      // wait for an exit already over, leaving the new start running. The `finally`
      // below releases it only for an exit no pass finalized.
      let isInHand = true;
      const releaseExit = (): void => {
        if (isInHand) {
          isInHand = false;
          this.isHandlingLoggerExit = false;
        }
      };

      // Defer a logger.exit() that arrives during an already-running shutdown until
      // that shutdown completes.
      const waitForRunningShutdown = async (): Promise<BeforeExitResult> => {
        // A pass this exit's own `stopAllComponents()` was refused by can end, and
        // release the exit, before that refusal reaches it here - with another pass,
        // a restart's stop phase say, running by then. The exit waits for that one too,
        // in hand again - unless a later exit took the lead meanwhile, and waits for it.
        if (!isInHand) {
          if (this.isHandlingLoggerExit) {
            return { action: 'wait' as const };
          }
          isInHand = true;
          this.isHandlingLoggerExit = true;
        }

        // The process is on its way out, so a restart stopping right now must not
        // start everything back up behind the exit. Recorded on the pass this exit
        // waits for, even after a refused `stopAllComponents()` recorded it already:
        // the pass that refused it may have ended since, and a restart's stop phase
        // taken its place. Noting the same pass twice raises the stay-down count
        // again, which only an individual restart that began between the two notes
        // sees - one that began after this exit was requested, so skipping its start
        // is still right.
        this.core.shutdownPass.noteShutdownRequestDuringActivePass();

        this.core.logger.debug(
          LIFECYCLE_MANAGER_LOG_LOGGER_EXIT_DURING_SHUTDOWN,
          {
            params: { exitCode, pendingExitCode: this.readPendingExitCode() },
          },
        );

        // Only the leading exit gets here, and it holds `isHandlingLoggerExit` until this
        // is resolved, so no other deferred exit can be pending.
        return await new Promise<BeforeExitResult>((resolve) => {
          this.pendingLoggerExitResolve = (result) => {
            releaseExit();
            resolve(result);
          };
        });
      };

      this.isHandlingLoggerExit = true;

      try {
        if (this.core.shutdownPass.isShuttingDown) {
          return await waitForRunningShutdown();
        }

        this.core.logger.info('Logger exit triggered, stopping components...', {
          params: {
            exitCode,
            pendingExitCode: this.readPendingExitCode(),
            timeoutMS: this.core.config.shutdownOptions.timeoutMS,
          },
        });

        // Released when the pass ends, as a deferred exit is - by whichever pass ends
        // first, should a sink have begun one ahead of this call.
        this.pendingLoggerExitResolve = releaseExit;

        // Stop all components with the manager's `shutdownOptions` defaults, through the
        // public method so an override of it runs. Guarded as `autoAttachSignals()`
        // guards `attachSignals()`: an override that throws, rejects or answers with
        // something other than a result must not keep this exit from proceeding.
        let shutdownCode: unknown;
        let didStopFail = false;

        try {
          const shutdownResult: unknown =
            await this.core.manager.stopAllComponents();
          shutdownCode = isObjectLike(shutdownResult)
            ? Reflect.get(shutdownResult, 'code')
            : undefined;
        } catch (error) {
          didStopFail = true;
          this.core.logger.error(
            'Logger exit could not stop components: {{error.message}}',
            { params: { error: toError(error), exitCode } },
          );
        }

        // A sink behind the log line above can start the shutdown first. This call
        // was then refused, and the exit waits for the running pass like any other -
        // as it does for a pass a failed override left running.
        if (
          (didStopFail || shutdownCode === 'already_in_progress') &&
          this.core.shutdownPass.isShuttingDown
        ) {
          return await waitForRunningShutdown();
        }

        // Proceed with exit - already done by the pass that released this exit, whose
        // `finalizePendingLoggerExit()` committed it; proceeding a second time would
        // only repeat that commit.
        return isInHand
          ? this.proceedWithLoggerExit()
          : { action: 'proceed' as const };
      } finally {
        // Still in hand only if no pass finalized this exit: its resolver is then still
        // set, and must not release a later exit's latch.
        if (isInHand) {
          this.pendingLoggerExitResolve = null;
        }
        releaseExit();
      }
    });

    this.core.logger.debug('Logger exit hook enabled', {
      params: { timeoutMS: this.core.config.shutdownOptions.timeoutMS },
    });
  }

  /**
   * Settle a logger exit being handled once the shutdown pass it depends on releases its
   * latch: release one deferred behind a running pass, and commit the process to ending.
   *
   * Committed here, synchronously with the latch release, for an exit that started its
   * own pass as much as for a deferred one: the exit resumes only a microtask or more
   * later, and a start a `shutdown-completed` listener queues in between must already be
   * refused. Every exit still in hand at this point proceeds - its own pass is over, or
   * it was waiting for this one.
   */
  public finalizePendingLoggerExit(): void {
    if (this.core.shutdownPass.isShuttingDown || !this.isHandlingLoggerExit) {
      return;
    }

    const result = this.proceedWithLoggerExit();
    const resolve = this.pendingLoggerExitResolve;

    if (resolve !== null) {
      this.pendingLoggerExitResolve = null;
      resolve(result);
    }
  }

  /**
   * Whether a logger exit keeps starts refused: one that ends the process has proceeded,
   * or a simulated one has proceeded and not yet finished closing the sinks. The logger
   * publishes `exit-process` only after this manager answers 'proceed', so a flag covers
   * that gap; `isFinishingExit` covers the rest, until `exit-completed`.
   *
   * The root logger may be a caller-supplied copy without these getters, or one whose
   * reads throw; either counts as no exit in progress.
   */
  public isLoggerExitInProgress(): boolean {
    if (this.isProcessExitCommitted) {
      return true;
    }

    if (this.readLoggerExitFlag('isFinishingExit')) {
      return true;
    }

    if (!this.isSimulatedLoggerExitProceeding) {
      return false;
    }

    // Still between 'proceed' and `exit-process`: the exit is pending until it commits.
    if (this.readLoggerExitFlag('isPendingExit')) {
      return true;
    }

    this.isSimulatedLoggerExitProceeding = false;
    return false;
  }

  /**
   * The code the logger's pending exit will commit, for the exit hook's log lines: the
   * `exitCode` the hook is called with is only that request's, and overlapping requests
   * settle on the last non-zero one. `undefined` when no exit is pending, or when the
   * logger cannot say - a logger copy without the getter, or one that throws.
   */
  private readPendingExitCode(): number | undefined {
    try {
      const code: unknown = this.core.rootLogger.pendingExitCode;
      return typeof code === 'number' ? code : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The answer for a logger exit allowed to proceed. When that exit ends the process,
   * every start from here on is refused (see `isProcessExitCommitted`). A simulated exit
   * (`callProcessExit: false`) leaves the process running, so starts are refused only
   * until its sink cleanup settles (see `isLoggerExitInProgress()`).
   */
  private proceedWithLoggerExit(): BeforeExitResult {
    let doesEndProcess = true;

    try {
      // Anything but an explicit `false` - a logger copy without the getter, say - is
      // treated as ending the process, the same assumption a throw gets below.
      doesEndProcess = this.core.rootLogger.endsProcessOnExit !== false;
    } catch {
      // Unreadable: the exit was told to proceed, so assume the process is ending.
    }

    if (doesEndProcess) {
      this.isProcessExitCommitted = true;
    } else {
      this.markSimulatedExitProceeding();
    }

    return { action: 'proceed' };
  }

  /**
   * Refuse starts until the proceeding simulated exit publishes `exit-process`, and no
   * longer. A request that proceeds after its exit was already published - one folded
   * into it - finds nothing pending, and has no `exit-process` of its own to wait for.
   */
  private markSimulatedExitProceeding(): void {
    if (!this.readLoggerExitFlag('isPendingExit')) {
      return;
    }

    this.isSimulatedLoggerExitProceeding = true;

    try {
      const unsubscribe = this.core.rootLogger.on<{ eventType?: unknown }>(
        'logger',
        (event) => {
          if (event?.eventType === 'exit-process') {
            this.isSimulatedLoggerExitProceeding = false;
            unsubscribe();
          }
        },
      );
    } catch {
      // Not subscribable: `isLoggerExitInProgress()` clears the flag lazily instead.
    }
  }

  /** A guarded read of one of the root logger's exit getters; anything but `true` is false. */
  private readLoggerExitFlag(
    name: 'isFinishingExit' | 'isPendingExit',
  ): boolean {
    try {
      const value: unknown = this.core.rootLogger[name];
      return value === true;
    } catch {
      return false;
    }
  }
}
