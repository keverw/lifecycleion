import { describe, expect, it, mock } from 'bun:test';
import { PromiseProtectedResolver } from './promise-protected-resolver';

describe('PromiseProtectedResolver regular', () => {
  it('should resolve a value once', () => {
    const resolver = new PromiseProtectedResolver<string>();
    resolver.resolveOnce('First resolve');
    resolver.resolveOnce('Second resolve'); // This should have no effect

    expect(resolver.promise).resolves.toEqual('First resolve');
  });

  it('should reject once', () => {
    const resolver = new PromiseProtectedResolver<string>();
    resolver.rejectOnce('First reject');

    expect(resolver.hasResolved).toBe(true);

    resolver.rejectOnce('Second reject'); // This should have no effect
    resolver.resolveOnce('Resolve after reject'); // Also should have no effect

    expect(resolver.promise).rejects.toEqual('First reject');
  });

  it('should not resolve after a rejection', () => {
    const resolver = new PromiseProtectedResolver<string>();
    resolver.rejectOnce('Reject first');
    resolver.resolveOnce('Resolve after reject');

    expect(resolver.promise).rejects.toEqual('Reject first');
  });

  it('should not reject after a resolution', () => {
    const resolver = new PromiseProtectedResolver<string>();
    resolver.resolveOnce('First resolve');
    resolver.rejectOnce('Reject after resolve');

    expect(resolver.promise).resolves.toEqual('First resolve');
  });

  it('should handle resolving with undefined', () => {
    const resolver = new PromiseProtectedResolver<string | undefined>();
    resolver.resolveOnce(undefined);
    resolver.resolveOnce('Resolve after undefined');

    expect(resolver.promise).resolves.toEqual(undefined);
  });
});

describe('PromiseProtectedResolver with beforeResolveOrRejectCallback', () => {
  it('should call the beforeResolveOrRejectCallback when resolving', () => {
    const mockCallback = mock();
    const resolver = new PromiseProtectedResolver<string>({
      beforeResolveOrReject: mockCallback,
    });

    resolver.resolveOnce('Test value');

    expect(mockCallback).toHaveBeenCalledWith('resolve', 'Test value');

    expect(resolver.promise).resolves.toEqual('Test value');
  });

  it('should call the beforeResolveOrRejectCallback when rejecting', () => {
    const mockCallback = mock();
    const resolver = new PromiseProtectedResolver<string>({
      beforeResolveOrReject: mockCallback,
    });

    const error = new Error('Test error');

    resolver.rejectOnce(error);

    expect(mockCallback).toHaveBeenCalledWith('reject', error);
    expect(resolver.promise).rejects.toThrow('Test error');
  });

  it('should only call the beforeResolveOrRejectCallback once for multiple resolve attempts', () => {
    const mockCallback = mock();
    const resolver = new PromiseProtectedResolver<string>({
      beforeResolveOrReject: mockCallback,
    });

    resolver.resolveOnce('First');
    resolver.resolveOnce('Second');

    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockCallback).toHaveBeenCalledWith('resolve', 'First');
  });

  it('should only call the beforeResolveOrRejectCallback once for multiple reject attempts', () => {
    const mockCallback = mock();
    const resolver = new PromiseProtectedResolver<string>({
      beforeResolveOrReject: mockCallback,
    });

    resolver.rejectOnce('First error');
    resolver.rejectOnce('Second error');

    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockCallback).toHaveBeenCalledWith('reject', 'First error');

    // Additional checks
    expect(resolver.hasResolved).toBe(true);

    // Check if the promise was actually rejected
    expect(resolver.promise).rejects.toBe('First error');
  });

  it('should handle asynchronous beforeResolveOrRejectCallback', async () => {
    let wasCallbackExecuted = false;

    const asyncCallback = async (
      _action: string,
      _value: unknown,
    ): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      wasCallbackExecuted = true;
    };

    const resolver = new PromiseProtectedResolver<string>({
      beforeResolveOrReject: asyncCallback,
    });

    resolver.resolveOnce('Async test');

    // The resolution should happen immediately, not waiting for the async callback
    expect(resolver.promise).resolves.toEqual('Async test');

    // Wait a bit to ensure the async callback has time to execute
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wasCallbackExecuted).toBe(true);
  });

  it('should handle errors in beforeResolveOrRejectCallback without affecting resolution', () => {
    const errorCallback = (): void => {
      throw new Error('Callback error');
    };

    const resolver = new PromiseProtectedResolver<string>({
      beforeResolveOrReject: errorCallback,
    });

    resolver.resolveOnce('Error test');

    expect(resolver.promise).resolves.toEqual('Error test');
  });
});
