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
import { copyHeaderRecord } from './internal/header-utils';
import {
  handedBodyValue,
  isBuildFailureUnreported,
} from './internal/observed-bodies';
import type { HeldAttemptRequest } from './internal/observed-bodies';
import { once } from './internal/once';
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
   * not reach. See `RequestInterceptorManager.snapshot()`. Run through
   * `runParentThenOwnResponseObservers`, which hands a parent's chain and the client's own
   * one request and one filter context.
   */
  public snapshot(): ResponseObserverChain {
    const observers = this.currentRegistrations();

    return (response, handedRequest, phase, cancelSignal, readContext) =>
      runObservers(
        'ResponseObserver',
        observers,
        cancelSignal,
        (filter) =>
          matchesFilterPhase(filter.phases, phase.type) &&
          matchesFilter(filter, readContext(), 'response'),
        () => [response, handedRequest(), copyCallbackPhase(phase)],
      );
  }
}

type ResponseObserverChain = (
  response: HTTPResponse,
  handedRequest: () => AttemptRequest,
  phase: ResponseObserverPhase,
  cancelSignal: AbortSignal | undefined,
  readContext: () => ObserverFilterContext,
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
   * not reach. See `ResponseObserverManager.snapshot()`; run through
   * `runParentThenOwnErrorObservers`.
   */
  public snapshot(): ErrorObserverChain {
    const observers = this.currentRegistrations();

    return (error, handedRequest, phase, cancelSignal, readContext) =>
      runObservers(
        'ErrorObserver',
        observers,
        cancelSignal,
        (filter) =>
          matchesFilterPhase(filter.phases, phase.type) &&
          matchesFilter(filter, readContext(), 'error'),
        () => [error, handedRequest(), copyCallbackPhase(phase)],
      );
  }
}

type ErrorObserverChain = (
  error: HTTPClientError,
  handedRequest: () => AttemptRequest,
  phase: ErrorObserverPhase,
  cancelSignal: AbortSignal | undefined,
  readContext: () => ObserverFilterContext,
) => Promise<void>;

/** What an observer's filter is matched against; see `matchesFilter`. */
type ObserverFilterContext = Parameters<typeof matchesFilter>[1];

/**
 * What the filters are matched against, read the first time a filter asks for it - by
 * the first observer registered for the phase, so before any observer has run - and
 * kept (see `once`): each observer is handed the same response and request, and one that
 * rewrites them - its `requestURL`, its `method` - must not change which of the rest they
 * reach. A chain with no observer for the phase reads nothing. The body is read as a
 * value: the keys `bodyContainsKeys` looks for are read from it by each filter that names
 * them, as the body is when that filter is asked. A read that throws is kept as well and
 * thrown to each filter that asks, so each reports it and its observer is skipped, as a
 * filter that throws is. This one is a response observer's.
 */
function readResponseFilterContext(
  response: HTTPResponse,
  request: HeldAttemptRequest,
): () => ObserverFilterContext {
  return once(() => ({
    status: response.status,
    method: request.method,
    requestURL: request.requestURL,
    body: response.body,
    contentType: response.contentType,
    contentTypeHeader: scalarHeader(response.headers, 'content-type'),
  }));
}

/**
 * An error observer's filter context, read as a response observer's is; see
 * `readResponseFilterContext`.
 */
function readErrorFilterContext(
  request: HeldAttemptRequest,
): () => ObserverFilterContext {
  return once(() => ({
    method: request.method,
    requestURL: request.requestURL,
  }));
}

/**
 * Run each observer whose filter matches, in registration order, waiting for each before
 * the next. `matches` is asked once per observer, against what was read before the first
 * ran (see `readResponseFilterContext`). A filter that throws is reported and its observer
 * skipped, and an observer that throws is reported without stopping the rest. Each
 * observer's arguments come from `argsFor`, so each is handed its own phase object. Once
 * `cancelSignal` has aborted no further observer runs: `send()` has stopped waiting on
 * the chain, and may have answered.
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

/**
 * Run a response's observers: a parent client's, then a client's own. See
 * `runParentThenOwn`.
 */
export function runParentThenOwnResponseObservers(
  parent: ResponseObserverManager | undefined,
  own: ResponseObserverManager,
  response: HTTPResponse,
  request: HeldAttemptRequest,
  phase: ResponseObserverPhase,
  cancelSignal?: AbortSignal,
): Promise<void> {
  return runParentThenOwn(
    'ResponseObserver',
    parent,
    own,
    request,
    readResponseFilterContext(response, request),
    (chain, handedRequest, readContext) =>
      chain(response, handedRequest, phase, cancelSignal, readContext),
  );
}

/**
 * Run an error's observers: a parent client's, then a client's own. See
 * `runParentThenOwn`.
 */
export function runParentThenOwnErrorObservers(
  parent: ErrorObserverManager | undefined,
  own: ErrorObserverManager,
  error: HTTPClientError,
  request: HeldAttemptRequest,
  phase: ErrorObserverPhase,
  cancelSignal?: AbortSignal,
): Promise<void> {
  return runParentThenOwn(
    'ErrorObserver',
    parent,
    own,
    request,
    readErrorFilterContext(request),
    (chain, handedRequest, readContext) =>
      chain(error, handedRequest, phase, cancelSignal, readContext),
  );
}

/**
 * Run a parent client's observers, then a client's own, each from a snapshot taken
 * before either runs - as `HTTPClient._runInterceptors` takes them. An empty manager has
 * nothing to snapshot or run, and a missing parent is skipped.
 *
 * The observers of both chains are handed one copy of `request`, its header record copied
 * too, so an observer's edit to it in place - redacting `requestURL` or a header - is seen
 * by the observers after it and by nothing the client goes on to read: the method the
 * next redirect hop is judged by, the request a cancelled retry wait is reported with.
 * The body and `rawBody` are the attempt's own (see `AttemptRequest`), built as the copy is
 * taken: a JSON `rawBody` parsed back, bytes or a form copied (see `handedBodyValue`). The
 * copy is taken when the first observer runs, so a phase no observer runs for copies and
 * parses nothing.
 *
 * The filters of both chains are matched against `readContext`, read before the first
 * observer of either runs (see `readResponseFilterContext`) from `request` - which no observer
 * is handed - and the response or error, so a parent's observer that rewrites the
 * request, or the response's status, content type or body, does not change which of the
 * client's own run. A `bodyContainsKeys` filter reads the keys of that body when it is
 * asked, so an observer that changes the body's contents in place is seen by the filters
 * after it, a sub-client's included.
 */
async function runParentThenOwn<Chain>(
  label: 'ResponseObserver' | 'ErrorObserver',
  parent: { readonly isEmpty: boolean; snapshot(): Chain } | undefined,
  own: { readonly isEmpty: boolean; snapshot(): Chain },
  request: HeldAttemptRequest,
  readContext: () => ObserverFilterContext,
  run: (
    chain: Chain,
    handedRequest: () => AttemptRequest,
    readContext: () => ObserverFilterContext,
  ) => Promise<void>,
): Promise<void> {
  const parentChain =
    parent === undefined || parent.isEmpty ? undefined : parent.snapshot();
  const ownChain = own.isEmpty ? undefined : own.snapshot();

  // Built once, by the first observer of either chain to run. A body that cannot be built -
  // bytes the adapter detached, say - is reported once for the attempt, whichever phases
  // hand its request out (see `isBuildFailureUnreported`), and the observers are handed
  // the request without it, so each still hears of the response or error.
  const handedRequest = once((): AttemptRequest => {
    try {
      return attemptRequestCopy(request, 'built');
    } catch (buildError) {
      if (isBuildFailureUnreported([request.body, request.rawBody])) {
        reportCallbackError(label, buildError);
      }
      return attemptRequestCopy(request, 'none');
    }
  });

  if (parentChain !== undefined) {
    await run(parentChain, handedRequest, readContext);
  }

  if (ownChain !== undefined) {
    await run(ownChain, handedRequest, readContext);
  }
}

/**
 * The copy of an attempt's request its observers are handed; see `runParentThenOwn`. The
 * request is the client's own, built from its records, so copying it reads no caller code.
 * With `bodies` `'built'` its body and `rawBody` are built (see `handedBodyValue`); with
 * `'none'` - its body could not be built - the copy has a `body` of `null` and a `rawBody`
 * of `undefined`, as a request whose body an interceptor returned could not be built is
 * reported.
 */
function attemptRequestCopy(
  request: HeldAttemptRequest,
  bodies: 'built' | 'none',
): AttemptRequest {
  const { body, rawBody, ...fields } = request;
  const handed: AttemptRequest = {
    ...fields,
    headers: copyHeaderRecord(request.headers),
  };

  if ('body' in request) {
    handed.body =
      bodies === 'built'
        ? (handedBodyValue(body) as AttemptRequest['body'])
        : null;
  }

  if ('rawBody' in request) {
    handed.rawBody = bodies === 'built' ? handedBodyValue(rawBody) : undefined;
  }

  return handed;
}
