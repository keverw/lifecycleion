import type { RequestState } from './types';

export interface TrackedRequest {
  requestID: string;
  clientID: string;
  label?: string;
  state: RequestState;
  abortController: AbortController;
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
   * Cancels a single request by ID. Returns 1 if cancelled, 0 if not found.
   */
  public cancel(requestID: string): number {
    const entry = this.requests.get(requestID);

    if (entry) {
      entry.state = 'cancelled';
      entry.abortController.abort();
      return 1;
    }

    return 0;
  }

  /**
   * Cancels ALL in-flight requests across the shared tracker (all clients).
   * Returns the number of requests cancelled.
   */
  public cancelAll(): number {
    let count = 0;

    for (const entry of this.requests.values()) {
      entry.state = 'cancelled';
      entry.abortController.abort();
      count++;
    }

    return count;
  }

  /**
   * Cancels all requests owned by a specific client.
   * Returns the number of requests cancelled.
   */
  public cancelOwn(clientID: string): number {
    let count = 0;

    for (const entry of this.requests.values()) {
      if (entry.clientID === clientID) {
        entry.state = 'cancelled';
        entry.abortController.abort();
        count++;
      }
    }

    return count;
  }

  /**
   * Cancels all requests that have the given label (across all clients in the shared tracker).
   * Returns the number of requests cancelled.
   */
  public cancelAllWithLabel(label: string): number {
    let count = 0;

    for (const entry of this.requests.values()) {
      if (entry.label === label) {
        entry.state = 'cancelled';
        entry.abortController.abort();
        count++;
      }
    }

    return count;
  }

  /**
   * Cancels requests owned by a specific client that also have the given label.
   * Returns the number of requests cancelled.
   */
  public cancelOwnWithLabel(clientID: string, label: string): number {
    let count = 0;

    for (const entry of this.requests.values()) {
      if (entry.clientID === clientID && entry.label === label) {
        entry.state = 'cancelled';
        entry.abortController.abort();
        count++;
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

    for (const entry of this.requests.values()) {
      if (filter?.clientID && entry.clientID !== filter.clientID) {
        continue;
      }

      if (filter?.label && entry.label !== filter.label) {
        continue;
      }

      requests.push({
        requestID: entry.requestID,
        label: entry.label,
        state: entry.state,
      });
    }

    return { count: requests.length, requests };
  }
}

export interface RequestInfo {
  requestID: string;
  label?: string;
  state: RequestState;
}
