import { EOL } from './constants';

/**
 * Formats a JSON value as a string.
 *
 * @param value - The value to format as JSON.
 * @param isHuman - Optional boolean to format JSON for human readability. Defaults to false.
 * @returns The formatted JSON string.
 */

export function formatJSON(value: unknown, isHuman: boolean = false): string {
  return JSON.stringify(value, null, isHuman ? 2 : 0) + (isHuman ? EOL : '');
}
