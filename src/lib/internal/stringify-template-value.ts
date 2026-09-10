/**
 * Normalizes values to the same string representation used by template rendering.
 */

import { describeContainer } from './container-entries';
import { isPlainContainer } from './is-plain-container';
import {
  NOOP_RENDER_REPORTER,
  type ReportRenderFailure,
} from './render-reporter';
import {
  charge,
  createRenderBudget,
  MAX_RENDER_DEPTH,
  TRUNCATED,
  TRUNCATED_LENGTH,
  type RenderBudget,
} from './render-budget';

/**
 * Whether a value carries a `toString` of its own worth using.
 *
 * `Error`, `Date`, `URL` and anything else that overrides `toString` renders something
 * meaningful. A class that does not override it inherits `Object.prototype.toString`,
 * which renders `[object Object]` and says nothing at all.
 */
export function hasOwnStringForm(value: object): boolean {
  try {
    return (
      (value as { toString?: unknown }).toString !== Object.prototype.toString
    );
  } catch {
    return false;
  }
}

/** A name for a value whose own string form says nothing, such as `[FooBar]`. */
function describeByConstructor(value: object): string {
  try {
    const name: unknown = (value as { constructor?: { name?: unknown } })
      .constructor?.name;

    if (typeof name === 'string' && name.length > 0) {
      return `[${name}]`;
    }
  } catch {
    // Fall through to the generic form.
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
  report: ReportRenderFailure,
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
      return charge(budget, quote(value));
    case 'bigint':
      // Rendered as text rather than thrown on, which is what `JSON.stringify` does.
      return charge(budget, quote(String(value)));
    default:
      break;
  }

  if (isPlainContainer(value)) {
    if (seen.has(value)) {
      // A cycle is cut where it closes, rather than collapsing everything above it.
      return charge(budget, quote('[circular]'));
    }

    if (depth >= MAX_RENDER_DEPTH) {
      return charge(budget, quote(TRUNCATED));
    }

    // Checked before descending rather than only after emitting: the cost of a runaway
    // render is the walk as much as the string, and a container entered past the budget
    // would serialize its whole subtree before anyone looked at the total.
    if (budget.remaining <= 0) {
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

  return charge(budget, quote(stringifyTemplateValue(value, path, report)));
}

/** Render a plain object or array as JSON, its leaves rendered by the shared rules. */
function renderContainer(
  value: object,
  path: string,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  report: ReportRenderFailure,
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

    return charge(budget, quote('[unrenderable]'));
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
        parts.push(charge(budget, quote('[unrenderable]')));
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

    // Stops the loop rather than only this entry, for the reason the array branch does:
    // the entries still to come would each be walked in full to no purpose.
    if (budget.remaining <= 0) {
      parts.push(charge(budget, quote(TRUNCATED_LENGTH)));

      break;
    }

    // The key and its separator are charged here; the value charges itself as it renders.
    const renderedKey = charge(budget, `${quote(key)}:`);

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
      parts.push(`${renderedKey}${charge(budget, quote('[unrenderable]'))}`);
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
  report: ReportRenderFailure = NOOP_RENDER_REPORTER,
): string {
  if (typeof value === 'string') {
    return value;
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
    return '[undefined]';
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
        createRenderBudget(),
        report,
      );
    } catch (error) {
      report(error, joinTemplatePath(path));

      // Nothing below is expected to throw: every read it makes is guarded, and the
      // depth cap stops recursion before it can exhaust the stack. Kept as a backstop
      // regardless, because nothing here may escape a log call.
      return Array.isArray(value) ? '[array]' : '[object]';
    }
  }

  // Before the `toString` branch below, which a `Date` would otherwise reach: its own
  // string form is the locale one, and this renders the ISO form at every depth instead.
  const date = renderDate(value);

  if (date !== null) {
    return date;
  }

  if (value !== null && typeof value === 'object' && !hasOwnStringForm(value)) {
    // A class instance with no `toString` of its own. Name it rather than dumping its
    // fields, which is neither what the caller asked for nor safe to assume is printable.
    return describeByConstructor(value);
  }

  if (typeof value === 'function') {
    return describeFunction(value);
  }

  try {
    // Every object still here has a `toString` of its own - a plain container was walked
    // above, and one inheriting `Object.prototype`'s was named by its constructor - so
    // this can no longer produce `[object Object]`. The rule cannot see that, and only
    // started asking once the `undefined` check above narrowed `unknown` to a type that
    // admits an object.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(value);
  } catch (error) {
    report(error, joinTemplatePath(path));

    return '[unrenderable]';
  }
}
