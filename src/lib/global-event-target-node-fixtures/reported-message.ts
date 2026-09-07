/**
 * The message a reported failure is identified by in these fixtures.
 *
 * `reportCallbackError` names the callback in the wrapper's message and puts the value
 * that was actually thrown on `cause`, so that whoever receives the report renders it
 * under their own settings rather than being handed a pre-rendered string. The assertions
 * here are about the original failure, so this reaches through the wrapper for it.
 *
 * Shared so four fixtures cannot disagree about how a report is read.
 */
export function reportedMessage(value: unknown): string {
  if (!(value instanceof Error)) {
    return String(value);
  }

  const cause: unknown = value.cause;

  // Both halves, because both are asserted: the wrapper names which callback failed and
  // the cause is the failure itself.
  if (cause instanceof Error) {
    return `${value.message}: ${cause.message}`;
  }

  return value.message;
}
