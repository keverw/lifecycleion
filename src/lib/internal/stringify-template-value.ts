/**
 * Normalizes values to the same string representation used by template rendering.
 */

import { describeContainer } from './container-entries';
import { isPlainContainer } from './is-plain-container';
import {
  NOOP_FORMAT_REPORTER,
  type ReportFormatFailure,
} from './format-reporter';
import {
  capKey,
  capToMaxRenderLength,
  keyAllowance,
  charge,
  chargeText,
  chargeUnits,
  createRenderBudget,
  MAX_RENDER_DEPTH,
  noteTruncation,
  TRUNCATED,
  TRUNCATED_LENGTH,
  type RenderBudget,
  type TruncationReason,
} from './render-budget';

/**
 * What replaces a value this could not render, and which half of it refused.
 *
 * The same three categories `errorToString` emits, in this renderer's own bracket style -
 * square here, alongside `[circular]` and `[max depth exceeded]`; angle there, alongside
 * `<circular>`. The split is what a reader gets without wiring anything: `keys` sends you
 * to the payload's shape, `value` to the code behind one field, `text` to a `toString`.
 *
 * **The cause is deliberately not here.** The thrown value belongs to the caller - a
 * getter may throw `new Error('cannot read ' + this.password)` - and a marker carrying
 * that message would put the value wherever the rendered string goes, past `redactedKeys`.
 * These are library-authored text, which is what lets them be rendered at all; the cause
 * goes to `onFormatError`.
 */
const UNRENDERABLE_KEYS = '[unrenderable: keys]';

/** A single value refused to be read - a throwing accessor, a revoked `Proxy`. */
const UNRENDERABLE_VALUE = '[unrenderable: value]';

/** A value was readable but could not be turned into text. */
const UNRENDERABLE_TEXT = '[unrenderable: text]';

/**
 * Whether a value carries a `toString` of its own worth using.
 *
 * `Error`, `Date`, `URL` and anything else that overrides `toString` renders something
 * meaningful. A class that does not override it inherits `Object.prototype.toString`,
 * which renders `[object Object]` and says nothing at all.
 */
export function hasOwnStringForm(value: object): boolean {
  try {
    const own = (value as { toString?: unknown }).toString;

    // Callable, and not the inherited one. "Not `Object.prototype.toString`" alone is also
    // true for a value that has *no* `toString` at all - `Object.create(Object.create(null))`
    // reads `undefined` - so such a value skipped `describeByConstructor`, reached
    // `String(value)`, and threw `TypeError: No default value`. It then rendered
    // `[unrenderable: text]` *and* spent the once-per-operation render-failure budget on a
    // value that is perfectly describable, suppressing the report for whatever failed next.
    return typeof own === 'function' && own !== Object.prototype.toString;
  } catch {
    // Not reported here, only fallen back from. A `toString` whose *read* throws says
    // nothing about whether the value can be described: `describeByConstructor` names it
    // `[Foo]` a moment later and the render is perfectly good, so reporting at this point
    // spent the once-per-operation budget on a value that did not fail - suppressing the
    // report the next genuine failure needed. The value that refuses every read reaches
    // the generic fallback below, which is where it is reported.
    return false;
  }
}

/** A name for a value whose own string form says nothing, such as `[FooBar]`. */
function describeByConstructor(
  value: object,
  onRefused: (error: unknown) => void = () => undefined,
): string {
  try {
    const name: unknown = (value as { constructor?: { name?: unknown } })
      .constructor?.name;

    if (typeof name === 'string' && name.length > 0) {
      return `[${name}]`;
    }
  } catch (error) {
    // Reported on the way to the generic form, which is `[object Object]` - the silent
    // collapse this whole function exists to avoid, and indistinguishable from a genuine
    // empty object. A revoked `Proxy` refuses this read and the `toString` read above, so
    // it used to render that marker with nothing said anywhere, while `errorToString`
    // reported the very same value. This is the one place both refusals end up.
    onRefused(error);
  }

  return '[object Object]';
}

/** JSON string literal for `value`, used for both keys and rendered leaves. */
function quote(value: string): string {
  try {
    return JSON.stringify(value) ?? '""';
  } catch {
    return '""';
  }
}

/**
 * Quote a leaf, cut so the *encoded* result fits what is left of the budget.
 *
 * Two things {@link chargeText} alone does not cover, both of which let a single value
 * run past the cap:
 *
 * - **What is charged has to be what is emitted.** Cutting the raw string and quoting
 *   afterwards charges the cut length and emits the escaped one, and escaping is not
 *   free: a million NUL characters become `\u0000` six times over, so a value cut to a
 *   megabyte was written out as six. The budget is a bound on output, so the encoded form
 *   is what has to fit.
 * - **Every variable-length leaf, not only a raw string.** A class whose `toString()`
 *   returns ten megabytes arrives here as text like any other, and went out whole because
 *   this path merely charged it.
 *
 * Cut by ratio rather than by search: one pass usually lands it, since the expansion is
 * uniform enough, and the loop is bounded so a pathological mixture costs a few
 * re-encodings rather than a binary search. The marker always survives - a budget with
 * nothing left still says it ran out rather than emitting an empty string.
 */
function quoteWithinBudget(budget: RenderBudget, text: string): string {
  const full = quote(text);

  if (full.length <= budget.remaining) {
    return charge(budget, full);
  }

  const { encoded, kept } = quoteWithinLimit(
    text,
    Math.max(0, budget.remaining),
  );

  // A nested leaf cut here is a cut like any other: without this, a template whose
  // oversized value sat one level down - `{{o}}` holding `{ k: <2 MB> }` - was shortened
  // and told its caller nothing, while the same string at the top reported.
  noteTruncation(budget, 'length', text.length - kept);
  chargeUnits(budget, encoded.length);

  return encoded;
}

/**
 * `key`, quoted, cut so the quoted form fits the render's whole allowance.
 *
 * The cheap test first: a key that cannot expand past the cap even if every character
 * escapes is the ordinary case, and it pays one length comparison.
 *
 * Counted once however many passes shortened it: `capKey` records the raw cut, and the
 * re-cut below only records when the raw one fitted - a key cut twice is still one key
 * that did not survive.
 */
function quoteKeyWithinCap(budget: RenderBudget, key: string): string {
  const allowance = keyAllowance(budget);
  const truncationsBefore = budget.truncations;
  const quoted = quote(capKey(budget, key));

  if (quoted.length <= allowance) {
    return quoted;
  }

  const recut = quoteWithinLimit(key, allowance);

  if (budget.truncations === truncationsBefore) {
    noteTruncation(budget, 'length', key.length - recut.kept);
  }

  return recut.encoded;
}

/**
 * `text`, quoted, cut so the *quoted* form fits `limit`.
 *
 * The cut and the encoding in one place, because doing them in the other order is the bug
 * both callers had: cutting the raw text and quoting afterwards emits whatever the escaping
 * expanded it to, which for a run of NUL characters is six times the cut.
 *
 * Cut by ratio first: one pass usually lands it, since the expansion is uniform enough,
 * and a few re-encodings are cheaper than a search. But the ratio is only an estimate,
 * and a mixture whose escaping density is front-loaded defeats it - a run of NUL
 * characters (six bytes each) ahead of plain text shrinks the prefix towards the dense
 * part, so every pass lands closer and none of them land. Four passes over such a value
 * still returned a fifth more than the cap, and the cap is the promise `maxRenderLength`
 * makes about untrusted input. So the ratio passes are followed by a binary search over
 * whatever is left, which cannot fail to fit: the encoded length is monotone in the
 * prefix, and the marker alone always fits.
 *
 * The marker always survives - a limit with nothing left still says it ran out rather
 * than emitting an empty string.
 */
function quoteWithinLimit(
  text: string,
  limit: number,
): { encoded: string; kept: number } {
  let keep = Math.min(text.length, limit);
  let encoded = quote(`${text.slice(0, keep)}${TRUNCATED_LENGTH}`);

  // The marker itself, quoted, is the floor: below that there is nothing to say.
  const cap = Math.max(limit, quote(TRUNCATED_LENGTH).length);

  for (
    let attempt = 0;
    attempt < 4 && keep > 0 && encoded.length > cap;
    attempt++
  ) {
    const ratio = cap / encoded.length;

    keep = Math.floor(keep * ratio);
    encoded = quote(`${text.slice(0, keep)}${TRUNCATED_LENGTH}`);
  }

  if (encoded.length <= cap) {
    return { encoded, kept: keep };
  }

  // Largest prefix in `[0, keep)` whose quoted form fits. `keep` itself is known not to,
  // and zero is known to, so the search closes on a fitting answer.
  let low = 0;
  let high = keep;

  encoded = quote(TRUNCATED_LENGTH);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = quote(`${text.slice(0, middle)}${TRUNCATED_LENGTH}`);

    if (candidate.length <= cap) {
      low = middle;
      encoded = candidate;
    } else {
      high = middle - 1;
    }
  }

  return { encoded, kept: low };
}

/**
 * A `Date` as an ISO timestamp, or `null` when it is not one this can render.
 *
 * ISO rather than `String(date)` because the locale form is timezone-dependent and neither
 * sortable nor parseable, which is the wrong trade for something written to a log. An
 * invalid `Date` throws from `toISOString`, and falls through to its own string form
 * (`Invalid Date`), which says more than a placeholder would.
 */
function renderDate(value: unknown): string | null {
  try {
    if (!(value instanceof Date)) {
      return null;
    }

    const iso = value.toISOString();

    return typeof iso === 'string' ? iso : null;
  } catch {
    return null;
  }
}

/**
 * Render one value *inside* a container, as a JSON fragment.
 *
 * Every leaf goes through {@link stringifyTemplateValue}, so a value renders the same way
 * at any depth. That is the whole point of not using `JSON.stringify` here: it applies its
 * own rules instead, which disagree with the top-level ones in ways that lose information
 * or leak it. An `Error` and a `Map` both became `{}`; a class instance had its fields
 * dumped, though naming it rather than dumping it is a deliberate rule one level up; a
 * function and an `undefined` vanished without trace; and a single `BigInt` anywhere threw
 * and collapsed the entire render to `[object]`.
 */
function renderNested(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  report: ReportFormatFailure,
): string {
  if (value === null) {
    return charge(budget, 'null');
  }

  switch (typeof value) {
    case 'boolean':
      return charge(budget, value ? 'true' : 'false');
    case 'number':
      // `NaN` and the infinities have no JSON form; `null` is the conventional stand-in.
      return charge(budget, Number.isFinite(value) ? String(value) : 'null');
    case 'string':
      // Cut to fit the budget *after* escaping, and still one JSON string literal: a value
      // truncated inside the quotes, carrying the marker that says so.
      return quoteWithinBudget(budget, value);
    case 'bigint':
      // Rendered as text rather than thrown on, which is what `JSON.stringify` does.
      // Cut like a string leaf: a `BigInt` has no bounded length either.
      return quoteWithinBudget(budget, String(value));
    default:
      break;
  }

  if (isPlainContainer(value)) {
    if (seen.has(value)) {
      // A cycle is cut where it closes, rather than collapsing everything above it.
      noteTruncation(budget, 'circular');

      return charge(budget, quote('[circular]'));
    }

    if (depth >= MAX_RENDER_DEPTH) {
      noteTruncation(budget, 'depth');

      return charge(budget, quote(TRUNCATED));
    }

    // Checked before descending rather than only after emitting: the cost of a runaway
    // render is the walk as much as the string, and a container entered past the budget
    // would serialize its whole subtree before anyone looked at the total.
    if (budget.remaining <= 0) {
      noteTruncation(budget, 'length');

      return charge(budget, quote(TRUNCATED_LENGTH));
    }

    seen.add(value);

    try {
      return renderContainer(value, path, seen, depth, budget, report);
    } finally {
      // Released so a value referenced twice side by side renders in full both times, and
      // only an object genuinely contained within itself is cut.
      seen.delete(value);
    }
  }

  // Bounded like any other leaf. Everything that reaches here renders through its own
  // `toString` - a `URL`, a `Map`, a class instance - and a `toString` has no length limit:
  // one returning ten megabytes was emitted whole, since this path only ever charged for
  // what it had already produced.
  //
  // Rendered against *this* render's allowance rather than bare: called with no budget,
  // `stringifyTemplateValue` falls back to `capToMaxRenderLength`, which cuts at the fixed
  // `MAX_RENDER_LENGTH` and notes nothing - so a caller who raised `maxRenderLength` had a
  // nested leaf silently cut at one megabyte while the same value at the root rendered in
  // full, and `onTruncate` never fired for it.
  const leaf = renderLeafWithinBudget(budget, value, path, report);
  const truncationsBeforeCharge = budget.truncations;
  const quoted = quoteWithinBudget(budget, leaf.text);

  noteLeafCut(budget, leaf, truncationsBeforeCharge);

  return quoted;
}

/** A leaf rendered against a budget, and whatever rendering it had to cut. */
export interface RenderedLeaf {
  text: string;
  /** The cut the render made, or `undefined` when the leaf fitted. */
  cut?: { reason: TruncationReason; dropped: number };
}

/**
 * Render one non-container leaf against a budget, without spending it.
 *
 * {@link stringifyTemplateValue} handed a budget charges what it emits, which is wrong for
 * a caller that has its own charge to make - a quoted leaf, or a row whose every character
 * costs more than one. Handed *no* budget it falls back to {@link capToMaxRenderLength},
 * whose cut is the fixed {@link MAX_RENDER_LENGTH} however much the caller allowed, and
 * which records nothing: a render with a raised `maxRenderLength` was shortened at a bound
 * it had replaced and reported as intact.
 *
 * So the render runs against a copy of the allowance and the caller bills the result. The
 * copy's cut is handed back rather than recorded here: the caller's own charge may cut the
 * same leaf a second time - quoting escapes it, a row re-indents it - and one leaf cut once
 * is one truncation however many passes shortened it. See {@link noteLeafCut}, which is how
 * a caller records it.
 *
 * `levels` is how many characters of output one character of the leaf costs - see
 * {@link chargeNestedText} - so the cut is made against the allowance that will actually
 * hold it.
 */
export function renderLeafWithinBudget(
  budget: RenderBudget,
  value: unknown,
  path: string,
  report: ReportFormatFailure,
  levels: number = 1,
): RenderedLeaf {
  const factor = Math.max(1, levels);
  const shadow: RenderBudget = {
    remaining:
      budget.remaining === Number.POSITIVE_INFINITY
        ? budget.remaining
        : Math.floor(budget.remaining / factor),
    // Scaled like `remaining`, and for the same reason: a key cut inside this leaf is
    // re-emitted once per enclosing level too, so cutting it at the caller's whole
    // allowance would let it render past that allowance `factor` times over.
    limit:
      budget.limit === Number.POSITIVE_INFINITY
        ? budget.limit
        : Math.max(1, Math.floor(budget.limit / factor)),
    truncations: 0,
    droppedChars: 0,
  };

  const text = stringifyTemplateValue(value, path, report, shadow);

  return {
    text,
    cut:
      shadow.truncations > 0
        ? {
            reason: shadow.firstReason ?? 'length',
            dropped: shadow.droppedChars,
          }
        : undefined,
  };
}

/**
 * Fold a leaf's own cut into the caller's budget, unless the caller already cut it again.
 *
 * The two cuts are one truncation: a leaf shortened to the allowance and then shortened
 * again by the charge that quotes or re-indents it was cut once, in the reader's terms.
 * Counted twice, `truncations` and `droppedChars` both over-report - and `droppedChars` is
 * documented as a lower bound on what was actually lost, not on what the render measured
 * twice. Compared against the count taken before the charge, so only a cut the caller did
 * not already record is added.
 */
export function noteLeafCut(
  budget: RenderBudget,
  leaf: RenderedLeaf,
  truncationsBeforeCharge: number,
): void {
  if (
    leaf.cut === undefined ||
    budget.truncations !== truncationsBeforeCharge
  ) {
    return;
  }

  noteTruncation(budget, leaf.cut.reason, leaf.cut.dropped);
}

/** Render a plain object or array as JSON, its leaves rendered by the shared rules. */
function renderContainer(
  value: object,
  path: string,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  report: ReportFormatFailure,
): string {
  // The shared enumeration, so a container that refuses to be read is the same case here
  // as in the redaction walks rather than a locally-invented empty result.
  const shape = describeContainer(value);

  if (shape.kind === 'unreadable') {
    // A revoked `Proxy`, an `ownKeys` trap that throws, a `length` that refuses: there is
    // no shape to render, so this one value degrades rather than taking the whole render
    // with it. Charged like the same marker inside the loops below - it is a leaf this
    // render emits, and one per element of the container above would otherwise be free.
    report(shape.error, path);

    return charge(budget, quote(UNRENDERABLE_KEYS));
  }

  if (shape.kind === 'array') {
    const source = value as unknown[];
    const parts: string[] = [];

    // The two brackets this branch returns, charged as they are decided on rather than
    // when the result is assembled. See `charge` for why an uncharged delimiter defeats
    // the cap entirely.
    charge(budget, '[]');

    for (let index = 0; index < shape.length; index++) {
      // The separator this element will be joined with, charged before anything else so
      // it counts even on the truncation path below.
      if (parts.length > 0) {
        charge(budget, ',');
      }

      // Read inside the guard, exactly as the object branch reads its entries inside one.
      // An element can be a throwing accessor or a `Proxy` trap, and losing the array -
      // and with it every sibling of whatever holds it - over one bad element is the
      // failure this degrades instead.
      //
      // Guarding per element rather than once around the loop: hoisting it was measured
      // and changed nothing (185ms against 181ms for 200k renders), because the cost here
      // is one `JSON.stringify` per string leaf rather than one for the whole value, not
      // the guard. A retry loop would have bought a getter being called twice for no gain.
      // Stops the loop rather than only the element: the elements still to come would
      // each be walked in full before adding to a total already past the cap.
      if (budget.remaining <= 0) {
        noteTruncation(budget, 'length');
        parts.push(charge(budget, quote(TRUNCATED_LENGTH)));

        break;
      }

      try {
        parts.push(
          renderNested(
            source[index],
            `${path}[${String(index)}]`,
            seen,
            depth + 1,
            budget,
            report,
          ),
        );
      } catch (error) {
        report(error, `${path}[${String(index)}]`);
        parts.push(charge(budget, quote(UNRENDERABLE_VALUE)));
      }
    }

    return `[${parts.join(',')}]`;
  }

  // Keys up front, then each value read inside its own guard - never `Object.entries`,
  // which runs every own getter under one `catch`, so a single throwing accessor collapsed
  // the whole object to `[unrenderable]` and lost every sibling beside it. The array branch
  // above degrades one element at a time, and so do `maskValueDeep`, `redactPathsInner`
  // and `errorToString`'s own walk; this was the one that did not.
  const parts: string[] = [];

  // The two braces this branch returns, for the reason the array branch charges its
  // brackets.
  charge(budget, '{}');

  for (const key of shape.keys) {
    // The separator this entry will be joined with, charged before anything else so it
    // counts even on the truncation path below.
    if (parts.length > 0) {
      charge(budget, ',');
    }

    // The key and its separator are charged here; the value charges itself as it renders.
    //
    // `capKey` first. `charge` bills text and hands it back *whole*, which bounds how many
    // keys are emitted and says nothing about the length of one - and the commit that cut
    // "every variable-length leaf" applied that reasoning to values and left keys on the
    // billing-only path. A key is no less variable and no less attacker-shaped: an object
    // parsed from JSON carries whatever names arrived, and
    // `stringifyValue({ ['k'.repeat(5_000_000)]: 1 })` returned 5,000,028 characters
    // against a 1,000,000 cap. Cut inside the quotes, so the result is still JSON.
    //
    // Cut against `keyAllowance` and not against bare `budget.remaining`, which is what
    // separates this from the value side: a key names where the render stopped, so it
    // keeps a short allowance of its own however spent the budget is, and an ordinary key
    // still goes out whole - billed whole too, exactly as `charge` bills every other
    // string it hands back.
    //
    // The quoting is part of the cut for the reason it is on the value side too: `capKey`
    // cuts the raw key and the escaping happens after, so a key of a million NUL characters
    // - six characters each once quoted - was cut to the cap and then emitted at six times
    // it. The identical string as a value had been charged what it emits since
    // `quoteWithinBudget` went in.
    // Stops the loop rather than only this entry, for the reason the array branch does:
    // the entries still to come would each be walked in full to no purpose.
    //
    // Tested *before* this key is charged rather than after, which is what keeps the cap
    // from reopening once per key: a key is cut against the render's whole allowance and
    // not against what is left of it, so charging first let every oversized key through
    // at full size - two 900 KB keys emitted 1,800,035 characters against a 1 MB cap,
    // each one billed after the budget it had already spent was checked.
    //
    // Emitted as this key's *value*, below the key rather than in place of the whole
    // entry. A bare `"[max length exceeded]"` pushed among parts that are all `"key":value`
    // produced `{"a":"...","[max length exceeded]"}`, which is not JSON - `JSON.parse`
    // refuses it with "Expected ':' before value in object property definition", though
    // this function's whole contract is that a plain object renders as JSON. The array
    // branch above has no such problem, since a bare element is legal there. Naming the
    // key also says *where* the render stopped rather than only that it did.
    if (budget.remaining <= 0) {
      noteTruncation(budget, 'length');
      parts.push(
        `${charge(budget, `${quoteKeyWithinCap(budget, key)}:`)}${charge(
          budget,
          quote(TRUNCATED_LENGTH),
        )}`,
      );

      break;
    }

    const renderedKey = charge(budget, `${quoteKeyWithinCap(budget, key)}:`);

    // The read is inside the guard with the render, exactly as the array branch reads its
    // elements inside one: an entry backed by a throwing accessor degrades to a marker in
    // its own slot instead of taking every sibling with it.
    try {
      const entryValue = (value as Record<string, unknown>)[key];

      parts.push(
        `${renderedKey}${renderNested(
          entryValue,
          joinTemplatePath(path, key),
          seen,
          depth + 1,
          budget,
          report,
        )}`,
      );
    } catch (error) {
      report(error, joinTemplatePath(path, key));
      parts.push(`${renderedKey}${charge(budget, quote(UNRENDERABLE_VALUE))}`);
    }
  }

  return `{${parts.join(',')}}`;
}

/**
 * A name for a function, rather than its source.
 *
 * `String(fn)` returns the whole body, which is unbounded and can carry anything the
 * author wrote inside it - a literal key, a comment - into a log line. The name is what
 * identifies it, and matches what `errorToString` already renders for a function.
 */
function describeFunction(value: unknown): string {
  try {
    const name: unknown = (value as { name?: unknown }).name;

    if (typeof name === 'string' && name.length > 0) {
      return `[Function: ${name}]`;
    }
  } catch {
    // Fall through to the anonymous form.
  }

  return '[Function]';
}

/**
 * Where a value sits, for the render reporter alone. Structural segments only - a key the
 * walk already holds or a bracketed index - so nothing a caller supplied as a *value* can
 * reach a report. `<value>` names the root, which has no key of its own.
 */
function joinTemplatePath(...segments: string[]): string {
  const parts = segments.filter((segment) => segment.length > 0);

  return parts.length > 0 ? parts.join('.') : '<value>';
}

/**
 * @param path   Where this value sits, for {@link report}. A caller rendering a bare value
 *               passes nothing and gets `<value>`.
 * @param report Notified of the first value that refuses to render. Defaults to
 *               discarding, so the path every template render takes allocates nothing:
 *               rendering degrades constantly and by design, and only a caller that asked
 *               for the causes should pay for them.
 */
export function stringifyTemplateValue(
  value: unknown,
  path: string = '',
  report: ReportFormatFailure = NOOP_FORMAT_REPORTER,
  budget?: RenderBudget,
): string {
  /**
   * Every leaf this function emits, held to one allowance.
   *
   * Cut to the same allowance a string one level down gets - see `capToMaxRenderLength`:
   * these were the variable-length leaves no budget touched, so whether one was bounded
   * depended only on whether anything was wrapped around it. Against the caller's budget
   * when one is supplied, so a render that shares an allowance with its siblings cannot
   * open a fresh `MAX_RENDER_LENGTH` of its own.
   *
   * Applied at *every* exit, not only the two obvious ones: `[Function: name]` and
   * `[ClassName]` read a `name` that is an ordinary, caller-controlled property and as
   * free to hold two megabytes as a string param is. Nested, `renderNested` puts both
   * through `quoteWithinBudget`; left uncharged here, the bound depended once again on
   * whether the value happened to sit inside a container.
   */
  const emit = (text: string): string =>
    budget === undefined
      ? capToMaxRenderLength(text)
      : chargeText(budget, text);

  if (typeof value === 'string') {
    return emit(value);
  }

  // `undefined` has no JSON form, so it is named the way everything else without one is -
  // `[circular]`, `[Function: f]`, `[Map]`, `[max depth exceeded]`. `String(undefined)`
  // produced the bare word, which inside a container quoted to `"undefined"` and became
  // indistinguishable from the string `'undefined'` actually holding that text. Redaction
  // already tells those apart, masking a genuine string in part and replacing a derived
  // value whole, so the renderer losing the distinction made it the less precise of the
  // two. `null` needs no such treatment: it has a JSON form and renders unquoted.
  //
  // `maskValueDeep` stringifies every leaf through this function before a `redactFunction`
  // sees it, so a custom function is handed `[undefined]` here too rather than a second
  // spelling of the same value.
  if (value === undefined) {
    return emit('[undefined]');
  }

  // A plain object or array is its contents, so render them rather than `[object Object]`
  // - and rather than an array's default comma join, which cannot be told apart from one
  // element that happens to contain a comma.
  if (isPlainContainer(value)) {
    try {
      const seen = new WeakSet<object>();

      seen.add(value);

      return renderContainer(
        value,
        joinTemplatePath(path),
        seen,
        0,
        budget ?? createRenderBudget(),
        report,
      );
    } catch (error) {
      report(error, joinTemplatePath(path));

      // Nothing below is expected to throw: every read it makes is guarded, and the
      // depth cap stops recursion before it can exhaust the stack. Kept as a backstop
      // regardless, because nothing here may escape a log call.
      return emit(Array.isArray(value) ? '[array]' : '[object]');
    }
  }

  // Before the `toString` branch below, which a `Date` would otherwise reach: its own
  // string form is the locale one, and this renders the ISO form at every depth instead.
  const date = renderDate(value);

  if (date !== null) {
    return emit(date);
  }

  if (value !== null && typeof value === 'object') {
    // Reported once, whichever of the two reads refused: both run caller code, and a value
    // that refuses both - a revoked `Proxy` - otherwise rendered `[object Object]` in
    // silence. `report` is itself once-per-operation, so the second call is a no-op rather
    // than a second entry.
    if (!hasOwnStringForm(value)) {
      // A class instance with no `toString` of its own. Name it rather than dumping its
      // fields, which is neither what the caller asked for nor safe to assume is printable.
      return emit(
        describeByConstructor(value, (error) => {
          report(error, joinTemplatePath(path));
        }),
      );
    }
  }

  if (typeof value === 'function') {
    return emit(describeFunction(value));
  }

  try {
    // Every object still here has a `toString` of its own - a plain container was walked
    // above, and one inheriting `Object.prototype`'s was named by its constructor - so
    // this can no longer produce `[object Object]`. The rule cannot see that, and only
    // started asking once the `undefined` check above narrowed `unknown` to a type that
    // admits an object.
    //
    // Capped for the same reason the root string above is: a `toString` of a caller's own
    // is as free to return ten megabytes as a string param is to hold them, and nested,
    // the same instance goes through `quoteWithinBudget` and is cut. Uncapped here, the
    // bound depended only on whether the value happened to sit inside a container -
    // `{{body}}` with a bare instance wrote the lot to every sink, `{ wrapper: body }`
    // wrote a megabyte.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return emit(String(value));
  } catch (error) {
    report(error, joinTemplatePath(path));

    return emit(UNRENDERABLE_TEXT);
  }
}
