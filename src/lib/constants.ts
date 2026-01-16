// prettier-ignore
export const blank_space = ' ';

export const EOL = '\n';
export const doubleEOL = EOL + EOL;
export const INDENT = ' '.repeat(4);
export const doubleINDENT = INDENT + INDENT;

// prettier-ignore
export const singleQuote = "'";

// similar to Python string library
export const ascii_lowercase = 'abcdefghijklmnopqrstuvwxyz';
export const ascii_uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const ascii_letters = ascii_lowercase + ascii_uppercase;
export const digits = '0123456789';
export const hexdigits = digits + 'abcdefABCDEF';
export const octdigits = '01234567';
export const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
export const whitespace = ' \t\n\r\v\f';
export const printable = digits + ascii_letters + punctuation + whitespace;
