import { safeHandleCallback } from './safe-handle-callback';

interface PromiseProtectedResolverOptions {
  beforeResolveOrReject?: (
    action: 'resolve' | 'reject',
    valueOrReason: unknown,
  ) => void | Promise<void>;
}

export class PromiseProtectedResolver<T> {
  public promise: Promise<T>;

  public get hasResolved(): boolean {
    return this._hasResolved;
  }

  private _hasResolved = false;
  private resolveHandler: ((value: T | PromiseLike<T>) => void) | undefined;
  private rejectHandler: ((reason?: unknown) => void) | undefined;
  private options: PromiseProtectedResolverOptions;

  constructor(options: PromiseProtectedResolverOptions = {}) {
    this.options = options;
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveHandler = resolve;
      this.rejectHandler = reject;
    });
  }

  public resolveOnce(value: T): void {
    if (!this._hasResolved && this.resolveHandler) {
      this.executeBeforeCallback('resolve', value);
      this._hasResolved = true;
      this.resolveHandler(value);
    }
  }

  public rejectOnce(reason?: unknown): void {
    if (!this._hasResolved && this.rejectHandler) {
      this.executeBeforeCallback('reject', reason);
      this._hasResolved = true;
      this.rejectHandler(reason);
    }
  }

  private executeBeforeCallback(
    action: 'resolve' | 'reject',
    valueOrReason: unknown,
  ): void {
    if (this.options.beforeResolveOrReject) {
      safeHandleCallback(
        'beforeResolveOrReject',
        this.options.beforeResolveOrReject,
        action,
        valueOrReason,
      );
    }
  }
}
