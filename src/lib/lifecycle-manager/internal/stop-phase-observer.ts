import { observeRejection } from '../../internal/promise-reactions';

/**
 * Reporting belongs to one observer per phase; state ownership is separate.
 *
 * Race window                 State/result owner        Rejection reporter
 * Before deadline             Foreground claim          Foreground
 * Abort listener settles hook Foreground claim          Deadline observer
 * Graceful wins during force  Graceful token + waiter    Abandoned-force observer*
 * After stalled result        Matching stop token       Deadline observer
 * After retry/restart         New claim/token           Old observer, logs only
 * * The deadline observer keeps reporting ownership if already installed.
 *
 * Installing an observer transfers reporting before promise callbacks run. This
 * includes rejections abort listeners cause that beat the deferred deadline. Foreground
 * catches still record results/transitions; their snapshots are never rewritten
 * by later reconciliation. An observed rejection is still a hook error: a fired
 * deadline does not mean its deferred timeout won the race. The caller supplies
 * phase-appropriate severity independently of who owns reporting.
 * Claims, generation tokens, and force waiters retain their distinct lifetimes
 * and are deliberately not managed here.
 */
export function createStopPhaseObserver(
  reportError: (
    error: unknown,
    message: string,
    level: 'warn' | 'error',
  ) => void,
): {
  reportForeground: (
    error: unknown,
    message: string,
    level?: 'warn' | 'error',
  ) => void;
  observe: (
    promise: Promise<unknown>,
    message: string,
    options?: {
      onResolved?: () => void;
      getReport?: () => { message: string; level: 'warn' | 'error' };
    },
  ) => void;
} {
  let isObserved = false;
  const report = (
    error: unknown,
    message: string,
    level: 'warn' | 'error' = 'warn',
  ): void => {
    reportError(error, message, level);
  };

  return {
    reportForeground: (error, message, level) => {
      if (!isObserved) {
        report(error, message, level);
      }
    },
    observe: (promise, message, options) => {
      if (isObserved) {
        return;
      }
      isObserved = true;
      // Which branch the terminal observer below hears from. Both reactions can throw,
      // and a failure to report the hook's rejection is not a failed late resolution,
      // so each gets its own label.
      let terminalLabel = 'Late stop resolution failed';
      // A selection failure the reaction could not throw itself, because reporting the
      // hook's rejection threw first: the terminal observer reports it after that one.
      let deferredSelectionFailure: { error: unknown } | undefined;
      // Already-adopted hook promises only. One chain owns both late success
      // reconciliation and rejection reporting, even when force is abandoned.
      const observed = promise.then(
        () => {
          options?.onResolved?.();
        },
        (error: unknown) => {
          // A selector that throws must not swallow the hook's own failure: that is
          // still reported, with the details given up front, before the selector's.
          let selected:
            { message: string; level: 'warn' | 'error' } | undefined;
          let selectionFailure: { error: unknown } | undefined;
          try {
            selected = options?.getReport?.();
          } catch (selectionError) {
            selectionFailure = { error: selectionError };
          }
          // Only a failure of this report itself is one the terminal observer may call
          // unreported.
          terminalLabel = 'Late stop failure could not be reported';
          try {
            report(
              error,
              selected?.message ?? message,
              // The selector exists to choose the level - it may downgrade an abandoned
              // hook to a warning - so without its answer nothing justifies downgrading:
              // `error`. With no selector at all, the reporter's default.
              selected?.level ??
                (selectionFailure !== undefined ? 'error' : undefined),
            );
          } catch (reportingError) {
            // Only one error can be thrown on: the report's own failure, under the label
            // above. The selector's must not be lost behind it.
            deferredSelectionFailure = selectionFailure;
            throw reportingError;
          }
          if (selectionFailure !== undefined) {
            // The hook's failure was reported above; what failed is the selection.
            terminalLabel = 'Late stop report selection failed';
            throw selectionFailure.error;
          }
        },
      );
      observeRejection(observed, (error: unknown) => {
        try {
          report(error, terminalLabel);
        } finally {
          if (deferredSelectionFailure !== undefined) {
            report(
              deferredSelectionFailure.error,
              'Late stop report selection failed',
            );
          }
        }
      });
    },
  };
}
