import chalk from 'chalk';
import type { LogType } from '../types';

interface ColorResult {
  coloredText: string;
  style?: string;
}

const browserColors: Record<Exclude<LogType, 'raw'>, string> = {
  error: 'color: #a95450;', // red
  info: 'color: #ffffff;', // white
  warn: 'color: #f5f566;', // yellow
  success: 'color: #56b97f;', // green
  notice: 'color: #5883bf;', // blue
  debug: 'color: #808080;', // gray
};

const chalkColors: Record<Exclude<LogType, 'raw'>, keyof typeof chalk> = {
  error: 'red',
  info: 'white',
  warn: 'yellow',
  success: 'green',
  notice: 'blue',
  debug: 'gray',
};

/**
 * Colorize text for console output
 * Automatically detects browser vs Node.js environment
 */
export function colorize(
  type: Exclude<LogType, 'raw'>,
  text: string,
): ColorResult {
  const isBrowser =
    typeof globalThis !== 'undefined' &&
    'window' in globalThis &&
    'document' in globalThis;

  if (isBrowser) {
    return {
      // Percent signs in the message are escaped, because this is the one branch that
      // hands the console a *format string* plus an argument. `console.error('%c' + text,
      // style)` makes every later `%s`, `%d`, `%o` and `%c` in `text` a specifier the
      // console fills: a message containing `%s` spliced the CSS string into the visible
      // text, and a second `%c` let message content restyle the rest of the line. The same
      // class of forgery `sanitizeScopeName` closed for newlines in names, for the one
      // runtime where messages are format strings - Node's branch below passes no second
      // argument, so nothing is interpolated there.
      coloredText: `%c${text.replaceAll('%', '%%')}`,
      style: browserColors[type],
    };
  } else {
    // Node.js - use chalk
    const colorName = chalkColors[type];
    const chalkColor = chalk[colorName] as (text: string) => string;
    return {
      coloredText: chalkColor(text),
    };
  }
}
