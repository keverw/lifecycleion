import {
  safeHandleCallbackAndWait,
  reportCallbackError,
} from '../safe-handle-callback';
import { matchesFilter, matchesFilterPhase, scalarHeader } from './utils';
import {
  CallbackRegistry,
  copyCallbackPhase,
} from './internal/callback-registry';
import type { RegisteredCallback } from './internal/callback-registry';
import type {
  ResponseObserverFilter,
  ErrorObserverFilter,
  ResponseObserver,
  ErrorObserver,
  AttemptRequest,
  HTTPResponse,
  HTTPClientError,
  ResponseObserverPhase,
  ErrorObserverPhase,
} from './types';

const DEFAULT_OBSERVER_PHASES: ResponseObserverFilter['phases'] = ['final'];
const DEFAULT_ERROR_OBSERVER_PHASES: ErrorObserverFilter['phases'] = ['final'];

export class ResponseObserverManager extends CallbackRegistry<
  ResponseObserver,
  ResponseObserverFilter
> {
  constructor() {
    super(DEFAULT_OBSERVER_PHASES, 'HTTPClient response observer', {
      fields: [
        'phases',
        'hosts',
        'schemes',
        'statusCodes',
        'contentTypes',
        'contentTypeHeaders',
        'bodyContainsKeys',
      ],
      phases: ['retry', 'redirect', 'final'],
    });
  }

  /**
   * Take the current registrations as a chain that later `add()` and removal calls do
   * not reach. See `RequestInterceptorManager.snapshot()`.
   */
  public snapshot(): ResponseObserverChain {
    const observers = this.currentRegistrations();

    return async (response, request, phase, cancelSignal) => {
      if (!reachesAny(observers, phase.type)) {
        return;
      }

      const readContext = readFilterContext(() => ({
        status: response.status,
        method: request.method,
        requestURL: request.requestURL,
        body: response.body,
        contentType: response.contentType,
        contentTypeHeader: scalarHeader(response.headers, 'content-type'),
      }));

      await runObservers(
        'ResponseObserver',
        observers,
        cancelSignal,
        (filter) =>
          matchesFilterPhase(filter.phases, phase.type) &&
          matchesFilter(filter, readContext(), 'response'),
        () => [response, request, copyCallbackPhase(phase)],
      );
    };
  }
}

export type ResponseObserverChain = (
  response: HTTPResponse,
  request: AttemptRequest,
  phase: ResponseObserverPhase,
  cancelSignal?: AbortSignal,
) => Promise<void>;

export class ErrorObserverManager extends CallbackRegistry<
  ErrorObserver,
  ErrorObserverFilter
> {
  constructor() {
    super(DEFAULT_ERROR_OBSERVER_PHASES, 'HTTPClient error observer', {
      fields: ['phases', 'hosts', 'schemes'],
      phases: ['retry', 'final'],
    });
  }

  /**
   * Take the current registrations as a chain that later `add()` and removal calls do
   * not reach. See `RequestInterceptorManager.snapshot()`.
   */
  public snapshot(): ErrorObserverChain {
    const observers = this.currentRegistrations();

    return async (error, request, phase, cancelSignal) => {
      if (!reachesAny(observers, phase.type)) {
        return;
      }

      const readContext = readFilterContext(() => ({
        method: request.method,
        requestURL: request.requestURL,
      }));

      await runObservers(
        'ErrorObserver',
        observers,
        cancelSignal,
        (filter) =>
          matchesFilterPhase(filter.phases, phase.type) &&
          matchesFilter(filter, readContext(), 'error'),
        () => [error, request, copyCallbackPhase(phase)],
      );
    };
  }
}

export type ErrorObserverChain = (
  error: HTTPClientError,
  request: AttemptRequest,
  phase: ErrorObserverPhase,
  cancelSignal?: AbortSignal,
) => Promise<void>;

/** Whether any of `observers` is registered for `phaseType`, so the chain reads anything. */
function reachesAny<
  Filter extends { phases?: ResponseObserverFilter['phases'] },
>(
  observers: ReadonlyArray<RegisteredCallback<unknown, Filter>>,
  phaseType: ResponseObserverPhase['type'] | ErrorObserverPhase['type'],
): boolean {
  return observers.some(({ filter }) =>
    matchesFilterPhase(filter.phases, phaseType),
  );
}

/**
 * What the filters are matched against, read once, before any observer runs: each
 * observer is handed the same response and request, and one that rewrites them - its
 * `requestURL`, its `method` - must not change which of the rest they reach. The body is
 * read as a value: the keys `bodyContainsKeys` looks for are read from it by each filter
 * that names them, as the body is when that filter is asked. Read through
 * the returned function, which throws what the read threw, so each filter reports it and
 * its observer is skipped, as a filter that throws is.
 */
function readFilterContext<Context>(read: () => Context): () => Context {
  try {
    const context = read();
    return () => context;
  } catch (error) {
    return () => {
      throw error;
    };
  }
}

/**
 * Run each observer whose filter matches, in registration order, waiting for each before
 * the next. `matches` is asked once per observer, against what the chain read before the
 * first ran (see `readFilterContext`). A filter that throws is reported and its observer
 * skipped, and an observer that throws is reported without stopping the rest. Each observer's arguments come from
 * `argsFor`, so each is handed its own phase object. Once `cancelSignal` has aborted no
 * further observer runs: `send()` has stopped waiting on the chain, and may have answered.
 */
async function runObservers<Filter, Args extends unknown[]>(
  label: 'ResponseObserver' | 'ErrorObserver',
  observers: ReadonlyArray<RegisteredCallback<unknown, Filter>>,
  cancelSignal: AbortSignal | undefined,
  matches: (filter: Filter) => boolean,
  argsFor: () => Args,
): Promise<void> {
  for (const { fn, filter } of observers) {
    if (cancelSignal?.aborted) {
      return;
    }

    let doesMatch: boolean;
    try {
      doesMatch = matches(filter);
    } catch (filterError) {
      reportCallbackError(`${label} filter`, filterError);
      continue;
    }
    if (!doesMatch) {
      continue;
    }

    // Asked again: the filter reads the response - a body getter, say - and a cancel made
    // there stops the chain before this observer runs.
    if (cancelSignal?.aborted) {
      return;
    }

    await safeHandleCallbackAndWait(label, fn, ...argsFor());
  }
}

interface ObserverChainSource<Args extends unknown[]> {
  readonly isEmpty: boolean;
  snapshot(): (...args: Args) => Promise<void>;
}

/**
 * Run a parent client's observers, then a client's own, each from a snapshot taken
 * before either runs - as `HTTPClient._runInterceptors` takes them. An empty manager has
 * nothing to snapshot or run, and a missing parent is skipped.
 */
export async function runParentThenOwnObservers<Args extends unknown[]>(
  parent: ObserverChainSource<Args> | undefined,
  own: ObserverChainSource<Args>,
  ...args: Args
): Promise<void> {
  const parentChain =
    parent === undefined || parent.isEmpty ? undefined : parent.snapshot();
  const ownChain = own.isEmpty ? undefined : own.snapshot();

  if (parentChain) {
    await parentChain(...args);
  }

  if (ownChain) {
    await ownChain(...args);
  }
}
