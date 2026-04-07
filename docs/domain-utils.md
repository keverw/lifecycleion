# domain-utils

Hardened helpers for normalizing and matching domains and origins used in CORS and routing. Includes IDNA/TR46 normalization, IPv6 literals, and robust wildcard semantics.

<!-- toc -->

- [Usage](#usage)
- [Overview](#overview)
- [Quick start](#quick-start)
- [Wildcard semantics](#wildcard-semantics)
- [Security hardening](#security-hardening)
- [API](#api)
  - [normalizeDomain](#normalizedomain)
  - [safeParseURL](#safeparseurl)
  - [normalizeOrigin](#normalizeorigin)
  - [parseHostHeader](#parsehostheader)
  - [matchesWildcardDomain](#matcheswildcarddomain)
  - [matchesWildcardOrigin](#matcheswildcardorigin)
  - [matchesDomainList](#matchesdomainlist)
  - [matchesOriginList](#matchesoriginlist)
  - [matchesCORSCredentialsList](#matchescorscredentialslist)
  - [validateConfigEntry](#validateconfigentry)
  - [isIPAddress](#isipaddress)
  - [isIPv4](#isipv4)
  - [isIPv6](#isipv6)
  - [canonicalizeBracketedIPv6Content](#canonicalizebracketedipv6content)
  - [checkDNSLength](#checkdnslength)
  - [getDomain](#getdomain)
  - [getSubdomain](#getsubdomain)
  - [isApexDomain](#isapexdomain)
  - [Types](#types)
- [Parsing Host headers](#parsing-host-headers)
- [Configuration & validation](#configuration--validation)
  - [Validate at startup](#validate-at-startup)
- [End-to-end example](#end-to-end-example)
- [Recommended defaults](#recommended-defaults)
  - [Quick rules](#quick-rules)
  - [Behavior notes](#behavior-notes)
  - [Defaults by function](#defaults-by-function)
  - [Global wildcard and credentials](#global-wildcard-and-credentials)
  - [Operational guidance](#operational-guidance)
- [Choose the right helper](#choose-the-right-helper)
- [Common recipes](#common-recipes)

<!-- tocstop -->

## Usage

```typescript
import {
  normalizeDomain,
  safeParseURL,
  normalizeOrigin,
  parseHostHeader,
  matchesWildcardDomain,
  matchesWildcardOrigin,
  matchesDomainList,
  matchesOriginList,
  matchesCORSCredentialsList,
  validateConfigEntry,
  isIPAddress,
  isIPv4,
  isIPv6,
  canonicalizeBracketedIPv6Content,
  checkDNSLength,
  getDomain,
  getSubdomain,
  isApexDomain,
  type ParsedHost,
  type WildcardKind,
  type ValidationResult,
} from 'lifecycleion/domain-utils';
```

## Overview

- Consistent origin/domain normalization across environments
- Safer wildcard matching (rejects `*.com`, forbids partial-label wildcards, IP-tail guard)
- Protocol-aware origin wildcards with scheme enforcement (e.g., `https://*`, `https://*.example.com`)

## Quick start

Pick a helper for your scenario and validate entries at startup:

- **Public APIs (no credentials)**: `matchesOriginList` + `validateConfigEntry(..., "origin")`
- **Credentials (exact only)**: `matchesCORSCredentialsList`
- **Credentials (subdomains)**: `matchesCORSCredentialsList(..., { allowWildcardSubdomains: true })` + `validateConfigEntry`
  Only host subdomain wildcards are honored in credentials mode. Protocol-only wildcards such as `https://*` and global `"*"` remain invalid at match time even if they are structurally valid in general origin validation.
- **Domain-only checks**: `matchesDomainList` (schemes are not allowed)

Example:

```typescript
for (const e of allowedOrigins) {
  const v = validateConfigEntry(e, 'origin', { allowGlobalWildcard: false });
  if (!v.valid) throw new Error(`Invalid origin: ${e} (${v.info})`);
}

const ok = matchesOriginList(
  req.headers.get('Origin') ?? undefined,
  allowedOrigins,
);
```

## Wildcard semantics

- `*` matches exactly one label
- `**` matches one-or-more labels when leftmost. In an interior position such as `a.**.example.com`, it matches zero-or-more labels. For example: `**.example.com` matches `api.example.com` but not `example.com` (1+ labels required), while `a.**.example.com` matches both `a.example.com` and `a.b.c.example.com` (0+ labels)
- Multi-label patterns like `*.*.example.com` are supported and must match the exact number of wildcarded labels
- Partial-label wildcards are not allowed. A label may be `*` or `**` only, patterns like `ex*.demo.com`, `*ample.demo.com`, `a*b.demo.com`, `foo*bar.demo.com` are rejected.
- Apex domains never match non-global wildcard patterns. List apex explicitly. The global `*` is an exception and does match apex domains.
- Origins:
  - `*` matches any valid HTTP(S) origin
  - `https://*` or `http://*` matches any origin with that scheme
  - `https://*.example.com` matches direct subdomains over HTTPS only

## Security hardening

- Rejects partial-label wildcards (e.g., `ex*.example.com`)
- Rejects invalid characters in patterns: ports, paths, fragments, brackets, userinfo, backslashes
- PSL/IP tail guard: disallows patterns like `*.com` or `**.co.uk`, and forbids wildcarding around IPs
- Wildcard tails are guarded consistently: public suffixes and the recognized pseudo-TLDs (`localhost`, `local`, `test`, `internal` - this is the complete set) are rejected for patterns like `*.suffix`
- Unicode dot normalization (`．。｡` → `.`) to avoid bypasses
- Step limits and label count caps to avoid pathological inputs
- Credentials helpers: exact-only and wildcard-enabled variants

## API

### normalizeDomain

Normalizes a domain/hostname for consistent comparison. Handles trim, lowercase, a single trailing-dot FQDN form, NFC normalization, and punycode conversion for IDN safety. Returns the canonical host form without a trailing dot. Returns `""` on invalid input, including repeated trailing dots such as `example.com..`. Strips IPv6 brackets. If you start with a full URL, parse it first and pass `url.hostname`.

```typescript
normalizeDomain('Example.COM.'); // 'example.com'
normalizeDomain('  api.test  '); // 'api.test'
normalizeDomain('münchen.de'); // 'xn--mnchen-3ya.de'
normalizeDomain('[::1]'); // '::1' (brackets stripped)
normalizeDomain('0x7f.0.0.1'); // '127.0.0.1'
normalizeDomain('example.com..'); // ''
```

### safeParseURL

Safely parses a URL string and returns `URL | null` instead of throwing. Useful when your caller may have a full URL and you want to derive `url.origin` or `url.hostname` before using the other helpers.

```typescript
const url = safeParseURL('https://api.example.com/path?x=1');
url?.origin; // 'https://api.example.com'
url?.hostname; // 'api.example.com'

safeParseURL('not-a-url'); // null
```

### normalizeOrigin

Normalizes a bare origin for consistent comparison. Returns the canonical origin form with a normalized hostname, lowercase scheme, no trailing slash, and default ports removed (80 for `http`, 443 for `https`). Returns `""` on invalid input or failed hostname normalization. Preserves the literal `"null"` origin. Like `normalizeDomain()`, it accepts only the canonical bare form plus one optional trailing separator: a single trailing `/` is normalized away, but repeated trailing slashes are rejected.

```typescript
normalizeOrigin('HTTPS://Example.COM:443/'); // 'https://example.com'
normalizeOrigin('https://example.com//'); // ''
normalizeOrigin('http://example.com:80'); // 'http://example.com'
normalizeOrigin('https://example.com:8080'); // 'https://example.com:8080'
normalizeOrigin('https://example.com:'); // ''
```

### parseHostHeader

Parses an HTTP `Host` header into `{ domain, port }`. Surrounding whitespace is trimmed before parsing, and IPv6 brackets are stripped from the returned `domain`. Returns `{ domain: '', port: '' }` on malformed input, including empty or whitespace-only values, invalid port strings (non-numeric or outside 0–65535), and bracketed IPv6 addresses that fail validation. The returned `domain` is not normalized. Pass it to `normalizeDomain()` before comparison. See [Parsing Host headers](#parsing-host-headers) for full details.

```typescript
parseHostHeader('example.com:8080'); // { domain: 'example.com', port: '8080' }
parseHostHeader('[::1]:443'); // { domain: '::1', port: '443' }
```

### matchesWildcardDomain

Matches a domain/hostname against a single wildcard pattern. Apex domains never match non-global wildcard patterns. List them explicitly. The global `*` is an exception and matches any valid domain including apex. If you start with a full URL, parse it first and pass `url.hostname`.

```typescript
matchesWildcardDomain('api.example.com', '*.example.com'); // true
matchesWildcardDomain('deep.api.example.com', '*.example.com'); // false
matchesWildcardDomain('deep.api.example.com', '**.example.com'); // true
matchesWildcardDomain('example.com', '*.example.com'); // false (apex)
```

### matchesWildcardOrigin

Matches a bare origin against a single wildcard pattern. Supports protocol-specific wildcards.

- The `origin` input must be an origin string, not a full URL.
  Valid examples: `https://api.example.com`, `http://localhost:3000`, `https://[::1]`, `https://api.example.com/` (trailing slash accepted)
  Invalid examples: `https://api.example.com/path`, `https://api.example.com?x=1`, `https://user@example.com`, `https://example.com:`
- A bare domain pattern like `*.example.com` or `**.example.com` is protocol-agnostic and ignores the origin port.
- A protocol-specific pattern like `https://*.example.com` or `https://*` requires that exact scheme.
- Wildcard patterns do not include ports. If you need an exact port match, use `matchesOriginList` or `matchesCORSCredentialsList` with exact origins instead.
- The `"null"` origin is never matched by wildcard patterns. Include `"null"` explicitly in list helpers if needed.

```typescript
matchesWildcardOrigin('https://api.example.com', 'https://*.example.com'); // true
matchesWildcardOrigin('http://api.example.com', 'https://*.example.com'); // false (protocol)
matchesWildcardOrigin('https://api.example.com:8443', '*.example.com'); // true (port ignored for wildcard match)
matchesWildcardOrigin('https://api.example.com/path', '*.example.com'); // false (full URL, not an origin)
matchesWildcardOrigin('https://example.com', '*'); // true
```

### matchesDomainList

Checks if a domain/hostname matches any entry in a list. Throws if any entry looks like an origin URL (starts with a scheme followed by `://`). Pre-validate entries with `validateConfigEntry(..., 'domain')`. Empty or invalid domain inputs return `false` without throwing. If you start with a full URL, parse it first and pass `url.hostname`.

Exact entries are normalized before comparison, including canonical IP literal handling (for example, `0x7f.0.0.1` matches `127.0.0.1`). Exact entries that equal a public suffix such as `com` or `co.uk` are never matched. Internal pseudo-TLDs such as `localhost`, `local`, `test`, and `internal` are handled separately and may be valid exact entries. The global wildcard `"*"` matches any valid domain, so reject it at config time with `validateConfigEntry(..., 'domain', { allowGlobalWildcard: false })` if undesired.

The literal string `"null"` is origin-only. It has no special meaning in domain matching and is never matched by `matchesDomainList`, whether passed as the domain input or included in the allowlist.

```typescript
matchesDomainList('api.example.com', ['*.example.com', 'other.com']); // true
matchesDomainList('test.com', ['*.example.com', 'other.com']); // false
```

### matchesOriginList

Checks if an origin matches any entry in a list. The runtime `origin` input must be an origin string, not a full URL. The literal browser `Origin` header value `null` must be listed explicitly as the exact string `"null"` to be matched. Allowlist entries may be exact bare origins or bare domains. Exact origins may use non-HTTP(S) schemes and are matched exactly, although wildcard origin matching remains HTTP(S)-only. Full URL inputs with userinfo, paths other than trailing slashes, queries, and fragments are rejected instead of being normalized. Default: `{ treatNoOriginAsAllowed: false }`.

`treatNoOriginAsAllowed: true` only takes effect when `"*"` is also present in the allowlist. It does not unconditionally allow no-origin requests. With any other allowlist, a missing `Origin` header always returns `false`.

Invalid inputs are handled internally. Callers do not need to wrap this helper in `try/catch`. Malformed origin strings simply return `false`.

Blank or whitespace-only allowlist entries are trimmed and ignored.

- Exact origin entries may include a port: `https://example.com:8443`
- Exact origin and bare-domain entries are normalized before comparison, including canonical IP literal handling
- Exact origin or bare-domain entries that equal a public suffix such as `com` or `co.uk` are never matched. Internal pseudo-TLDs such as `localhost`, `local`, `test`, and `internal` are handled separately and may be valid exact entries
- Bare-domain entries such as `example.com` match by hostname only and ignore scheme and port
- Wildcard entries may be:
  - host-only patterns such as `*.example.com` or `**.example.com`
  - protocol wildcards such as `https://*`
  - protocol + host wildcards such as `https://*.example.com`
- Wildcard entries do not match on port. Exact entries do.
- Origin matchers accept a bare origin or that same origin with a single trailing `/`, consistent with `normalizeOrigin`
- If you have a full URL, parse it first and pass `url.origin`.

```typescript
matchesOriginList('https://api.example.com', ['https://*.example.com']); // true
matchesOriginList('https://api.example.com:8443', [
  'https://api.example.com:8443',
]); // true
matchesOriginList('https://example.com', ['example.com']); // true
matchesOriginList(undefined, ['*'], { treatNoOriginAsAllowed: true }); // true
```

### matchesCORSCredentialsList

Credentials-safe origin matching. Exact-only by default, with optional subdomain wildcards. The runtime `origin` input must be an origin string, not a full URL. Malformed origins and malformed exact allowlist entries are rejected rather than compared via the invalid-input sentinel. Allowlist entries may be exact bare origins or bare domains. Bare-domain entries match by hostname only and ignore scheme and port, so use exact origins like `https://example.com` when scheme restriction is required. Exact origins may use non-HTTP(S) schemes and are matched exactly, but wildcard matching in credentials mode is limited to host subdomain patterns only. Protocol-only wildcards such as `https://*` and global `"*"` are never honored here. Full URL inputs with userinfo, paths other than trailing slashes, queries, or fragments are rejected. A missing or empty origin always returns `false`, and there is no `treatNoOriginAsAllowed` option in credentials mode. The literal string `"null"` may be included explicitly in the allowlist to match sandbox/file/data origins that emit a `null` Origin header.

Invalid inputs are handled internally. Callers do not need to wrap this helper in `try/catch`. Malformed origin strings simply return `false`.

Blank or whitespace-only allowlist entries are trimmed and ignored.

Exact origin and bare-domain entries are normalized before comparison, including canonical IP literal handling. Exact origin or bare-domain entries that equal a public suffix such as `com` or `co.uk` are never matched. Internal pseudo-TLDs such as `localhost`, `local`, `test`, and `internal` are handled separately and may be valid exact entries.

```typescript
// Exact match only (default)
matchesCORSCredentialsList('https://example.com', ['https://example.com']); // true
matchesCORSCredentialsList('https://example.com', ['example.com']); // true

// With subdomain wildcards
matchesCORSCredentialsList(
  'https://api.example.com',
  ['https://*.example.com'],
  { allowWildcardSubdomains: true },
); // true

// Matching "null" origin explicitly
matchesCORSCredentialsList('null', ['null']); // true
```

### validateConfigEntry

Validates a domain or origin config entry. Non-throwing, returns a result object. Exact origins may include an explicit port, but it must be in the range `0-65535`. See [Configuration & validation](#configuration--validation) for usage guidance.

For exact origins with bracketed hosts, the bracket contents must be a valid IPv6 literal.

```typescript
validateConfigEntry('*.example.com', 'domain');
// { valid: true, wildcardKind: 'subdomain' }

validateConfigEntry('*.com', 'domain');
// { valid: false, info: '...public suffix...', wildcardKind: 'none' }
```

Options: `{ allowGlobalWildcard?: boolean; allowProtocolWildcard?: boolean }`. Defaults: `allowGlobalWildcard: false`, `allowProtocolWildcard: true`.

`allowProtocolWildcard` applies only to the protocol-only wildcard forms `http://*` and `https://*`. It does not disable scheme-qualified host wildcards such as `https://*.example.com` or `https://**.example.com`.

### isIPAddress

Returns `true` for IPv4 or IPv6 strings. Accepts bracketed IPv6.

```typescript
isIPAddress('192.168.1.1'); // true
isIPAddress('::1'); // true
isIPAddress('[::1]'); // true
isIPAddress('example.com'); // false
```

### isIPv4

Returns `true` if the string is a valid IPv4 address.

```typescript
isIPv4('192.168.1.1'); // true
isIPv4('255.255.255.255'); // true
isIPv4('::1'); // false
isIPv4('example.com'); // false
```

### isIPv6

Returns `true` if the string is a valid IPv6 address. Accepts bracketed form, but rejects zone IDs to keep behavior portable across runtimes.

```typescript
isIPv6('::1'); // true
isIPv6('[::1]'); // true
isIPv6('fe80::1%25eth0'); // false
isIPv6('192.168.1.1'); // false
```

### canonicalizeBracketedIPv6Content

Canonicalizes an IPv6 address string (without brackets) using the platform URL parser so the result matches WHATWG URL origin semantics. This lowercases the address and compresses equivalent spellings to a single canonical form.

```typescript
canonicalizeBracketedIPv6Content('FE80::1'); // 'fe80::1'
canonicalizeBracketedIPv6Content('2001:0db8:0:0:0:0:0:1'); // '2001:db8::1'
canonicalizeBracketedIPv6Content('::ffff:192.0.2.128'); // '::ffff:c000:280'
```

### checkDNSLength

Validates DNS length constraints for a hostname. Non-throwing. Assumes ASCII input (post-punycode processing).

- Each label must be ≤ 63 octets
- Total FQDN must be ≤ 255 octets
- Maximum 127 labels (128+ is rejected)

```typescript
checkDNSLength('example.com'); // true
checkDNSLength('a'.repeat(64) + '.com'); // false (label > 63)
checkDNSLength('x.'.repeat(127) + 'com'); // false (128 labels > 127 limit)
```

### getDomain

Returns the registrable domain (e.g. `example.com` from a subdomain). Re-exported from [`tldts`](https://github.com/remusao/tldts). No separate install is needed.

```typescript
getDomain('api.example.com'); // 'example.com'
getDomain('deep.sub.example.co.uk'); // 'example.co.uk'
getDomain('example.com'); // 'example.com'
getDomain('localhost'); // null
```

### getSubdomain

Returns the subdomain portion of a hostname. Re-exported from [`tldts`](https://github.com/remusao/tldts). No separate install is needed.

```typescript
getSubdomain('api.example.com'); // 'api'
getSubdomain('deep.sub.example.co.uk'); // 'deep.sub'
getSubdomain('example.com'); // ''
getSubdomain('localhost'); // null
```

### isApexDomain

Returns `true` if a domain/hostname is an apex (registrable) domain with no subdomain. Uses `tldts` to correctly handle multi-part TLDs like `.co.uk` and `.com.au`. Internal pseudo-TLDs (`localhost`, `local`, `test`, `internal`) are treated as apex by definition. A single label under a pseudo-TLD (e.g. `foo.local`, `myapp.test`, `api.internal`) is also considered apex. Returns `false` for IPs, bare public TLDs, and any input that `tldts` cannot resolve to a registrable domain.

```typescript
isApexDomain('example.com'); // true
isApexDomain('example.co.uk'); // true
isApexDomain('localhost'); // true (pseudo-TLD)
isApexDomain('foo.local'); // true (apex under .local pseudo-TLD)
isApexDomain('myapp.test'); // true (apex under .test pseudo-TLD)
isApexDomain('www.example.com'); // false (subdomain)
isApexDomain('api.example.com'); // false (subdomain)
isApexDomain('bar.foo.local'); // false (subdomain under foo.local)
isApexDomain('sub.localhost'); // false (localhost is a hostname, not a TLD suffix)
isApexDomain('192.168.1.1'); // false (IP)
```

### Types

- `ParsedHost`: `{ domain: string; port: string }`, result of `parseHostHeader`
- `WildcardKind`: `'none' | 'global' | 'protocol' | 'subdomain'`, returned by `validateConfigEntry`
- `ValidationResult`: `{ valid: boolean; info?: string; wildcardKind: WildcardKind }`, returned by `validateConfigEntry`

## Parsing Host headers

Use `parseHostHeader` to safely parse HTTP Host headers into domain and port components:

```typescript
import { parseHostHeader, normalizeDomain } from 'lifecycleion/domain-utils';

const host = request.headers.host || '';
const { domain, port } = parseHostHeader(host);

// domain has brackets stripped for normalization:
// "[::1]:8080" → domain: "::1", port: "8080"
// "example.com:443" → domain: "example.com", port: "443"

// Check for malformed input
if (!domain) {
  // Malformed Host header - reject or handle appropriately
  return reply.code(400).send({ error: 'Invalid Host header' });
}

const normalized = normalizeDomain(domain);
```

**Handles:**

- Regular hostnames with optional ports: `example.com`, `example.com:8080`
- IPv6 with brackets: `[::1]`, `[::1]:8080`, `[2001:db8::1]:443`
- IPv4 addresses: `127.0.0.1`, `192.168.1.1:3000`

**Strict validation:** For bracketed IPv6, only allows empty or `:port` after closing bracket. Malformed input like `[::1]garbage`, `[::1][::2]`, or `[::1` returns `{ domain: '', port: '' }`.

The returned `domain` has brackets stripped so it can be passed directly to `normalizeDomain()` or `matchesDomainList()`.

## Configuration & validation

- Validate configuration at startup with `validateConfigEntry` and reject misconfigurations early.
- Prefer exact matches for credentials, enable wildcard credentials only when subdomains are strictly required and after validation.
- For hot paths, pre-normalize/validate allowlists once and reuse them.

### Validate at startup

Validate every allowlist entry (domain/origin) at startup with `validateConfigEntry`. This ensures each entry is structurally safe before you pass it to matchers at runtime. Structural validity does not imply every matcher will honor every valid pattern: for example, credentials matching ignores protocol-only wildcards such as `https://*` and global `"*"`.

```typescript
for (const entry of allowedOrigins) {
  const v = validateConfigEntry(entry, 'origin', {
    allowGlobalWildcard: false,
  });

  if (!v.valid) throw new Error(`Invalid origin: ${entry} (${v.info})`);
}
```

Domain list example (reject origin-style entries early):

```typescript
for (const entry of allowedDomains) {
  const v = validateConfigEntry(entry, 'domain');
  if (!v.valid) throw new Error(`Invalid domain: ${entry} (${v.info})`);
}
```

Inputs: a single entry (domain, domain pattern, origin, or protocol wildcard)

Outputs: `{ valid, info?, wildcardKind }`, where `wildcardKind` is `"none" | "global" | "protocol" | "subdomain"` and `info` may include hints (for example, when an exact origin uses a non-HTTP(S) scheme).

For exact origins, the scheme must be syntactically valid and any explicit port must be numeric. Exact origins with non-HTTP(S) schemes are structurally valid and may return an informational hint because wildcard matching is CORS-oriented. A single trailing slash on an exact origin is accepted and normalized at runtime, so entries like `https://example.com/` remain valid, but paths other than that bare-origin form are rejected. Wildcard origin patterns are restricted to `http` and `https`. Entries like `1http://example.com`, `://example.com`, `https://example.com/path`, `https://example.com//`, `https://example.com:abc`, or `https://[::1]:abc` are rejected at validation time.
Ports must also be in the valid URL range `0-65535`. Entries like `https://example.com:65536` are rejected.
Wildcard patterns are also rejected when they exceed the runtime label-processing cap.
The literal string `"null"` is valid only in origin context, where it represents the browser `Origin: null` value. In domain context, `"null"` is invalid:

```typescript
validateConfigEntry('null', 'domain');
// { valid: false, info: '"null" is not a valid domain entry', wildcardKind: 'none' }

validateConfigEntry('null', 'origin');
// { valid: true, wildcardKind: 'none' }
```

## End-to-end example

```typescript
import {
  matchesOriginList,
  validateConfigEntry,
} from 'lifecycleion/domain-utils';

const allowed = ['https://*.example.com', 'https://partner.io', '*']; // example

// Validate at config time
for (const entry of allowed) {
  const v = validateConfigEntry(entry, 'origin', { allowGlobalWildcard: true });
  if (!v.valid) throw new Error(`Invalid origin entry: ${entry} (${v.info})`);
}

// At runtime
const ok = matchesOriginList(
  request.headers.get('Origin') ?? undefined,
  allowed,
  {
    treatNoOriginAsAllowed: false,
  },
);
```

## Recommended defaults

### Quick rules

- Domain vs Origin contexts differ: origins may include protocol wildcards, domains may not.
- `matchesDomainList` allows `"*"` as match-all. If undesired, reject it at config time with `validateConfigEntry`.
- `normalizeOrigin` returns `""` on invalid URLs or failed hostname normalization, the literal `"null"` is preserved.
- `normalizeOrigin` also rejects malformed bare origins with an empty port, such as `https://example.com:`.
- In origin lists, `"null"` never matches wildcards. Include `"null"` explicitly if you want to allow it.
- `normalizeDomain` returns `""` on invalid input, strips IPv6 brackets (e.g., `[::1]` → `::1`), and canonicalizes IP literals to WHATWG URL form (for example, `0x7f.0.0.1` → `127.0.0.1`).
- Protocol-only wildcards (e.g., `https://*`) are allowed by default in validation and respected by origin matching.
- In domain context, entries with `://` are invalid, the validator returns info `"protocols are not allowed in domain context"`.

### Behavior notes

- Domain-only checks (`matchesDomainList`) reject origin-style entries (anything with `://`) by throwing. Use `matchesOriginList` for origin-style matching.
- Origin matching:
  - `matchesWildcardOrigin` and `matchesOriginList` expect a bare origin, not a full URL with path/query/fragment/userinfo.
  - A single trailing `/` is accepted as a bare-origin form, but repeated trailing slashes and other paths are rejected.
  - Empty-port origins such as `https://example.com:` are treated as malformed and rejected.
  - `matchesCORSCredentialsList` also expects a bare origin, not a full URL.
  - If you start with a full URL, pass `new URL(url).origin` to origin helpers and `new URL(url).hostname` to domain helpers.
  - Exact non-HTTP(S) origins such as `ftp://example.com` are allowed and matched exactly by the list helpers. This is separate from wildcard matching.
  - Domain wildcard patterns (e.g., `*.example.com`, `**.example.com`) are protocol-agnostic.
  - Wildcard origin matching is HTTP(S)-only. Protocol wildcards (e.g., `https://*`) and protocol + host wildcards (e.g., `https://*.example.com`) match only that scheme.
  - Wildcard origin matching ignores ports. Use exact origins when the port matters.
  - The literal string `"null"` is never matched by wildcard patterns. If you intend to allow it, include `"null"` explicitly in the allowlist.
  - Blank or whitespace-only allowlist entries are ignored.
- Credentials: prefer exact-only matching. Enable wildcard subdomains for credentials only when necessary and after pre-validation.
- IPv6 zone IDs are intentionally rejected. Plain IPv6 literals such as `"::1"` and `"[2001:db8::1]"` remain supported.

### Defaults by function

- `validateConfigEntry(entry, "domain")`
  - Default: `allowGlobalWildcard: false`. Validate concrete domains and wildcard patterns only.

- `validateConfigEntry(entry, "origin", { allowGlobalWildcard, allowProtocolWildcard })`
  - Recommended: `{ allowGlobalWildcard: false, allowProtocolWildcard: true }`. Set `allowProtocolWildcard: false` to reject only the protocol-only wildcard forms `http://*` and `https://*`.
  - Exact origins and bare domains are validated, origins must not include path/query/fragment/userinfo, bracketed IPv6 is supported.

- `matchesDomainList(domain, allowedDomains)`
  - Domains only (no schemes). Throws if any entry contains `://`.
  - If you do not want `"*"` to match all, pre-validate and reject it.

- `matchesOriginList(origin, allowedOrigins, { treatNoOriginAsAllowed })`
  - Default: `{ treatNoOriginAsAllowed: false }`.
  - `"*"` matches any valid HTTP(S) origin. `"null"` must be explicitly listed.

- `matchesCORSCredentialsList(origin, allowedOrigins, { allowWildcardSubdomains })`
  - Default: exact-only. When `allowWildcardSubdomains: true`, host subdomain wildcards are honored (e.g., `https://*.example.com`). Protocol-only wildcards like `https://*` and global `"*"` are still rejected. Always pre-validate entries.

### Global wildcard and credentials

- Public, non-credential CORS: you may intentionally allow all origins by validating with `{ allowGlobalWildcard: true }` and including `"*"` in the allowlist.
- Credentialed CORS: do not use `"*"`. Browsers reject `Access-Control-Allow-Origin: *` when credentials are involved. Prefer exact origins, or enable subdomain wildcards with care and pre-validation.

### Operational guidance

- No-Origin requests: keep `treatNoOriginAsAllowed: false` unless explicitly required.
- Pre-validation: run `validateConfigEntry` on every entry at startup, fail fast on PSL/IP tails, partial-label wildcards, and URL-ish characters.

## Choose the right helper

- **CORS allowlist (non-credentials)**: `matchesOriginList(origin, allowedOrigins)`
  - Supports exact and wildcard origins (including protocol wildcards)
  - Validate at startup with `validateConfigEntry(..., "origin")`
- **CORS with credentials (strict)**: `matchesCORSCredentialsList(origin, allowedOrigins)`
  - Exact matches only, safest for cookies/authorization
- **CORS with credentials (needs subdomains)**: `matchesCORSCredentialsList(origin, allowedOrigins, { allowWildcardSubdomains: true })`
  - Allows wildcards like `https://*.example.com` and multi-label patterns as specified, pre-validate with `validateConfigEntry`
- **Domain-only checks (no scheme)**: `matchesDomainList(domain, allowedDomains)`
  - Rejects origin-style entries, pre-validate with `validateConfigEntry(..., "domain")`
- **Low-level checks**: `matchesWildcardDomain`, `matchesWildcardOrigin`
  - For custom logic, prefer list helpers for most cases

## Common recipes

Allow HTTPS subdomains, include the apex, and one exact partner origin, disallow global wildcard:

```typescript
const allowed = [
  'https://example.com', // apex must be listed explicitly
  'https://*.example.com', // direct subdomains only
  'https://partner.io',
]; // no "*"

for (const e of allowed) {
  const v = validateConfigEntry(e, 'origin', { allowGlobalWildcard: false });
  if (!v.valid) throw new Error(`Invalid: ${e} (${v.info})`);
}

const ok = matchesOriginList(req.headers.get('Origin') ?? undefined, allowed);
```

Credentials (exact only):

```typescript
const allowedCreds = [
  'https://admin.example.com',
  'https://console.example.com',
];

for (const e of allowedCreds) {
  const v = validateConfigEntry(e, 'origin');
  if (!v.valid) throw new Error(`Invalid: ${e} (${v.info})`);
}

const okCreds = matchesCORSCredentialsList(
  req.headers.get('Origin') ?? undefined,
  allowedCreds,
);
```

Credentials (subdomains required):

```typescript
const allowedCredsWildcard = ['https://*.example.com']; // consider risk

for (const e of allowedCredsWildcard) {
  const v = validateConfigEntry(e, 'origin');
  if (!v.valid) throw new Error(`Invalid: ${e} (${v.info})`);
}

const okCredsWildcard = matchesCORSCredentialsList(
  req.headers.get('Origin') ?? undefined,
  allowedCredsWildcard,
  { allowWildcardSubdomains: true },
);
```
