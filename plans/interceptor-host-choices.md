# Plan: let interceptors choose hosts the way the retry phase already does

Status: not started, needs a decision from the owner first. Two related gaps came up in PR #34's review. Neither is a regression: both behave the same on `main` or are documented. Do them on a new branch once a direction is chosen.

## 1. A redirect-phase interceptor that moves the hop to another host loses the headers it added

**Now.** After the redirect-phase interceptors run, `_sanitizeRedirectRequest` compares the URL they returned with the server's target (`interceptedFromURL`). If they moved the hop to another origin, every header outside the cross-origin allow-list is stripped, including headers the interceptor itself just set. The only exception is an exact `http:` to `https:` upgrade on the same host and port. `docs/http-client.md` (the cross-origin redirect paragraph) documents this: a redirect interceptor "can add a header back for a target it trusts" only while it keeps the server's target.

Example: `api.test` answers `307` to `cdn.test`, and a redirect interceptor returns `{ ...request, requestURL: 'https://mirror.test/dest', headers: { ...request.headers, authorization: 'Bearer mirror' } }`. The request reaches `mirror.test` without `Authorization`, and nothing reports it. Steering the hop back to `https://api.test/dest` gives the same result.

**The retry phase decides differently.** A retry interceptor that rewrites the URL to another host selects that host, so its headers, URL and body are kept there (see `withoutAddedCrossOriginCredentials` and the retry paragraph in the docs).

**Proposed rule.** When a redirect interceptor names another origin itself:

- Keep the headers it added. A header counts as added when it was not on the request the chain was handed, or was given a new value.
- Strip the inherited headers that are not allow-listed, as now. Those came from an earlier hop, so the interceptor never chose to send them to this host.

This is the retry phase's rule turned around. The retry phase strips what was added, because there the server chose the host. Here the interceptor chose it. Reuse the `inputHeaderNames` snapshot the retry phase already takes.

**Risk.** An interceptor written as `{ ...request, requestURL }` with a header spread that copies everything would now send every header it re-spreads, if it rebuilds them. Spreading the input carries the same values, so those still count as inherited and are still stripped. Only a value the interceptor actually changed or added is kept. Write a test for each shape.

## 2. `hosts` filters refuse `*.internal`, `*.localhost`, `*.test` and `*.local`

**Now.** `callback-registry.ts` validates each `hosts` entry with domain-utils' `validateConfigEntry`. That guard was written for CORS allowlists, where `*.com` or `*.internal` would trust whole namespaces. Applied to an outbound filter, `addRequestInterceptor(fn, { hosts: ['*.internal'] })` throws a `TypeError` when it is registered. On `main` it registered but never matched. The docs list the refusal. The only workarounds are to list every host or to use `hosts: ['*']`.

**Why the guard is wrong here.** A `hosts` filter decides which of the caller's own requests an interceptor or observer runs on. It grants no trust to the hosts it names, so `*.internal` ("every internal service") is a normal routing rule. The same holds for an ICANN suffix tail (`*.com`), although that is less useful.

**Options.**

- **Match them (recommended).** Add a matcher mode to domain-utils without the pseudo-TLD and public-suffix tail guards, and use it for `hosts` filters. Keep every other refusal: an empty label, a mixed wildcard, an IP wildcard, a name the matcher cannot read.
- **Allow only the internal pseudo-TLDs** (`*.internal`, `*.localhost`, `*.test`, `*.local`, ...) and keep refusing ICANN suffix tails. This is narrower, if `*.com` should stay a mistake.
- **Leave it.** The refusal is documented and fails fast.

**Watch for.** The CORS and allowlist callers must keep the guard, so the mode has to be a separate option, not a changed default. Add tests that the domain-utils allowlist still refuses `*.internal`.

## Tests

For each part, add tests pinning the new behaviour and keep the existing ones that pin today's behaviour until the decision is made: the cross-origin redirect stripping tests in `http-client.test.ts` and `request-normalization.test.ts`, and the `hosts` validation tests in `callback-registry.test.ts`.
