import {
  describeInvalidHTTPMethod,
  matchesFilter,
  matchesFilterPhase,
  mergeHeaders,
} from './utils';
import { normalizeStandardMethod } from './internal/http-method';
import { isPlainRecord } from './internal/plain-record';
import { describeValue } from '../internal/describe-value';
import { adoptPromise } from '../internal/adopt-promise';
import { releaseRequestBody } from './internal/request-body-copy';
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
  /**
   * Whether the request was cancelled, after which no further interceptor runs and the
   * chain returns a cancel of its own, with no reason: the caller reads the reason from
   * whatever cancelled the request.
   */
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
  /**
   * Called as an interceptor's function is about to be called, so a caller can tell a
   * result some interceptor was handed the request for - and may have rewritten in place
   * - from the request it passed, untouched.
   */
  onInterceptorCalled?: () => void;
  /**
   * Called once, as the first interceptor's function this phase calls is about to be
   * called - after its filter, which reads the request as it was handed over - and its
   * answer read in place of the request: the client hands each phase's interceptors a
   * copy of the parts of the request it keeps this way - the header record in the initial
   * phase, the body in the retry phase, both in the redirect phase - so one that edits
   * them in place edits neither the request a cancel or a failure reports, the body the
   * hop's later attempts start from, what a hop to an origin the caller never chose
   * sends, nor an upload still under way.
   * The filters up to and including that interceptor's read the request as handed over,
   * as on any other hop; the filters after it read the prepared request, or whatever an
   * interceptor returned in its place. A request no interceptor's function is called
   * for is never prepared, so a phase with nothing registered for it, or nothing its
   * filters match, pays nothing.
   */
  prepareRequest?: (request: InterceptedRequest) => InterceptedRequest;
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
    onInterceptorCalled,
    prepareRequest,
  }: InterceptorChainOptions,
): Promise<InterceptedRequest | InterceptorCancel> {
  let current = request;
  /** Whether `current` is an interceptor's result, not yet copied. */
  let isCurrentUncopied = isInterceptorResult;
  /** `prepareRequest` while it is still to be called. */
  let pendingPrepare = prepareRequest;

  for (const { fn, filter } of interceptors) {
    // A cancel made by an earlier interceptor, or while it ran, ends the chain: the request
    // is not dispatched, so the rest - a token refresh, say - has nothing to prepare.
    if (isCancelled?.()) {
      break;
    }

    // Asked first, and only here - `matchesFilter` leaves `phases` to it - as it reads only
    // the filter: an interceptor this phase never reaches (one registered for `retry`
    // alone, in the initial phase) reads no request, so it takes no copy - and cannot
    // change how a result that fails to copy is reported.
    if (!matchesFilterPhase(filter.phases, phase.type)) {
      continue;
    }

    // An earlier interceptor's result, copied before this one's filter and function read
    // it, as the chain's own result is copied once it ends (see
    // `snapshotInterceptedRequest`). Uncopied, the two would read it apart: a
    // `requestURL` getter that answers a trusted host to a filter and another to the
    // interceptor it guards would hand a token interceptor's credentials to the other
    // host. Copied only once an interceptor is reached that will read it, so a result no
    // later interceptor reads is left for the phase to copy. A copy that fails here hands
    // the phase that result, so the failure is reported from it either way.
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
        filter,
        {
          method: current.method,
          requestURL: current.requestURL,
          body: current.body,
        },
        'request',
      )
    ) {
      continue;
    }

    // After the filter, which reads the request as it was handed over, so this filter
    // and every one before it match as they do where nothing is prepared; before the
    // function, the first that can touch the request. Later filters read what it
    // returns.
    if (pendingPrepare !== undefined) {
      current = pendingPrepare(current);
      pendingPrepare = undefined;
    }

    onInterceptorCalled?.();

    // Caller code may keep the body it is handed and change it in place, so a JSON copy
    // the client took is no longer sent as the text it was read from.
    releaseRequestBody(current.body);

    let result: Awaited<ReturnType<RequestInterceptor>>;
    try {
      // Adopted, not awaited as it is: an interceptor is caller code, and one returning
      // a native promise with its own `constructor` and a no-op `then` would hang the
      // request. See `adoptPromise()`.
      ({ value: result } = await adoptPromise(
        // The context too, its `redirectHistory` with it: one shared per chain would let
        // an interceptor that pushes to it or rewrites a field change what the next is
        // told.
        fn(current, copyCallbackPhase(phase), {
          ...context,
          redirectHistory: [...context.redirectHistory],
        }),
      ));
    } catch (error) {
      // A cancel made before the interceptor threw - by that interceptor, say - ends the
      // chain as a cancel, not a failure: whoever cancelled was told the request is
      // cancelled, and it never goes out, so the error is dropped as its result would be.
      if (isCancelled?.()) {
        break;
      }
      throw error;
    }

    // A cancel made while the interceptor ran ends the chain before its result is read:
    // that result is never sent, so a value that is no request - `undefined` from an
    // interceptor that cancelled and returned nothing - is not refused, and a request it
    // returned is neither copied nor reported.
    if (isCancelled?.()) {
      break;
    }

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

  // A cancel, of the chain's own, rather than the request it reached - which may be an
  // interceptor's result, not yet copied: the request is not sent, so nothing reads that
  // result, and the chain's answer says it was cancelled, so every phase ends it as it
  // ends an interceptor's cancel. Asked here, once, for every way out of the loop above,
  // and for a cancel made while a result was read as a cancel or not - a `Proxy` whose
  // `has` trap cancels.
  return isCancelled?.() ? makeInterceptorCancel(undefined) : current;
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
 * `requestURL` getter that answers `https://api.example/x` to the check and
 * `https://evil.example/` afterwards would attach `api.example`'s cookies to a request
 * sent to `evil.example`. Taken here, once, every later check and use sees the same
 * values.
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
      `[HTTPClient] Interceptor returned a request whose requestURL is not a string (got ${describeValue(requestURL)}).`,
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

/**
 * A cancel of the client's own, which {@link isInterceptorCancel} tells from a request,
 * carrying `reason` when there is one.
 */
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
