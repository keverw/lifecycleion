/**
 * Mask emails, domains and plain strings - a proportion of each hidden behind a mask
 * character, the rest left readable.
 *
 * The successor to the `datamask` npm package, which this library used for its default
 * redaction and which has the same three functions with the same arguments and
 * defaults, including treating null optional settings as omitted. What changed is the unit: `datamask` indexed a string by UTF-16 code unit,
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
 * Percentages are clamped to 0–100, including infinities. A multi-character mask
 * lengthens the output. A NaN percentage throws RangeError rather than silently
 * returning unmasked input. Non-number percentages throw TypeError. Lone surrogate
 * mask characters fall back to `*`.
 */

import { splitGraphemes } from './internal/graphemes';

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
  return splitGraphemes(value);
}

/** The mask character used when none is given. */
export const DEFAULT_MASK_CHAR = '*';
/** How much of a plain string, or of a domain label, is hidden when no percent is given. */
export const DEFAULT_MASK_PERCENT = 60;
/** How much of an email's local part is hidden when no percent is given. */
export const DEFAULT_EMAIL_USER_PERCENT = 50;

function validatePercent(percent: number | null): void {
  if (percent !== null && typeof percent !== 'number') {
    throw new TypeError('Mask percentage must be a number');
  }
  if (Number.isNaN(percent)) {
    throw new RangeError('Mask percentage must not be NaN');
  }
}

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
  maskChar: string | null = DEFAULT_MASK_CHAR,
  percent: number | null = DEFAULT_MASK_PERCENT,
): string {
  maskChar ??= DEFAULT_MASK_CHAR;
  // Unicode mode matches lone surrogates while preserving valid astral pairs.
  maskChar = maskChar.replace(/[\uD800-\uDFFF]/gu, DEFAULT_MASK_CHAR);
  percent ??= DEFAULT_MASK_PERCENT;
  validatePercent(percent);
  percent = Math.max(0, Math.min(100, percent));
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
  maskChar: string | null = DEFAULT_MASK_CHAR,
  percent: number | null = DEFAULT_MASK_PERCENT,
): string {
  validatePercent(percent);
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
  maskChar: string | null = DEFAULT_MASK_CHAR,
  userPercent: number | null = DEFAULT_EMAIL_USER_PERCENT,
  domainPercent: number | null = DEFAULT_MASK_PERCENT,
): string {
  userPercent ??= DEFAULT_EMAIL_USER_PERCENT;
  validatePercent(userPercent);
  validatePercent(domainPercent);
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
