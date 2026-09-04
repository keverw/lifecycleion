import {
  defaultRedactValue,
  REDACTION_FAILED_MARKER,
} from '../../internal/default-redact-function';
import { isPlainContainer } from '../../internal/is-plain-container';
import {
  parseRedactPaths,
  redactMatchedPaths,
} from '../../internal/redact-paths';
import type { RedactFunction } from '../types';
import {
  createRedactionReporter,
  type RedactionErrorHandler,
} from '../../internal/redaction-reporter';

/**
 * Default redaction function using datamask
 * Masks sensitive values with asterisks
 */
export const defaultRedactFunction: RedactFunction = defaultRedactValue;

export { REDACTION_FAILED_MARKER } from '../../internal/default-redact-function';

/**
 * Apply redaction to params based on redacted keys
 * Supports top-level keys and mixed object/array paths
 * (e.g., 'user.password', 'users[0].password', or 'users[0]["password-hash"]')
 *
 * @param params Original params object
 * @param redactedKeys Keys to redact (supports nested object paths, array indexes, and quoted bracket keys)
 * @param redactFunction Custom redaction function (uses defaultRedactFunction if not provided)
 * @returns New object with redacted values
 */
export function applyRedaction(
  params: Record<string, unknown>,
  redactedKeys?: string[],
  redactFunction?: RedactFunction,
  onRedactionError?: RedactionErrorHandler,
): Record<string, unknown> {
  // No redaction needed
  if (!redactedKeys || redactedKeys.length === 0) {
    return params;
  }

  const report = createRedactionReporter(onRedactionError);

  // Checked before anything reads the list: a non-array cannot name a key, so there is
  // no safe way to redact and no key to mark. Returning `params` would hand back the
  // values the caller asked to hide.
  if (!Array.isArray(redactedKeys)) {
    report(new Error('redactedKeys is not an array'), '<redactedKeys>');

    return {};
  }

  /**
   * Every redacted key marked, used whenever nothing safer can be produced.
   *
   * Guarded: this runs on the path that exists because the input could not be trusted,
   * so it must not assume `redactedKeys` is a usable array. `redactedKeys` is typed
   * `string[]`, but a JavaScript caller can pass anything, and a fail-closed branch that
   * throws is not fail-closed. With nothing nameable to mark, an empty object is the
   * safe answer - it carries no original value.
   */
  const allMarked = (): Record<string, unknown> => {
    try {
      return Object.fromEntries(
        redactedKeys.map((key) => [key, REDACTION_FAILED_MARKER]),
      );
    } catch {
      return {};
    }
  };

  // Parsed with the shared parser rather than a local `includes('.')` test, so an entry
  // addresses the same thing here as it does in `sensitiveFieldNames` and
  // `stringifyValue`. A list that is present but unusable fails closed.
  const paths = parseRedactPaths(redactedKeys);

  if (paths === null) {
    report(
      new Error('redactedKeys is not a usable list of paths'),
      '<redactedKeys>',
    );

    return allMarked();
  }

  // No copy is made, and none is probed for either.
  //
  // A `deepClone` of the params used to run here purely as a throw-probe, its result
  // discarded: the theory was that a structure `deepClone` cannot copy - a throwing
  // getter, a revoked `Proxy` - meant redaction could not be trusted. It was wrong in
  // both directions. It cost a full deep clone of the params on every redacted log call
  // for a value nothing read, and it failed closed on payloads the walk itself handles
  // perfectly well: one unrelated throwing getter anywhere in the bag dropped *every*
  // param, including the sensitive one that would have masked correctly.
  //
  // The walk is the thing that fails closed, per value and where the failure actually is:
  // an unreadable set of keys or an unreadable element yields the failure marker in that
  // one place, and `redactMatchedPaths` refuses the "nothing matched, keep the original"
  // shortcut once any read has failed. A total refusal beneath it is caught below.
  //
  // The walk runs over `params` itself and builds its own copies - only along the
  // branches that lead to a redacted key; every other param is passed through by
  // reference. That is what keeps a `Date`, an `Error`, or a `URL` logged alongside a
  // secret from being flattened into `{}` - both in the rendered message and in the
  // `redactedParams` a structured sink reads. It does not mutate what it reads.

  // The params bag itself is normalized to a plain object, which the walk does not do
  // for it. The walk treats anything with a non-plain prototype as a single *value* and
  // masks it whole - right for a `URL` or a class instance sitting inside a payload,
  // since that is how it renders, but wrong for the bag being walked. A class instance
  // passed as `params` matched "a path points inside this" at the root and came back as
  // the string `'***REDACTED***'`, against this function's declared record type: every
  // template placeholder then rendered as the fallback, and a structured sink reading
  // `entry.redactedParams` got a string where it expected its params.
  //
  // Spread rather than walked as-is: own enumerable properties are exactly what the
  // renderer prints and what the walk would have read anyway, so this changes only the
  // prototype. A plain bag is handed over untouched, so a walk that matches nothing gives
  // the caller back its own object.
  //
  // Guarded because a property can be an accessor that throws, and a spread abandons the
  // whole bag at the first one that does. That is the retry below, not a reason to give
  // up on the params.
  const walk = (
    root: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    let result: unknown;

    try {
      result = redactMatchedPaths(root, paths, redactFunction, report);
    } catch (error) {
      // The walk guards every step it owns, so reaching here means something beneath it
      // refused entirely.
      report(error, '<params>');

      return null;
    }

    // The walk can hand back a single value rather than a bag - the failure marker it
    // returns when the root's own keys could not be read, say - and this function
    // declares a record. Returning a string would make every template placeholder render
    // as the fallback and give a structured sink reading `entry.redactedParams` a string
    // where it expects its params.
    return isPlainContainer(result) && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  };

  let root: Record<string, unknown> | null;

  try {
    root = isPlainContainer(params)
      ? params
      : { ...(params as Record<string, unknown>) };
  } catch {
    root = null;
  }

  if (root !== null) {
    const walked = walk(root);

    if (walked !== null) {
      return walked;
    }
  }

  // The bag could not be read as it stands - an accessor that throws defeated the spread,
  // or defeated `Object.entries` inside the walk and collapsed the root to the failure
  // marker. Retried one key at a time so a throwing param is marked where it is and every
  // other param, the sensitive one included, is still masked and still logged. Dropping
  // them all is what the discarded `deepClone` probe used to do, and it hid working
  // redaction behind an unrelated getter. Values are copied by reference, so this stays a
  // shallow copy, and it runs only on this failure path.
  let guarded: Record<string, unknown>;

  // The keys whose read failed, so the marker can be put back after the walk. A key that
  // is *also* named in `redactedKeys` arrives at the walk already holding the marker, and
  // the walk masks whatever it finds there - which turns `***REDACTION FAILED***` into an
  // ordinary-looking `**********`, exactly the disguise the distinct marker exists to
  // prevent. Nothing but the marker is ever written back, so this cannot restore a value.
  const unreadable: string[] = [];

  try {
    const source = params;

    guarded = {};

    for (const key of Object.keys(source)) {
      let copied: unknown;

      try {
        copied = source[key];
      } catch {
        copied = REDACTION_FAILED_MARKER;
        unreadable.push(key);
      }

      // Defined rather than assigned, for the reason the walk defines: a plain assignment
      // to `__proto__` is a no-op for a string and reparents the object for an object, so
      // a bag carrying that key would silently lose the entry or change the shape of what
      // is walked.
      Object.defineProperty(guarded, key, {
        value: copied,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  } catch {
    // `Object.keys` itself refused - a revoked `Proxy`, an `ownKeys` trap that throws -
    // so there is no key to read safely and nothing to mark but the redacted ones.
    return allMarked();
  }

  // Never fall through with the originals: a sensitive key still holding its own value is
  // the one outcome redaction exists to prevent.
  const walked = walk(guarded);

  if (walked === null) {
    return allMarked();
  }

  for (const key of unreadable) {
    try {
      Object.defineProperty(walked, key, {
        value: REDACTION_FAILED_MARKER,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } catch {
      // The walk returns either `guarded` itself or a copy it built, both of them plain
      // and writable, so this cannot fail - and if it somehow did, the key already holds
      // a mask of the marker rather than anything the caller passed in.
    }
  }

  return walked;
}
