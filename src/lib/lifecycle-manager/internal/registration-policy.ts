import type {
  ComponentOperationResult,
  InsertComponentAtResult,
  InsertPosition,
} from '../types';

/**
 * What a registration has done so far, shared with the safety net that wraps it: a
 * failure the registration's own catch could not answer - that catch throwing - must
 * still report a commit and an auto-start that happened, or a caller told otherwise
 * could register or start the component a second time.
 */
export interface RegistrationProgress {
  hasCommitted: boolean;
  // What the commit computed, filled in as each part is known, so a failure part-way
  // reports what was.
  committed: Partial<
    Pick<
      InsertComponentAtResult,
      'startupOrder' | 'manualPositionRespected' | 'targetFound'
    >
  >;
  // Whether a bulk startup was running when it committed. An independent auto-start
  // from a completion callback can finish after that startup releases its latch.
  wasDuringStartup: boolean;
  didAutoStartAttempt: boolean;
  isAutoStartDeferred: boolean;
  startResult: ComponentOperationResult | undefined;
  // Whether `component:registered` or `component:registration-rejected` went out for
  // this call, so it is announced exactly once whichever path answers.
  isAnnounced: boolean;
  // What this call's `getName()` answered, whatever it was; absent if it threw. The net
  // names the component from this rather than asking again - which runs the
  // component's code a second time, may answer differently, and would fall back to a
  // name an earlier registration of the same instance recorded.
  nameRead?: { value: unknown };
}

export function newRegistrationProgress(): RegistrationProgress {
  return {
    hasCommitted: false,
    committed: {},
    wasDuringStartup: false,
    didAutoStartAttempt: false,
    isAutoStartDeferred: false,
    startResult: undefined,
    isAnnounced: false,
  };
}

/** Whether `position` is relative to a target component: `before` or `after`. */
export function positionHasTarget(position: InsertPosition): boolean {
  return position === 'before' || position === 'after';
}

/**
 * `targetFound` for a registration refused before it looked for a target: `false` for a
 * position that has one, and absent for `start` / `end`.
 */
export function defaultTargetFound(
  position: InsertPosition,
): boolean | undefined {
  return positionHasTarget(position) ? false : undefined;
}

/**
 * The name to report a registration under, from what its `getName()` answered - never
 * by asking again. Only a string is a name; anything else is described by its type.
 */
export function reportedComponentName(progress: RegistrationProgress): string {
  if (progress.nameRead === undefined) {
    return '<unknown>';
  }

  const { value } = progress.nameRead;

  return typeof value === 'string'
    ? value
    : `<getName() returned ${value === null ? 'null' : typeof value}>`;
}

/**
 * What a registration reports - where it is, the order it computed, the target it
 * found, and an auto-start it attempted or left to a bulk startup - on its event and
 * its result, from the success path, the registration's own catch and the safety net
 * above it: built once, so they cannot drift. One that never committed reports a
 * refusal's defaults, and so does a part the failure came before.
 */
export function committedRegistrationReport(
  progress: RegistrationProgress,
  position: InsertPosition,
  actualPosition: InsertComponentAtResult['actualPosition'],
): Pick<
  InsertComponentAtResult,
  | 'startupOrder'
  | 'duringStartup'
  | 'actualPosition'
  | 'manualPositionRespected'
  | 'targetFound'
  | 'autoStartAttempted'
  | 'autoStartDeferred'
  | 'autoStartSucceeded'
> {
  const { committed } = progress;

  if (!progress.hasCommitted) {
    return {
      startupOrder: [],
      manualPositionRespected: undefined,
      targetFound: defaultTargetFound(position),
      autoStartAttempted: false,
    };
  }

  return {
    startupOrder: committed.startupOrder ?? [],
    duringStartup: progress.wasDuringStartup,
    actualPosition,
    manualPositionRespected: committed.manualPositionRespected,
    targetFound:
      'targetFound' in committed
        ? committed.targetFound
        : defaultTargetFound(position),
    autoStartAttempted: progress.didAutoStartAttempt,
    ...(progress.isAutoStartDeferred ? { autoStartDeferred: true } : {}),
    ...(progress.didAutoStartAttempt
      ? { autoStartSucceeded: progress.startResult?.success === true }
      : {}),
  };
}

/** Whether a value is a supported insertion position. */
export function isInsertPosition(value: unknown): value is InsertPosition {
  return (
    value === 'start' ||
    value === 'end' ||
    value === 'before' ||
    value === 'after'
  );
}

/** Whether the dependency-ordered position meets the requested placement. */
export function isManualPositionRespected(input: {
  componentName: string;
  position: InsertPosition;
  targetComponentName?: string;
  startupOrder: string[];
}): boolean {
  const compIdx = input.startupOrder.indexOf(input.componentName);
  if (compIdx === -1) {
    return false;
  }

  if (input.position === 'start') {
    return compIdx === 0;
  } else if (input.position === 'end') {
    return compIdx === input.startupOrder.length - 1;
  } else if (input.position === 'before' || input.position === 'after') {
    const targetIdx = input.startupOrder.indexOf(
      input.targetComponentName ?? '',
    );
    if (targetIdx === -1) {
      return false;
    }
    if (input.position === 'before') {
      return compIdx < targetIdx;
    }
    return compIdx > targetIdx;
  }

  return false;
}
