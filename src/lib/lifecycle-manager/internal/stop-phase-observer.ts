import { observePromise, observeRejection } from '../../internal/intrinsics';

/**
 * Reporting belongs to one observer per phase; state ownership is separate.
 *
 * Race window                 State/result owner        Rejection reporter
 * Before deadline             Foreground claim          Foreground
 * Timeout hook settles work   Foreground claim          Deadline observer
 * Graceful wins during force  Graceful token + waiter    Abandoned-force observer*
 * After stalled result        Matching stop token       Deadline observer
 * After retry/restart         New claim/token           Old observer, logs only
 * * The deadline observer keeps reporting ownership if already installed.
 *
 * Installing an observer transfers reporting before promise callbacks run. This
 * includes abort-hook rejections that beat the deferred deadline. Foreground
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
      level?: 'warn' | 'error';
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
      // Already-adopted hook promises only. One chain owns both late success
      // reconciliation and rejection reporting, even when force is abandoned.
      const observed = observePromise(
        promise,
        () => {
          options?.onResolved?.();
        },
        (error: unknown) => {
          const selected = options?.getReport?.();
          report(
            error,
            selected?.message ?? message,
            selected?.level ?? options?.level,
          );
        },
      );
      observeRejection(observed, (error: unknown) => {
        report(error, 'Late stop resolution failed');
      });
    },
  };
}
