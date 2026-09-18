# curly-brackets

`curly-brackets` is a versatile string templating library designed for TypeScript applications. It enhances the standard templating capabilities with features like configurable fallbacks for undefined values, support for escaped brackets, and an efficient `compileTemplate` method for reusing templates with different datasets. This makes it a powerful tool for generating dynamic content in a variety of contexts.

<!-- toc -->

- [Features](#features)
- [Usage](#usage)
  - [Basic Usage](#basic-usage)
  - [Using a Fallback](#using-a-fallback)
  - [Escaping Brackets](#escaping-brackets)
  - [Compiling Templates](#compiling-templates)
  - [Telling an Unreadable Placeholder From an Absent One](#telling-an-unreadable-placeholder-from-an-absent-one)
  - [Bounding How Much a Template Renders](#bounding-how-much-a-template-renders)
  - [Escaping Utility](#escaping-utility)
- [Credits / Inspiration](#credits--inspiration)

<!-- tocstop -->

## Features

- **Performance Optimized**: Automatically short-circuits when no placeholders are detected, avoiding unnecessary processing for plain strings.
- **Fallback Support**: Specify a fallback string to use whenever a placeholder's corresponding value is not found, instead of the default `'(null)'`.
- **Nested Path Support**: Resolve nested object properties with paths like `{{user.name}}`, array indexes like `{{users[0].name}}`, and quoted bracket keys like `{{user["display-name"]}}`.
- **Escaped Brackets**: Safely include literal `{{` and `}}` in your templates without them being replaced, by escaping them with a backslash (`\`).
- **Efficient Template Reuse**: With `compileTemplate`, compile your template once and reuse it with different sets of data, improving performance for repeated template processing.
- **Bounded Output**: One render allowance shared across a template's placeholders, so a
  repeated placeholder cannot multiply one payload into many times the output. Configurable
  with `maxRenderLength`, and observable with `onTruncate`.
- **TypeScript Support**: Fully supports TypeScript for type-safe templating.

## Usage

Import `CurlyBrackets` into your project:

```typescript
import { CurlyBrackets } from 'lifecycleion/curly-brackets';
```

### Basic Usage

Simply call `CurlyBrackets` with a template string and an object containing replacements:

```typescript
const result = CurlyBrackets('Hello, {{name}}!', { name: 'World' });
console.log(result); // Outputs: "Hello, World!"
```

### Using a Fallback

Specify a fallback for any undefined placeholders:

```typescript
const result = CurlyBrackets('Hello, {{name}}!', {}, '(???)');
console.log(result); // Outputs: "Hello, (???)!"
```

Dot notation follows the same rule. If any segment in the path is missing, `null`, `undefined`, or a primitive before the final property is reached, the fallback is used:

```typescript
const missingUser = CurlyBrackets('{{user.name}}', {}, '(???)');
console.log(missingUser); // Outputs: "(???)"

const primitiveParent = CurlyBrackets('{{user.name}}', { user: true }, '(???)');
console.log(primitiveParent); // Outputs: "(???)"

const falseValue = CurlyBrackets(
  '{{user.name}}',
  { user: { name: false } },
  '(???)',
);

console.log(falseValue); // Outputs: "false"

const zeroValue = CurlyBrackets(
  '{{user.name}}',
  { user: { name: 0 } },
  '(???)',
);

console.log(zeroValue); // Outputs: "0"
```

Dot notation, array indexes, and quoted bracket keys can be mixed into the same path:

```typescript
const userName = CurlyBrackets(
  '{{users[0].name}}',
  { users: [{ name: 'Alice' }] },
  '(???)',
);

console.log(userName); // Outputs: "Alice"

const matrixValue = CurlyBrackets(
  '{{matrix[0][2]}}',
  {
    matrix: [
      [1, 2, 3],
      [4, 5, 6],
    ],
  },
  '(???)',
);

console.log(matrixValue); // Outputs: "3"

const displayName = CurlyBrackets(
  '{{users[0]["display-name"]}} - {{["public-id"]}}',
  {
    users: [{ 'display-name': 'Alice' }],
    'public-id': 'USR-12345',
  },
  '(???)',
);

console.log(displayName); // Outputs: "Alice - USR-12345"
```

More precisely, the fallback is used when any intermediate segment cannot be traversed, or when the final resolved value is `null` or `undefined`. Final values like `false`, `0`, and `''` are rendered normally. Supported path syntax is dot notation, numeric indexes, and quoted bracket keys. Wildcards are not supported.

Each path segment resolves only an **own enumerable property**. Inherited properties such as the usual `constructor` and `__proto__`, and values added to `Object.prototype`, are treated as missing, but an own enumerable property explicitly supplied with one of those names remains available. This keeps template lookup on the same property surface the logger's redaction walk can inspect. There are narrow exceptions: `length` on arrays, typed arrays, Buffers, and arguments objects, so `{{items.length}}` remains available, and standard `Error` fields (`name`, `message`, `stack`, and `cause`), so documented patterns such as `{{error.message}}` continue to work even though JavaScript defines these properties as non-enumerable or on a standard prototype.

Binary values are leaves: Buffers and typed arrays expose only numeric elements and their intrinsic `length` to path lookup. Custom properties attached to binary values, including `ArrayBuffer` and `DataView`, are treated as missing. This lets redaction inspect a large binary body without walking every byte or following attached references back to unmasked params.

An unquoted segment may hold Unicode letters, digits, and marks plus `_`, `$`, `@`, and `-`, so `{{user.password-hash}}` and `{{user.@id}}` resolve without quoting. Braces holding anything else - a space, a comma, `!` - are not a path and are left exactly as written. Note the consequence: a hyphenated phrase such as `{{opt-in}}` or `{{2024-01-01}}` _is_ a path, resolves to nothing, and renders the fallback. Escape the braces to render one literally. Substituted values are never re-scanned, so a value that contains such text survives intact.

### Escaping Brackets

Prevent placeholders from being replaced by escaping them:

```typescript
const result = CurlyBrackets('Use \\{{ and \\}} to escape.', {});
console.log(result); // Outputs: "Use {{ and }} to escape."
```

### Compiling Templates

For efficiency, compile a template once and reuse it:

```typescript
const template = CurlyBrackets.compileTemplate('Hello, {{name}}!', '(???)');
console.log(template({ name: 'Alice' })); // Outputs: "Hello, Alice!"
console.log(template({})); // Outputs: "Hello, (???)!"
```

### Telling an Unreadable Placeholder From an Absent One

Both render the fallback. `{{user.token}}` on an object whose `token` accessor throws
produces exactly what a typo produces, so the output alone cannot tell them apart.
`onFormatError` is how you separate the two:

```typescript
CurlyBrackets('{{missing.key}} {{user.token}}', { user: hostile }, '(null)', {
  onFormatError: (error, kind, path) => {
    // fires once, for 'user.token' - the typo reports nothing, because nothing failed.
    // `kind` is 'render' here; a nested redaction failure arrives as 'redaction'.
  },
});
```

The path is rooted at the placeholder as written, so a template with many of them still
says which one refused. It fires at most once per render of the template - not once per
placeholder. With no handler it first dispatches a cancelable global `'error'` event, so a
`logger.registerReportErrorListener()` can record it. If event dispatch is unavailable it
uses `globalThis.reportError()` when present. An unclaimed dispatch, unavailable reporting
function, or reporting failure ends at guarded `console.error`. Logger-owned template
rendering uses the logger's separate diagnostic channel. A custom sink or formatter that
calls this function should pass a handler that terminates locally.

The cause is never written into the output: it comes from your own getter and may carry
the value it was hiding, and the rendered string is going wherever you send it.

`compileTemplate` takes the same options as its third argument, and each render of a
compiled template gets its own budget. Options are read once when the template is compiled, so changing the options object later does not change the compiled template. Unreadable option members use their defaults.

### Bounding How Much a Template Renders

Every render has one allowance shared by all of its placeholders, defaulting to 1,000,000
characters. The bound is per render and shared rather than per placeholder, because the
same value substituted many times is many times the output for one payload:

```typescript
// Six placeholders, one 2 MB value: ~1 MB out, not 12 MB.
CurlyBrackets('{{body}}'.repeat(6), { body });
```

That matters most when the _template_ is user input, as it is for anything rendering a
message someone else wrote - then the repeat count is theirs to choose too.

Only the values substituted in are charged. The literal text between placeholders is
passed through untouched and costs nothing, and neither does the fallback, so the cap
governs interpolation rather than the length of the template itself. A plain string costs
exactly its own length. A container costs its rendered form, so it also pays for its
braces, quotes, commas and key names.

Raise it, or turn it off, when you are rendering something other than a log line:

```typescript
CurlyBrackets(template, locals, undefined, { maxRenderLength: 20_000_000 });
CurlyBrackets(template, locals, undefined, { maxRenderLength: Infinity });
```

`Infinity` is the only way to render without a bound. Anything else unusable - a negative,
zero, `NaN`, a non-number - takes the default rather than being honoured, because this is
the bound that makes a hostile template safe to render and a typo in a config must not be
what switches it off.

Truncation is a degradation rather than a failure: the output carries a
`[max length exceeded]` marker and `onFormatError` does **not** fire, since that channel
means something _refused_ to render. For a log line the marker is enough. For a template
rendering something a person will read, it is not - the output is quietly shortened and
ships that way - so ask for `onTruncate`:

```typescript
CurlyBrackets(template, locals, undefined, {
  onTruncate: ({ reason, subject, dropped }) => {
    // reason:  'length' | 'depth' | 'circular'
    // subject: the placeholder, e.g. 'user.body'
    // dropped: characters cut, or undefined when nothing measured them
  },
});
```

`reason` says which bound stopped it, because all three are the same kind of event: the
render succeeded and simply could not represent everything. `'length'` is this budget,
`'depth'` is the nesting cap, and `'circular'` is a reference back into something already
being rendered - each emits its own marker where it stopped.

`dropped` is a lower bound, and only ever present for `'length'`. A cycle, a depth cap, and
a placeholder the budget was already spent before reaching all drop something that was
never rendered, so its size was never established - `undefined` is the honest answer there
rather than a zero that reads as "nothing was lost".

It fires at most once per render, not once per cut: a template past its budget degrades
continuously, and the first cut is the one that explains the rest. Scanning the output for
the marker is not a substitute - a payload can legitimately contain those words, and it
does not say which placeholder was cut or why.

`stringifyValue`, `redactValue` and `errorToString` take the same two options and report
through the same `TruncationInfo`, so "is my output complete" is one question with one
answer wherever you ask it. Within a single call the allowance is shared end to end -
masking a value and rendering the result spend one budget between them, not one each.

The `Logger` pins its own allowance at the default on both the message and the error paths,
so raising `maxRenderLength` for your own templates never changes how much a log line hands
to each sink.

### Escaping Utility

You can also use the provided utility to escape brackets in a string:

```typescript
const escaped = CurlyBrackets.escape('This {{will}} be escaped.');
console.log(escaped); // Outputs: "This \\{{will\\}} be escaped."
```

## Credits / Inspiration

This was originally an internal fork of https://github.com/bjarneo/y8 but expanded to support TypeScript and can set a fallback instead of defaulting undefined. Later it was rewritten completely to support escaped brackets, `compileTemplate` if reusing a string for multiple replacements. Now the only in-common is some of the unit tests, and function interface mainly.
