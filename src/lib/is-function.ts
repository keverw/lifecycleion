/**
 * Whether `value` has the JavaScript function type: `typeof value === 'function'`.
 *
 * True for ordinary functions, arrow functions, classes, async functions, generators,
 * bound functions, and callable proxies. Classes require `new`; passing this check
 * does not guarantee that ordinary invocation succeeds.
 *
 * An object that merely inherits from `Function.prototype` (`Object.create(Function.prototype)`)
 * is not callable and answers `false`, so a value that passes the check never throws
 * "is not a function" when called.
 *
 * Never throws and reads nothing from `value`: `typeof` runs no caller code, even for
 * a proxy or a revoked one.
 */
export function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}
