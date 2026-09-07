/**
 * The bounds one render may not exceed, shared by every renderer that walks caller data.
 *
 * Extracted rather than copied because `stringifyTemplateValue` and `errorToString` walk
 * the same payloads from different entry points - a log line's params and a thrown error's
 * `additionalInfo` - and a cap that held in one and not the other is no cap at all: the
 * same object graph simply arrives through the other door.
 */

/**
 * How deep a renderer will walk before saying so.
 *
 * A payload nested past this is pathological, and the alternative is worse than a cap in
 * both directions: without one, deep recursion raises a `RangeError`, which the per-entry
 * guards catch - so the render silently stopped partway and emitted tens of kilobytes with
 * nothing to say it was truncated. An explicit cap keeps the output bounded *and* marks
 * where it stopped.
 */
export const MAX_RENDER_DEPTH = 100;

/** Emitted where the walk stopped, so a truncated render never looks complete. */
export const TRUNCATED = '[max depth exceeded]';

/**
 * How much text one render may produce before it stops.
 *
 * The depth cap bounds how *deep* the walk goes and says nothing about how much it emits,
 * and the two are not the same limit. `seen` is released as a walk leaves a container -
 * deliberately, so a value referenced twice side by side renders in full both times rather
 * than the second being called circular - which means a shared subtree is serialized once
 * per reference. An object graph of 45 objects, 22 levels of `{ l: child, r: child }`,
 * rendered to 96 MB, four times that at 24 levels. Nothing about that payload is
 * pathological - reusing one object under two keys is ordinary - and neither the depth cap
 * nor the cycle check stops any of it.
 *
 * A megabyte is far past any log line or rendered error worth writing and still leaves the
 * cap invisible to every render that is not running away.
 */
export const MAX_RENDER_LENGTH = 1_000_000;

/** Emitted where the budget ran out, so a truncated render never looks complete. */
export const TRUNCATED_LENGTH = '[max length exceeded]';

/** Remaining output allowance for one render, shared by every level of it. */
export interface RenderBudget {
  remaining: number;
}

/** A fresh allowance for one top-level render. */
export function createRenderBudget(): RenderBudget {
  return { remaining: MAX_RENDER_LENGTH };
}

/**
 * Charge `text` against the budget and hand it back.
 *
 * Applied to the terminals only - a rendered leaf, a key, a container's own brackets and
 * the punctuation between its entries - never to a container's assembled result. A
 * container's text is exactly the sum of what its contents already charged, so charging it
 * again would bill a leaf once per level above it and make the effective cap collapse with
 * depth rather than hold at {@link MAX_RENDER_LENGTH}.
 *
 * The delimiters have to be charged for the cap to hold at all. Left uncharged, a container
 * with nothing chargeable inside it cost nothing, so a payload built from empty containers
 * ran past the cap without ever reaching it: 500,000 `{}` in an array rendered 1.5 MB with
 * the budget still untouched, and the size grew linearly from there.
 */
export function charge(budget: RenderBudget, text: string): string {
  chargeUnits(budget, text.length);

  return text;
}

/**
 * Charge a fixed number of characters that no single string in hand accounts for.
 *
 * For output whose cost is structural rather than textual: a renderer that emits rows
 * rather than a flat string pays for each row's framing - borders, padding out to the
 * table width, indentation per level - and none of that is any of the strings the walk
 * produced. Charging only the content there let a payload of one-character keys expand to
 * a million rows against a budget it had barely touched.
 */
export function chargeUnits(budget: RenderBudget, amount: number): void {
  budget.remaining -= amount;
}
