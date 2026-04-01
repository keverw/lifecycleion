import qs from 'qs';
import type {
  ContentType,
  RequestPhaseName,
  HTTPClientConfig,
  AdapterType,
} from './types';

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
  params?: Record<string, unknown>,
): string {
  let url: string;

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
    const [urlWithoutHash, hash = ''] = url.split('#', 2);
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
      const mergedParams = {
        ...qs.parse(existingQuery),
        ...params,
      };

      const queryString = qs.stringify(mergedParams, { addQueryPrefix: true });
      url = `${basePath}${queryString}${hash ? `#${hash}` : ''}`;
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
 * Normalizes header keys to lowercase.
 */
export function normalizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }

  return result;
}

/**
 * Merges multiple request-header objects, normalizing keys to lowercase.
 * Later objects win on conflict. Array values replace earlier scalars/arrays
 * wholesale, and single-item arrays are collapsed back to a plain string.
 */
export function mergeHeaders(
  ...headerSets: Array<Record<string, string | string[]> | undefined>
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }

    for (const [key, value] of Object.entries(headers)) {
      result[key.toLowerCase()] = Array.isArray(value)
        ? normalizeMergedHeaderArray(value)
        : String(value);
    }
  }

  return result;
}

function normalizeMergedHeaderArray(value: string[]): string | string[] {
  const normalized = value.map((item) => String(item));
  return normalized.length === 1 ? normalized[0] : normalized;
}

export function mergeObservedHeaders(
  ...headerSets: Array<Record<string, string | string[]> | undefined>
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const headers of headerSets) {
    if (!headers) {
      continue;
    }

    for (const [key, value] of Object.entries(headers)) {
      result[key.toLowerCase()] = Array.isArray(value)
        ? value.map((item) => String(item))
        : String(value);
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
    const lower = contentTypeHeader.toLowerCase();

    if (lower.includes('application/json') || lower.includes('+json')) {
      return 'json';
    } else if (lower.includes('text/')) {
      return 'text';
    } else if (lower.includes('application/x-www-form-urlencoded')) {
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
  config: HTTPClientConfig,
  adapterType: AdapterType,
  isBrowserRuntime: boolean,
): void {
  if (config.followRedirects === false && config.maxRedirects !== undefined) {
    throw new Error(
      'HTTPClient maxRedirects cannot be set when followRedirects is false.',
    );
  }

  if (
    config.followRedirects !== false &&
    config.maxRedirects !== undefined &&
    config.maxRedirects < 1
  ) {
    throw new Error(
      'HTTPClient maxRedirects must be greater than or equal to 1 when followRedirects is true.',
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

  if (
    (adapterType === 'fetch' || adapterType === 'xhr') &&
    config.followRedirects === true
  ) {
    throw new Error(
      `HTTPClient redirect handling is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHR adapter'} in browser environments. Set followRedirects: false or use a server runtime.`,
    );
  }
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
    const lower = key.toLowerCase();

    if (lower !== 'set-cookie') {
      result[lower] = value;
    }
  }

  // Use getSetCookie() when available (Bun, Node 18.14+, modern browsers)
  if (typeof headers.getSetCookie === 'function') {
    const setCookies = headers.getSetCookie();

    if (setCookies.length > 0) {
      result['set-cookie'] = setCookies;
    }
  } else {
    // Fallback: headers.get() comma-joins — split on ', ' is unreliable for
    // cookies but better than nothing on older runtimes
    const raw = headers.get('set-cookie');

    if (raw) {
      result['set-cookie'] = [raw];
    }
  }

  return result;
}

/**
 * Lowercases all keys on adapter/response header objects. `HTTPClient` runs
 * this on each adapter response before {@link CookieJar.processResponseHeaders}.
 * The jar also normalizes so the same shapes work when feeding headers directly.
 *
 * - Non–`set-cookie` values: if an array appears (unexpected), the first
 *   element is kept when read via {@link scalarHeader}.
 * - `set-cookie`: stored as `string[]` — each array entry is one full
 *   `Set-Cookie` header line (one cookie). A single string value becomes a
 *   one-element array. If the same header appears under keys that differ only
 *   by case, those lines are appended in the order they appear on the input
 *   object.
 */
export function normalizeAdapterResponseHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();

    if (lower === 'set-cookie') {
      const chunk = Array.isArray(value) ? value : [value];
      const existing = result[lower];

      if (existing === undefined) {
        result[lower] = chunk;
      } else {
        const existingLines = Array.isArray(existing) ? existing : [existing];
        result[lower] = [...existingLines, ...chunk];
      }
    } else {
      result[lower] = Array.isArray(value) ? (value[0] ?? '') : value;
    }
  }

  return result;
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
 * If `formData` is provided, it takes precedence over `body`.
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
 * Wildcard hostname matching. '*.example.com' matches 'api.example.com' but NOT 'example.com'.
 */
export function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // '.example.com'
    return hostname.endsWith(suffix) && hostname !== suffix.slice(1);
  }

  return hostname === pattern;
}

/**
 * Checks whether a dot-path key exists in a nested object.
 * Arrays are not traversed — only plain objects at each segment.
 */
function hasNestedKey(obj: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return false;
    }

    if (!(part in (current as Record<string, unknown>))) {
      return false;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return true;
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0].trim().toLowerCase();
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
 * - `methods`: skipped if `context.method` is absent.
 * - `hosts`: supports exact hostnames and wildcard patterns (e.g. `*.example.com`
 *   matches subdomains but not the apex). Skipped if `context.requestURL` is absent.
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
    phases?: RequestPhaseName[];
    contentTypes?: ContentType[];
    contentTypeHeaders?: string[];
  },
  context: {
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

  if (filter.methods && context.method) {
    if (!filter.methods.includes(context.method)) {
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
    if (
      !context.body ||
      typeof context.body !== 'object' ||
      Array.isArray(context.body)
    ) {
      return false;
    }

    const body = context.body as Record<string, unknown>;

    if (!filter.bodyContainsKeys.some((k) => hasNestedKey(body, k))) {
      return false;
    }
  }

  if (filter.hosts && context.requestURL) {
    const hostname = extractHostname(context.requestURL);

    if (
      !filter.hosts.some((pattern: string) =>
        matchesHostPattern(hostname, pattern),
      )
    ) {
      return false;
    }
  }

  return true;
}
