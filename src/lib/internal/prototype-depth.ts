/**
 * The most prototypes a walk up a caller's value's chain reads: an ordinary chain ends
 * long before it, and a `Proxy` whose `getPrototypeOf` answers a new `Proxy` every time
 * would otherwise never end.
 */
export const MAX_PROTOTYPE_DEPTH = 64;
