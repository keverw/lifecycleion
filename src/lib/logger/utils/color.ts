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
  note: 'color: #5883bf;', // blue
  debug: 'color: #808080;', // gray
};

const chalkColors: Record<Exclude<LogType, 'raw'>, keyof typeof chalk> = {
  error: 'red',
  info: 'white',
  warn: 'yellow',
  success: 'green',
  note: 'blue',
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
      coloredText: `%c${text}`,
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
