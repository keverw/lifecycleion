export function isFunction(value: unknown): boolean {
  return typeof value === 'function' || value instanceof Function;
}
