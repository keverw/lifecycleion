import { safeHandleCallbackAndWait } from '../safe-handle-callback';
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

  public async run(
    response: HTTPResponse,
    request: AttemptRequest,
    phase: ResponseObserverPhase,
  ): Promise<void> {
    for (const { fn, filter } of this.observers) {
      if (
        !matchesFilter(
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
        )
      ) {
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

  public async run(
    error: HTTPClientError,
    request: AttemptRequest,
    phase: ErrorObserverPhase,
  ): Promise<void> {
    for (const { fn, filter } of this.observers) {
      if (
        !matchesFilter(
          filter ?? {},
          {
            method: request.method,
            requestURL: request.requestURL,
          },
          phase.type,
          'error',
        )
      ) {
        continue;
      }

      await safeHandleCallbackAndWait(
        'ErrorObserver',
        fn,
        error,
        request,
        phase,
      );
    }
  }
}
