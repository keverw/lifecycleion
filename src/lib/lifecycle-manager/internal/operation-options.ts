import type {
  BroadcastOptions,
  GetValueOptions,
  RegisterOptions,
  RestartAllOptions,
  RestartComponentOptions,
  SendMessageOptions,
  StartComponentOptions,
  StartupOptions,
  StopAllOptions,
  StopComponentOptions,
  UnregisterOptions,
} from '../types';
import { copyBoundedArray } from './bounded-array-copy';
import { invalidOperationOptionError } from './operation-policy';

/*
 * A caller's options object, read once, at the start of the operation it configures.
 * Fields are read in the order each snapshot's object literal lists them.
 *
 * The object is the caller's: any field can be a getter, or the object a `Proxy`, and a
 * read runs the caller's code - which can throw, answer differently the second time, or
 * re-enter the manager. Each operation reads every field it may use exactly once, in a
 * fixed order, after the refusals that need no options, and then makes one re-entry
 * check. Everything after that works from the frozen snapshot.
 *
 * The snapshot types are branded, so internal code that takes one cannot be handed the
 * caller's object instead: re-reading it deeper in is a compile error. A read that
 * throws is not caught here; the public safety net classifies it as `operation_crashed`.
 * Values are kept as read - validation (a timeout's range, say) stays with the code that
 * uses them, so an operation can still refuse for availability before it refuses an
 * option it would never use.
 */

declare const snapshotBrand: unique symbol;

/** `T`, read once and frozen, branded so the caller's own object does not satisfy it. */
type Snapshot<T, Brand extends string> = Readonly<T> & {
  readonly [snapshotBrand]: Brand;
};

function freezeSnapshot<S extends { readonly [snapshotBrand]: string }>(
  values: Omit<S, typeof snapshotBrand>,
): S {
  return Object.freeze(values) as S;
}

export type StartOptionsSnapshot = Snapshot<
  Required<StartComponentOptions>,
  'StartComponentOptions'
>;

/** What a start reads when it is handed no options: nothing overridden. */
export const DEFAULT_START_OPTIONS: StartOptionsSnapshot = freezeSnapshot({
  allowDuringBulkStartup: false,
  forceStalled: false,
  allowNonRunningDependencies: false,
});

export function snapshotStartOptions(
  options: StartComponentOptions | undefined,
): StartOptionsSnapshot {
  return freezeSnapshot<StartOptionsSnapshot>({
    allowDuringBulkStartup: options?.allowDuringBulkStartup === true,
    forceStalled: options?.forceStalled === true,
    allowNonRunningDependencies: options?.allowNonRunningDependencies === true,
  });
}

/** `timeout` is kept as read: it is validated where it is used, against the component's own. */
export type StopOptionsSnapshot = Snapshot<
  {
    allowStopWithRunningDependents: boolean;
    forceImmediate: boolean;
    timeout: StopComponentOptions['timeout'];
  },
  'StopComponentOptions'
>;

export function snapshotStopOptions(
  options: StopComponentOptions | undefined,
): StopOptionsSnapshot {
  // Truthiness, as these flags have always been read. `Boolean()` runs no caller code.
  return freezeSnapshot<StopOptionsSnapshot>({
    allowStopWithRunningDependents: Boolean(
      options?.allowStopWithRunningDependents,
    ),
    forceImmediate: Boolean(options?.forceImmediate),
    timeout: options?.timeout,
  });
}

export type RestartComponentOptionsSnapshot = Snapshot<
  {
    stopOptions: StopOptionsSnapshot;
    startOptions: StartOptionsSnapshot;
  },
  'RestartComponentOptions'
>;

export function snapshotRestartComponentOptions(
  options: RestartComponentOptions | undefined,
): RestartComponentOptionsSnapshot {
  const stopOptions = options?.stopOptions;
  const startOptions = snapshotStartOptions(options?.startOptions);
  return freezeSnapshot<RestartComponentOptionsSnapshot>({
    stopOptions: snapshotStopOptions(stopOptions),
    startOptions,
  });
}

/** `timeoutMS` is kept as read: it is validated after the availability refusals. */
export type StartupOptionsSnapshot = Snapshot<
  {
    ignoreStalledComponents: boolean;
    timeoutMS: StartupOptions['timeoutMS'];
  },
  'StartupOptions'
>;

export function snapshotStartupOptions(
  options: StartupOptions | undefined,
): StartupOptionsSnapshot {
  return freezeSnapshot<StartupOptionsSnapshot>({
    ignoreStalledComponents: options?.ignoreStalledComponents === true,
    timeoutMS: options?.timeoutMS,
  });
}

/**
 * Each field as read, `undefined` when not given: the shutdown pass resolves them
 * against the manager's `shutdownOptions` defaults.
 */
export type StopAllOptionsSnapshot = Snapshot<
  Pick<
    StopAllOptions,
    | 'timeoutMS'
    | 'retryStalled'
    | 'haltOnStall'
    | 'allowStopWithPendingStarts'
    | 'waitForAbandonedStarts'
    | 'abortPendingStarts'
  >,
  'StopAllOptions'
>;

export function snapshotStopAllOptions(
  options: StopAllOptions | undefined,
): StopAllOptionsSnapshot {
  return freezeSnapshot<StopAllOptionsSnapshot>({
    timeoutMS: options?.timeoutMS,
    retryStalled: options?.retryStalled,
    haltOnStall: options?.haltOnStall,
    allowStopWithPendingStarts: options?.allowStopWithPendingStarts,
    waitForAbandonedStarts: options?.waitForAbandonedStarts,
    abortPendingStarts: options?.abortPendingStarts,
  });
}

/** Both timeouts are kept as read: restart validates them after its re-entry check. */
export type RestartAllOptionsSnapshot = Snapshot<
  {
    startupOptions: StartupOptionsSnapshot;
    shutdownTimeoutMS: RestartAllOptions['shutdownTimeoutMS'];
  },
  'RestartAllOptions'
>;

export function snapshotRestartAllOptions(
  options: RestartAllOptions | undefined,
): RestartAllOptionsSnapshot {
  // The startup timeout is read ahead of `ignoreStalledComponents` here, as restart
  // always has, and both ahead of the shutdown timeout.
  const startupOptions = options?.startupOptions;
  const startupTimeoutMS = startupOptions?.timeoutMS;
  const shouldIgnoreStalledComponents =
    startupOptions?.ignoreStalledComponents === true;
  return freezeSnapshot<RestartAllOptionsSnapshot>({
    startupOptions: freezeSnapshot<StartupOptionsSnapshot>({
      ignoreStalledComponents: shouldIgnoreStalledComponents,
      timeoutMS: startupTimeoutMS,
    }),
    shutdownTimeoutMS: options?.shutdownTimeoutMS,
  });
}

export type RegisterOptionsSnapshot = Snapshot<
  Required<RegisterOptions>,
  'RegisterOptions'
>;

export function snapshotRegisterOptions(
  options: RegisterOptions | undefined,
): RegisterOptionsSnapshot {
  return freezeSnapshot<RegisterOptionsSnapshot>({
    autoStart: options?.autoStart === true,
  });
}

export type UnregisterOptionsSnapshot = Snapshot<
  Required<UnregisterOptions>,
  'UnregisterOptions'
>;

export function snapshotUnregisterOptions(
  options: UnregisterOptions | undefined,
): UnregisterOptionsSnapshot {
  return freezeSnapshot<UnregisterOptionsSnapshot>({
    // Defaults to true: only an explicit `false` opts out.
    stopIfRunning: options?.stopIfRunning !== false,
    forceStop: Boolean(options?.forceStop),
  });
}

/** `timeout` is kept as read: availability and handler refusals take precedence over it. */
export type SendMessageOptionsSnapshot = Snapshot<
  {
    includeStopped: boolean;
    includeStalled: boolean;
    timeout: SendMessageOptions['timeout'];
  },
  'SendMessageOptions'
>;

export function snapshotSendMessageOptions(
  options: SendMessageOptions | undefined,
): SendMessageOptionsSnapshot {
  return freezeSnapshot<SendMessageOptionsSnapshot>({
    includeStopped: options?.includeStopped === true,
    includeStalled: options?.includeStalled === true,
    timeout: options?.timeout,
  });
}

export type GetValueOptionsSnapshot = Snapshot<
  Required<GetValueOptions>,
  'GetValueOptions'
>;

export function snapshotGetValueOptions(
  options: GetValueOptions | undefined,
): GetValueOptionsSnapshot {
  return freezeSnapshot<GetValueOptionsSnapshot>({
    includeStopped: options?.includeStopped === true,
    includeStalled: options?.includeStalled === true,
  });
}

/**
 * `componentNames` is copied as it is read (see {@link copyTargetNames}); `timeout` is
 * kept as read and validated by the broadcast before it selects any target.
 */
export type BroadcastOptionsSnapshot = Snapshot<
  {
    componentNames: ReadonlySet<unknown> | undefined;
    includeStopped: boolean;
    includeStalled: boolean;
    timeout: BroadcastOptions['timeout'];
  },
  'BroadcastOptions'
>;

export function snapshotBroadcastOptions(
  options: BroadcastOptions | undefined,
): BroadcastOptionsSnapshot {
  return freezeSnapshot<BroadcastOptionsSnapshot>({
    componentNames: copyTargetNames(options?.componentNames ?? undefined),
    includeStopped: options?.includeStopped === true,
    includeStalled: options?.includeStalled === true,
    timeout: options?.timeout,
  });
}

/**
 * The most `componentNames` a broadcast filter is read for. Far above any registry this
 * manager is meant to hold - and duplicates or unknown names only cost a set entry each -
 * yet small enough that copying a list this long cannot stall the event loop.
 */
const MAX_BROADCAST_TARGET_NAMES = 100_000;

/**
 * The broadcast's `componentNames` filter, copied once by index - with the same bounded
 * copy `tryReadDependencies()` makes of a dependency list - into a set the filter
 * consults. The array is the caller's: a subclass or proxy runs its own code for
 * `length` and `includes`, and the filter would have asked it once per registered
 * component. A non-array, or a `length` that is not a plausible list size (a proxy can
 * claim `Infinity`), refuses the whole broadcast as an invalid option before it has
 * announced itself - as does a value `Array.isArray` cannot even classify (a revoked
 * proxy), which is no more usable as a list. A `length` or entry read that throws fails
 * it at the same point.
 */
function copyTargetNames(names: unknown): Set<unknown> | undefined {
  if (names === undefined) {
    return undefined;
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(names);
  } catch {
    isArray = false;
  }
  if (!isArray) {
    throw invalidOperationOptionError(
      'broadcastMessage componentNames must be an array',
    );
  }
  const entries = copyBoundedArray(
    names as readonly unknown[],
    MAX_BROADCAST_TARGET_NAMES,
    (length) =>
      invalidOperationOptionError(
        `broadcastMessage componentNames has an implausible length: ${length} (at most ${String(MAX_BROADCAST_TARGET_NAMES)})`,
      ),
  );
  const copy = new Set<unknown>();
  for (const name of entries) {
    copy.add(name);
  }
  return copy;
}
