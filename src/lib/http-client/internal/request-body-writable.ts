/**
 * Minimal subset of http.ClientRequest used by internal request-body writers.
 * Accepting this interface instead of the concrete class keeps upload helpers
 * independently testable without a live HTTP socket.
 */
export interface RequestBodyWritable {
  setHeader(name: string, value: string): void;
  write(
    data: string | Buffer | Uint8Array,
    callback?: (error: Error | null | undefined) => void,
  ): boolean;
  once(event: 'drain', listener: () => void): this;
  once(event: 'close', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  off(event: 'drain', listener: () => void): this;
  off(event: 'close', listener: () => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  readonly destroyed: boolean;
}
