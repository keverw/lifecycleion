import { describe, expect, it, test } from 'bun:test';
import { CurlyBrackets } from './curly-brackets';

const html = `
<html>
    <title>{{hello}}</title>
    <body>
        <h1>{{hello}}</h1>
        <ul>
            <li>{{tasks.one}}</li>
            <li>{{tasks.two}}</li>
            <li>{{tasks.three}}</li>
        <ul>

        <footer>
            <p>Made in {{madeIn}} by {{author}}<p>
        </footer>
    </body>
</html>
`;

const replacements: Record<string, unknown> = {
  hello: 'Hello, World',
  tasks: {
    one: 'This is task one',
    two: 'This is task two',
    three: 'This is task three',
  },
  madeIn: 'Norway',
  author: 'Bjarne Oeverli',
};

const fullyReplaced = `
<html>
    <title>Hello, World</title>
    <body>
        <h1>Hello, World</h1>
        <ul>
            <li>This is task one</li>
            <li>This is task two</li>
            <li>This is task three</li>
        <ul>

        <footer>
            <p>Made in Norway by Bjarne Oeverli<p>
        </footer>
    </body>
</html>
`;

const missingReplacement = `
<html>
    <title>Hello, World</title>
    <body>
        <h1>Hello, World</h1>
        <ul>
            <li>This is task one</li>
            <li>This is task two</li>
            <li>This is task three</li>
        <ul>

        <footer>
            <p>Made in Norway by (null)<p>
        </footer>
    </body>
</html>
`;

describe('CurlyBrackets', () => {
  it('should replace all the placeholders', () => {
    expect(CurlyBrackets(html, replacements)).toEqual(fullyReplaced);
  });

  it('should have one undefined replacement', () => {
    delete replacements.author;

    expect(CurlyBrackets(html, replacements)).toEqual(missingReplacement);
  });

  it('should be blank if called with no parameters', () => {
    expect(CurlyBrackets()).toEqual('');
  });

  it('should short-circuit if no brackets found', () => {
    const simpleString = 'This is a simple message without any brackets';
    expect(CurlyBrackets(simpleString, { name: 'test' })).toEqual(simpleString);
  });

  it('should work with a string fallback', () => {
    const testString = 'The quick brown fox jumps over the lazy {{animal}}';
    expect(
      CurlyBrackets(
        testString,
        {
          animal: 'dog',
        },
        '(???)',
      ),
    ).toEqual('The quick brown fox jumps over the lazy dog');

    expect(CurlyBrackets(testString, {}, '(???)')).toEqual(
      'The quick brown fox jumps over the lazy (???)',
    );
  });

  it('should handle nested objects', () => {
    expect(
      CurlyBrackets(
        '{{name.first}} {{name.last}} was a founder of Apple Inc.',
        {
          name: {
            first: 'Steve',
            last: 'Jobs',
          },
        },
        '(???)',
      ),
    ).toEqual('Steve Jobs was a founder of Apple Inc.');

    // test without defining a last name

    expect(
      CurlyBrackets(
        '{{name.first}} {{name.last}} was a founder of Apple Inc.',
        {
          name: {
            first: 'Steve',
          },
        },
        '(???)',
      ),
    ).toEqual('Steve (???) was a founder of Apple Inc.');
  });

  test('compileTemplate and escaped brackets', () => {
    // Usage example:
    // Compile the template once
    const template1 = CurlyBrackets.compileTemplate(
      'The quick brown fox jumps over the lazy {{animal}} and then {{action}}. leading \\{{escaped}} or tailing {{escaped\\}} or both \\{{escaped\\}} is shown',
      '(???)',
    );

    // Use the compiled template with different objects
    expect(template1({ animal: 'dog', action: 'sits' })).toEqual(
      'The quick brown fox jumps over the lazy dog and then sits. leading {{escaped}} or tailing {{escaped}} or both {{escaped}} is shown',
    );

    expect(template1({ animal: 'cat' })).toEqual(
      'The quick brown fox jumps over the lazy cat and then (???). leading {{escaped}} or tailing {{escaped}} or both {{escaped}} is shown',
    );

    const template2 = CurlyBrackets.compileTemplate(
      'Hello {{name.first}} {{name.last}} - {{name}} - \\{{name}} - {{name\\}} - \\{{name\\}}',
      '(???)',
    );

    expect(
      template2({
        name: {
          first: 'Steve',
          last: 'Jobs',
        },
      }),
    ).toEqual(
      'Hello Steve Jobs - [object Object] - {{name}} - {{name}} - {{name}}',
    );
  });
});

describe('CurlyBrackets.escape', () => {
  it('should escape placeholders in the string', () => {
    const input = 'This {{should}} be escaped: \\{{not replaced}}';
    const expected = 'This \\{{should\\}} be escaped: \\{{not replaced\\}}';

    expect(CurlyBrackets.escape(input)).toEqual(expected);
  });

  it('should not affect already escaped brackets', () => {
    const input = 'Already \\{{escaped}} brackets';
    const expected = 'Already \\{{escaped\\}} brackets';

    expect(CurlyBrackets.escape(input)).toEqual(expected);
  });
});
