import { defineEntry } from '../../internal/define-entry';

/**
 * A container being filled while {@link parseExactJSON} reads its entries: an array, or an
 * object and the key its next value is for.
 */
type OpenContainer =
  | { readonly isArray: true; readonly value: unknown[] }
  | {
      readonly isArray: false;
      readonly value: Record<string, unknown>;
      key: string | undefined;
    };

/** A JSON number token, matched where the reader stands. */
const NUMBER_TOKEN = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** The whitespace JSON allows between tokens, skipped where the reader stands. */
const WHITESPACE = /[ \t\n\r]*/y;

/**
 * `text` parsed as `JSON.parse` parses it, but with each number whose text its nearest
 * double does not write back - `9007199254740993`, or `1.0` - kept as the
 * `rawJSON(source)` value of that text, so the data serializes to the same text again.
 *
 * Read with a stack of its own rather than by recursion, so data nested as deep as
 * `JSON.stringify` can write is read whole: `JSON.parse` with a reviver walks the data by
 * recursion, and runs out of stack on a body a few thousand levels deep. A string is
 * decoded by `JSON.parse` itself, so its escapes are read exactly as there, and an
 * object's keys are defined as its own (see `defineEntry`), so a `__proto__` key is a
 * member, a repeated key keeps its first place and its last value, as `JSON.parse` makes
 * them. Throws a `SyntaxError` on text that is not JSON.
 */
export function parseExactJSON(
  text: string,
  rawJSON: (source: string) => unknown,
): unknown {
  const stack: OpenContainer[] = [];
  let position = 0;
  let result: unknown;
  let hasResult = false;

  const fail = (): never => {
    throw new SyntaxError(`Unexpected JSON at position ${position}`);
  };

  const skipWhitespace = (): void => {
    WHITESPACE.lastIndex = position;
    WHITESPACE.test(text);
    position = WHITESPACE.lastIndex;
  };

  const readString = (): string => {
    const start = position;
    position++;
    while (position < text.length) {
      const char = text[position];
      if (char === '"') {
        position++;
        return JSON.parse(text.slice(start, position)) as string;
      }
      position += char === '\\' ? 2 : 1;
    }
    return fail();
  };

  /** Puts a value read into the container it belongs to, or makes it the result. */
  const place = (value: unknown): void => {
    const open = stack.at(-1);
    if (open === undefined) {
      result = value;
      hasResult = true;
    } else if (open.isArray) {
      open.value.push(value);
    } else {
      defineEntry(open.value, open.key as string, value);
      open.key = undefined;
    }
  };

  /** After a value or an opening bracket: a comma, or the container's close. */
  const readAfterEntry = (): void => {
    for (;;) {
      skipWhitespace();
      const open = stack.at(-1);
      if (open === undefined) {
        return;
      }
      const char = text[position];
      if (char === ',') {
        position++;
        skipWhitespace();
        if (!open.isArray) {
          readKey(open);
        }
        return;
      }
      if (char !== (open.isArray ? ']' : '}')) {
        fail();
      }
      position++;
      stack.pop();
      place(open.value);
    }
  };

  const readKey = (open: Extract<OpenContainer, { isArray: false }>): void => {
    if (text[position] !== '"') {
      fail();
    }
    open.key = readString();
    skipWhitespace();
    if (text[position] !== ':') {
      fail();
    }
    position++;
  };

  for (;;) {
    skipWhitespace();
    const char = text[position];

    if (char === '{' || char === '[') {
      position++;
      skipWhitespace();
      const isArray = char === '[';
      // An empty one closes at once.
      if (text[position] === (isArray ? ']' : '}')) {
        position++;
        place(isArray ? [] : {});
      } else {
        const open: OpenContainer = isArray
          ? { isArray: true, value: [] }
          : { isArray: false, value: {}, key: undefined };
        stack.push(open);
        if (!open.isArray) {
          readKey(open);
        }
        continue;
      }
    } else if (char === '"') {
      place(readString());
    } else if (text.startsWith('true', position)) {
      position += 4;
      place(true);
    } else if (text.startsWith('false', position)) {
      position += 5;
      place(false);
    } else if (text.startsWith('null', position)) {
      position += 4;
      place(null);
    } else {
      NUMBER_TOKEN.lastIndex = position;
      const match = NUMBER_TOKEN.exec(text);
      if (match === null) {
        fail();
      }
      const source = (match as RegExpExecArray)[0];
      position += source.length;
      const value = Number(source);
      place(String(value) === source ? value : rawJSON(source));
    }

    readAfterEntry();
    if (hasResult) {
      skipWhitespace();
      if (position !== text.length) {
        fail();
      }
      return result;
    }
  }
}
