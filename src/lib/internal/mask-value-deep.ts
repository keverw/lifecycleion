import {
  REDACTED_PLACEHOLDER,
  REDACTION_FAILED_MARKER,
} from './default-redact-function';
import {
  defineEntry,
  describeContainer,
  namedArrayKeys,
} from './container-entries';
import { isPlainContainer } from './is-plain-container';
import {
  NOOP_FORMAT_REPORTER,
  type ReportFormatFailure,
} from './format-reporter';
import { stringifyTemplateValue } from './stringify-template-value';
import {
  charge,
  chargeUnits,
  createRenderBudget,
  MAX_RENDER_DEPTH,
  type RenderBudget,
} from './render-budget';

/**
 * Applies the caller's masking to one leaf value.
 *
 * `isDerived` is true when `value` is the string form of an object rather than the
 * value itself. Proportional masking must not be used on a derived string: the default
 * masking keeps the first and last characters, and for a `URL` or a custom `toString`
 * the secret often lives at exactly those ends - a query-string API key survived almost
 * intact. A derived string is replaced outright instead.
 */
export type MaskLeaf = (
  key: string,
  value: string,
  isDerived: boolean,
) => unknown;

/**
 * Mask every leaf of a value, keeping its shape.
 *
 * Naming a container in `redactedKeys` or `sensitiveFieldNames` used to stringify it and
 * mask the result, which was wrong twice over. `String({ a: 'secret' })` is
 * `'[object Object]'`, so the mask was applied to text that was never the secret and the
 * structure was replaced by a meaningless `[ob*********ct]`. An array fared worse:
 * `['topsecret', 'other']` joined to `'topsecret,other'` and masked proportionally, so
 * the edges of the first and last elements survived into the output.
 *
 * Masking each leaf and rebuilding the container fixes both, and keeps the shape intact
 * for a structured sink that reads the redacted params.
 *
 * @param key   The entry as the caller wrote it. Every leaf under it is masked because of
 *              that one entry, so that is the key each leaf is reported under - a
 *              `redactFunction` keyed on it keeps working for a container.
 * @param value The value to mask.
 * @param mask  Applied to each leaf, already stringified the way templates render it.
 * @param seen  Guards against a container that contains itself.
 * @param report Notified of the first leaf whose masking threw, so a broken
 *               `redactFunction` leaves a diagnosis and not only a marker.
 * @param depth  How far below the named container this call sits. Callers start at the
 *               default.
 * @param budget The allowance for this whole mask, shared by every level of it. One
 *               top-level call gets one allowance, so callers start at the default.
 *
 * Bounded in both directions for the reason the renderers are. `seen` is released on the
 * way out - deliberately, so a value referenced twice side by side is masked both times -
 * so a shared subtree is walked once per reference: `{ l: child, r: child }` nested 27
 * levels took 51 seconds and 9.4 GB before these limits, and this runs *before* the
 * budgeted render sees anything, so bounding only the render left the cost untouched.
 */
export function maskValueDeep(
  key: string,
  value: unknown,
  mask: MaskLeaf,
  seen: WeakSet<object> = new WeakSet(),
  report: ReportFormatFailure = NOOP_FORMAT_REPORTER,
  depth: number = 0,
  budget: RenderBudget = createRenderBudget(),
): unknown {
  // Only a plain object or an array is walked. Anything else - an `Error`, a `Date`, a
  // `URL`, a class instance - has no shape worth rebuilding, so it is replaced outright
  // by the caller's mask rather than partially masked. Rendering it and masking a
  // proportion of the result is what leaked: a `URL` keeps its query string at the end,
  // which is exactly where an API key sits and exactly what the default preserves.
  //
  // Tested by prototype rather than with `is-plain-object`, which accepts an `Error` and
  // a `Date` too. Guarded because reading the prototype of a revoked `Proxy` throws.
  //
  if (!isPlainContainer(value)) {
    // Partial masking is only ever right for a value that was genuinely a string.
    // Everything else - a number, an object, a function, a symbol - reaches the mask as
    // a *produced* string, and proportional masking keeps its ends: a card number kept
    // its BIN prefix and last four, a `URL` kept its query.
    const isDerived = typeof value !== 'string';
    const text = stringifyTemplateValue(value);

    charge(budget, text);

    return mask(key, text, isDerived);
  }

  // Past either limit nothing of the original survives, which is the safe direction here
  // and the same answer the cycle below gives. A truncation marker would read as masked
  // content rather than as the absence of it.
  if (depth >= MAX_RENDER_DEPTH || budget.remaining <= 0) {
    return REDACTED_PLACEHOLDER;
  }

  if (seen.has(value)) {
    // A cycle cannot be rebuilt, and must not be walked forever. Nothing of the original
    // survives here, which is the safe direction.
    return REDACTED_PLACEHOLDER;
  }

  seen.add(value);

  try {
    // The shared enumeration, so this walk and the rendering walks cannot disagree about
    // what a container holds or about a read that refused.
    const shape = describeContainer(value);

    if (shape.kind === 'unreadable') {
      // Nothing can be enumerated, so nothing of the original may survive - and there is
      // no way to know what is below. Fails closed, as the same read does in
      // `redactPathsInner`.
      report(shape.error, key);

      return REDACTION_FAILED_MARKER;
    }

    if (shape.kind === 'array') {
      // A plain `[]` filled by index, not `source.map`, for the reason `redactPathsInner`
      // does the same: `map` goes through `ArraySpeciesCreate`, which calls the value's
      // own subclass constructor with a length. A tuple subclass whose constructor
      // rejects that argument threw from inside the walk, where there is no `catch`, so
      // a named container came back as the failure marker instead of the masked array
      // shape this promises. Rebuilding plain also matches what masking does everywhere
      // else: the caller's value must not be mutated and its type cannot be
      // reconstructed from outside.
      const source = value as unknown[];
      const masked: unknown[] = [];

      // Whether the truncation marker below has already gone in, so the named pass does
      // not add a second one for the same spent budget.
      let didMarkTruncation = false;

      // A counted index loop, not `for...of`: iteration resolves `Symbol.iterator` off
      // the value, which is caller code on a subclass, free to throw or to yield
      // something other than the elements. Same reason `redactPathsInner` counts.
      for (let index = 0; index < shape.length; index++) {
        // `shape.length` is the caller's own `length`, and that is not a fact:
        // `Array.isArray` is true for a `Proxy` over an array, and a `get` trap may answer
        // any number at all. Once the budget is spent every remaining element masks to the
        // placeholder anyway - the guard at the top of this function says so - so spinning
        // through five million of them to emit five million placeholders buys nothing but
        // the stall. One placeholder stands for the tail, which is what the rest would
        // have been.
        if (budget.remaining <= 0) {
          masked.push(REDACTED_PLACEHOLDER);
          didMarkTruncation = true;

          break;
        }

        // Each element read and masked inside its own guard, exactly as
        // `redactPathsInner` and `renderContainer` do. Without this, one throwing
        // accessor anywhere inside a named container collapsed the *whole* container to
        // the failure marker at the caller's `catch` - so a payload that redacted
        // perfectly well everywhere else lost its shape, and the two walks disagreed
        // about a value they are meant to treat identically.
        try {
          chargeUnits(budget, 1);

          masked.push(
            maskValueDeep(
              key,
              source[index],
              mask,
              seen,
              report,
              depth + 1,
              budget,
            ),
          );
        } catch (error) {
          report(error, key);
          masked.push(REDACTION_FAILED_MARKER);
        }
      }

      // An array's *named* properties, for the same reason `redactPathsInner` carries
      // them: `describeContainer` reports an array as a length, so this branch rebuilt it
      // without them - and a rebuilt array is what the caller receives, so anything not
      // carried over is simply gone. `const a = ['s1', 's2']; a.note = 'request-42';`
      // masked the two elements and dropped `note` entirely. The comment below the loop
      // claimed parity with that walk while this was the one place the two disagreed.
      //
      // Behind the budget check and after the index loop, exactly as there: `Object.keys`
      // materializes every own index key as a string, which on a large array is the stall
      // the budget exists to bound, and running it once the budget is spent defeats the
      // cap it sits next to.
      //
      // Truncation is marked rather than left silent, which is what every other stopping
      // point in both walks does. A key that was never enumerated cannot be named, so the
      // marker goes in as a trailing element - the same one the index loop writes - rather
      // than under a key this cannot invent. Without it an array whose budget ran out on
      // its *last element* came back with its named properties simply missing and nothing
      // anywhere saying so: the index loop exits normally in that case, having written no
      // marker at all.
      if (budget.remaining <= 0) {
        if (!didMarkTruncation) {
          masked.push(REDACTED_PLACEHOLDER);
          didMarkTruncation = true;
        }
      } else {
        let namedKeys: string[] = [];

        try {
          namedKeys = namedArrayKeys(source);
        } catch (error) {
          // Reported *and* marked. A failed enumeration is not an array without named
          // properties, and treating it as one is the difference between "there was
          // nothing here" and "what was here could not be read".
          report(error, key);
          masked.push(REDACTION_FAILED_MARKER);
        }

        for (const namedKey of namedKeys) {
          if (budget.remaining <= 0) {
            if (!didMarkTruncation) {
              masked.push(REDACTED_PLACEHOLDER);
              didMarkTruncation = true;
            }

            break;
          }

          try {
            charge(budget, namedKey);

            defineEntry(
              masked as unknown as Record<string, unknown>,
              namedKey,
              maskValueDeep(
                key,
                (source as unknown as Record<string, unknown>)[namedKey],
                mask,
                seen,
                report,
                depth + 1,
                budget,
              ),
            );
          } catch (error) {
            report(error, key);
            defineEntry(
              masked as unknown as Record<string, unknown>,
              namedKey,
              REDACTION_FAILED_MARKER,
            );
          }
        }
      }

      return masked;
    }

    // Keys read up front, then each value inside its own guard - never `Object.entries`,
    // which runs every getter under one `catch`, so one throwing accessor collapsed the
    // whole named container to the failure marker while the array branch above degraded a
    // single slot. Per entry, as `redactPathsInner` and `renderContainer` do.
    const masked: Record<string, unknown> = {};

    for (const entryKey of shape.keys) {
      // The same stop the array branch makes, and for the same reason. Past the budget
      // every remaining entry masks to the placeholder anyway - the guard at the top of
      // this function says so for a container, and a *leaf* does not even reach it: the
      // non-container path above returns before the check, so it renders and masks its
      // value in full no matter how much budget is left. A million-key object of string
      // leaves therefore cost 969 ms and some sixty megabytes of mask text, while the
      // equivalent array stopped after fifteen thousand elements in seven. One
      // placeholder stands for the tail, which is what the rest would have been.
      if (budget.remaining <= 0) {
        // `defineEntry`, like every other write in this loop: a plain assignment to
        // `__proto__` is a no-op for a string, so a budget that ran out on exactly that
        // key would have dropped the marker and made the truncation invisible.
        defineEntry(masked, entryKey, REDACTED_PLACEHOLDER);

        break;
      }

      let entryResult: unknown;

      try {
        charge(budget, entryKey);

        entryResult = maskValueDeep(
          key,
          (value as Record<string, unknown>)[entryKey],
          mask,
          seen,
          report,
          depth + 1,
          budget,
        );
      } catch (error) {
        report(error, key);
        entryResult = REDACTION_FAILED_MARKER;
      }

      // Defined rather than assigned: a plain assignment to `__proto__` is a no-op for a
      // string and reparents the rebuilt object for an object, so a payload carrying that
      // key would silently lose the entry or change the shape of the result.
      defineEntry(masked, entryKey, entryResult);
    }

    return masked;
  } finally {
    // Released so a value referenced twice side by side is masked both times rather than
    // the second being reported as a cycle.
    seen.delete(value);
  }
}
