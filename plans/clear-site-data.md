# Plan: honor `Clear-Site-Data: "cookies"` in the cookie jar

Status: not started. Do it after PR #34 and PR #35 have merged, on a new branch from main (for example `feat-clear-site-data`). It adds behavior on the response path, so it belongs in a minor release while the package is 0.x.

## Goal

A response that carries `Clear-Site-Data: "cookies"` (or `"*"`) clears the jar's cookies for the response's site, as a browser does under the W3C Clear Site Data spec. A server's logout endpoint can then end a session held by `HTTPClient` the same way it ends one held by a browser, without the caller clearing the jar by hand.

## Spec points to confirm before building

Read the current W3C Clear Site Data draft and check each of these against it, and against what Chrome and Firefox do, before writing code:

- **Header syntax.** A comma-separated list of quoted strings: `"cache"`, `"cookies"`, `"storage"`, `"executionContexts"`, `"*"`, and newer types such as `"clientHints"` and `"prefetchCache"`. An unknown type is ignored. Check how an unquoted token (`cookies`) is treated; Chrome is believed to ignore it.
- **Secure contexts only.** The header is honored only on a response from a potentially trustworthy URL: `https:`, and loopback hosts such as `localhost` and `127.0.0.1`. A plain `http:` response's header is ignored.
- **Which cookies.** The spec clears cookies for the response URL's registrable domain and every host under it, whatever their scheme or port. That is close to `clear(host, 'domain')`. Confirm what it says for a host with no registrable domain (an IP literal, `localhost`).
- **Ordering with `Set-Cookie`.** If one response carries both `Clear-Site-Data: "cookies"` and `Set-Cookie`, decide which applies first. Clearing first lets a logout response hand over a fresh anonymous cookie; check what the spec and browsers actually do.
- **Redirects.** Check whether a `3xx` response's `Clear-Site-Data` is honored before the redirect is followed. Browsers are believed to process it on every response.

## Design

- **Where it lives.** `CookieJar.processResponseHeaders(headers, url)` is the single place `HTTPClient` stores `Set-Cookie`. It is called from the answered path and from the stream-failure path in `http-client.ts`. Reading `clear-site-data` there covers both call sites, retries and redirect hops, and a caller who drives the jar by hand.
- **Which site.** The jar files cookies in one bucket per site, keyed by `apexFor(host)`: the registrable domain under the jar's `publicSuffixes`, so overrides apply. A `Domain=` cannot reach above the setting host's site, so the response host's bucket holds exactly that site's cookies, and clearing the site is deleting that one bucket (then pruning). Delete the bucket directly rather than calling `clear(host, 'domain')`: for a host that is a public suffix (a response from `github.io` itself) or a removed suffix, `clear` reaches every site under it, and a response must clear only its own. Under a removed suffix the site can be the removed name: with `com` removed, a response from `x.example.com` clears the `com` site - every host under `.com` not behind a listed suffix, and `Domain=com` cookies - and leaves `app.blogspot.com`'s own cookies, a site of its own behind `blogspot.com`. Only a caller's explicit `clear('com', 'domain')` reaches into those sites.
- **Opt-in or default-on.** Browsers always honor the header. The library prefers explicit APIs, so decide between:
  - a `CookieJar` option (`new CookieJar({ clearSiteData: true })`), off by default;
  - on by default, with an option to turn it off.
    Whichever is chosen, the README and `docs/http-client.md` say so plainly.
- **Other types.** `"cache"`, `"storage"` and `"executionContexts"` have no equivalent in the client and are ignored. `"*"` clears cookies only.
- **Parsing.** Read the header as `set-cookie` lines are read: a string or a string array, a non-string refused. Malformed values are ignored rather than thrown, since the header comes from a remote server and the request has to keep going.
- **Observability.** Consider whether the clear should be visible to callers, for example through an observer phase or a count on the response. Not required for the first version.

## Steps

1. Confirm the spec points above, and record the answers in this plan.
2. Add the option, if opt-in, to `CookieJarOptions`, with validation matching the jar's other options.
3. Parse `clear-site-data` in `processResponseHeaders`, check the URL is potentially trustworthy, and clear the site before or after storing `Set-Cookie`, as step 1 decided.
4. Tests:
   - `"cookies"` and `"*"` clear the site and its subdomains, and leave other sites alone;
   - an `http:` response's header is ignored, and loopback `http:` is honored;
   - unknown types, unquoted values and other malformed headers are ignored without throwing;
   - the `Set-Cookie` ordering on a single response;
   - a redirect hop's header, through `HTTPClient` with `MockAdapter`;
   - under `publicSuffixes` removals, the response host's site is cleared and the sites behind a suffix still listed are not;
   - a response from a public suffix host (`github.io`) clears only that host's own cookies, not its tenants';
   - trailing-dot and IP-literal hosts.
5. Docs: a section in `docs/http-client.md` next to the cookie jar's `clear()`, and a changelog bullet.
