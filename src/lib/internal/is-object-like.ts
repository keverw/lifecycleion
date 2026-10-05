/** Objects and callable objects can carry promise or logger properties. */
export function isObjectLike(value: unknown): value is object {
  return (
    value !== null && (typeof value === 'object' || typeof value === 'function')
  );
}
