import { HTTP_METHODS } from './consts';
import qs from 'qs';
import { defineEntry } from '../internal/define-entry';
import { isNullish } from '../internal/is-nullish';
import { assertHeaderRecord, isPlainRecord } from './internal/plain-record';
import { readUnknownMember } from '../internal/read-member';
import {
  lowerCaseHeaderName,
  presentHeaderValue,
} from './internal/header-utils';
import { normalizeDomain } from '../domain-utils/domain-utils';
import {
  compileWildcardPattern,
  isIPAddress,
  matchesCompiledWildcard,
  type CompiledWildcardPattern,
} from '../domain-utils/helpers';
import type {
  ContentType,
  RequestPhaseName,
  HTTPClientConfig,
  SubClientConfig,
  AdapterType,
  HTTPMethod,
  RequestHeadersInput,
} from './types';

export { lowerCaseHeaderName } from './internal/header-utils';
/**
 * If `path` is an absolute HTTP(S) URL, returns its canonical `href` (normalized
 * scheme/host casing). Otherwise `null`. Protocol-relative `//host` is handled
 * separately in `buildURL`.
 *
 * Rules differ from `resolveAbsoluteURL` (which accepts any absolute scheme).
 * One parse here per request is negligible next to network I/O.
 */
function tryAbsoluteWebHref(path: string): string | null {
  if (!path || path.startsWith('//')) {
    return null;
  }

  try {
    const u = new URL(path);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.href;
    }
  } catch {
    // not parseable as absolute
  }

  return null;
}

/** Whether a `.params()` value names its key: not `undefined`, nor made only of it. */
function isGivenParam(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  // An array or object is given when empty (it clears the key) or when anything in it
  // is; one made only of `undefined` - `[maybeId]` with no id - writes nothing, and is not.
  if (Array.isArray(value) || isPlainRecord(value)) {
    const entries = Object.values(value as object);
    return entries.length === 0 || entries.some(isGivenParam);
  }
  return true;
}

/** The key a query pair from the wire sets at the top level, as `qs` reads it. */
function topLevelQueryKey(pair: string): string {
  const rawKey = pair.split('=', 1)[0].replace(/\+/g, ' ');
  let key: string;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    key = rawKey;
  }
  return topLevelKeyOf(key);
}

/**
 * The top-level name of a decoded key: `filter[a]` is `filter`, and a key that opens with
 * a bracket (`[x]`) is the name inside it, as `qs` reads both. A `.params()` key goes
 * straight here - it is a name `qs` will encode, not one to decode.
 */
function topLevelKeyOf(key: string): string {
  // A key that opens with a bracket (`[x]=1`) is read by `qs` as the name inside it.
  if (key.startsWith('[')) {
    const close = key.indexOf(']');
    return close > 1 ? key.slice(1, close) : key;
  }
  const bracket = key.indexOf('[');
  return bracket > 0 ? key.slice(0, bracket) : key;
}

/**
 * Builds a request URL string from `baseURL`, `path`, and optional query params
 * (`qs` — nested objects and arrays supported).
 *
 * **Relative paths (usual case)** — When `baseURL` is set and `path` is not
 * absolute, `path` is joined to `baseURL` (leading slash normalized). Example:
 * `baseURL: https://api.test`, `path: /v1/users` → `https://api.test/v1/users`.
 *
 * **Absolute / protocol-relative `path` (escape hatch)** — If `path` is a full
 * `http:` or `https:` URL, it is **not** prefixed with `baseURL` (after
 * normalization via `URL#href`). The same applies to protocol-relative URLs
 * (`//cdn.example/x`): they are left for {@link resolveAbsoluteURL} to resolve
 * using the client `baseURL`’s scheme. Use this for one-off cross-origin calls,
 * CDN assets, or URLs returned by APIs; for strict per-origin clients, prefer
 * relative paths and a dedicated client or `HTTPClient.createSubClient()` per
 * origin.
 */
export function buildURL(
  baseURL: string | undefined,
  path: string,
  givenParams?: Record<string, unknown>,
): string {
  let url: string;
  // Each top-level value read once: the override check below and the serialized query
  // read the same values, where a getter answering differently gave them different ones.
  let params: Record<string, unknown> | undefined;
  if (givenParams) {
    params = {};
    for (const [key, value] of Object.entries(givenParams)) {
      defineEntry(params, key, value);
    }
  }

  const absoluteHref = tryAbsoluteWebHref(path);

  if (baseURL && absoluteHref === null && !path.startsWith('//')) {
    // Avoid double slashes when joining base + path
    const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
    const p = path.startsWith('/') ? path : `/${path}`;
    url = `${base}${p}`;
  } else if (absoluteHref !== null) {
    url = absoluteHref;
  } else {
    url = path;
  }

  if (params && Object.keys(params).length > 0) {
    // At the first `#` only: `split`'s limit drops everything after a second one.
    const hashIndex = url.indexOf('#');
    const urlWithoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex + 1);
    const queryStartIndex = urlWithoutHash.indexOf('?');

    if (queryStartIndex === -1) {
      const queryString = qs.stringify(params, { addQueryPrefix: true });
      url = `${urlWithoutHash}${queryString}${hash ? `#${hash}` : ''}`;
    } else {
      const basePath = urlWithoutHash.slice(0, queryStartIndex);
      const existingQuery = urlWithoutHash.slice(queryStartIndex + 1);
      // Fragments are preserved only as part of the caller's URL string.
      // They are not transmitted in HTTP requests, but keeping them intact
      // makes buildURL safer as a general-purpose URL composition helper.
      //
      // The existing query is kept as written, pair by pair, rather than parsed and
      // re-serialized: that rewrote what `qs` reads differently from the server - a
      // repeated key into `tag[0]`, `%E9` into `%25E9`, `constructor=1` dropped - though
      // nothing asked to change it. Only a pair whose top-level key `params` also names is
      // left out, so the `params` value wins.
      // Top-level keys on both sides, as the docs state the rule: `page[number]` in params
      // replaces the path's `page[...]` pairs as `{ page: { number } }` would.
      // A key whose value is `undefined` - or an object of nothing but `undefined` - is
      // not given, so it leaves the path's pairs alone: `.params({ page: options.page })`
      // with no page keeps `?page=2`. An empty array or object is given, and clears them.
      const overridden = new Set(
        Object.keys(params)
          .filter((key) => isGivenParam(params[key]))
          .map(topLevelKeyOf),
      );
      const kept = existingQuery
        .split('&')
        .filter(
          (pair) => pair !== '' && !overridden.has(topLevelQueryKey(pair)),
        );
      const added = qs.stringify(params);
      const query = [...kept, ...(added ? [added] : [])].join('&');
      url = `${basePath}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
    }
  }

  return url;
}

/**
 * Best-effort absolute URL for logging, redirects, and hop metadata.
 *
 * - If `url` parses as an absolute URL (has a scheme), returns normalized `href`.
 * - Otherwise, when `baseURL` is set, resolves `url` against it (path-relative,
 *   same-host relative, protocol-relative `//host`, query-only, etc.).
 * - If neither works, returns `url` unchanged (callers without `baseURL` may still
 *   see path-only strings).
 */
export function resolveAbsoluteURL(url: string, baseURL?: string): string {
  if (!url) {
    return url;
  }

  try {
    return new URL(url).href;
  } catch {
    // Not a standalone absolute URL
  }

  if (baseURL) {
    try {
      const base = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
      return new URL(url, base).href;
    } catch {
      // fall through
    }
  }

  return url;
}

/**
 * The same URL with any `user:pass@` userinfo removed.
 *
 * Userinfo in a URL is `Authorization: Basic` by another name: `NodeAdapter` copies it
 * onto `options.auth` (`fetch` sends none of it - Node's refuses such a URL, Bun's drops
 * the credentials). A redirect target is chosen by the
 * remote server, so a `Location` carrying credentials must not be able to authenticate
 * this client to a host the caller never named - see `_sanitizeRedirectRequest`.
 *
 * A string that does not parse is returned unchanged: there is no userinfo to find in it,
 * and this is on the redirect path, which already tolerates a `Location` it cannot parse.
 *
 * @param url - The URL to strip.
 * @returns The URL without userinfo, or `url` unchanged when it cannot be parsed.
 */
export function stripURLCredentials(url: string): string {
  try {
    const parsed = new URL(url);

    if (!parsed.username && !parsed.password) {
      return url;
    }

    parsed.username = '';
    parsed.password = '';

    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Withhold URL userinfo when an adapter is dispatching a hop to an origin other than
 * the one the caller addressed.
 *
 * HTTPClient sanitizes its own redirect requests, but adapters are public and can be
 * driven directly. `initialURL` is the adapter-level trust boundary for that path. An
 * unparseable initial URL fails closed: it cannot prove that the credentials belong to
 * the target origin, so they are stripped.
 */
export function stripCrossOriginURLCredentials(
  requestURL: string,
  initialURL: string | undefined,
): string {
  if (initialURL === undefined) {
    return requestURL;
  }

  let initial: URL;

  try {
    initial = new URL(initialURL);
  } catch {
    // The initial origin cannot be trusted. An absolute URL can be handled by the
    // ordinary helper; a network-path reference needs a base merely to expose its
    // authority to URL parsing - `//host` and every spelling the parser reads as one
    // (`\\host`, `/\host`, a leading space or tab), which a `startsWith('//')` let
    // through with their credentials.
    try {
      new URL(requestURL);
      return stripURLCredentials(requestURL);
    } catch {
      // Not absolute: resolved against a placeholder below.
    }

    try {
      const target = new URL(requestURL, 'http://credential-sanitizer.invalid');

      if (!target.username && !target.password) {
        return requestURL;
      }

      target.username = '';
      target.password = '';

      return target.href.slice(target.protocol.length);
    } catch {
      return requestURL;
    }
  }

  try {
    // Read on its own first, as `fetch` reads it: `https:u:p@b.com/x` is a relative path
    // under an `https:` base but an absolute URL to `b.com`, credentials and all.
    let target: URL;
    try {
      target = new URL(requestURL);
    } catch {
      target = new URL(requestURL, initial);
    }

    if (initial.origin === target.origin) {
      return requestURL;
    }

    if (!target.username && !target.password) {
      return requestURL;
    }

    target.username = '';
    target.password = '';

    // Keep the caller's network-path form; both browser adapters support relative URLs.
    return requestURL.startsWith('//')
      ? target.href.slice(target.protocol.length)
      : target.href;
  } catch {
    // The origins cannot be shown to match, so fail closed below.
  }

  return stripURLCredentials(requestURL);
}

/**
 * Browser-aware absolute URL resolution used by HTTPClient before interceptors
 * and adapter dispatch. Starts with normal baseURL resolution, then falls back
 * to the current page/worker location when running in a browser-like runtime.
 */
export function resolveAbsoluteURLForRuntime(
  url: string,
  baseURL: string | undefined,
  isBrowserRuntime: boolean,
): string {
  const resolved = resolveAbsoluteURL(url, baseURL);

  if (
    !isBrowserRuntime ||
    resolved.startsWith('http://') ||
    resolved.startsWith('https://')
  ) {
    return resolved;
  }

  const browserBase = getBrowserResolutionBase();

  if (!browserBase) {
    return resolved;
  }

  return resolveAbsoluteURL(resolved, browserBase);
}

function getBrowserResolutionBase(): string | undefined {
  if (
    typeof document !== 'undefined' &&
    typeof document.baseURI === 'string' &&
    document.baseURI
  ) {
    return document.baseURI;
  }

  if (
    typeof window !== 'undefined' &&
    window.location &&
    typeof window.location.href === 'string' &&
    window.location.href
  ) {
    return window.location.href;
  }

  const globalLocation = (globalThis as { location?: { href?: unknown } })
    .location;

  if (
    globalLocation &&
    typeof globalLocation.href === 'string' &&
    globalLocation.href
  ) {
    return globalLocation.href;
  }

  const selfLocation = (
    globalThis as { self?: { location?: { href?: unknown } } }
  ).self?.location;

  if (
    selfLocation &&
    typeof selfLocation.href === 'string' &&
    selfLocation.href
  ) {
    return selfLocation.href;
  }

  return undefined;
}

/**
 * Normalizes header keys to lowercase.
 */
export function normalizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    defineEntry(result, lowerCaseHeaderName(key), value);
  }

  return result;
}

/**
 * The methods matched case-insensitively and sent uppercase - the exported `HTTP_METHODS`:
 * fetch's normalized set, plus `PATCH`, which fetch leaves as given but the
 * non-idempotent check must still catch, and `TRACE`.
 */
const STANDARD_HTTP_METHODS: ReadonlySet<string> = new Set(HTTP_METHODS);

/**
 * A standard method in any case, uppercased - so `'post'` is `POST` for the
 * non-idempotent check and method filters - and any other method as given, since method
 * names are case-sensitive (RFC 9110) and a server may route `purge` and `PURGE` apart.
 * ASCII only: `toUpperCase` would also turn `poſt` into `POST`.
 */
export function normalizeHTTPMethod(method: string): HTTPMethod {
  const uppercased = method.replace(/[a-z]/g, (letter) => letter.toUpperCase());
  return STANDARD_HTTP_METHODS.has(uppercased) ? uppercased : method;
}

/** RFC 9110's `token`: the characters a method name is made of. */
const HTTP_METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * What is wrong with `candidate` as a request method - completing "the method …" - or
 * `undefined` when nothing is. A method is a non-empty string of RFC 9110 token
 * characters; every adapter refuses anything else, but only at dispatch, where a
 * caller's typo reads as a failed send. Shared by `request()` and the interceptor
 * snapshot, so neither accepts what the other refuses.
 */
export function describeInvalidHTTPMethod(
  candidate: unknown,
): string | undefined {
  if (typeof candidate !== 'string') {
    return `is not a string (got ${candidate === null ? 'null' : typeof candidate})`;
  }
  if (candidate === '') {
    return 'is empty';
  }
  if (!HTTP_METHOD_TOKEN.test(candidate)) {
    return `is not a valid HTTP method name (got ${JSON.stringify(candidate)})`;
  }
  // CONNECT asks for a tunnel rather than a response, which no adapter here handles:
  // NodeAdapter would wait on it until the attempt timed out, or forever.
  if (candidate.toUpperCase() === 'CONNECT') {
    return 'is CONNECT, which opens a tunnel and is not supported';
  }
  return undefined;
}

/**
 * A filter's `methods`, checked and normalized once when its callback is registered, so
 * matching a request is a plain lookup. Nullish means no method filter. Anything else must
 * be an array of method names, each held to the rule a request's method is; anything else
 * throws a `TypeError` naming `label`.
 */
export function normalizeFilterMethods(
  methods: unknown,
  label: string,
): HTTPMethod[] | undefined {
  if (isNullish(methods)) {
    return undefined;
  }
  if (!Array.isArray(methods)) {
    throw new TypeError(
      `${label} filter methods must be an array of method names (got ${typeof methods})`,
    );
  }
  if (methods.length === 0) {
    throw new TypeError(
      `${label} filter methods is empty, which would match no request; omit it to match every method`,
    );
  }
  // Copied first, as the other lists are: the caller's own `map` is not called, and a
  // hole is read as the `undefined` it is, and refused.
  const entries = [...(methods as unknown[])];
  const normalized: HTTPMethod[] = [];
  for (const entry of entries) {
    // Held to the rule a request's method is, so an entry no request can have - `''`,
    // `'GET, POST'` - is refused rather than registered to match nothing.
    const problem = describeInvalidHTTPMethod(entry);
    if (problem !== undefined) {
      throw new TypeError(`${label} filter method ${problem}`);
    }
    normalized.push(normalizeHTTPMethod(entry as string));
  }
  return normalized;
}

/**
 * Merges multiple request-header objects, normalizing keys to lowercase.
 * Later objects win on conflict. Array values replace earlier scalars/arrays
 * wholesale, and single-item arrays are collapsed back to a plain string. A later
 * `null` or `undefined` value removes the header an earlier object set - a request
 * dropping a client default such as `authorization` - rather than being sent.
 */
export function mergeHeaders(
  ...headerSets: Array<RequestHeadersInput | undefined>
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }

    for (const [key, value] of Object.entries(headers)) {
      const name = lowerCaseHeaderName(key);
      const normalized = normalizeMergedHeaderValue(value);
      if (normalized === undefined) {
        delete result[name];
        continue;
      }
      defineEntry(result, name, normalized);
    }
  }

  return result;
}

/**
 * One header value as {@link mergeHeaders} stores it, or `undefined` when it is unset
 * (see `presentHeaderValue`). Throws if conversion does.
 */
export function normalizeMergedHeaderValue(
  value: unknown,
): string | string[] | undefined {
  const present = presentHeaderValue(value);
  return Array.isArray(present) && present.length === 1 ? present[0] : present;
}

/**
 * Merges header records as observers see them, normalizing keys to lowercase. Later
 * objects win on conflict. Unlike {@link mergeHeaders}, an array is never collapsed: it
 * is copied with each element converted to a string. A scalar is converted to a string
 * (Node's `getHeaders()` answers numbers), and an unset value is skipped (see
 * `presentHeaderValue`): these records report what was sent, so an unset entry is one
 * not reported, not one removed.
 */
export function mergeObservedHeaders(
  ...headerSets: Array<
    Record<string, string | string[] | number | undefined> | undefined
  >
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }

    for (const [key, value] of Object.entries(headers)) {
      const present = presentHeaderValue(value);
      if (present === undefined) {
        continue;
      }

      defineEntry(result, lowerCaseHeaderName(key), present);
    }
  }

  return result;
}

/**
 * Parses the Content-Type header into a ContentType enum value.
 */
export function parseContentType(
  contentTypeHeader: string | undefined,
): ContentType {
  if (!contentTypeHeader) {
    return 'binary';
  } else {
    // The media type alone: a parameter (`profile="x+json"`) or a longer subtype
    // (`application/jsonl`) is not JSON.
    const lower = normalizeMimeType(contentTypeHeader);

    if (lower === 'application/json' || lower.endsWith('+json')) {
      return 'json';
    } else if (lower.startsWith('text/')) {
      return 'text';
    } else if (lower === 'application/x-www-form-urlencoded') {
      return 'text';
    } else {
      return 'binary';
    }
  }
}

/**
 * Validates adapter/runtime combinations and redirect config before a client
 * is constructed, so unsupported browser-only/server-only options fail fast
 * with clear errors instead of surfacing later during request dispatch.
 */
export function assertSupportedAdapterRuntimeAndConfig(
  config: HTTPClientConfig | SubClientConfig,
  adapterType: AdapterType,
  isBrowserRuntime: boolean,
): void {
  // Checked by type before anything below compares them with `=== true`: the client
  // reads them by truthiness, so `followRedirects: 'false'` (an environment variable,
  // say) would pass a check for `true` and still follow redirects. Nullish reads as false.
  for (const name of [
    'followRedirects',
    'retryNonIdempotentMethods',
    'includeRequestID',
    'includeAttemptHeader',
  ] as const) {
    const value: unknown = config[name];
    if (!isNullish(value) && typeof value !== 'boolean') {
      throw new TypeError(
        `HTTPClient ${name} must be a boolean (got ${typeof value})`,
      );
    }
  }

  const userAgent: unknown = config.userAgent;
  if (!isNullish(userAgent) && typeof userAgent !== 'string') {
    throw new TypeError(
      `HTTPClient userAgent must be a string (got ${typeof userAgent})`,
    );
  }

  // A jar the client cannot call fails here rather than on every request.
  const jar: unknown = config.cookieJar;
  if (
    !isNullish(jar) &&
    (typeof readUnknownMember(jar, 'getCookieHeaderString') !== 'function' ||
      typeof readUnknownMember(jar, 'processResponseHeaders') !== 'function')
  ) {
    throw new TypeError(
      'HTTPClient cookieJar must be a CookieJar (or null to disable cookies)',
    );
  }

  // A string, checked on every runtime, not only where it must be absolute: a `URL`
  // object passed `new URL()` here and then failed every request at `endsWith`. And no
  // query or fragment - a path is appended to it, so `/v1?key=abc` sent `/users` inside
  // the query.
  const baseURL: unknown = config.baseURL;
  if (baseURL !== undefined) {
    if (typeof baseURL !== 'string') {
      throw new TypeError(
        `HTTPClient baseURL must be a string (got ${baseURL === null ? 'null' : typeof baseURL})`,
      );
    }
    if (baseURL.includes('?') || baseURL.includes('#')) {
      throw new Error(
        'HTTPClient baseURL must not carry a query or fragment: request paths are appended to it. Pass query values as params.',
      );
    }
  }

  if (
    config.baseURL !== undefined &&
    requiresAbsoluteBaseURL(adapterType, isBrowserRuntime)
  ) {
    assertValidBaseURL(config.baseURL);
  }

  if (config.maxRedirects !== undefined && config.followRedirects !== true) {
    throw new Error('HTTPClient maxRedirects requires followRedirects: true.');
  }

  if (
    config.followRedirects === true &&
    config.maxRedirects !== undefined &&
    // A whole number, as every other count option is: `1.5` was accepted and acted as 1.
    (!Number.isInteger(config.maxRedirects) || config.maxRedirects < 1)
  ) {
    throw new Error(
      'HTTPClient maxRedirects must be an integer greater than or equal to 1 when followRedirects is true.',
    );
  }

  if (adapterType === 'xhr' && config.followRedirects === true) {
    throw new Error(
      'HTTPClient redirect handling is not supported with XHR adapter. Set followRedirects: false or use a different adapter/runtime.',
    );
  }

  if (adapterType === 'xhr' && !hasXMLHttpRequestGlobal()) {
    throw new Error(
      'HTTPClient XHR adapter is not supported when XMLHttpRequest is unavailable. Use a browser runtime, install a test shim, or switch to the FetchAdapter/NodeAdapter.',
    );
  }

  if (!isBrowserRuntime) {
    return;
  }

  if (adapterType === 'node') {
    throw new Error(
      'HTTPClient Node adapter is not supported in browser environments.',
    );
  }

  // MockAdapter is intentionally allowed in browser runtimes: it is an
  // in-memory test adapter, so cookie jars and redirect following are local
  // simulation features rather than forbidden browser networking controls.
  if ((adapterType === 'fetch' || adapterType === 'xhr') && config.cookieJar) {
    throw new Error(
      `HTTPClient cookieJar is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHR adapter'} in browser environments. Browsers manage cookies automatically.`,
    );
  }

  if ((adapterType === 'fetch' || adapterType === 'xhr') && config.userAgent) {
    throw new Error(
      `HTTPClient userAgent is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHR adapter'} in browser environments. Browsers do not allow overriding the User-Agent header.`,
    );
  }

  if (adapterType === 'fetch' && config.followRedirects === true) {
    throw new Error(
      'HTTPClient redirect handling is not supported with FetchAdapter in browser environments. Set followRedirects: false or use a server runtime.',
    );
  }
}

function requiresAbsoluteBaseURL(
  adapterType: AdapterType,
  isBrowserRuntime: boolean,
): boolean {
  if (adapterType === 'node' || adapterType === 'mock') {
    return true;
  }

  if (adapterType === 'fetch' && !isBrowserRuntime) {
    return true;
  }

  return false;
}

function hasXMLHttpRequestGlobal(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest ===
      'function'
  );
}

/** The first of a `Location` that fetch joined from repeated headers, or the value whole. */
function firstJoinedLocation(value: string): string {
  const separator = value.search(/, (?:\/|[a-z][a-z\d+.-]*:\/\/)/i);

  return separator === -1 ? value : value.slice(0, separator);
}

/**
 * Converts a Headers object (from fetch) into AdapterResponse headers.
 * `set-cookie` is extracted as `string[]` via `getSetCookie()` — the Fetch API
 * would otherwise incorrectly comma-join multiple Set-Cookie values.
 * All other headers are extracted as plain strings.
 */
export function extractFetchHeaders(
  headers: Headers,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of headers.entries()) {
    const lower = lowerCaseHeaderName(key);

    if (lower !== 'set-cookie') {
      // A repeated `Location` arrives joined as `a, b`; its first value is kept, as Node's
      // `res.headers` keeps it, rather than followed as the one mangled URL `a,%20b`. Only
      // when what follows the `, ` starts as a URL target does - a path or `scheme://`: a
      // single value with a raw space (`/files/Smith, John.pdf`) is kept whole and
      // percent-encoded when followed, as NodeAdapter and browsers follow it.
      defineEntry(
        result,
        lower,
        lower === 'location' ? firstJoinedLocation(value) : value,
      );
    }
  }

  // Use getSetCookie() when available (Bun, Node 18.14+, modern browsers)
  if (typeof headers.getSetCookie === 'function') {
    const setCookies = headers.getSetCookie();

    if (setCookies.length > 0) {
      result['set-cookie'] = setCookies;
    }
  } else {
    // Legacy Headers implementations can combine cookie lines. A comma before
    // another name=value may be a cookie boundary, a valid part of a Path or
    // extension attribute, or an invalid cookie-value octet accepted by a
    // permissive server. Reject that ambiguous header: splitting can invent
    // cookies or broaden their scope, and keeping it can apply one cookie's
    // attributes to another. Ordinary Expires date commas do not contain an '='
    // before the next delimiter and remain intact.
    const raw = headers.get('set-cookie');

    if (raw && !/,[^;,]*=/.test(raw)) {
      result['set-cookie'] = [raw];
    }
  }

  return result;
}

/**
 * The response headers Node's `http` keeps only the first of when one repeats, rather
 * than joining: each can hold a single value, so a joined `location` or `content-type`
 * would be no value at all.
 */
const SINGLE_VALUE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'server',
  'user-agent',
]);

/**
 * Lowercases all keys on adapter/response header objects. `HTTPClient` runs
 * this on each adapter response before {@link CookieJar.processResponseHeaders}.
 * Refuses, with a `TypeError`, a record that is not a plain object and a value
 * that is not a string or finite number.
 *
 * - Non–`set-cookie` values: an array (a mock or custom adapter's repeated
 *   header) is read as Node's `res.headers` reads a repeated header - the first
 *   value of a header that holds one ({@link SINGLE_VALUE_RESPONSE_HEADERS}),
 *   the others joined with `', '`.
 * - `set-cookie`: stored as `string[]` — each array entry is one full
 *   `Set-Cookie` header line (one cookie). A single string value becomes a
 *   one-element array. If the same header appears under keys that differ only
 *   by case, those lines are appended in the order they appear on the input
 *   object.
 */
export function normalizeAdapterResponseHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  // A `Headers` or `Map` keeps its entries off its own properties: read as one, every
  // header - the content type, `Set-Cookie` - was silently dropped. Refused, as the
  // request side refuses one.
  assertHeaderRecord(headers, 'HTTPClient adapter response headers');

  const result: Record<string, string | string[]> = {};

  for (const [key, rawValue] of Object.entries(headers)) {
    const lower = lowerCaseHeaderName(key);
    // As every header normalizer reads an unset value: a `null` or `undefined` value or
    // array item is no header, so an adapter's `undefined` is not reported as `''`.
    if (isNullish(rawValue)) {
      continue;
    }
    const value: unknown[] = Array.isArray(rawValue)
      ? (rawValue as unknown[]).filter((item) => !isNullish(item))
      : [rawValue];

    if (value.length === 0) {
      continue;
    }

    // The adapter's malformed answer, said as one: an object value was read as
    // `'[object Object]'` - a `content-type` of one read the body as binary - and a
    // `set-cookie` line that is not a string, left for the cookie jar to trip over, as
    // the jar failing. A finite number, as a mock's `content-length: 2`, is its text.
    if (
      value.some((item) =>
        lower === 'set-cookie'
          ? typeof item !== 'string'
          : !isAdapterHeaderValue(item),
      )
    ) {
      throw new TypeError(
        `HTTPClient adapter answered with a ${lower} header value that is not ${lower === 'set-cookie' ? 'a string' : 'a string or finite number'}`,
      );
    }
    const lines = value.map((item) => String(item));

    if (lower === 'set-cookie') {
      const existing = result[lower];

      if (existing === undefined) {
        result[lower] = lines;
      } else {
        const existingLines = Array.isArray(existing) ? existing : [existing];
        result[lower] = [...existingLines, ...lines];
      }
    } else {
      // As Node's `res.headers` reads a repeated header - an array, or keys that
      // differ only by case: the first value of one that can hold only one
      // (`location`, `content-type`), and the rest joined.
      const existing = Object.hasOwn(result, lower) ? result[lower] : undefined;
      const all =
        existing === undefined ? lines : [existing as string, ...lines];
      defineEntry(
        result,
        lower,
        SINGLE_VALUE_RESPONSE_HEADERS.has(lower) ? all[0] : all.join(', '),
      );
    }
  }

  return result;
}

/**
 * A header value an adapter may answer with: a string, or a finite number - Node's
 * `getHeaders()` answers `content-length` as one - which is its text.
 */
export function isAdapterHeaderValue(value: unknown): value is string | number {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Reads a single-valued header when keys are already lowercase (e.g. after
 * {@link mergeHeaders} on requests or {@link normalizeAdapterResponseHeaders}
 * on responses). If the stored value is `string[]`, returns the first entry.
 */
export function scalarHeader(
  headers: Record<string, string | string[]>,
  lowercaseName: string,
): string | undefined {
  const v = headers[lowercaseName];

  if (v === undefined) {
    return undefined;
  }

  return Array.isArray(v) ? v[0] : v;
}

/**
 * Resolves a redirect target from response headers when the adapter can
 * observe a redirect response but the client may not follow it itself.
 */
export function resolveDetectedRedirectURL(
  requestURL: string,
  status: number,
  headers: Record<string, string | string[]>,
  baseURL?: string,
): string | undefined {
  if (![301, 302, 303, 307, 308].includes(status)) {
    return undefined;
  }

  const location = scalarHeader(headers, 'location');

  if (!location) {
    return undefined;
  }

  try {
    const absoluteRequestURL = resolveAbsoluteURL(requestURL, baseURL);
    return new URL(location, absoluteRequestURL).toString();
  } catch {
    return location;
  }
}

export function assertValidBaseURL(
  baseURL: string,
  fieldName = 'baseURL',
): void {
  try {
    const url = new URL(baseURL);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(
      `HTTPClient ${fieldName} must be an absolute http(s) URL (for example "https://api.example.com").`,
    );
  }
}

/**
 * Detects whether the current runtime looks like a browser environment.
 */
export function isBrowserEnvironment(): boolean {
  if (typeof globalThis === 'undefined') {
    return false;
  }

  if ('window' in globalThis && 'document' in globalThis) {
    return true;
  }

  const workerGlobalScope = (
    globalThis as {
      WorkerGlobalScope?: abstract new (...args: never[]) => unknown;
    }
  ).WorkerGlobalScope;

  if (
    typeof workerGlobalScope === 'function' &&
    (globalThis as { self?: unknown }).self instanceof workerGlobalScope
  ) {
    return true;
  }

  const constructorName = globalThis.constructor?.name;

  return (
    !('window' in globalThis) &&
    !('document' in globalThis) &&
    typeof constructorName === 'string' &&
    constructorName.endsWith('WorkerGlobalScope')
  );
}

/**
 * Serializes the request body and returns the body + inferred content-type.
 */
export function serializeBody(body: unknown): {
  body: string | Uint8Array | FormData | null;
  contentType: string | null;
} {
  assertSupportedRequestBody(body);

  if (body instanceof FormData) {
    return { body, contentType: null }; // browser/runtime sets multipart boundary automatically
  } else if (body === undefined || body === null) {
    return { body: null, contentType: null };
  } else if (typeof body === 'string') {
    return { body, contentType: 'text/plain; charset=utf-8' };
  } else if (body instanceof Uint8Array) {
    return { body, contentType: 'application/octet-stream' };
  } else if (Array.isArray(body) || isPlainJSONBodyObject(body)) {
    return {
      body: JSON.stringify(body),
      contentType: 'application/json; charset=utf-8',
    };
  } else {
    throw new Error(
      'Unsupported request body type. Supported types: string, Uint8Array, FormData, plain object, array, null, and undefined.',
    );
  }
}

export function assertSupportedRequestBody(body: unknown): void {
  if (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof FormData ||
    Array.isArray(body) ||
    isPlainJSONBodyObject(body)
  ) {
    return;
  }

  throw new Error(
    'Unsupported request body type. Supported types: string, Uint8Array, FormData, plain object, array, null, and undefined.',
  );
}

export function isPlainJSONBodyObject(
  value: unknown,
): value is Record<string, unknown> {
  // The header record's rule, so a plain object is one in either place - another
  // realm's (a `vm` context's) included. It is sent as `JSON.stringify` serializes it;
  // see `buildObservedAttemptBodies`.
  return isPlainRecord(value);
}

/**
 * Extracts the hostname from a URL string. Returns empty string on failure.
 */
export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Wildcard hostname matching by `matchesWildcardDomain`'s rules.
 *
 * - `*` — global wildcard, matches any valid hostname including apex domains
 * - `*.example.com` — matches exactly one subdomain label (`api.example.com`) but not deeper levels or the apex
 * - `**.example.com` — matches one or more subdomain labels (`api.example.com`, `a.b.example.com`) but not the apex
 * - Exact patterns (no `*`) — normalized comparison, case-insensitive
 * - PSL tail guard active: `*.com`, `**.co.uk`, etc. never match
 * - Pseudo-TLD suffix wildcards are rejected just like PSL tails (`*.localhost`, `*.local`, etc.)
 */
export function matchesHostPattern(hostname: string, pattern: string): boolean {
  return matchesReadHostPattern(
    new CheckedHost(hostname),
    readHostPattern(pattern),
  );
}

/** One `hosts` pattern read once, by {@link readHostPattern}. */
export type HostPattern =
  /**
   * `*` alone: any host a request URL can carry, as documented - including one the
   * domain matcher cannot read (`-edge.example.com`), which every other pattern skips.
   */
  | { readonly kind: 'any' }
  /** An exact name, normalized. */
  | { readonly kind: 'exact'; readonly name: string }
  | { readonly kind: 'wildcard'; readonly compiled: CompiledWildcardPattern }
  /** A pattern that matches no host: `*.com`, `*.*`, a name the normalizer cannot read. */
  | { readonly kind: 'never' };

const ANY_HOST: HostPattern = { kind: 'any' };
const NO_HOST: HostPattern = { kind: 'never' };

/**
 * Whether a `hosts` pattern is `*` alone, trimmed. Not `*.`: that is an empty label after
 * the wildcard - what `*.${domain}` gives with the domain unset - and read as `*` it sent
 * a host-scoped interceptor's token to every host. It matches nothing, as in the domain
 * matchers, and is refused when the filter is added.
 */
export function isGlobalHostPattern(pattern: string): boolean {
  return pattern.trim() === '*';
}

/**
 * A `hosts` pattern read once - done when a filter is registered, rather than on every
 * request it is checked for: normalizing parses with the URL parser and runs IDNA, and a
 * wildcard's checks look its tail up in the Public Suffix List.
 */
export function readHostPattern(pattern: string): HostPattern {
  if (isGlobalHostPattern(pattern)) {
    return ANY_HOST;
  }

  if (pattern.includes('*')) {
    const compiled = compileWildcardPattern(pattern);
    if (compiled === undefined) {
      return NO_HOST;
    }

    return { kind: 'wildcard', compiled };
  }

  const name = normalizeDomain(pattern);
  return name === '' ? NO_HOST : { kind: 'exact', name };
}

/**
 * A request's hostname as one filter check reads it: normalized, and told whether it is
 * an IP address, each at most once and only if a pattern asks.
 */
class CheckedHost {
  private normalizedName: string | undefined;
  private isIPName: boolean | undefined;

  constructor(public readonly hostname: string) {}

  public get normalized(): string {
    this.normalizedName ??= normalizeDomain(this.hostname);
    return this.normalizedName;
  }

  public get isIP(): boolean {
    this.isIPName ??= isIPAddress(this.normalized);
    return this.isIPName;
  }
}

/**
 * The last hostname checked, kept for the next check: every host-scoped interceptor and
 * observer of a request checks the same one, in turn, and normalizing it - the URL parser
 * and IDNA - is the same answer each time. The hostname alone, not the request URL, so
 * no query token or userinfo stays in module state after its request; one entry, so it
 * holds nothing past the next request.
 */
let lastCheckedHost: CheckedHost | undefined;

function checkedHostFor(hostname: string): CheckedHost {
  if (lastCheckedHost?.hostname !== hostname) {
    lastCheckedHost = new CheckedHost(hostname);
  }

  return lastCheckedHost;
}

/** The one place a host is matched against a read pattern, exact or wildcard. */
function matchesReadHostPattern(
  host: CheckedHost,
  pattern: HostPattern,
): boolean {
  switch (pattern.kind) {
    case 'any':
      return host.hostname !== '';
    case 'never':
      return false;
    case 'exact':
      return host.normalized === pattern.name;
    case 'wildcard':
      return (
        host.normalized !== '' &&
        matchesCompiledWildcard(host.normalized, pattern.compiled, host.isIP)
      );
  }
}

/**
 * Checks whether a dot-path key exists in a nested object.
 * Arrays are not traversed — only plain objects at each segment.
 */
function hasNestedKey(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (!isPlainRecord(current)) {
      return false;
    }

    // Own keys only: `in` also finds inherited names, so `constructor` or `a.toString`
    // matched every object body.
    if (!Object.hasOwn(current, part)) {
      return false;
    }

    current = current[part];
  }

  return true;
}

// The first media type of a header fetch or XHR joined from repeats
// (`application/json, application/json`), without its parameters.
function normalizeMimeType(value: string): string {
  return value.split(',', 1)[0].split(';', 1)[0].trim().toLowerCase();
}

function matchesContentTypePattern(
  actualHeader: string,
  pattern: string,
): boolean {
  const actual = normalizeMimeType(actualHeader);
  const expected = normalizeMimeType(pattern);

  if (!actual || !expected) {
    return false;
  }

  if (expected === '*/*') {
    return actual.includes('/');
  }

  if (expected.endsWith('/*')) {
    const expectedType = expected.slice(0, -2);
    const slashIndex = actual.indexOf('/');

    if (slashIndex === -1) {
      return false;
    }

    return actual.slice(0, slashIndex) === expectedType;
  }

  return actual === expected;
}

/**
 * Tests whether a request context matches an interceptor/observer filter.
 *
 * Each filter field is optional — omitting it skips that check entirely.
 * All specified fields must match for the function to return true.
 * Within each field, values are matched with OR logic (any one match is sufficient).
 *
 * - `phases`: **OR** allowlist on `phaseType` ({@link RequestPhaseName}). Skipped when
 *   `filter.phases` is omitted or empty.
 * - `statusCodes`: skipped if `context.status` is absent.
 * - `methods`: skipped if `context.method` is absent for an observer; for an interceptor
 *   (`kind === 'request'`) a missing method matches nothing.
 * - `hosts`: supports exact hostnames and wildcard patterns. `*.example.com` matches
 *   exactly one subdomain label; `**.example.com` matches any depth. Neither matches the
 *   apex — list it explicitly. PSL tail guard prevents `*.com`-style patterns. `*` is a
 *   global wildcard that matches any hostname a URL can carry. Skipped if
 *   `context.requestURL` is absent for an observer; for an interceptor a missing URL
 *   matches nothing.
 * - `schemes`: `'http'` or `'https'`. `requestURL` is absolute whenever the
 *   request could be resolved before dispatch. For `MockAdapter`, path-only
 *   requests without a client `baseURL` are materialized as `http://localhost/...`;
 *   browser adapters fall back to `window.location`, and the Node adapter requires
 *   absolute URLs. Skipped only when `requestURL` is absent for an observer; for an
 *   interceptor a missing URL matches nothing.
 * - `bodyContainsKeys`: supports dot paths (e.g. `data.results`). Each segment in
 *   the path must resolve to a plain object for traversal to continue — the final
 *   value can be anything (array, string, null, etc). Array indexing is not supported.
 *   Skipped when `kind` is `'error'`.
 */
export function matchesFilter(
  filter: {
    statusCodes?: number[];
    methods?: string[];
    bodyContainsKeys?: string[];
    hosts?: string[];
    /** `hosts` read by {@link readHostPattern}, index for index, when it was registered. */
    hostPatterns?: readonly HostPattern[];
    schemes?: ('http' | 'https')[];
    phases?: RequestPhaseName[];
    contentTypes?: ContentType[];
    contentTypeHeaders?: string[];
  },
  requestContext: {
    status?: number;
    method?: string;
    body?: unknown;
    requestURL?: string;
    contentType?: ContentType;
    contentTypeHeader?: string;
  },
  phaseType: RequestPhaseName,
  kind: 'request' | 'response' | 'error',
): boolean {
  // An interceptor's context is the previous interceptor's result, and one that dropped
  // its `requestURL` or `method` had no host or method to skip the filter over: missing,
  // it matches nothing, as an unreadable one does - a host-scoped interceptor adding a
  // token does not run for a request whose host it cannot see, which a later one could
  // still point anywhere.
  const context =
    kind === 'request'
      ? {
          ...requestContext,
          requestURL: requestContext.requestURL ?? '',
          method: requestContext.method ?? '',
        }
      : requestContext;
  if (
    filter.phases &&
    filter.phases.length > 0 &&
    !filter.phases.includes(phaseType)
  ) {
    return false;
  }

  if (filter.statusCodes && context.status !== undefined) {
    if (!filter.statusCodes.includes(context.status)) {
      return false;
    }
  }

  // Checked whenever the filter names methods and the context has one, an empty one
  // included: `''` matches no method rather than skipping the filter.
  if (filter.methods && context.method !== undefined) {
    // Compared as the request is sent: an earlier interceptor's `'post'` is `POST`. A
    // method that is not a string matches nothing here; the snapshot after the chain
    // refuses it with its own error.
    // The filter's own entries were normalized when it was registered.
    const candidate: unknown = context.method;
    if (
      typeof candidate !== 'string' ||
      !filter.methods.includes(normalizeHTTPMethod(candidate))
    ) {
      return false;
    }
  }

  if (filter.contentTypes && filter.contentTypes.length > 0) {
    if (
      !context.contentType ||
      !filter.contentTypes.includes(context.contentType)
    ) {
      return false;
    }
  }

  if (filter.contentTypeHeaders && filter.contentTypeHeaders.length > 0) {
    if (
      !context.contentTypeHeader ||
      !filter.contentTypeHeaders.some((pattern) =>
        matchesContentTypePattern(context.contentTypeHeader as string, pattern),
      )
    ) {
      return false;
    }
  }

  if (
    kind !== 'error' &&
    filter.bodyContainsKeys &&
    filter.bodyContainsKeys.length > 0
  ) {
    // A plain object, as documented: a typed array or a boxed string has index keys,
    // so `'0'` matched every binary body.
    if (!isPlainRecord(context.body)) {
      return false;
    }

    const body = context.body;

    if (!filter.bodyContainsKeys.some((k) => hasNestedKey(body, k))) {
      return false;
    }
  }

  // Checked whenever the context has a URL, an empty one included, as `methods` is: a
  // request whose URL could not be read (`''`) matches no host or scheme rather than
  // skipping the filter, so a host-scoped observer does not hear about other hosts.
  if (filter.hosts && context.requestURL !== undefined) {
    const host = checkedHostFor(extractHostname(context.requestURL));
    const { hosts, hostPatterns } = filter;

    if (
      !hosts.some((pattern: string, index: number) =>
        matchesReadHostPattern(
          host,
          // Read here only for a filter not registered through a client.
          hostPatterns?.[index] ?? readHostPattern(pattern),
        ),
      )
    ) {
      return false;
    }
  }

  if (
    filter.schemes &&
    filter.schemes.length > 0 &&
    context.requestURL !== undefined
  ) {
    let scheme: 'http' | 'https' | null = null;

    try {
      const parsedScheme = new URL(context.requestURL).protocol.replace(
        ':',
        '',
      );

      if (parsedScheme === 'http' || parsedScheme === 'https') {
        scheme = parsedScheme;
      }
    } catch {
      scheme = null;
    }

    if (!scheme || !filter.schemes.includes(scheme)) {
      return false;
    }
  }

  return true;
}
