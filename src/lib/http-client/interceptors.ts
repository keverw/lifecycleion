import { matchesFilter } from './utils';
import { adoptPromise } from '../internal/adopt-promise';
import type {
  RequestInterceptorFilter,
  RequestInterceptor,
  RequestInterceptorContext,
  InterceptedRequest,
  InterceptorCancel,
  InterceptorPhase,
} from './types';

interface RegisteredInterceptor<T> {
  fn: T;
  filter?: RequestInterceptorFilter;
}

type RemoveFn = () => void;
const DEFAULT_INTERCEPTOR_PHASES: RequestInterceptorFilter['phases'] = [
  'initial',
];

export class RequestInterceptorManager {
  private interceptors: RegisteredInterceptor<RequestInterceptor>[] = [];

  public add(
    fn: RequestInterceptor,
    filter?: RequestInterceptorFilter,
  ): RemoveFn {
    const entry: RegisteredInterceptor<RequestInterceptor> = {
      fn,
      filter: {
        ...filter,
        phases: filter?.phases ?? DEFAULT_INTERCEPTOR_PHASES,
      },
    };
    this.interceptors.push(entry);

    return () => {
      const idx = this.interceptors.indexOf(entry);

      if (idx !== -1) {
        this.interceptors.splice(idx, 1);
      }
    };
  }

  /** Whether nothing is registered, so a chain taken now would hand the request back. */
  public get isEmpty(): boolean {
    return this.interceptors.length === 0;
  }

  /**
   * Copy the current registrations into a chain that later `add()` and removal calls do
   * not reach. A client takes its parent's snapshot and its own together when a chain run
   * begins - once per phase of a request - so a callback registered on either while the
   * other's chain is awaiting applies to the next chain run, not this one.
   */
  public snapshot(): InterceptorChain {
    const interceptors = this.interceptors.slice();

    return (request, phase, context) =>
      runInterceptors(interceptors, request, phase, context);
  }
}

export type InterceptorChain = (
  request: InterceptedRequest,
  phase: InterceptorPhase,
  context: RequestInterceptorContext,
) => Promise<InterceptedRequest | InterceptorCancel>;

async function runInterceptors(
  interceptors: readonly RegisteredInterceptor<RequestInterceptor>[],
  request: InterceptedRequest,
  phase: InterceptorPhase,
  context: RequestInterceptorContext,
): Promise<InterceptedRequest | InterceptorCancel> {
  let current = request;

  for (const { fn, filter } of interceptors) {
    if (
      !matchesFilter(
        filter ?? {},
        {
          method: current.method,
          requestURL: current.requestURL,
          body: current.body,
        },
        phase.type,
        'request',
      )
    ) {
      continue;
    }

    // Adopted, not awaited as it is: an interceptor is caller code, and one returning
    // a native promise with its own `constructor` and a no-op `then` hung the
    // request. See `adoptPromise()`.
    const { value: result } = await adoptPromise(fn(current, phase, context));

    // null is shorthand for { cancel: true } with no reason
    if (result === null) {
      return { cancel: true };
    }

    // Interceptor signalled cancellation with optional reason
    if (result && 'cancel' in result && result.cancel === true) {
      return result;
    }

    current = result as InterceptedRequest;
  }

  return current;
}
