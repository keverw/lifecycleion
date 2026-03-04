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

  it('should use the fallback when a dot path parent is missing or a primitive', () => {
    expect(CurlyBrackets('{{foo.bar}}', {}, '(???)')).toEqual('(???)');
    expect(CurlyBrackets('{{foo.bar}}', { foo: undefined }, '(???)')).toEqual(
      '(???)',
    );

    expect(CurlyBrackets('{{foo.bar}}', { foo: true }, '(???)')).toEqual(
      '(???)',
    );

    expect(CurlyBrackets('{{foo.bar}}', { foo: 123 }, '(???)')).toEqual(
      '(???)',
    );
  });

  it('should not treat falsey nested values as missing', () => {
    expect(
      CurlyBrackets('{{foo.bar}}', { foo: { bar: false } }, '(???)'),
    ).toEqual('false');

    expect(CurlyBrackets('{{foo.bar}}', { foo: { bar: 0 } }, '(???)')).toEqual(
      '0',
    );

    expect(CurlyBrackets('{{foo.bar}}', { foo: { bar: '' } }, '(???)')).toEqual(
      '',
    );
  });

  it('should support array index access in paths', () => {
    expect(
      CurlyBrackets(
        '{{users[0].name}} - {{users[0].roles[1]}} - {{matrix[0][2]}}',
        {
          users: [
            {
              name: 'Alice',
              roles: ['admin', 'ops'],
            },
          ],
          matrix: [
            [1, 2, 3],
            [4, 5, 6],
          ],
        },
        '(???)',
      ),
    ).toEqual('Alice - ops - 3');
  });

  it('should use the fallback when an indexed path is missing or hits a primitive early', () => {
    expect(
      CurlyBrackets(
        '{{users[1].name}}',
        { users: [{ name: 'Alice' }] },
        '(???)',
      ),
    ).toEqual('(???)');

    expect(
      CurlyBrackets(
        '{{users[0].active.value}}',
        {
          users: [{ active: true }],
        },
        '(???)',
      ),
    ).toEqual('(???)');

    expect(
      CurlyBrackets(
        '{{matrix[0][3]}}',
        {
          matrix: [[1, 2, 3]],
        },
        '(???)',
      ),
    ).toEqual('(???)');
  });

  it('should not treat falsey indexed values as missing', () => {
    expect(CurlyBrackets('{{flags[0]}}', { flags: [false] }, '(???)')).toEqual(
      'false',
    );

    expect(CurlyBrackets('{{counts[0]}}', { counts: [0] }, '(???)')).toEqual(
      '0',
    );

    expect(CurlyBrackets('{{labels[0]}}', { labels: [''] }, '(???)')).toEqual(
      '',
    );
  });

  it('should stringify Error values and allow access to Error properties', () => {
    const error = new Error('boom');

    expect(CurlyBrackets('{{error}}', { error }, '(???)')).toEqual(
      'Error: boom',
    );

    expect(CurlyBrackets('{{error.message}}', { error }, '(???)')).toEqual(
      'boom',
    );

    expect(CurlyBrackets('{{error.name}}', { error }, '(???)')).toEqual(
      'Error',
    );
  });

  it('should stringify full arrays and objects using default JavaScript coercion', () => {
    expect(
      CurlyBrackets('{{users}}', { users: ['Alice', 'Bob'] }, '(???)'),
    ).toEqual('Alice,Bob');
    expect(CurlyBrackets('{{counts}}', { counts: [1, 2, 3] }, '(???)')).toEqual(
      '1,2,3',
    );

    expect(
      CurlyBrackets('{{user}}', { user: { name: 'Alice', age: 42 } }, '(???)'),
    ).toEqual('[object Object]');
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
