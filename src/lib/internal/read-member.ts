/**
 * Read a property off a value without trusting it.
 *
 * Every caller is on a reporting path, and the value being read is somebody else's: what
 * was thrown, or an event dispatched by whoever chose to dispatch it. `message`, `stack`,
 * `code`, `target` are ordinary properties that a subclass or a `Proxy` can turn into
 * accessors that throw, and a throw from one of these reads escapes the very code whose
 * job is to report a failure - which outside a browser means the runtime treats it as
 * uncaught and exits.
 *
 * Shared rather than copied, for the reason `toError` and `isPlainContainer` are: the
 * guarantee is one rule, and it had already been written twice under two names, in
 * `error-to-string` and in the logger's global `'error'` listener. `global-event-target`
 * keeps its own, deliberately - it answers with a sentinel so its callers can tell a read
 * that threw from a member that is genuinely `undefined`, which is a different question
 * from the one this answers.
 *
 * @returns The member's value, or `undefined` when reading it threw. An unreadable member
 *          is therefore indistinguishable from an absent one; where that distinction
 *          matters, ask a function that keeps it.
 */
export function readMember(source: object, key: PropertyKey): unknown {
  try {
    return (source as Record<PropertyKey, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * {@link readMember}, for a source that may not be an object at all.
 *
 * The same guarantee with the type check folded in, so a caller holding an `unknown` -
 * a thrown value, a rejection reason, an adapter marker read off something it did not
 * construct - does not have to narrow before asking. A primitive, `null` and `undefined`
 * all answer `undefined` rather than throwing or coercing: reading a member off a string
 * would otherwise return `String.prototype`'s, which is never what these callers mean.
 *
 * Shared for the reason `readMember` is. The HTTP client carried five copies of these two
 * shapes between `http-client`, three adapters and `tls-error-utils`, on a rule against
 * importing across module boundaries that the same files now break for `toError`.
 *
 * The key is a `PropertyKey` rather than a `string` because one marker is deliberately
 * symbol-keyed: `REQUEST_BODY_SETTLED_KEY` carries a `Promise` on a thrown error, and a
 * string key would ride into an IPC payload through `serializeError`'s
 * `getOwnPropertyNames` walk.
 *
 * @returns The member's value, or `undefined` when the source cannot hold one or reading
 *          it threw.
 */
export function readUnknownMember(source: unknown, key: PropertyKey): unknown {
  if (
    source === null ||
    (typeof source !== 'object' && typeof source !== 'function')
  ) {
    return undefined;
  }

  return readMember(source, key);
}

/**
 * The named members of an options object, each read once through {@link readMember}.
 *
 * An entry point that promises never to throw reads its options before it reaches the
 * `try` that keeps that promise, so an options object with a throwing accessor - a
 * `Proxy`, a getter - escaped it. Reading each member here, once, into a plain object
 * turns a refused read into the member being absent, which is the documented fallback
 * for every option this is used on: the console reporter, the default cap, no truncation
 * hook, the default mask. The object handed back is this function's own, so a getter
 * that answers differently on a second read is never asked again either.
 */
export function snapshotMembers<T extends object, K extends keyof T>(
  source: T | undefined,
  keys: readonly K[],
): { [P in K]?: T[P] } {
  const snapshot: { [P in K]?: T[P] } = {};

  if (source === null || typeof source !== 'object') {
    return snapshot;
  }

  for (const key of keys) {
    snapshot[key] = readMember(source, key) as T[K] | undefined;
  }

  return snapshot;
}
