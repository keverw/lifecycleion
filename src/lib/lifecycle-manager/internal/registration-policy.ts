import type { BaseComponent } from '../base-component';
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
  // `true` once the lookup found a relative position's target, so a failure after it -
  // a throwing `getDependencies()`, a failed hook - reports the target as found.
  // Absent before the lookup, and for `start` / `end`.
  targetFound?: true;
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
 * position that has one, and absent for `start` / `end`. One that failed after its
 * lookup found the target reports `progress.targetFound` instead.
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
      targetFound: progress.targetFound ?? defaultTargetFound(position),
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
        : (progress.targetFound ?? defaultTargetFound(position)),
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

/**
 * The timeout hooks the abort signals replaced, each with the reason a registration of a
 * component that still defines it is refused. The manager no longer calls them, so a
 * component relying on one would otherwise lose that behavior silently - in
 * `onStartupAborted()`'s case, also its opt-out of automatic late-start cleanup.
 */
const REMOVED_TIMEOUT_HOOKS: readonly (readonly [string, string])[] = [
  [
    'onStartupAborted',
    'onStartupAborted() was removed: use the AbortSignal passed to start(); set ownsLateStartCleanup: true if the component cleans up a late start itself',
  ],
  [
    'onGracefulStopTimeout',
    'onGracefulStopTimeout() was removed: use the AbortSignal passed to stop()',
  ],
  [
    'onShutdownForceAborted',
    'onShutdownForceAborted() was removed: use the AbortSignal passed to onShutdownForce()',
  ],
];

/**
 * Why `component` cannot be registered because it still defines a removed timeout hook,
 * as an own or inherited property, or `undefined` when it defines none. Each property is
 * read once, through `Reflect.get`: a value other than `undefined`
 * defines the hook, and so does a getter that throws - an accessor there is a definition
 * the component made. Never throws for the component's own code.
 */
export function removedTimeoutHooksReason(
  component: BaseComponent,
  componentName: string,
): string | undefined {
  const found: string[] = [];
  for (const [hook, reason] of REMOVED_TIMEOUT_HOOKS) {
    let isDefined: boolean;
    try {
      isDefined = Reflect.get(component, hook) !== undefined;
    } catch {
      isDefined = true;
    }
    if (isDefined) {
      found.push(reason);
    }
  }

  if (found.length === 0) {
    return undefined;
  }

  return found.length === 1
    ? `Component "${componentName}" defines a removed hook: ${found[0]}`
    : `Component "${componentName}" defines removed hooks: ${found.join('; ')}`;
}
