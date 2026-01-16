// Helper from https://github.com/then/is-promise/tree/master
// For some reason the @types/is-promise package stopped being picked up on

export function isPromise(obj: unknown): obj is Promise<unknown> {
  return (
    !!obj &&
    (typeof obj === 'object' || typeof obj === 'function') &&
    // @ts-expect-error - obj is checked to be object/function, then property access works at runtime
    typeof obj['then'] === 'function'
  );
}
