import { matchesFilter } from './utils';
import { adoptPromise } from '../internal/adopt-promise';
import {
  CallbackRegistry,
  type RegisteredCallback,
} from './internal/callback-registry';
import type {
  RequestInterceptorFilter,
  RequestInterceptor,
  RequestInterceptorContext,
  InterceptedRequest,
  InterceptorCancel,
  InterceptorPhase,
} from './types';

const DEFAULT_INTERCEPTOR_PHASES: RequestInterceptorFilter['phases'] = [
  'initial',
];

export class RequestInterceptorManager extends CallbackRegistry<
  RequestInterceptor,
  RequestInterceptorFilter
> {
  constructor() {
    super(DEFAULT_INTERCEPTOR_PHASES);
  }

  /**
   * Copy the current registrations into a chain that later `add()` and removal calls do
   * not reach. A client takes its parent's snapshot and its own together when a chain run
   * begins - once per phase of a request - so a callback registered on either while the
   * other's chain is awaiting applies to the next chain run, not this one.
   */
  public snapshot(): InterceptorChain {
    const interceptors = this.copyRegistrations();

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
  interceptors: ReadonlyArray<
    RegisteredCallback<RequestInterceptor, RequestInterceptorFilter>
  >,
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
      return makeInterceptorCancel(undefined);
    }

    // Interceptor signalled cancellation with optional reason. Only `cancel: true`
    // cancels: a request carrying `cancel: false` is passed on as a request.
    if (result && 'cancel' in result && result.cancel === true) {
      // Read once, and kept only as a string: it becomes `cancelReason`, which is
      // typed as one, as the stream factory's cancel reason is.
      const reason: unknown = result.reason;

      return makeInterceptorCancel(
        typeof reason === 'string' ? reason : undefined,
      );
    }

    current = result as InterceptedRequest;
  }

  return current;
}

/**
 * The cancels a chain has returned. Each is the chain's own object rather than the
 * interceptor's, so telling one from a request reads nothing the caller supplied: a
 * request whose `cancel` key is `false`, or whose getter answers differently on a
 * second read, cannot be taken for a cancel once the chain has passed it on.
 */
const interceptorCancels = new WeakSet<object>();

function makeInterceptorCancel(reason: string | undefined): InterceptorCancel {
  const cancel: InterceptorCancel =
    reason !== undefined ? { cancel: true, reason } : { cancel: true };
  interceptorCancels.add(cancel);

  return cancel;
}

/** Whether an {@link InterceptorChain} result is a cancel rather than a request. */
export function isInterceptorCancel(
  result: InterceptedRequest | InterceptorCancel,
): result is InterceptorCancel {
  return interceptorCancels.has(result);
}
