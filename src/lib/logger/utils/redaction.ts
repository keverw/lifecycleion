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
 * The params bag as a plain object holding exactly what the walk and the renderer can
 * both reach.
 *
 * Always copied, and copied with `for...in` rather than a spread. Both halves of that
 * fix the same class of bug: the walk enumerates a bag, while the template renderer
 * resolves `{{name}}` by property lookup, and every key one of them can see that the
 * other cannot is either a value printed without being masked or a value masked out of a
 * message that would have printed it.
 *
 * - A spread and `Object.entries` see only *own enumerable* properties, so a key on the
 *   prototype - a bag built with `Object.create`, or a class instance - was invisible to
 *   redaction while the renderer still resolved it. `for...in` walks the prototype chain,
 *   so both now see it and it is masked and printed as it was before this walk existed.
 * - Neither sees a *non-enumerable* own property, or one a `Proxy` hides from `ownKeys`,
 *   but property lookup does. Handing the caller's own bag straight to the walk left such
 *   a key unmasked *and* still resolvable, so `{{password}}` rendered a secret the
 *   caller had explicitly named. Copying means the renderer is given this object instead,
 *   which does not carry the key at all: it is neither masked nor printed, which is what
 *   the walk not seeing it has to mean.
 *
 * Values are copied by reference, so this stays shallow - `redactedParams` is still not
 * a snapshot of what lies beneath it.
 *
 * Defined rather than assigned, because a plain assignment to `__proto__` reparents the
 * object instead of storing the entry.
 */
function normalizeParamsBag(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};

  for (const key in params) {
    Object.defineProperty(copy, key, {
      value: params[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return copy;
}

/**
 * Every redacted key marked as failed, used whenever nothing safer can be produced.
 *
 * Exported because two layers need the same answer: `applyRedaction` when the list is
 * present but unusable, and any caller that has to fail a whole redacted log call closed.
 * Written twice, the two drifted the moment either changed what "all marked" means, and a
 * sink would then have seen a different shape depending on which layer gave up.
 *
 * Guarded throughout: this runs precisely because the input could not be trusted, so it
 * must not assume `redactedKeys` is a usable array - a fail-closed branch that throws is
 * not fail-closed. With nothing nameable to mark, an empty object is the safe answer,
 * since it carries no original value.
 */
export function markAllRedactionFailed(
  redactedKeys: unknown,
): Record<string, unknown> {
  try {
    return Object.fromEntries(
      (redactedKeys as string[]).map((key) => [key, REDACTION_FAILED_MARKER]),
    );
  } catch {
    return {};
  }
}

/**
 * Apply redaction to params based on redacted keys
 * Supports top-level keys and mixed object/array paths
 * (e.g., 'user.password', 'users[0].password', or 'users[0]["password-hash"]')
 *
 * @param params Original params object
 * @param redactedKeys Keys to redact (supports nested object paths, array indexes, and quoted bracket keys)
 * @param redactFunction Custom redaction function (uses defaultRedactFunction if not provided)
 * @returns With no `redactedKeys` to act on, `params` itself - nothing was asked for, so
 *          nothing is copied. Otherwise a fresh plain bag carrying exactly the keys the
 *          walk saw, so the renderer cannot resolve one the walk could not: every matched
 *          path masked, and every other value carried over by reference, since copies are
 *          built only along the branches that lead to a mask.
 */
export function applyRedaction(
  params: Record<string, unknown>,
  redactedKeys?: string[],
  redactFunction?: RedactFunction,
  onRedactionError?: RedactionErrorHandler,
): Record<string, unknown> {
  const report = createRedactionReporter(onRedactionError);

  // Read inside the guard, not before it. `redactedKeys` is typed `string[]`, but a
  // JavaScript caller can hand over anything, and `length` is an ordinary property that a
  // `Proxy` or an accessor can make throw. Reading it in the function's own head put the
  // one throw this function could not catch in the one place nothing was watching, which
  // is why `handleLog` carried a second copy of the fail-closed bag purely to catch it.
  let requestedCount: number;

  try {
    if (!redactedKeys) {
      return params;
    }

    requestedCount = redactedKeys.length;
  } catch (error) {
    report(error, '<redactedKeys>');

    // Nothing nameable to mark, since the list is what could not be read.
    return {};
  }

  // No redaction needed
  if (requestedCount === 0) {
    return params;
  }

  // Checked before anything reads the list: a non-array cannot name a key, so there is
  // no safe way to redact and no key to mark. Returning `params` would hand back the
  // values the caller asked to hide.
  if (!Array.isArray(redactedKeys)) {
    report(new Error('redactedKeys is not an array'), '<redactedKeys>');

    return {};
  }

  // Parsed with the shared parser rather than a local `includes('.')` test, so an entry
  // addresses the same thing here as it does in `sensitiveFieldNames` and
  // `stringifyValue`. A list that is present but unusable fails closed.
  const paths = parseRedactPaths(redactedKeys);

  if (paths === null) {
    report(
      new Error('redactedKeys is not a usable list of paths'),
      '<redactedKeys>',
    );

    return markAllRedactionFailed(redactedKeys);
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
  // for it. The walk treats anything with a non-plain prototype as a single *value* -
  // right for a `URL` or a class instance sitting inside a payload, since that is how it
  // renders, but wrong for the bag being walked, whose entries are the params.
  //
  // This is now the only thing standing between a non-plain bag and an unmasked log line.
  // It first went in when a class instance passed as `params` matched "a path points
  // inside this" at the root and came back as the string `'***REDACTED***'`, against this
  // function's declared record type. Since a path no longer addresses the root at all,
  // the failure has changed sides and got quieter: an unnormalized class instance is now
  // left *entirely alone*, so a key named in `redactedKeys` is never masked and the
  // renderer prints it. Verified rather than assumed - the walk hands back
  // `{ password: 'hunter2secret' }` for a `Session` bag redacted on `['password']`.
  //
  // Guarded because a property can be an accessor that throws, and copying abandons the
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
    root = normalizeParamsBag(params);
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

    // `for...in`, matching `normalizeParamsBag`: an inherited enumerable key is one the
    // renderer resolves, so it has to reach the walk here too or this path would mask
    // and print a different set of keys than the one above it.
    for (const key in source) {
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
    return markAllRedactionFailed(redactedKeys);
  }

  // Never fall through with the originals: a sensitive key still holding its own value is
  // the one outcome redaction exists to prevent.
  const walked = walk(guarded);

  if (walked === null) {
    return markAllRedactionFailed(redactedKeys);
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
