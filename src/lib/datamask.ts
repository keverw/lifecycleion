/**
 * Mask emails, domains and plain strings - a proportion of each hidden behind a mask
 * character, the rest left readable.
 *
 * The successor to the `datamask` npm package, which this library used for its default
 * redaction and which has the same three functions with the same arguments and
 * defaults. What changed is the unit: `datamask` indexed a string by UTF-16 code unit,
 * so an emoji-heavy value came back cut through a surrogate pair - a lone `\uD83D` at
 * the seam, `isWellFormed()` false - and the same broken text went wherever the mask
 * did. These count in code points, so a cut never lands inside a character. A value with
 * no astral characters masks exactly as it did before.
 *
 * A character is a grapheme cluster where the runtime has `Intl.Segmenter` - so a
 * family emoji, a flag, a skin-tone variant or `e` + combining accent is one character,
 * hidden behind one mask character or shown whole - and a code point where it does not,
 * which still never splits a surrogate pair. See {@link splitCharacters}.
 *
 * `maskChar.repeat(maskCount)` writes one mask character per hidden character, so a
 * `percent` past 100 or a multi-character `maskChar` lengthens the output. Neither is
 * clamped here: the functions do what they are asked, and a caller masking untrusted
 * input with untrusted settings bounds them first, as the logger's default redaction
 * does.
 */

/**
 * Split a string into the characters the masks count in.
 *
 * Grapheme clusters through `Intl.Segmenter` where the runtime has it, so what a reader
 * sees as one character is one character here: a family emoji built from several code
 * points and zero-width joiners, a flag, a skin-tone variant, a base letter with a
 * combining accent. Code points otherwise, which never split a surrogate pair but can
 * show the base of a cluster with its modifier masked. Either way a cut between two
 * entries is a cut between whole characters, never inside one.
 *
 * Exported so a caller sizing a value before masking it - "too short to mask in part" -
 * counts the same units the mask will.
 */
export function splitCharacters(value: string): string[] {
  const segmenter = graphemeSegmenter();

  if (segmenter === undefined) {
    return Array.from(value);
  }

  const characters: string[] = [];

  for (const { segment } of segmenter.segment(value)) {
    characters.push(segment);
  }

  return characters;
}

/**
 * One segmenter for the module, built on first use: constructing one is the expensive
 * part, segmenting with it is not. `undefined` where the runtime has no `Intl.Segmenter`.
 */
let cachedSegmenter: Intl.Segmenter | undefined | null = null;

function graphemeSegmenter(): Intl.Segmenter | undefined {
  if (cachedSegmenter === null) {
    const ctor = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;

    // Mark the probe complete before invoking host code. A broken implementation should
    // cost one failed construction, not one throw/catch for every redacted leaf forever.
    cachedSegmenter = undefined;

    if (typeof ctor === 'function') {
      try {
        cachedSegmenter = new ctor(undefined, { granularity: 'grapheme' });
      } catch {
        // Code-point splitting is the documented fallback when Segmenter is unavailable.
      }
    }
  }

  return cachedSegmenter;
}

/** The mask character used when none is given. */
export const DEFAULT_MASK_CHAR = '*';
/** How much of a plain string, or of a domain label, is hidden when no percent is given. */
export const DEFAULT_MASK_PERCENT = 60;
/** How much of an email's local part is hidden when no percent is given. */
export const DEFAULT_EMAIL_USER_PERCENT = 50;

/**
 * Mask a proportion of `value`, keeping the ends readable.
 *
 * `percent` of the characters are hidden; the visible remainder is split as evenly as it
 * can be, the shorter half in front. Counted in characters - see
 * {@link splitCharacters} - so the prefix and suffix each end on a whole one.
 *
 * @example
 * ```typescript
 * maskString("I'm a string!", '*', 30); // "I'm a***ring!"
 * maskString('hunter2secret');          // 'hun*******ret'
 * ```
 */
export function maskString(
  value: string,
  maskChar: string = DEFAULT_MASK_CHAR,
  percent: number = DEFAULT_MASK_PERCENT,
): string {
  // In characters, so the prefix and suffix each end on a whole one.
  const characters = splitCharacters(value);
  const length = characters.length;

  if (length === 0) {
    return '';
  }

  const maskCount = Math.floor((length * percent) / 100);
  const offset = Math.floor((length - maskCount) / 2);

  return (
    characters.slice(0, offset).join('') +
    maskChar.repeat(maskCount) +
    characters.slice(offset + maskCount).join('')
  );
}

/**
 * Mask a hostname label by label, keeping the dots and the last label whole.
 *
 * Every label but the last is masked with {@link maskString} at `percent`; the last one -
 * the TLD, ordinarily - is left readable. A value with no dot is masked as one string.
 *
 * @example
 * ```typescript
 * maskDomain('example.com', '*', 50); // 'ex***le.com'
 * ```
 */
export function maskDomain(
  value: string,
  maskChar: string = DEFAULT_MASK_CHAR,
  percent: number = DEFAULT_MASK_PERCENT,
): string {
  if (!value.includes('.')) {
    return maskString(value, maskChar, percent);
  }

  const labels = value.split('.');
  const last = labels.length - 1;

  return labels
    .map((label, index) =>
      index === last ? label : maskString(label, maskChar, percent),
    )
    .join('.');
}

/**
 * Mask an email address as a local part and a domain, keeping the `@`.
 *
 * The local part is masked with {@link maskString} at `userPercent`, the domain with
 * {@link maskDomain} at `domainPercent`. Only the text up to the first `@` and the text
 * between the first and second are used - an address with a second `@` loses what follows
 * it, which is a safe direction for a mask to err in. A value with no `@` at all is masked
 * as one string at `userPercent`.
 *
 * @example
 * ```typescript
 * maskEmail('test@example.com');               // 't**t@e****le.com'
 * maskEmail('test@example.com', '#', 45, 80);  // 't#st@e#####e.com'
 * ```
 */
export function maskEmail(
  value: string,
  maskChar: string = DEFAULT_MASK_CHAR,
  userPercent: number = DEFAULT_EMAIL_USER_PERCENT,
  domainPercent: number = DEFAULT_MASK_PERCENT,
): string {
  if (!value.includes('@')) {
    return maskString(value, maskChar, userPercent);
  }

  const [user = '', domain = ''] = value.split('@');

  return `${maskString(user, maskChar, userPercent)}@${maskDomain(domain, maskChar, domainPercent)}`;
}

/**
 * The original `datamask` API shape - `string`, `domain`, `email` - for a caller moving
 * off the npm package without renaming every call.
 *
 * @example
 * ```typescript
 * import { datamask } from 'lifecycleion/datamask';
 *
 * datamask.email('test@example.com'); // 't**t@e****le.com'
 * ```
 */
export const datamask = {
  string: maskString,
  domain: maskDomain,
  email: maskEmail,
} as const;
