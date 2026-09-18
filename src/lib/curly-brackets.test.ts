import { describe, expect, it, test } from 'bun:test';
import { CurlyBrackets, type TruncationInfo } from './curly-brackets';

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

  it('should support quoted bracket keys in paths', () => {
    expect(
      CurlyBrackets(
        '{{user["display-name"]}} - {{users[0]["display-name"]}} - {{["public-id"]}}',
        {
          user: {
            'display-name': 'Alice',
          },
          users: [
            {
              'display-name': 'Bob',
            },
          ],
          'public-id': 'USR-12345',
        },
        '(???)',
      ),
    ).toEqual('Alice - Bob - USR-12345');
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

  it('should resolve unquoted segments that are not plain identifiers', () => {
    // Only `.`, `[` and `]` delimit a path segment, so an ordinary hyphenated or spaced
    // key resolves without quoting. These used to render as the literal placeholder.
    expect(
      CurlyBrackets(
        '{{user.display-name}}',
        { user: { 'display-name': 'Alice' } },
        '(???)',
      ),
    ).toEqual('Alice');

    // A key containing a space needs the quoted form, so that ordinary prose inside a
    // placeholder is not mistaken for a lookup.
    expect(
      CurlyBrackets("{{u['my key']}}", { u: { 'my key': 'Bob' } }, '(???)'),
    ).toEqual('Bob');
  });

  it('should leave a placeholder holding prose exactly as written', () => {
    // An unquoted segment holds name characters only, so this does not parse as a path
    // and is left alone rather than being replaced by the fallback.
    expect(CurlyBrackets('Note: {{Hello world}} done', {}, '(???)')).toEqual(
      'Note: {{Hello world}} done',
    );

    // Punctuation counts as prose too. Excluding whitespace alone left these parsing as
    // key names that resolve to nothing, so a phrase rendered as `(???)`.
    expect(CurlyBrackets('Note: {{Hello,world}} done', {}, '(???)')).toEqual(
      'Note: {{Hello,world}} done',
    );

    expect(CurlyBrackets('{{oops!}}', {}, '(???)')).toEqual('{{oops!}}');

    expect(
      CurlyBrackets('{{u.my key}}', { u: { 'my key': 'Bob' } }, '(???)'),
    ).toEqual('{{u.my key}}');
  });

  it('renders the fallback for a placeholder holding a hyphenated or @-prefixed name', () => {
    // The unquoted segment grammar admits `-`, `@` and `$` so that `{{user.password-hash}}`
    // and `{{user.@id}}` resolve (and redact). The cost, accepted rather than avoided: a
    // hyphenated phrase in braces parses as a path, resolves to nothing, and renders the
    // fallback where it used to round-trip verbatim. Pinned here so the trade is visible.
    for (const prose of ['Hello-world', 'opt-in', '2024-01-01', '@mention']) {
      expect(CurlyBrackets(`Note: {{${prose}}} done`, {}, '(???)')).toEqual(
        'Note: (???) done',
      );
    }

    // Substituted text is not re-scanned, so a value that *contains* such a placeholder
    // survives as written. This is what keeps a component's own error text intact when
    // `LifecycleManager` logs `'...: {{error.message}}'` with the error as a param.
    expect(
      CurlyBrackets('Component failed: {{error.message}}', {
        error: new Error('Cannot reach {{svc-a}} after {{opt-in}}'),
      }),
    ).toEqual('Component failed: Cannot reach {{svc-a}} after {{opt-in}}');
  });

  it('should leave unsupported placeholder path syntax unchanged', () => {
    // Wildcards remain unsupported.
    expect(
      CurlyBrackets(
        '{{users[*].name}}',
        { users: [{ name: 'Alice' }] },
        '(???)',
      ),
    ).toEqual('{{users[*].name}}');

    expect(CurlyBrackets('{{user.}}', { user: { a: 1 } }, '(???)')).toEqual(
      '{{user.}}',
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

  it('does not resolve properties through the prototype chain', () => {
    Object.defineProperty(Object.prototype, 'leakedPassword', {
      configurable: true,
      enumerable: false,
      value: 'hunter2secret',
    });

    try {
      const rendered = CurlyBrackets(
        '{{leakedPassword}} {{__proto__.leakedPassword}} {{constructor}}',
        { ordinary: true },
      );

      expect(rendered).toBe('(null) (null) (null)');
      expect(rendered).not.toContain('hunter2secret');
      expect(rendered).not.toContain('Function');
    } finally {
      delete (Object.prototype as Record<string, unknown>)['leakedPassword'];
    }
  });

  it('does not inherit standard Error fields from Object.prototype', () => {
    Object.defineProperty(Object.prototype, 'cause', {
      configurable: true,
      enumerable: false,
      value: 'prototype secret',
    });

    try {
      expect(
        CurlyBrackets('{{error.cause}}', { error: new Error('boom') }),
      ).toBe('(null)');
    } finally {
      delete (Object.prototype as Record<string, unknown>)['cause'];
    }
  });

  it('resolves array length without admitting arbitrary non-enumerable properties', () => {
    const value = Object.defineProperty({}, 'hidden', {
      enumerable: false,
      value: 'not template data',
    });

    expect(
      CurlyBrackets('{{items.length}} {{empty.length}} {{value.hidden}}', {
        items: ['one', 'two'],
        empty: [],
        value,
      }),
    ).toBe('2 0 (null)');
  });

  it('resolves typed-array, Buffer and arguments length', () => {
    function getArguments(..._values: unknown[]): IArguments {
      // Deliberately exercise the special non-enumerable `arguments.length` shape.
      // eslint-disable-next-line prefer-rest-params
      return arguments;
    }

    expect(
      CurlyBrackets('{{typed.length}} {{buffer.length}} {{args.length}}', {
        typed: new Uint8Array(4),
        buffer: Buffer.from('abc'),
        args: getArguments('one', 'two'),
      }),
    ).toBe('4 3 2');
  });

  it('terminates an Error prototype cycle and reads a null-prototype Error own field', () => {
    const holder: { value?: object } = {};
    const cyclicPrototype = new Proxy(
      {},
      {
        getPrototypeOf: (): object => holder.value as object,
      },
    );

    holder.value = cyclicPrototype;
    const cyclic = new Error('boom');

    Object.setPrototypeOf(cyclic, cyclicPrototype);

    const bare = new Error('own message');

    Object.setPrototypeOf(bare, null);

    expect(CurlyBrackets('{{error.name}}', { error: cyclic })).toBe('(null)');
    expect(CurlyBrackets('{{error.message}}', { error: bare })).toBe(
      'own message',
    );
  });

  it('returns promptly for an unclosed placeholder followed by whitespace', () => {
    const template = `{{${' '.repeat(500)}`;
    const startedAt = performance.now();

    expect(CurlyBrackets(template, {})).toBe(template);
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('should stringify full arrays and plain objects as JSON', () => {
    expect(
      CurlyBrackets('{{users}}', { users: ['Alice', 'Bob'] }, '(???)'),
    ).toEqual('["Alice","Bob"]');
    expect(CurlyBrackets('{{counts}}', { counts: [1, 2, 3] }, '(???)')).toEqual(
      '[1,2,3]',
    );

    expect(
      CurlyBrackets('{{user}}', { user: { name: 'Alice', age: 42 } }, '(???)'),
    ).toEqual('{"name":"Alice","age":42}');
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
      'Hello Steve Jobs - {"first":"Steve","last":"Jobs"} - {{name}} - {{name}} - {{name}}',
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

  describe('CurlyBrackets onFormatError', () => {
    it('should tell an unreadable placeholder apart from an absent one', () => {
      // Both render the fallback, and until this existed they were indistinguishable: a
      // `{{user.token}}` whose accessor throws looked exactly like a typo. The path is
      // rooted at the placeholder rather than at an anonymous value, so a template with
      // many of them still says which one failed.
      const seen: string[] = [];

      const bag: Record<string, unknown> = {};

      Object.defineProperty(bag, 'token', {
        get() {
          throw new Error('accessor refused: hunter2secret');
        },
        enumerable: true,
      });

      const rendered = CurlyBrackets(
        '{{missing.key}} {{user.token}}',
        { user: bag },
        '(null)',
        {
          onFormatError: (error, _kind, path) =>
            seen.push(`${path}|${error.message}`),
        },
      );

      // The typo reports nothing - nothing failed, the path simply is not there.
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('user.token');
      expect(seen[0]).toContain('accessor refused');

      expect(rendered).toBe('(null) (null)');
      expect(rendered).not.toContain('hunter2secret');
    });
  });
});

describe('CurlyBrackets - one budget across the whole template', () => {
  test('bounds the total output rather than each placeholder on its own', () => {
    // Every placeholder opened a render budget of its own, so a template with four of them
    // could emit four megabytes while each individual render looked perfectly in bounds.
    const big = 'x'.repeat(900_000);

    const rendered = CurlyBrackets('{{a}}{{b}}{{c}}{{d}}', {
      a: big,
      b: big,
      c: big,
      d: big,
    });

    expect(rendered).toContain('[max length exceeded]');
    expect(rendered.length).toBeLessThan(2_000_000);
  });

  test('spends nothing extra on an ordinary template', () => {
    // The cap is invisible to every render that is not running away.
    expect(CurlyBrackets('{{a}}-{{b}}', { a: 'one', b: 'two' })).toBe(
      'one-two',
    );
  });

  test('gives each render of a compiled template its own allowance', () => {
    // Per render, not per compile: a compiled template is reused, and a budget shared
    // across calls would spend itself on the first one and truncate every call after it.
    const compiled = CurlyBrackets.compileTemplate('{{a}}');
    const big = 'x'.repeat(900_000);

    expect(compiled({ a: big }).length).toBe(900_000);
    expect(compiled({ a: big }).length).toBe(900_000);
  });
  test('stops rendering once the budget is gone rather than rendering and discarding', () => {
    // `chargeText` bounds what is *emitted* and nothing about what is *produced*: the
    // render was evaluated as its argument, so every placeholder after the budget ran out
    // still walked its value in full - each under a fresh allowance of its own - only for
    // the result to be cut to the marker and thrown away. The work is quadratic in the
    // template's placeholder count against one large param.
    const wide: Record<string, unknown> = {};

    for (let index = 0; index < 20_000; index++) {
      wide[`k${String(index)}`] = 'value';
    }

    const params = { big: 'x'.repeat(1_000_000), wide };
    const template = `{{big}}${'{{wide}}'.repeat(200)}`;

    const startedAt = Date.now();
    const rendered = CurlyBrackets(template, params);
    const elapsed = Date.now() - startedAt;

    expect(rendered).toContain('[max length exceeded]');

    // Measured at 1.7 seconds when the exhausted placeholders still rendered, against
    // roughly fifty milliseconds when they stop at the check - the whole of which is the
    // one placeholder that legitimately renders. The bound sits between the two with room
    // for a slow machine; the point is that the renders do not happen, not how fast they
    // are.
    expect(elapsed).toBeLessThan(600);

    // And the exhausted placeholders are not charged for a marker nobody budgeted, so the
    // total stays at the cap rather than creeping past it once per placeholder.
    expect(rendered.length).toBeLessThan(1_100_000);
  });
});

describe('maxRenderLength and onTruncate', () => {
  const body = 'x'.repeat(2_000_000);

  it('caps the whole render, not each placeholder', () => {
    // The shape the bound exists for: one payload substituted six times is six times the
    // output, and where the template is user input the repeat count is theirs too.
    const rendered = CurlyBrackets('{{body}}'.repeat(6), { body });

    expect(rendered.length).toBeLessThan(1_100_000);
  });

  it('tells the caller what was cut', () => {
    const cuts: TruncationInfo[] = [];

    CurlyBrackets('{{ body }}', { body }, undefined, {
      onTruncate: (info) => cuts.push(info),
    });

    expect(cuts).toEqual([
      { reason: 'length', subject: 'body', dropped: 1_000_000 },
    ]);
  });

  it('reports a cut made inside a container, not only a bare string', () => {
    // The counter lives on the budget rather than being measured off the result, so a
    // nested leaf cut by `quoteWithinBudget` is seen exactly as a top-level string is.
    const cuts: TruncationInfo[] = [];

    CurlyBrackets('{{o}}', { o: { k: body } }, undefined, {
      onTruncate: (info) => cuts.push(info),
    });

    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.subject).toBe('o');
    expect(cuts[0]?.dropped).toBeGreaterThan(0);
  });

  it('reports a placeholder the budget never reached with no count', () => {
    // `dropped` is honest rather than zero: the guard exists so the value is never
    // rendered, so nothing ever measured it.
    const cuts: TruncationInfo[] = [];

    CurlyBrackets('{{a}}{{b}}', { a: body, b: body }, undefined, {
      maxRenderLength: 100,
      onTruncate: (info) => cuts.push(info),
    });

    // Once per render, not once per placeholder - and the first is the informative one.
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.subject).toBe('a');
  });

  it('charges substituted values only, never the literal template text', () => {
    // Documented: the cap governs interpolation, not the length of the template. A
    // template that is mostly literal renders in full under a tiny bound, and only the
    // placeholder is measured against it. Pinned so the boundary does not move quietly.
    const literal = 'L'.repeat(50_000);
    const cuts: TruncationInfo[] = [];

    const rendered = CurlyBrackets(
      `${literal}{{v}}${literal}`,
      { v: 'value' },
      undefined,
      { maxRenderLength: 10, onTruncate: (info) => cuts.push(info) },
    );

    expect(rendered).toBe(`${literal}value${literal}`);
    expect(cuts).toEqual([]);

    const cut = CurlyBrackets(
      `${literal}{{v}}${literal}`,
      { v: 'x'.repeat(100) },
      undefined,
      { maxRenderLength: 10, onTruncate: (info) => cuts.push(info) },
    );

    expect(cut.startsWith(literal)).toBe(true);
    expect(cut.endsWith(literal)).toBe(true);
    expect(cut.length).toBeLessThan(literal.length * 2 + 100);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.subject).toBe('v');
  });

  it('does not fire when nothing was cut', () => {
    const cuts: unknown[] = [];

    const rendered = CurlyBrackets('hi {{name}}', { name: 'bob' }, undefined, {
      onTruncate: (info) => cuts.push(info),
    });

    expect(rendered).toBe('hi bob');
    expect(cuts).toHaveLength(0);
  });

  it('honours a raised limit and Infinity', () => {
    expect(
      CurlyBrackets('{{body}}'.repeat(6), { body }, undefined, {
        maxRenderLength: 20_000_000,
      }).length,
    ).toBe(12_000_000);

    expect(
      CurlyBrackets('{{body}}'.repeat(6), { body }, undefined, {
        maxRenderLength: Number.POSITIVE_INFINITY,
      }).length,
    ).toBe(12_000_000);
  });

  it('falls back to the default for any unusable limit', () => {
    // Fails closed, unlike `resolveMaxQueueSize`'s reading of the same shapes: this is the
    // bound that makes a hostile template safe to render, so a typo in a config must not
    // be what switches it off.
    for (const bad of [-1, 0, Number.NaN, '5000', undefined]) {
      const rendered = CurlyBrackets('{{body}}', { body }, undefined, {
        maxRenderLength: bad as number | undefined,
      });

      expect(rendered.length).toBeLessThan(1_100_000);
      expect(rendered).toContain('[max length exceeded]');
    }
  });

  it('survives a handler that throws', () => {
    // A notification about a degradation, not a step in producing the output.
    const rendered = CurlyBrackets('{{body}}', { body }, undefined, {
      onTruncate: () => {
        throw new Error('boom');
      },
    });

    expect(rendered.length).toBeLessThan(1_100_000);
  });

  it('does not route truncation through onFormatError', () => {
    // Truncation is an ordinary degradation; `onFormatError` means something refused to
    // render, and spending its one report here would hide a real failure.
    const failures: unknown[] = [];

    CurlyBrackets('{{body}}', { body }, undefined, {
      onFormatError: (error) => failures.push(error),
    });

    expect(failures).toHaveLength(0);
  });
});

describe('CurlyBrackets options are read once, at compile time', () => {
  test('a throwing options getter does not escape the render', () => {
    // The reads sat outside any `try`, so an options object with a throwing accessor threw
    // straight out of a call documented not to - the same hole `errorToString`,
    // `stringifyValue` and `serializeError` each closed by snapshotting their own bag.
    const hostile = {
      get onFormatError(): never {
        throw new Error('options refused');
      },
      get maxRenderLength(): never {
        throw new Error('options refused');
      },
      get onTruncate(): never {
        throw new Error('options refused');
      },
    };

    expect(() =>
      CurlyBrackets('hello {{name}}', { name: 'world' }, '(null)', hostile),
    ).not.toThrow();

    expect(
      CurlyBrackets('hello {{name}}', { name: 'world' }, '(null)', hostile),
    ).toBe('hello world');
  });

  test('a compiled template does not re-read its options on every render', () => {
    // A compiled template is reused, and each read used to happen again per call: a getter
    // answering differently the second time changed the allowance or the handler for the
    // rest of the template's life. Read once at compile time, the second render behaves
    // like the first.
    let reads = 0;

    const counting = {
      get maxRenderLength(): number {
        reads++;

        return 1_000;
      },
    };

    const render = CurlyBrackets.compileTemplate(
      '{{value}}',
      '(null)',
      counting,
    );

    render({ value: 'a' });
    render({ value: 'b' });
    render({ value: 'c' });

    expect(reads).toBe(1);
  });

  test('the options still take effect', () => {
    // Snapshotting must not quietly stop honouring them - the cut below comes from the
    // supplied `maxRenderLength`, not from the default.
    const truncations: TruncationInfo[] = [];

    const rendered = CurlyBrackets(
      '{{value}}',
      { value: 'x'.repeat(5_000) },
      '(null)',
      {
        maxRenderLength: 100,
        onTruncate: (info) => truncations.push(info),
      },
    );

    expect(rendered.length).toBeLessThan(200);
    expect(truncations).toHaveLength(1);
    expect(truncations[0]?.reason).toBe('length');
  });
});
