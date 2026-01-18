import { describe, expect, test } from 'bun:test';
import {
  characterAllowedOnly,
  chopBeginningCharacter,
  chopBothBeginningAndEndingCharacters,
  chopEndingCharacter,
  isString,
  skipTrailingNewLines,
  splitGraphemes,
  toCamelCase,
  toCamelCaseWithPascalOverride,
  toConstantCase,
  toPascalCase,
} from './strings';
import { ASCII_UPPERCASE } from './constants';

describe('toPascalCase', () => {
  test('converts a regular string to Pascal Case', () => {
    expect(toPascalCase('hello-world')).toBe('HelloWorld');
  });

  test('removes non-alphanumeric characters', () => {
    expect(toPascalCase('hello-world-123!$')).toBe('HelloWorld123');
  });

  test('handles strings with no hyphens correctly', () => {
    expect(toPascalCase('helloworld')).toBe('Helloworld');
  });

  test('processes empty strings correctly', () => {
    expect(toPascalCase('')).toBe('');
  });

  test('handles strings with multiple hyphens correctly', () => {
    expect(toPascalCase('multi-hyphen-example-string')).toBe(
      'MultiHyphenExampleString',
    );
  });

  test('processes strings with leading and trailing hyphens', () => {
    expect(toPascalCase('-leading-trailing-')).toBe('LeadingTrailing');
  });

  test('handles strings with multiple consecutive hyphens', () => {
    expect(toPascalCase('hello--world')).toBe('HelloWorld');
  });

  test('handles strings with only leading hyphens', () => {
    expect(toPascalCase('-leading')).toBe('Leading');
  });

  test('handles strings with only trailing hyphens', () => {
    expect(toPascalCase('trailing-')).toBe('Trailing');
  });

  test('handles an array of strings with no hyphens', () => {
    expect(toPascalCase(['hello', 'world'])).toBe('HelloWorld');
  });

  test('handles an array of strings with hyphens and special characters', () => {
    expect(toPascalCase(['hello-world', '123!$', 'another-example'])).toBe(
      'HelloWorld123AnotherExample',
    );
  });
});

describe('toCamelCase', () => {
  test('converts a regular string to Camel Case', () => {
    expect(toCamelCase('hello-world')).toBe('helloWorld');
  });

  test('removes non-alphanumeric characters', () => {
    expect(toCamelCase('hello-world-123!$')).toBe('helloWorld123');
  });

  test('handles strings with no hyphens correctly', () => {
    expect(toCamelCase('helloworld')).toBe('helloworld');
  });

  test('processes empty strings correctly', () => {
    expect(toCamelCase('')).toBe('');
  });

  test('handles strings with multiple hyphens correctly', () => {
    expect(toCamelCase('multi-hyphen-example-string')).toBe(
      'multiHyphenExampleString',
    );
  });

  test('processes strings with leading and trailing hyphens', () => {
    expect(toCamelCase('-leading-trailing-')).toBe('leadingTrailing');
  });

  test('handles strings with multiple consecutive hyphens', () => {
    expect(toCamelCase('hello--world')).toBe('helloWorld');
  });

  test('handles strings with only leading hyphens', () => {
    expect(toCamelCase('-leading')).toBe('leading');
  });

  test('handles strings with only trailing hyphens', () => {
    expect(toCamelCase('trailing-')).toBe('trailing');
  });

  test('handles an array of strings with no hyphens', () => {
    expect(toCamelCase(['hello', 'world'])).toBe('helloWorld');
  });

  test('handles an array of strings with hyphens and special characters', () => {
    expect(toCamelCase(['hello-world', '123!$', 'another-example'])).toBe(
      'helloWorld123AnotherExample',
    );
  });
});

describe('toCamelCaseWithPascalOverride', () => {
  test('converts a regular string to Camel Case', () => {
    expect(toCamelCaseWithPascalOverride('hello-world')).toBe('helloWorld');
  });

  test('converts a string with leading hyphen to Pascal Case', () => {
    expect(toCamelCaseWithPascalOverride('-hello-world')).toBe('HelloWorld');
  });

  test('converts an array of strings to Camel Case', () => {
    expect(toCamelCaseWithPascalOverride(['hello', 'world'])).toBe(
      'helloWorld',
    );
  });

  test('converts an array of strings with leading hyphen to Pascal Case', () => {
    expect(toCamelCaseWithPascalOverride(['-hello', 'world'])).toBe(
      'HelloWorld',
    );
  });
});

test('toConstantCase', () => {
  expect(toConstantCase('')).toEqual('');
  expect(toConstantCase([])).toEqual('');
  expect(toConstantCase('-----')).toEqual('');
  expect(toConstantCase('a---b-c')).toEqual('A_B_C');
  expect(toConstantCase('a-b-c')).toEqual('A_B_C');
  expect(toConstantCase(['---a-b-c----', '--d-e-f-g--'])).toEqual(
    'A_B_C_D_E_F_G',
  );

  // toConstantCase with special characters
  expect(toConstantCase('a!b$c-d')).toEqual('ABC_D');
  expect(toConstantCase(['**a**', '??b??', 'c--'])).toEqual('A_B_C');
});

describe('splitGraphemes', () => {
  test('splits a string into grapheme clusters', () => {
    expect(splitGraphemes('hello')).toEqual(['h', 'e', 'l', 'l', 'o']);
  });

  test('handles combining characters correctly', () => {
    expect(splitGraphemes('e\u0301')).toEqual(['é']);
    expect(splitGraphemes('a\u0302')).toEqual(['â']);
  });

  test('handles emojis correctly', () => {
    expect(splitGraphemes('😀')).toEqual(['😀']);
    expect(splitGraphemes('👨‍👩‍👧‍👦')).toEqual(['👨‍👩‍👧‍👦']);
  });

  test('handles empty string correctly', () => {
    expect(splitGraphemes('')).toEqual([]);
  });

  test('handles string with only whitespace correctly', () => {
    expect(splitGraphemes('   ')).toEqual([' ', ' ', ' ']);
  });

  test('handles string with Thai letters correctly', () => {
    expect(splitGraphemes('สวัสดี')).toEqual(['ส', 'วั', 'ส', 'ดี']);
  });

  test('handles string with mixed scripts correctly', () => {
    expect(splitGraphemes('Hello, สวัสดี 😀👨‍👩‍👧‍👦')).toEqual([
      'H',
      'e',
      'l',
      'l',
      'o',
      ',',
      ' ',
      'ส',
      'วั',
      'ส',
      'ดี',
      ' ',
      '😀',
      '👨‍👩‍👧‍👦',
    ]);
  });
});

describe('skipTrailingNewLines', () => {
  test('should remove trailing newlines from a string', () => {
    const input = 'Hello\nWorld\n\n';
    const expected = 'Hello\nWorld';
    const result = skipTrailingNewLines(input);
    expect(result).toBe(expected);
  });

  test('should remove a single trailing newline from a string', () => {
    const input = 'Hello\nWorld\n';
    const expected = 'Hello\nWorld';
    const result = skipTrailingNewLines(input);
    expect(result).toBe(expected);
  });

  test('should not modify a string without trailing newlines', () => {
    const input = 'Hello\nWorld';
    const expected = 'Hello\nWorld';
    const result = skipTrailingNewLines(input);
    expect(result).toBe(expected);
  });

  test('should handle an empty string', () => {
    const input = '';
    const expected = '';
    const result = skipTrailingNewLines(input);
    expect(result).toBe(expected);
  });

  test('should handle a string with only newlines', () => {
    const input = '\n\n\n';
    const expected = '';
    const result = skipTrailingNewLines(input);
    expect(result).toBe(expected);
  });
});

describe('characterAllowedOnly', () => {
  test('test with disallowed characters', () => {
    expect(
      characterAllowedOnly('ABC.DEF#GHI', ASCII_UPPERCASE.split('')),
    ).toEqual('ABCDEFGHI');
  });

  test('default as case sensitive', () => {
    expect(characterAllowedOnly('ABC.def', ASCII_UPPERCASE.split(''))).toEqual(
      'ABC',
    );
  });

  test('test as case insensitive', () => {
    expect(
      characterAllowedOnly('ABC.def', ASCII_UPPERCASE.split(''), true),
    ).toEqual('abcdef');
  });

  test('test with replacement character', () => {
    expect(
      characterAllowedOnly(
        'ABC.DEF#GHI',
        ASCII_UPPERCASE.split(''),
        false,
        '-',
      ),
    ).toEqual('ABC-DEF-GHI');
  });

  test('test with replacement character and case insensitive', () => {
    expect(
      characterAllowedOnly('ABC.def#GHI', ASCII_UPPERCASE.split(''), true, '-'),
    ).toEqual('abc-def-ghi');
  });
});

test('chopBeginningCharacter', () => {
  expect(chopBeginningCharacter('foo', 'f')).toBe('oo');
  expect(chopBeginningCharacter('foo', 'o')).toBe('foo');
});

test('chopEndingCharacter', () => {
  expect(chopEndingCharacter('foo', 'o')).toBe('fo');
  expect(chopEndingCharacter('foo', 'f')).toBe('foo');
});

test('chopBothBeginningAndEndingCharacters', () => {
  expect(chopBothBeginningAndEndingCharacters('foo', 'f')).toBe('oo');
  expect(chopBothBeginningAndEndingCharacters('foo', 'o')).toBe('fo');
  expect(chopBothBeginningAndEndingCharacters('/foo/', '/')).toBe('foo');
});

describe('isString', () => {
  test('should return true for strings', () => {
    expect(isString('')).toBe(true);
    expect(isString('hello')).toBe(true);
    expect(isString('123')).toBe(true);
  });

  test('should return false for non-strings', () => {
    expect(isString(123)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
    expect(isString([])).toBe(false);
    expect(isString({})).toBe(false);
    expect(isString(true)).toBe(false);
  });
});
