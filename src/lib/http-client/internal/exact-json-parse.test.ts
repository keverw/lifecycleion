import { describe, expect, test } from 'bun:test';
import { parseExactJSON } from './exact-json-parse';

// The TypeScript lib in use does not declare `JSON.rawJSON` or `JSON.isRawJSON`.
const { rawJSON, isRawJSON } = JSON as unknown as {
  rawJSON: (source: string) => unknown;
  isRawJSON: (value: unknown) => boolean;
};

describe('parseExactJSON', () => {
  test.each([
    '{"a":1,"b":[true,false,null],"c":{"d":"e"}}',
    '[1,-2,3.5,1e+21,-0.000001,{"":""}]',
    '"a string with \\"quotes\\", \\\\ and \\u00e9 \\ud83d\\ude00"',
    '{"2":"b","1":"a","z":0,"10":"c"}',
    '{"a":1,"a":2,"b":3}',
    ' { "a" : [ 1 , 2 ] , "b" : { } , "c" : [ ] } ',
    '[[],{},[[]],[{}],{"a":[]}]',
    'true',
    'null',
    '0',
  ])('reads %s as JSON.parse does', (text) => {
    const parsed = parseExactJSON(text, rawJSON);

    expect(parsed).toEqual(JSON.parse(text));
    if (typeof parsed === 'object' && parsed !== null) {
      expect(Object.keys(parsed)).toEqual(
        Object.keys(JSON.parse(text) as object),
      );
    }
  });

  test('keeps each number its nearest double does not write back as a JSON.rawJSON value', () => {
    const text = '{"id":9007199254740993,"list":[1.0,-0,1e400,2],"n":5}';
    const parsed = parseExactJSON(text, rawJSON) as {
      id: unknown;
      list: unknown[];
      n: unknown;
    };

    expect(isRawJSON(parsed.id)).toBe(true);
    expect(parsed.list.map((value) => isRawJSON(value))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(parsed.n).toBe(5);
    expect(JSON.stringify(parsed)).toBe(text);
  });

  test('defines a __proto__ key as an own member, not the prototype', () => {
    const parsed = parseExactJSON(
      '{"__proto__":{"polluted":true},"a":1}',
      rawJSON,
    ) as Record<string, unknown>;

    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).toEqual(['__proto__', 'a']);
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test('reads data nested far deeper than a reviver can walk', () => {
    const depth = 50_000;
    const text = `${'{"a":'.repeat(depth)}9007199254740993${'}'.repeat(depth)}`;
    let level = parseExactJSON(text, rawJSON);
    for (let index = 0; index < depth; index++) {
      level = (level as { a: unknown }).a;
    }

    expect(isRawJSON(level)).toBe(true);
    expect(JSON.stringify(rawJSON('9007199254740993'))).toBe(
      JSON.stringify(level),
    );
  });

  test.each([
    '',
    '{',
    '[1,]',
    '{"a"}',
    '{"a":1,}',
    '[1 2]',
    'tru',
    'truex',
    'nullnull',
    '1 2',
    '{a:1}',
    '01',
    '[-]',
    '[.5]',
    '[1.]',
    '"\\x41"',
  ])('throws a SyntaxError on %p, which is not JSON', (text) => {
    expect(() => parseExactJSON(text, rawJSON)).toThrow(SyntaxError);
  });
});
