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

    return (response, request, phase) =>
      runObservers(
        'ResponseObserver',
        observers,
        (filter) =>
          matchesFilterPhase(filter?.phases, phase.type) &&
          matchesFilter(
            filter ?? {},
            {
              status: response.status,
              method: request.method,
              requestURL: request.requestURL,
              body: response.body,
              contentType: response.contentType,
              contentTypeHeader: scalarHeader(response.headers, 'content-type'),
            },
            'response',
          ),
        () => [response, request, copyCallbackPhase(phase)],
      );
  }
}

export type ResponseObserverChain = (
  response: HTTPResponse,
  request: AttemptRequest,
  phase: ResponseObserverPhase,
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

    return (error, request, phase) =>
      runObservers(
        'ErrorObserver',
        observers,
        (filter) =>
          matchesFilterPhase(filter?.phases, phase.type) &&
          matchesFilter(
            filter ?? {},
            {
              method: request.method,
              requestURL: request.requestURL,
            },
            'error',
          ),
        () => [error, request, copyCallbackPhase(phase)],
      );
  }
}

export type ErrorObserverChain = (
  error: HTTPClientError,
  request: AttemptRequest,
  phase: ErrorObserverPhase,
) => Promise<void>;

/**
 * Run each observer whose filter matches, in registration order, waiting for each before
 * the next. `matches` is asked once per observer, so a filter target is read afresh for
 * every one; a filter that throws is reported and its observer skipped, and an observer
 * that throws is reported without stopping the rest. Each observer's arguments come from
 * `argsFor`, so each is handed its own phase object.
 */
async function runObservers<Filter, Args extends unknown[]>(
  label: 'ResponseObserver' | 'ErrorObserver',
  observers: ReadonlyArray<RegisteredCallback<unknown, Filter>>,
  matches: (filter: Filter | undefined) => boolean,
  argsFor: () => Args,
): Promise<void> {
  for (const { fn, filter } of observers) {
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
