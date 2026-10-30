# Plan: limit how many cookies a `CookieJar` holds

Status: optional, not scheduled. Worth doing only if a jar is meant to live a long time and talk to servers the caller does not trust; see "When to do it". Do it on its own branch from main, after PR #34 and PR #35 have merged.

## What it is now

A `CookieJar` caps the size of one cookie (a name and value past 4096 bytes is ignored), but not how many it holds. Every `Set-Cookie` with a new name, domain or path adds an entry, for as long as it has not expired.

A review of PR #34 measured it: one server sending 20,000 distinct names of about 4 KB each was stored in full, and `getCookieHeaderString` returned an 80 MB header. Main behaves the same, so this is no regression.

## The risk

Both need a server that wants to do harm, or one that is badly broken:

- **Memory.** A long-lived shared jar grows without bound.
- **Failed requests.** Every later request to that host carries the oversized `Cookie` header, which a server refuses, so the host's cookies stop the client reaching it until they expire or the jar is cleared. A bucket is per site, so a tenant under a shared private suffix is limited to its own site, but `Domain=` cookies reach every host of that site.

## When to do it

Not needed for a client that talks to the caller's own APIs, where the server is trusted and the count stays small. It matters for a crawler, a proxy fetching user-supplied URLs, or anything else holding one jar across hosts it does not control.

## What others do

Confirm each of these before building, against current sources:

- **RFC 6265bis** recommends a user agent support at least 50 cookies per domain and 3000 in total, and lets it evict beyond its limits.
- **Chrome** is believed to keep about 180 per host and 3300 in total, evicting the least recently used first, and non-Secure cookies before Secure ones.
- **Firefox** is believed to keep about 150 per host.
- **tough-cookie**, the common Node jar, is believed to have no limit by default.

## Design

- **Option.** `new CookieJar({ limits: { perSite, total } })`, or plain `maxCookiesPerSite` and `maxCookies`. Decide whether it is on by default. Browsers always cap, which argues for on, with numbers high enough that no ordinary server notices. An explicit `Infinity` turns it off, as `maxResponseBytes` does.
- **Which count.** Per site, as buckets are filed, rather than per host: a tenant cannot escape by inventing subdomains. Check this against how Chrome counts.
- **Which to evict.** The least recently used, as browsers do. That needs a last-access time on each cookie, set on the send path, which `toJSON`/`fromJSON` should carry. Non-Secure cookies go before Secure ones, so a plain `http:` response cannot push out a Secure session (this extends "Leave Secure Cookies Alone").
- **Where it applies.** The store path shared by `Set-Cookie` and `setCookie()`, and `fromJSON()`, so a saved jar over the limit is trimmed on load. A cookie that evicts another is not reported: a browser says nothing either.
- **Header size.** Consider also bounding the `Cookie` header one request carries, as browsers bound it. Check what they do when a host's cookies pass the limit.

## Steps

1. Confirm the points under "What others do", and record the answers in this plan.
2. Add the option to `CookieJarOptions`, with validation matching the jar's other options.
3. Track last access and evict on store, in the jar's bucket code.
4. Tests:
   - a site past its limit evicts its least recently used cookie, and other sites are untouched;
   - a non-Secure cookie goes before a Secure one, and an `http:` response cannot evict a Secure cookie;
   - subdomains share their site's count;
   - `fromJSON()` trims a jar over the limit and keeps last-access order across a round trip;
   - `Infinity` turns it off.
5. Docs: a paragraph in `docs/http-client.md` next to the cookie jar's validation rules, and a changelog bullet. If it is on by default, say what the numbers are, and mark it **BREAKING** when a jar could hold more before.
