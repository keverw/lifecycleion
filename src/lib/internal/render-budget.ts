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

/**
 * How much one render may emit, from what the caller asked for.
 *
 * Fails *closed* on anything unusable, which is the opposite of `resolveMaxQueueSize`'s
 * reading of the same shapes and deliberately so: an unlimited queue is a coherent request
 * and costs the caller memory they asked to spend, while an unlimited render is the bound
 * that makes an untrusted payload safe to render at all. A negative, a zero, a `NaN` out
 * of `Number(process.env.X)` - none of those say "no limit", and treating them that way
 * would turn a typo into the thing that disabled it. Only `Infinity`, which says it
 * exactly, does.
 */
export function resolveMaxRenderLength(requested: number | undefined): number {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    return MAX_RENDER_LENGTH;
  }

  if (requested === Number.POSITIVE_INFINITY) {
    return requested;
  }

  // Floored to at least one: a fraction in `(0, 1)` would otherwise round to a budget of
  // zero, which is not "a very small allowance" but the spent state every guard reads as
  // "emit the marker and render nothing".
  return requested > 0 ? Math.max(1, Math.floor(requested)) : MAX_RENDER_LENGTH;
}

/** Emitted where the budget ran out, so a truncated render never looks complete. */
export const TRUNCATED_LENGTH = '[max length exceeded]';

/**
 * The shortest key a cut will leave, whatever the budget is doing.
 *
 * A key does not only carry text, it *names where the render stopped*: the truncation
 * branch emits `"c":"[max length exceeded]"` so a reader learns which entry was cut, and
 * cutting the key against a budget that is already spent replaced that name with the
 * marker too - leaving `"[max length exceeded]":"[max length exceeded]"` and no way to
 * tell where the render got to. This floor is what keeps an ordinary key whole there.
 *
 * The caller's own cap still wins over it: a render asked for `maxRenderLength: 1` gets
 * one character and not this, since a floor that outranked the cap would be a bound the
 * caller set and this module quietly ignored - the very thing the key path was fixed for.
 * Naming where the render stopped is what a floor *within* the allowance buys.
 */
export const MIN_KEY_ALLOWANCE = 256;

/**
 * Cut `text` at `end` without splitting a surrogate pair.
 *
 * `slice` counts UTF-16 code units, so a cut that lands between the two halves of an
 * astral character keeps a lone surrogate: `stringifyValue('😀'.repeat(200), {
 * maxRenderLength: 5 })` emitted `"😀😀\ud83d[max length exceeded]"`, a string
 * `isWellFormed()` rejects and a JSON consumer or a terminal renders as a replacement
 * character. A truncation marker is an ordinary degradation and should not also corrupt
 * the text it is appended to - the grapheme-aware `splitWord` in the table renderer
 * already holds to that on the wrapping side.
 *
 * Only ever cuts one unit *shorter*, never longer, so every budget charged against the
 * result stays within its allowance.
 */
export function cutAt(text: string, end: number): string {
  const limit = Math.max(0, Math.min(end, text.length));

  if (limit === 0 || limit === text.length) {
    return text.slice(0, limit);
  }

  return text.slice(0, graphemeSafeCut(text, limit));
}

/**
 * Whether the code point is one that attaches to the character before it.
 *
 * Combining marks (`\p{M}`), the zero-width joiner, variation selectors, emoji skin-tone
 * modifiers, and the tag characters a subdivision flag is spelled with. A cut that lands
 * in front of one of these leaves the base on one side and its attachment on the other,
 * so the text before the cut renders differently from how it was written.
 */
function isAttachingCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f) ||
    ATTACHING_MARK.test(String.fromCodePoint(codePoint))
  );
}

const ATTACHING_MARK = /^\p{M}$/u;

/** Whether the code point is a regional indicator, half of a flag. */
function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/** The index at which the code point ending at `end` begins. */
function codePointStartBefore(text: string, end: number): number {
  const low = text.charCodeAt(end - 1);

  if (end >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(end - 2);

    if (high >= 0xd800 && high <= 0xdbff) {
      return end - 2;
    }
  }

  return end - 1;
}

/**
 * The nearest cut at or before `limit` that does not split a character.
 *
 * Steps back off a high surrogate, then off anything the character after the cut would
 * attach to: a combining mark or variation selector left on the far side, a joiner on
 * either side of the cut, and the first half of a flag. Bounded by the text, and only
 * ever shorter than `limit`.
 */
function graphemeSafeCut(text: string, limit: number): number {
  let cut = limit;

  // A high surrogate immediately before the cut has its low half on the other side of it.
  const last = text.charCodeAt(cut - 1);

  if (last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }

  while (cut > 0 && cut < text.length) {
    const next = text.codePointAt(cut) ?? 0;
    const previousStart = codePointStartBefore(text, cut);
    const previous = text.codePointAt(previousStart) ?? 0;

    // The character after the cut attaches to the one before it, or the one before is a
    // joiner waiting for the one after: either way the cut is inside a character.
    if (isAttachingCodePoint(next) || previous === 0x200d) {
      cut = previousStart;

      continue;
    }

    // Two regional indicators make one flag. Left with an odd run of them before the
    // cut and another after it, the cut is inside a flag.
    if (isRegionalIndicator(next) && isRegionalIndicator(previous)) {
      let run = 0;
      let at = cut;

      while (at > 0) {
        const start = codePointStartBefore(text, at);

        if (!isRegionalIndicator(text.codePointAt(start) ?? 0)) {
          break;
        }

        run++;
        at = start;
      }

      if (run % 2 === 1) {
        cut = previousStart;

        continue;
      }
    }

    break;
  }

  return cut;
}

/**
 * How long a key this render may still emit.
 *
 * What is left of the budget, never more than the whole allowance and never less than
 * {@link MIN_KEY_ALLOWANCE}. Reading the whole allowance alone - which is what this did -
 * bounded *one* key and not a render: each key was measured against a cap none of its
 * siblings had spent, so two 900 KB keys emitted 1,800,011 characters against a
 * 1,000,000 cap, and any number of them scaled from there.
 */
export function keyAllowance(budget: RenderBudget): number {
  return Math.min(budget.limit, Math.max(budget.remaining, MIN_KEY_ALLOWANCE));
}

/**
 * Cut `text` to the whole render's allowance, independent of what is left of it.
 *
 * For the one leaf that is not a value: a container's *keys*. {@link charge} bills a key
 * and emits it whole, which bounds how many keys a render produces and says nothing about
 * the length of one - and a key is as attacker-shaped as a value, since an object parsed
 * from JSON carries whatever names arrived. `stringifyValue({ ['k'.repeat(5_000_000)]: 1 })`
 * returned 5,000,028 characters against a 1,000,000 cap.
 *
 * Cut against {@link keyAllowance} rather than bare `budget.remaining`, which is what
 * separates this from {@link chargeText}. A key does not only carry text, it *names where
 * the render stopped*: the truncation branch emits `"c":"[max length exceeded]"` so a
 * reader learns which entry was cut, and cutting the key against a budget that is already
 * spent replaced that name with the marker too, leaving `"[max length exceeded]":"[max
 * length exceeded]"` and no way to tell where the render got to. An ordinary key is
 * therefore never touched, whatever the budget is doing, and only a key that could not fit
 * the cap even on its own is cut.
 *
 * Charging is left to the caller, which knows whether its key needs quoting, a separator,
 * or row framing around it.
 */
export function capKey(budget: RenderBudget, text: string): string {
  const allowance = keyAllowance(budget);

  if (text.length <= allowance) {
    return text;
  }

  const kept = cutAt(text, allowance);

  noteTruncation(budget, 'length', text.length - kept.length);

  return `${kept}${TRUNCATED_LENGTH}`;
}

/**
 * {@link capKey} for a key whose every character is emitted more than once.
 *
 * The same relationship {@link chargeNestedText} has to {@link chargeText}, on the other
 * column. A renderer that wraps a long key inside a narrow key column and pads each of the
 * resulting lines out to the full table width emits several characters per character of
 * key, so a key cut at the render's whole allowance still rendered past it - measured at
 * 2,251,070 characters for a five-megabyte key against a one-megabyte cap. The cut is made
 * against the per-level allowance, so what is kept still fits once multiplied.
 *
 * `levels` is how many characters one character of key costs: 1 is exactly {@link capKey}.
 */
export function capNestedKey(
  budget: RenderBudget,
  text: string,
  levels: number,
): string {
  const factor = Math.max(1, levels);

  if (factor === 1) {
    return capKey(budget, text);
  }

  const base = keyAllowance(budget);
  const allowance =
    base === Number.POSITIVE_INFINITY
      ? base
      : Math.max(1, Math.floor(base / factor));

  if (text.length <= allowance) {
    return text;
  }

  const kept = cutAt(text, allowance);

  noteTruncation(budget, 'length', text.length - kept.length);

  return `${kept}${TRUNCATED_LENGTH}`;
}

/**
 * Cut `text` to the whole render's allowance, for a leaf that has no budget to charge.
 *
 * The one such leaf is a string handed to `stringifyTemplateValue` as the *root* value:
 * there is no container around it, so nothing had opened a budget yet, and it was returned
 * whole. The same string one level down is cut to {@link MAX_RENDER_LENGTH} with a marker,
 * which made the cap depend on where a value happened to sit -
 * `logger.info('{{body}}', { params: { body: tenMegabyteString } })` wrote all ten
 * megabytes to every sink, while `{ wrapper: { body } }` wrote one. Same rule at every
 * level now.
 */
export function capToMaxRenderLength(
  text: string,
  limit: number = MAX_RENDER_LENGTH,
): string {
  if (text.length <= limit) {
    return text;
  }

  return `${cutAt(text, limit)}${TRUNCATED_LENGTH}`;
}

/** Remaining output allowance for one render, shared by every level of it. */
export interface RenderBudget {
  remaining: number;
  /**
   * The whole allowance this render opened with, unchanged as `remaining` is spent.
   *
   * Kept because a key is cut against the render's *total* rather than against what is
   * left of it - see {@link capKey} - and the total was previously read from the
   * {@link MAX_RENDER_LENGTH} constant, which is not what the caller asked for: a render
   * given `maxRenderLength: Infinity` still had its keys cut at one megabyte, and one
   * given a smaller cap let a single key run past it.
   */
  limit: number;
  /**
   * How many times this render has cut something short.
   *
   * Counted rather than reported from here: truncation is an ordinary degradation and
   * this module has no channel to report on, but a caller that renders a template for
   * something other than a log line - an email body, a rendered document - needs to know
   * its output was shortened, and scanning the result for {@link TRUNCATED_LENGTH} cannot
   * tell a cut apart from a payload that happens to contain those words. Reading this
   * before and after a render answers it exactly, wherever in the walk the cut happened.
   *
   * The count, not the characters, is what makes the answer complete: a container that
   * gives up on its remaining entries drops a tail it never rendered and therefore never
   * measured, so {@link droppedChars} cannot see it and a caller reading only that would
   * be told a truncated render was intact.
   */
  truncations: number;
  /**
   * Characters this render is *known* to have cut.
   *
   * A lower bound rather than a total, and deliberately so: only a cut that had the text
   * in hand can measure it. A dropped tail - the elements or entries past a spent budget,
   * or a placeholder the budget never reached - was never rendered, so nothing about its
   * size was ever established. Pair it with {@link truncations}, which counts those too.
   */
  droppedChars: number;
  /**
   * Which bound stopped this render first, or `undefined` if none did.
   *
   * The first rather than the last: once a budget is spent everything after it degrades
   * too, so the last says only that the render kept going. The first is the one that
   * explains the output.
   */
  firstReason?: TruncationReason;
}

/**
 * A fresh allowance for one top-level render.
 *
 * @param limit Characters this render may emit. `Infinity` is unlimited - `chargeText`
 *        then never cuts and the `remaining <= 0` guards never trip - which is how a
 *        caller that is not writing to a log opts out without every leaf falling back to
 *        its own separate {@link MAX_RENDER_LENGTH} cap.
 */
export function createRenderBudget(
  limit: number = MAX_RENDER_LENGTH,
): RenderBudget {
  return { remaining: limit, limit, truncations: 0, droppedChars: 0 };
}

/**
 * A second allowance of the same size, for a pass whose output another pass re-renders.
 *
 * Two passes over one value are not two halves of one output: `stringifyValue` masks the
 * value and then renders what the masking returned, so every masked leaf is charged
 * once as it is replaced and again as it is emitted. Sharing one budget therefore made
 * redaction shrink the cap it was supposed to be rendering under - the same value came
 * out at 1,000,000 characters plain and 400,028 with one key redacted, which is neither
 * the documented cap nor the documented equality between `stringifyValue(v, o)` and
 * `stringifyValue(redactValue(v, o))`.
 *
 * The cap still holds, because the *render* is what emits the characters and it is still
 * bounded. What the second budget buys is that the first pass is bounded too, rather than
 * being free or being paid for twice. Fold its counters back with
 * {@link foldTruncations}, so a cut made while masking still reaches `onTruncate`.
 */
export function createSiblingBudget(budget: RenderBudget): RenderBudget {
  return createRenderBudget(budget.limit);
}

/**
 * Carry a sibling budget's cuts into the one the caller reports from.
 *
 * The counters only - `remaining` is exactly what is not shared. See
 * {@link createSiblingBudget}.
 */
export function foldTruncations(
  target: RenderBudget,
  source: RenderBudget,
): void {
  if (source.truncations === 0) {
    return;
  }

  target.truncations += source.truncations;
  target.droppedChars += source.droppedChars;
  target.firstReason ??= source.firstReason;
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

/**
 * Why a render emitted a marker instead of the content it stood for.
 *
 * The three ways a walk stops early, and they are one family rather than three: each
 * succeeded at rendering and simply could not represent everything, which is what
 * separates all of them from a value that *refused* to render and reports an error. A
 * caller asking "is my output complete" is asking one question, so it gets one channel
 * and this says which bound answered.
 */
export type TruncationReason =
  /** {@link MAX_RENDER_LENGTH}, or whatever the caller set in its place. */
  | 'length'
  /** {@link MAX_RENDER_DEPTH}. */
  | 'depth'
  /** A reference back into something already being rendered. */
  | 'circular';

/**
 * What a truncation handler is told.
 *
 * One shape across every entry point that renders - `curlyBrackets`, `stringifyValue`,
 * `errorToString` - because a caller asking "is my output complete" is asking the same
 * question of all of them, and three near-identical shapes would only make the answer
 * look like three different questions.
 */
export interface TruncationInfo {
  /** Which bound stopped the render. */
  reason: TruncationReason;
  /**
   * What was being rendered when it stopped.
   *
   * The placeholder as written for a template - `user.body` for `{{ user.body }}` - and
   * the rendered value's own root otherwise.
   */
  subject: string;
  /**
   * Characters known to have been dropped, or `undefined` when nothing measured them.
   *
   * A lower bound rather than a total, and only ever present for a `'length'` cut: a
   * cycle, a depth cap, and a value the budget was already spent before reaching all drop
   * something that was never rendered, so its size was never established. `undefined` is
   * the honest answer there rather than a zero that reads as "nothing was lost".
   */
  dropped: number | undefined;
}

/** Notified when a render was cut short. See {@link TruncationInfo}. */
export type TruncationHandler = (info: TruncationInfo) => void;

/**
 * Record that this render cut something short.
 *
 * @param reason Which bound stopped it. Only the first is kept: a render past its budget
 *        degrades continuously, and the first is the one that explains the rest.
 * @param droppedChars Characters dropped, when the cut had them in hand to count. Omitted
 *        by a caller giving up on a tail it never rendered - the count still rises, which
 *        is what keeps "was anything cut" answerable when "how much" is not. Only a
 *        `'length'` cut ever has one: a cycle and a depth cap drop a subtree that was
 *        never rendered and so was never measured.
 */
export function noteTruncation(
  budget: RenderBudget,
  reason: TruncationReason,
  droppedChars?: number,
): void {
  budget.truncations++;
  budget.firstReason ??= reason;

  if (droppedChars !== undefined && droppedChars > 0) {
    budget.droppedChars += droppedChars;
  }
}

/**
 * Charge a variable-length leaf, cutting it at whatever budget is left.
 *
 * {@link charge} bills a leaf and emits it whole, which bounds how *many* leaves a render
 * produces and says nothing about how large one of them is. That was deliberate for a
 * leaf that overshoots by a little - cutting a value mid-string to save a few hundred
 * characters is a worse trade than going slightly over - but it leaves the one case that
 * produces the most output as the one nothing bounds: a single ten-megabyte string param
 * rendered in full against a one-megabyte cap, and the render that emitted it said so
 * nowhere. The marker only ever landed on the *next* entry, so a leaf with nothing after
 * it - the last key, the only key, a bare value - overshot silently.
 *
 * What is emitted is therefore bounded and self-describing: as much of the leaf as the
 * budget still allows, then {@link TRUNCATED_LENGTH}. A reader sees where it stopped
 * rather than inferring it from a length.
 *
 * Billed by what it emits rather than by what it was handed, so the budget lands just
 * past zero and every sibling after it truncates rather than being billed for text that
 * was never written.
 *
 * Truncation is not a failure and is never reported: it is an ordinary degradation like
 * `[circular]` and `[max depth exceeded]`, and the marker in the output is the whole of
 * the diagnosis. Only a value that *refused* to render reaches a reporter.
 */
export function chargeText(budget: RenderBudget, text: string): string {
  if (text.length <= budget.remaining) {
    return charge(budget, text);
  }

  // `cutAt` rather than a bare `slice`: the budget can already be negative - a container's
  // delimiters and keys are charged before its values, so a leaf can arrive with nothing
  // left at all, and a negative end reads as counting back from the end of the string -
  // and a cut that lands between the halves of a surrogate pair emits a lone surrogate.
  const kept = cutAt(text, budget.remaining);
  const emitted = `${kept}${TRUNCATED_LENGTH}`;

  // What this cut, before the charge below moves `remaining`.
  noteTruncation(budget, 'length', text.length - kept.length);

  chargeUnits(budget, emitted.length);

  return emitted;
}

/**
 * Charge a variable-length leaf that every level above it will re-emit.
 *
 * {@link chargeText} bills a leaf once, which is right for a renderer whose output is the
 * concatenation of its leaves. A table nested inside a table is not that: every line of a
 * cause's table is re-wrapped, padded to the width and indented again by each ancestor, so
 * one character of the innermost message costs one character per enclosing level. Billed
 * once, a 200 KB message twenty-five causes deep charged 200 KB and rendered 26 MB against
 * a 1 MB cap - the cap holding only for the shallow payloads it was never needed for.
 *
 * `levels` is how many times the text will be emitted: 1 at the top level, where this is
 * exactly {@link chargeText}. The cut is made against the per-level allowance, so what is
 * kept still fits once multiplied.
 */
export function chargeNestedText(
  budget: RenderBudget,
  text: string,
  levels: number,
): string {
  const factor = Math.max(1, levels);

  if (factor === 1) {
    return chargeText(budget, text);
  }

  if (text.length * factor <= budget.remaining) {
    chargeUnits(budget, text.length * factor);

    return text;
  }

  // `cutAt`, for the same reason `chargeText` needs it: the budget can already be negative
  // when a leaf arrives, a negative end reads as counting back from the end of the string,
  // and a cut that splits a surrogate pair leaves a lone surrogate in the output. Cut
  // against the per-level allowance, so what is kept still fits once multiplied.
  const kept = cutAt(text, Math.floor(budget.remaining / factor));
  const emitted = `${kept}${TRUNCATED_LENGTH}`;

  // Counted like every other cut. Missed here, a rendered error - whose nested rows are
  // the *only* thing that reaches this function - reported an intact render while its
  // `AdditionalInfo` had been shortened, which is precisely the surface a caller sets a
  // handler to watch.
  noteTruncation(budget, 'length', text.length - kept.length);
  chargeUnits(budget, emitted.length * factor);

  return emitted;
}
