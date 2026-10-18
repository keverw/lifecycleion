import { readUnknownMember } from '../internal/read-member';
import type { CancelResult, RequestState } from './types';

export interface TrackedRequest {
  requestID: string;
  clientID: string;
  label?: string;
  state: RequestState;
  abortController: AbortController;
  /**
   * The caller's own signal for this request, when it gave one: a request it has aborted
   * is cancelled already, though this controller has not fired.
   */
  callerSignal?: AbortSignal;
}

/**
 * Shared in-flight request map. One instance is shared between a root HTTPClient and
 * all its sub-clients so that cancelAll() cancels across all of them.
 */
export class RequestTracker {
  private requests: Map<string, TrackedRequest> = new Map();

  public add(entry: TrackedRequest): void {
    this.requests.set(entry.requestID, entry);
  }

  public remove(requestID: string): void {
    this.requests.delete(requestID);
  }

  public get(requestID: string): TrackedRequest | undefined {
    return this.requests.get(requestID);
  }

  public updateState(requestID: string, state: RequestState): void {
    const entry = this.requests.get(requestID);

    if (entry) {
      entry.state = state;
    }
  }

  /**
   * Cancels a single request by ID. Returns 1 if this call cancelled it, 0 if it was not
   * found or was cancelled already.
   */
  public cancel(requestID: string, reason?: string): number {
    const entry = this.requests.get(requestID);

    return entry && cancelEntry(entry, reason) ? 1 : 0;
  }

  /**
   * Cancels ALL in-flight requests across the shared tracker (all clients).
   * Returns the number of requests cancelled.
   */
  public cancelAll(reason?: string): number {
    let count = 0;

    // A copy, in each of these loops: an abort listener can start a request, and walking
    // the live map would cancel and count it too.

    for (const entry of [...this.requests.values()]) {
      if (cancelEntry(entry, reason)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Cancels all requests owned by a specific client.
   * Returns the number of requests cancelled.
   */
  public cancelOwn(clientID: string, reason?: string): number {
    let count = 0;

    for (const entry of [...this.requests.values()]) {
      if (entry.clientID === clientID) {
        if (cancelEntry(entry, reason)) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Cancels all requests that have the given label (across all clients in the shared tracker).
   * Returns the number of requests cancelled.
   */
  public cancelAllWithLabel(label: string, reason?: string): number {
    let count = 0;

    for (const entry of [...this.requests.values()]) {
      if (entry.label === label) {
        if (cancelEntry(entry, reason)) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Cancels requests owned by a specific client that also have the given label.
   * Returns the number of requests cancelled.
   */
  public cancelOwnWithLabel(
    clientID: string,
    label: string,
    reason?: string,
  ): number {
    let count = 0;

    for (const entry of [...this.requests.values()]) {
      if (entry.clientID === clientID && entry.label === label) {
        if (cancelEntry(entry, reason)) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Returns a read-only view of tracked requests.
   *
   * Intentionally omits abortController,
   * callers cancel via cancel()/cancelAll()/etc. so that
   * the tracker remains the sole owner of state mutations.
   */
  public list(filter?: { clientID?: string; label?: string }): {
    count: number;
    requests: RequestInfo[];
  } {
    const requests: RequestInfo[] = [];

    for (const entry of [...this.requests.values()]) {
      if (filter?.clientID && entry.clientID !== filter.clientID) {
        continue;
      }

      if (filter?.label && entry.label !== filter.label) {
        continue;
      }

      requests.push({
        requestID: entry.requestID,
        clientID: entry.clientID,
        label: entry.label,
        state: entry.state,
      });
    }

    return { count: requests.length, requests };
  }
}

export interface RequestInfo {
  requestID: string;
  clientID: string;
  label?: string;
  state: RequestState;
}

/**
 * Cancel one tracked request, answering whether this call is what cancelled it. One
 * already settled or cancelled is left as it is and not counted, so the cancel methods
 * count requests they cancelled, not requests they saw.
 */
export function cancelEntry(
  entry: TrackedRequest,
  reason: string | undefined,
): boolean {
  return cancelTrackedRequest(entry, reason) === 'cancelled';
}

/** As {@link cancelEntry}, saying why nothing was cancelled when nothing was. */
export function cancelTrackedRequest(
  entry: TrackedRequest,
  reason: string | undefined,
): CancelResult {
  if (entry.state === 'completed' || entry.state === 'failed') {
    return 'already_settled';
  }
  if (isEntryPastCancel(entry)) {
    return 'already_cancelled';
  }
  entry.state = 'cancelled';
  entry.abortController.abort(reason);
  return 'cancelled';
}

/**
 * Whether a tracked request is past cancelling: settled - its outcome decided, though its
 * final observers may still be running - or cancelled already, by its own controller (a
 * cancel here or from its builder) or by the caller's signal. Shared with the builder's
 * `cancel()`, so both answer the same. The caller's `aborted` is read guarded: unreadable
 * is not aborted.
 */
export function isEntryPastCancel(entry: TrackedRequest): boolean {
  return (
    entry.state === 'completed' ||
    entry.state === 'failed' ||
    entry.state === 'cancelled' ||
    entry.abortController.signal.aborted ||
    readUnknownMember(entry.callerSignal, 'aborted') === true
  );
}
