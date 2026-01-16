import { removeEmptyStringsFromArray } from './arrays';

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Converts a string or an array of strings to Pascal Case.
 *
 * This function takes an input string or an array of strings, each potentially containing hyphens,
 * and converts them to Pascal Case. It removes any characters that are not letters or numbers,
 * capitalizes the first letter of each substring, and ensures the rest of the substring
 * is in lowercase. Finally, it concatenates all these substrings to produce a Pascal Case
 * output.
 *
 * @param {string | string[]} input - The input string or array of strings to be converted to Pascal Case.
 * @returns {string} The converted string in Pascal Case.
 *
 * Examples:
 * toPascalCase("hello-world-123!$") will return "HelloWorld123"
 * toPascalCase(["hello", "world-123!$"]) will return "HelloWorld123"
 */

export function toPascalCase(input: string | string[]): string {
  // Ensure input is an array
  const inputArray = Array.isArray(input) ? input : [input];

  // Process each string in the array
  const parts: string[] = [];

  for (const item of inputArray) {
    // Clean the string, split by hyphen, and remove empty strings
    const cleanedItem = item.replace(/[^a-zA-Z0-9-]/g, '');
    parts.push(...removeEmptyStringsFromArray(cleanedItem.split('-')));
  }

  // Process and rejoin the input strings
  return parts
    .map(
      (subString) =>
        subString.charAt(0).toUpperCase() + subString.slice(1).toLowerCase(),
    )
    .join('');
}

/**
 * Converts a string or an array of strings to Camel Case.
 *
 * This function takes an input string or an array of strings, each potentially containing hyphens,
 * and converts them to Camel Case. It removes any characters that are not letters or numbers,
 * capitalizes the first letter of each substring after the first one, and ensures the rest of the substring
 * is in lowercase. For the first substring, it ensures the entire substring is in lowercase.
 * Finally, it concatenates all these substrings to produce a Camel Case output.
 *
 * @param {string | string[]} input - The input string or array of strings to be converted to Camel Case.
 * @returns {string} The converted string in Camel Case.
 *
 * Examples:
 * toCamelCase("hello-world-123!$") will return "helloWorld123"
 * toCamelCase(["hello", "world-123!$"]) will return "helloWorld123"
 */

export function toCamelCase(input: string | string[]): string {
  // Ensure input is an array
  const inputArray = Array.isArray(input) ? input : [input];

  // Process each string in the array
  const parts: string[] = [];

  for (const item of inputArray) {
    // Clean the string, split by hyphen, and remove empty strings
    const cleanedItem = item.replace(/[^a-zA-Z0-9-]/g, '');
    parts.push(...removeEmptyStringsFromArray(cleanedItem.split('-')));
  }

  // Process and rejoin the input strings
  return parts
    .map((subString, index) =>
      index === 0
        ? subString.toLowerCase()
        : subString.charAt(0).toUpperCase() + subString.slice(1).toLowerCase(),
    )
    .join('');
}

/**
 * This method converts a string or an array of strings to camel case,
 * but if starting with a leading hyphen, it will convert to Pascal case.
 */

export function toCamelCaseWithPascalOverride(
  input: string | string[],
): string {
  if (isString(input) && input.startsWith('-')) {
    return toPascalCase(input);
  } else if (
    Array.isArray(input) &&
    input.length > 0 &&
    input[0].startsWith('-')
  ) {
    return toPascalCase(input);
  } else {
    return toCamelCase(input);
  }
}

/**
 * Converts a string or an array of strings to constant case.
 *
 * The function takes a string or an array of strings, where each string can be separated by a '-',
 * and converts them into a constant case format (all uppercase with underscores between words).
 * It first cleans the input by removing non-alphanumeric characters (except for hyphens), splits the
 * string into parts on hyphens, and then joins these parts with underscores, converting the entire
 * result to uppercase.
 *
 * @param {string | string[]} input - The input string or array of strings to be converted.
 * @returns {string} The converted string in constant case.
 *
 * Example:
 * toConstantCase("hello-world") will return "HELLO_WORLD"
 * toConstantCase(["hello", "world"]) will return "HELLO_WORLD"
 */

export function toConstantCase(input: string | string[]): string {
  // Ensure input is an array
  const inputArray = Array.isArray(input) ? input : [input];

  // Process each string in the array
  let parts: string[] = [];

  for (const item of inputArray) {
    // Clean the string and split by hyphen
    const cleanedItem = item.replace(/[^a-zA-Z0-9-]/g, '');
    parts.push(...cleanedItem.split('-'));
  }

  // Remove empty strings from the array
  parts = removeEmptyStringsFromArray(parts);

  // Join parts with underscore and convert to uppercase
  return parts.join('_').toUpperCase();
}

export function splitGraphemes(text: string): string[] {
  const graphemes: string[] = [];
  let grapheme = '';
  let zwjSequence = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1] || '';
    const code = char.charCodeAt(0);

    // Handling combining marks and zero width joiner
    if (
      (code >= 0x0300 && code <= 0x036f) || // Combining Diacritical Marks
      (code >= 0x1ab0 && code <= 0x1aff) || // Combining Diacritical Marks Extended
      (code >= 0x1dc0 && code <= 0x1dff) || // Combining Diacritical Marks Supplement
      (code >= 0xfe20 && code <= 0xfe2f) || // Combining Half Marks
      (code >= 0x0e31 && code <= 0x0e3a) || // Thai combining marks
      (code >= 0x0e47 && code <= 0x0e4e)
    ) {
      // Thai combining marks
      grapheme += char;
    } else if (char === '\u200d') {
      // Zero Width Joiner (ZWJ)
      zwjSequence += grapheme + char;
      grapheme = '';
    } else {
      if (grapheme) {
        if (zwjSequence) {
          graphemes.push(zwjSequence + grapheme);
          zwjSequence = '';
        } else {
          graphemes.push(grapheme);
        }
      }
      grapheme = char;

      // Handle surrogate pairs (needed for certain characters including emojis)
      if (
        char >= '\ud800' &&
        char <= '\udbff' &&
        nextChar >= '\udc00' &&
        nextChar <= '\udfff'
      ) {
        grapheme += nextChar;
        i++;
      }
    }
  }

  if (grapheme) {
    if (zwjSequence) {
      graphemes.push(zwjSequence + grapheme);
    } else {
      graphemes.push(grapheme);
    }
  }

  return graphemes;
}

export function skipTrailingNewLines(str: string): string {
  return str.replace(/\n+$/, '');
}

/**
 * Filters a string to include only specified characters, optionally replacing disallowed characters.
 *
 * @param str - The input string to be filtered.
 * @param list - An array of allowed characters.
 * @param caseInsensitive - Optional. If true, the filtering is case-insensitive. Default is false.
 * @param replacementChar - Optional. Character to replace disallowed characters. If empty, disallowed characters are removed. Default is ''.
 * @returns A new string containing only the allowed characters from the input string, with disallowed characters optionally replaced.
 *
 * @example
 * // Case-sensitive usage, removing disallowed characters
 * characterAllowedOnly("Hello123!", ["H", "e", "l", "o"]);
 * // Returns: "Hello"
 *
 * @example
 * // Case-insensitive usage, removing disallowed characters
 * characterAllowedOnly("Hello123!", ["h", "E", "L", "O"], true);
 * // Returns: "Hello"
 *
 * @example
 * // Using replacement character
 * characterAllowedOnly("Hello123!", ["H", "e", "l", "o"], false, "-");
 * // Returns: "Hello---"
 */

export function characterAllowedOnly(
  str: string,
  list: string[],
  // eslint-disable-next-line @typescript-eslint/naming-convention
  caseInsensitive = false,
  replacementChar = '',
): string {
  let newStr = '';

  // Convert the allowed list to lowercase if case-insensitive
  if (caseInsensitive) {
    list = Array.from(new Set(list.map((item) => item.toLowerCase())));
  }

  // Convert the entire input string to lowercase if case-insensitive
  const processedStr = caseInsensitive ? str.toLowerCase() : str;

  for (const c of processedStr) {
    if (list.includes(c)) {
      newStr += c;
    } else if (replacementChar !== '') {
      newStr += replacementChar;
    }
  }

  return newStr;
}

// functions to chop characters from a string.

/**
 * Will remove the matching first character from a string
 * @param str
 * @param char
 * @returns
 */

export function chopBeginningCharacter(str: string, char: string): string {
  if (str.startsWith(char)) {
    return str.slice(1);
  } else {
    return str;
  }
}

/**
 * Will remove the matching last character from the string
 * @param str
 * @param char
 * @returns
 */
export function chopEndingCharacter(str: string, char: string): string {
  if (str.endsWith(char)) {
    return str.slice(0, -1);
  } else {
    return str;
  }
}

/**
 * Will remove the matching character, from the beginning and/or end of the string if matching
 * @param str
 * @param char
 * @returns
 */

export function chopBothBeginningAndEndingCharacters(
  str: string,
  char: string,
): string {
  return chopBeginningCharacter(chopEndingCharacter(str, char), char);
}
