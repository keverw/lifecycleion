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
export function readMember(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
