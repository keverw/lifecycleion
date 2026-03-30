import { matchesFilter } from './utils';
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

  public async run(
    request: InterceptedRequest,
    phase: InterceptorPhase,
    context: RequestInterceptorContext,
  ): Promise<InterceptedRequest | InterceptorCancel> {
    let current = request;

    for (const { fn, filter } of this.interceptors) {
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

      const result = await fn(current, phase, context);

      // Interceptor signalled cancellation
      if (result && 'cancel' in result && result.cancel === true) {
        return result;
      }

      current = result as InterceptedRequest;
    }

    return current;
  }
}
