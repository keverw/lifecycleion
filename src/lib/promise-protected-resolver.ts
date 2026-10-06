import { promiseConstructorIntrinsic } from './internal/intrinsics';
import {
  reportCallbackError,
  safeHandleCallback,
} from './safe-handle-callback';

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
    this.promise = new promiseConstructorIntrinsic<T>((resolve, reject) => {
      this.resolveHandler = resolve;
      this.rejectHandler = reject;
    });
  }

  public resolveOnce(value: T): void {
    if (!this._hasResolved && this.resolveHandler) {
      // Claimed before the callback runs, so a `resolveOnce`/`rejectOnce` it makes is
      // a no-op rather than settling the promise ahead of this call.
      this._hasResolved = true;
      this.executeBeforeCallback('resolve', value);
      this.resolveHandler(value);
    }
  }

  public rejectOnce(reason?: unknown): void {
    if (!this._hasResolved && this.rejectHandler) {
      this._hasResolved = true;
      this.executeBeforeCallback('reject', reason);
      this.rejectHandler(reason);
    }
  }

  private executeBeforeCallback(
    action: 'resolve' | 'reject',
    valueOrReason: unknown,
  ): void {
    let callback: PromiseProtectedResolverOptions['beforeResolveOrReject'];

    try {
      callback = this.options.beforeResolveOrReject;
    } catch (error) {
      // The resolver is already claimed. Report a broken options getter without
      // leaving its promise pending or allowing a later call to settle it first.
      reportCallbackError('beforeResolveOrReject', error);
      return;
    }

    if (callback) {
      safeHandleCallback(
        'beforeResolveOrReject',
        callback,
        action,
        valueOrReason,
      );
    }
  }
}
