/**
 * Simple error classes for retry-utils
 * Following the pattern from FileSinkError
 */

export class RetryUtilsErrPolicyConfigInvalidStrategy extends Error {
  constructor(
    public strategyProvided: string,
    public validStrategies: string[],
  ) {
    super('Invalid strategy provided.');
    this.name = 'RetryUtilsErrPolicyConfigInvalidStrategy';
  }
}

export class RetryUtilsErrRunnerAlreadyCompleted extends Error {
  constructor(public invokedMethod: 'run' | 'resume' | 'forceTry') {
    super(
      'The runner has already completed running the operation. Use the .reset() method, and .run() to run the operation again.',
    );
    this.name = 'RetryUtilsErrRunnerAlreadyCompleted';
  }
}

export class RetryUtilsErrRunnerAlreadyRunning extends Error {
  constructor(public invokedMethod: 'run' | 'resume') {
    super('The operation is already running and cannot be started again.');
    this.name = 'RetryUtilsErrRunnerAlreadyRunning';
  }
}

export class RetryUtilsErrRunnerForceTryRetryInProgress extends Error {
  constructor(public invokedMethod: 'forceTry') {
    super('Force try retry is already in progress.');
    this.name = 'RetryUtilsErrRunnerForceTryRetryInProgress';
  }
}

export class RetryUtilsErrRunnerNotPaused extends Error {
  constructor(public invokedMethod: 'resume') {
    super(
      'The runner is not in a paused state. resume() can only be called when the runner state is stopped.',
    );
    this.name = 'RetryUtilsErrRunnerNotPaused';
  }
}

export class RetryUtilsErrRunnerCancelPending extends Error {
  constructor(public invokedMethod: 'run' | 'resume') {
    super(
      'A cancel operation is pending. The operation cannot be started again.',
    );
    this.name = 'RetryUtilsErrRunnerCancelPending';
  }
}

export class RetryUtilsErrRunnerRetryCanceled extends Error {
  constructor(public invokedMethod: 'run') {
    super(
      'The operation was already canceled. Use either .resume(), .forceTry() or .reset() and .run() to run the operation again.',
    );
    this.name = 'RetryUtilsErrRunnerRetryCanceled';
  }
}

export class RetryUtilsErrRunnerLastRetryFatallyFailed extends Error {
  constructor(public invokedMethod: 'run' | 'resume') {
    super(
      'The last retry attempt failed fatally. The operation cannot be retried. Use either .reset() then .run() or .forceTry() to run the operation again.',
    );
    this.name = 'RetryUtilsErrRunnerLastRetryFatallyFailed';
  }
}

export class RetryUtilsErrRunnerAttemptsExhausted extends Error {
  constructor(public invokedMethod: 'run' | 'resume') {
    super(
      'All attempts were exhausted. The operation cannot be retried. Use either .reset() then .run() or .forceTry() to run the operation again.',
    );
    this.name = 'RetryUtilsErrRunnerAttemptsExhausted';
  }
}

export class RetryUtilsErrRunnerLockAcquisitionError extends Error {
  constructor(public invokedMethod: 'run' | 'resume' | 'forceTry') {
    super(
      'Failed to acquire operation lock. Cannot attempt to run the operation.',
    );
    this.name = 'RetryUtilsErrRunnerLockAcquisitionError';
  }
}

export class RetryUtilsErrRunnerUnexpectedError extends Error {
  constructor(
    public invokedMethod: 'run' | 'resume' | 'forceTry',
    public originalError: Error,
  ) {
    super('An unexpected error occurred.');
    this.name = 'RetryUtilsErrRunnerUnexpectedError';
  }
}

export class RetryUtilsErrRunnerUnknownState extends Error {
  constructor(
    public invokedMethod: 'waitForCompletion',
    public runnerState: string,
  ) {
    super('An unknown runner state was encountered.');
    this.name = 'RetryUtilsErrRunnerUnknownState';
  }
}

export class RetryUtilsErrRunnerNotRunning extends Error {
  constructor(public invokedMethod: 'waitForCompletion') {
    super('The operation is not currently running.');
    this.name = 'RetryUtilsErrRunnerNotRunning';
  }
}
