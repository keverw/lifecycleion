# datamask

Mask emails, domains and plain strings: a proportion of each is hidden behind a mask character and the ends are left readable. The successor to the `datamask` npm package, with the same three functions, arguments and defaults, counting in characters rather than UTF-16 code units so a cut never lands inside an emoji.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [maskString](#maskstring)
  - [maskDomain](#maskdomain)
  - [maskEmail](#maskemail)
  - [datamask](#datamask)
- [Characters, not code units](#characters-not-code-units)
- [Untrusted settings](#untrusted-settings)

<!-- tocstop -->

## Usage

```typescript
import { maskString, maskDomain, maskEmail } from 'lifecycleion/datamask';
```

Every function takes the value first, then the mask character (default `*`), then how much to hide as a percentage. The visible remainder is split as evenly as it can be, the shorter half in front.

## API

### maskString

Masks `percent` of a string (default `60`).

```typescript
maskString("I'm a string!", '*', 30); // "I'm a***ring!"
maskString('hunter2secret'); // 'hun*******ret'
maskString(''); // ''
```

### maskDomain

Masks every label of a hostname but the last, keeping the dots. Default `percent` is `60`. A value with no dot is masked as one string.

```typescript
maskDomain('example.com', '*', 50); // 'ex***le.com'
maskDomain('mail.example.co.uk', '*', 50); // 'm**l.ex***le.*o.uk'
```

### maskEmail

Masks the local part at `userPercent` (default `50`) and the domain, through `maskDomain`, at `domainPercent` (default `60`), keeping the `@`. A value with no `@` is masked as one string at `userPercent`.

```typescript
maskEmail('test@example.com'); // 't**t@e****le.com'
maskEmail('test@example.com', '#', 45, 80); // 't#st@e#####e.com'
```

### datamask

The original package's API shape, for a caller moving off it without renaming every call.

```typescript
import { datamask } from 'lifecycleion/datamask';

datamask.string("I'm a string!", '*', 30); // "I'm a***ring!"
datamask.domain('example.com', '*', 50); // 'ex***le.com'
datamask.email('test@example.com'); // 't**t@e****le.com'
```

## Characters, not code units

The masks count in code points, so an emoji-heavy value comes back with every character whole: the `datamask` package indexed by UTF-16 code unit and could leave a lone surrogate at the seam. They do not segment grapheme clusters - a combining mark or a variation selector is its own character - so `é` written as `e` plus a combining accent can be split into a visible `e` and a masked accent. That is a legible cut rather than a broken one.

## Untrusted settings

`maskChar` is repeated once per hidden character and `percent` is not clamped, so a percent past `100` or a multi-character mask lengthens the output. Bound both before masking a value with settings you did not choose; the logger's default redaction does.
