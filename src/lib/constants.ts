// prettier-ignore
export const BLANK_SPACE = ' ';

export const EOL = '\n';
export const DOUBLE_EOL = EOL + EOL;
export const INDENT = ' '.repeat(4);
export const DOUBLE_INDENT = INDENT + INDENT;

// prettier-ignore
export const SINGLE_QUOTE = "'";

// similar to Python string library
export const ASCII_LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
export const ASCII_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const ASCII_LETTERS = ASCII_LOWERCASE + ASCII_UPPERCASE;
export const DIGITS = '0123456789';
export const HEX_DIGITS = DIGITS + 'abcdefABCDEF';
export const OCT_DIGITS = '01234567';
export const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
export const WHITESPACE = ' \t\n\r\v\f';
export const PRINTABLE = DIGITS + ASCII_LETTERS + PUNCTUATION + WHITESPACE;
