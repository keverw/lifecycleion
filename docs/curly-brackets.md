# curly-brackets

`curly-brackets` is a versatile string templating library designed for TypeScript applications. It enhances the standard templating capabilities with features like configurable fallbacks for undefined values, support for escaped brackets, and an efficient `compileTemplate` method for reusing templates with different datasets. This makes it a powerful tool for generating dynamic content in a variety of contexts.

## Features

- **Fallback Support**: Specify a fallback string to use whenever a placeholder's corresponding value is not found, instead of the default `undefined`.
- **Escaped Brackets**: Safely include literal `{{` and `}}` in your templates without them being replaced, by escaping them with a backslash (`\`).
- **Efficient Template Reuse**: With `compileTemplate`, compile your template once and reuse it with different sets of data, improving performance for repeated template processing.
- **TypeScript Support**: Fully supports TypeScript for type-safe templating.

## Usage

Import `CurlyBrackets` into your project:

```typescript
import { CurlyBrackets } from '@libs/curly-brackets';
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

### Escaping Utility

You can also use the provided utility to escape brackets in a string:

```typescript
const escaped = CurlyBrackets.escape('This {{will}} be escaped.');
console.log(escaped); // Outputs: "This \\{{will\\}} be escaped."
```

## Credits / Inspiration

This was originally an internal fork of https://github.com/bjarneo/y8 but expanded to support TypeScript and can set a fallback instead of defaulting undefined. Later it was rewritten completely to support escaped brackets, `compileTemplate` if reusing a string for multiple replacements. Now the only in-common is some of the unit tests, and function interface mainly.
