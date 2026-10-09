import {
  safeHandleCallbackAndWait,
  reportCallbackError,
} from '../safe-handle-callback';
import { matchesFilter, scalarHeader } from './utils';
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

type RemoveFn = () => void;
const DEFAULT_OBSERVER_PHASES: ResponseObserverFilter['phases'] = ['final'];
const DEFAULT_ERROR_OBSERVER_PHASES: ErrorObserverFilter['phases'] = ['final'];

export class ResponseObserverManager {
  private observers: Array<{
    fn: ResponseObserver;
    filter?: ResponseObserverFilter;
  }> = [];

  public add(fn: ResponseObserver, filter?: ResponseObserverFilter): RemoveFn {
    const entry = {
      fn,
      filter: {
        ...filter,
        phases: filter?.phases ?? DEFAULT_OBSERVER_PHASES,
      },
    };
    this.observers.push(entry);

    return () => {
      const idx = this.observers.indexOf(entry);

      if (idx !== -1) {
        this.observers.splice(idx, 1);
      }
    };
  }

  /** Whether nothing is registered. See `RequestInterceptorManager.isEmpty`. */
  public get isEmpty(): boolean {
    return this.observers.length === 0;
  }

  /**
   * Copy the current registrations into a chain that later `add()` and removal calls do
   * not reach. See `RequestInterceptorManager.snapshot()`.
   */
  public snapshot(): ResponseObserverChain {
    const observers = this.observers.slice();

    return (response, request, phase) =>
      runResponseObservers(observers, response, request, phase);
  }
}

export type ResponseObserverChain = (
  response: HTTPResponse,
  request: AttemptRequest,
  phase: ResponseObserverPhase,
) => Promise<void>;

async function runResponseObservers(
  observers: ReadonlyArray<{
    fn: ResponseObserver;
    filter?: ResponseObserverFilter;
  }>,
  response: HTTPResponse,
  request: AttemptRequest,
  phase: ResponseObserverPhase,
): Promise<void> {
  for (const { fn, filter } of observers) {
    let doesMatch: boolean;
    try {
      doesMatch = matchesFilter(
        filter ?? {},
        {
          status: response.status,
          method: request.method,
          requestURL: request.requestURL,
          body: response.body,
          contentType: response.contentType,
          contentTypeHeader: scalarHeader(response.headers, 'content-type'),
        },
        phase.type,
        'response',
      );
    } catch (filterError) {
      reportCallbackError('ResponseObserver filter', filterError);
      continue;
    }
    if (!doesMatch) {
      continue;
    }

    await safeHandleCallbackAndWait(
      'ResponseObserver',
      fn,
      response,
      request,
      phase,
    );
  }
}

export class ErrorObserverManager {
  private observers: Array<{
    fn: ErrorObserver;
    filter?: ErrorObserverFilter;
  }> = [];

  public add(fn: ErrorObserver, filter?: ErrorObserverFilter): RemoveFn {
    const entry = {
      fn,
      filter: {
        ...filter,
        phases: filter?.phases ?? DEFAULT_ERROR_OBSERVER_PHASES,
      },
    };
    this.observers.push(entry);

    return () => {
      const idx = this.observers.indexOf(entry);

      if (idx !== -1) {
        this.observers.splice(idx, 1);
      }
    };
  }

  /** Whether nothing is registered. See `RequestInterceptorManager.isEmpty`. */
  public get isEmpty(): boolean {
    return this.observers.length === 0;
  }

  /**
   * Copy the current registrations into a chain that later `add()` and removal calls do
   * not reach. See `RequestInterceptorManager.snapshot()`.
   */
  public snapshot(): ErrorObserverChain {
    const observers = this.observers.slice();

    return (error, request, phase) =>
      runErrorObservers(observers, error, request, phase);
  }
}

export type ErrorObserverChain = (
  error: HTTPClientError,
  request: AttemptRequest,
  phase: ErrorObserverPhase,
) => Promise<void>;

async function runErrorObservers(
  observers: ReadonlyArray<{
    fn: ErrorObserver;
    filter?: ErrorObserverFilter;
  }>,
  error: HTTPClientError,
  request: AttemptRequest,
  phase: ErrorObserverPhase,
): Promise<void> {
  for (const { fn, filter } of observers) {
    let doesMatch: boolean;
    try {
      doesMatch = matchesFilter(
        filter ?? {},
        {
          method: request.method,
          requestURL: request.requestURL,
        },
        phase.type,
        'error',
      );
    } catch (filterError) {
      reportCallbackError('ErrorObserver filter', filterError);
      continue;
    }
    if (!doesMatch) {
      continue;
    }

    await safeHandleCallbackAndWait('ErrorObserver', fn, error, request, phase);
  }
}
