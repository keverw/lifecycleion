/**
 * Test-only helper: a timer for a test to race the operation it checks against.
 *
 * Armed when called, so one set before the timer under test comes due first however
 * late a runner fires them: timers run in the order they come due. Unreferenced, so a
 * test that passes - the operation winning - leaves no timer holding the process open;
 * one that fires during a later test only settles a promise nothing awaits any more.
 */
export function raceSentinel<Label extends string>(
  ms: number,
  label: Label,
): Promise<Label> {
  return new Promise<Label>((resolve) => {
    const timer = setTimeout(() => resolve(label), ms);
    timer.unref();
  });
}
