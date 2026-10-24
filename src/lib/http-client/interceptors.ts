import {
  describeInvalidHTTPMethod,
  matchesFilter,
  matchesFilterPhase,
  mergeHeaders,
} from './utils';
import { normalizeStandardMethod } from './internal/http-method';
import { isPlainRecord } from './internal/plain-record';
import { adoptPromise } from '../internal/adopt-promise';
import {
  CallbackRegistry,
  copyCallbackPhase,
} from './internal/callback-registry';
import type { RegisteredCallback } from './internal/callback-registry';
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
    super(DEFAULT_INTERCEPTOR_PHASES, 'HTTPClient request interceptor', {
      fields: ['phases', 'hosts', 'schemes', 'bodyContainsKeys'],
      phases: ['initial', 'retry', 'redirect'],
    });
  }

  /**
   * Take the current registrations as a chain that later `add()` and removal calls do
   * not reach. A client takes its parent's snapshot and its own together when a chain run
   * begins - once per phase of a request - so a callback registered on either while the
   * other's chain is awaiting applies to the next chain run, not this one.
   */
  public snapshot(): InterceptorChain {
    const interceptors = this.currentRegistrations();

    return (request, phase, context, options) =>
      runInterceptors(interceptors, request, phase, context, options ?? {});
  }
}

export type InterceptorChain = (
  request: InterceptedRequest,
  phase: InterceptorPhase,
  context: RequestInterceptorContext,
  options?: InterceptorChainOptions,
) => Promise<InterceptedRequest | InterceptorCancel>;

export interface InterceptorChainOptions {
  /** Whether the request was cancelled, after which no further interceptor runs. */
  isCancelled?: () => boolean;
  /**
   * Whether `request` may be an interceptor's result - a parent client's chain's - rather
   * than one the client built, so it is copied before an interceptor here reads it.
   */
  isInterceptorResult?: boolean;
  /**
   * Handed the interceptor result whose copy failed, before the failure is thrown, so the
   * phase reports from it as it does when its own copy of the chain's result fails.
   */
  onCopyFailure?: (request: InterceptedRequest) => void;
}

async function runInterceptors(
  interceptors: ReadonlyArray<
    RegisteredCallback<RequestInterceptor, RequestInterceptorFilter>
  >,
  request: InterceptedRequest,
  phase: InterceptorPhase,
  context: RequestInterceptorContext,
  {
    isCancelled,
    isInterceptorResult = false,
    onCopyFailure,
  }: InterceptorChainOptions,
): Promise<InterceptedRequest | InterceptorCancel> {
  let current = request;
  /** Whether `current` is an interceptor's result, not yet copied. */
  let isCurrentUncopied = isInterceptorResult;

  for (const { fn, filter } of interceptors) {
    // A cancel made by an earlier interceptor, or while it ran, ends the chain: the request
    // is not dispatched, so the rest - a token refresh, say - has nothing to prepare.
    if (isCancelled?.()) {
      return current;
    }

    // Asked first, as it reads only the filter: an interceptor this phase never reaches
    // (one registered for `retry` alone, in the initial phase) reads no request, so it
    // takes no copy - and cannot change how a result that fails to copy is reported.
    if (!matchesFilterPhase(filter?.phases, phase.type)) {
      continue;
    }

    // An earlier interceptor's result, copied before this one's filter and function read
    // it, as the chain's own result is copied once it ends (see
    // `snapshotInterceptedRequest`). Uncopied, the two read it apart: a `requestURL`
    // getter that answered a trusted host to a filter and another to the interceptor it
    // guards handed a token interceptor's credentials to the other host. Copied only once
    // an interceptor is reached that will read it, so a result no later interceptor reads
    // is left for the phase to copy. A copy that fails here hands the phase that result,
    // so the failure is reported from it either way.
    if (isCurrentUncopied) {
      try {
        current = snapshotInterceptedRequest(current);
      } catch (error) {
        onCopyFailure?.(current);
        throw error;
      }
      isCurrentUncopied = false;
    }

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
    // a native promise with its own `constructor` and a no-op `then` would hang the
    // request. See `adoptPromise()`.
    const { value: result } = await adoptPromise(
      // The context too, its `redirectHistory` with it: one shared per chain let an
      // interceptor that pushed to it or rewrote a field change what the next was told.
      fn(current, copyCallbackPhase(phase), {
        ...context,
        redirectHistory: [...context.redirectHistory],
      }),
    );

    // null is shorthand for { cancel: true } with no reason
    if (result === null) {
      return makeInterceptorCancel(undefined);
    }

    // Refused here, before anything reads it as a request: an `in` check on a primitive
    // throws its own obscure TypeError, and a forgotten `return request` answers
    // `undefined`, which the next interceptor's filter would fail to read.
    const candidate: unknown = result;
    if (typeof candidate !== 'object') {
      throw new TypeError(
        `[HTTPClient] Interceptor returned a value that is not a request, a cancel or null (got ${typeof candidate}).`,
      );
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
    isCurrentUncopied = true;
  }

  return current;
}

/**
 * Read a request an interceptor returned once, into a plain object the client owns: in the
 * chain, before the next interceptor reads it (see `runInterceptors`), and the chain's
 * result in each phase once the chain ends.
 *
 * An interceptor's result is caller code: any member can be a getter, and the header
 * record a `Proxy` or an object whose entries are getters. Everything after it validates
 * a field and then uses it - the next interceptor's filter and then the interceptor; once
 * the chain is done, the URL is checked as http(s), then read again for the cookie jar
 * and again for the adapter; the headers are checked against the browser-restricted
 * list, then merged for dispatch - and each of those reads could answer differently. A
 * `requestURL` getter that answered `https://api.example/x` to the check and
 * `https://evil.example/` afterwards attached `api.example`'s cookies to a request sent
 * to `evil.example`. Taken here, once, every later check and use sees the same values.
 *
 * Header values are normalized here as `mergeHeaders` normalizes them for dispatch - a
 * single value converted to a string, an array's elements each converted, and a
 * one-element array collapsed to its string - so a value whose `toString` answers
 * differently on each call is checked and sent as one string. Names are lowercased, and
 * an unset value removes the header whatever its capitalization. A standard method is
 * uppercased (see `normalizeStandardMethod`), so a `post` is the `POST` the retry and
 * redirect rules check for; any other method is kept as given.
 * Throws on a `requestURL` that is not a string, a `method` that is not a method name
 * (see `describeInvalidHTTPMethod`), or `headers` that is not a plain object (an array, a
 * `Headers` or a `Map` is refused), and on any read or conversion that throws; each phase
 * reports that as the interceptor's failure.
 */
export function snapshotInterceptedRequest(
  request: InterceptedRequest,
): ResolvedRequest {
  const { requestURL, method, headers, body } = request;

  if (typeof requestURL !== 'string') {
    throw new TypeError(
      `[HTTPClient] Interceptor returned a request whose requestURL is not a string (got ${requestURL === null ? 'null' : typeof requestURL}).`,
    );
  }

  const methodProblem = describeInvalidHTTPMethod(method);

  if (methodProblem !== undefined) {
    throw new TypeError(
      `[HTTPClient] Interceptor returned a request whose method ${methodProblem}.`,
    );
  }

  const normalizedMethod = normalizeStandardMethod(method);

  const candidateHeaders: unknown = headers;

  // A plain record only (see `isPlainRecord`): a `Headers` or `Map` would have every
  // header it carries silently dropped, and an array's indices taken for names.
  if (!isPlainRecord(candidateHeaders)) {
    const got =
      candidateHeaders === null
        ? 'null'
        : Array.isArray(candidateHeaders)
          ? 'an array'
          : typeof candidateHeaders !== 'object'
            ? typeof candidateHeaders
            : 'an object with a non-Object prototype, such as Headers or Map';
    throw new TypeError(
      `[HTTPClient] Interceptor returned a request whose headers is not a plain object (got ${got}).`,
    );
  }

  // Read as every other phase's headers are: names lowercased, and an unset value
  // removing the header, whatever its capitalization -
  // `{ ...request.headers, Authorization: undefined }` drops `authorization` rather
  // than sending it.
  const headersSnapshot = mergeHeaders(
    candidateHeaders as Record<string, string | string[]>,
  );

  return {
    requestURL,
    method: normalizedMethod,
    headers: headersSnapshot,
    body,
  };
}

/**
 * A request as the client holds it once its headers are normalized - names lowercased,
 * values strings or arrays, unset ones removed: what `snapshotInterceptedRequest` returns
 * and what the attempt loop sends. Typed apart from {@link InterceptedRequest}, whose
 * headers may still carry an interceptor's `undefined`, so a step that only copies
 * headers can rely on that without normalizing them again.
 */
export type ResolvedRequest = Omit<InterceptedRequest, 'headers'> & {
  headers: Record<string, string | string[]>;
};

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
