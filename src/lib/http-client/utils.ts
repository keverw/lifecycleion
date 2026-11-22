import {
  describeNonTokenMethod,
  normalizeStandardMethod,
} from './internal/http-method';
import {
  asciiLowercase,
  asciiUppercase,
  trimHTTPWhitespace,
  trimWhere,
} from '../internal/ascii-text';
import { REDIRECT_STATUS_CODES } from './consts';
import qs from 'qs';
import { defineEntry } from '../internal/define-entry';
import { isNullish } from '../internal/is-nullish';
import { describeValue } from '../internal/describe-value';
import { assertHeaderRecord, isPlainRecord } from './internal/plain-record';
import { copyArrayValue } from '../internal/array-copy';
import { inKeyOrder } from './internal/param-array-copy';
import { isFormData, isMethodlessFormData } from './internal/form-entries';
import {
  MAX_PARAM_DEPTH,
  exceedsParamDepth,
  PARAM_DEPTH_EXCEEDED_MESSAGE,
  unreadableCollectionRefusal,
  type CollectionLookup,
} from './internal/param-check';
import { readUnknownMember } from '../internal/read-member';
import { isUint8ArrayValue } from '../internal/binary-view';
import {
  isAdapterRequestBody,
  nonRetryableAdapterErrorFrom,
} from './internal/adapter-error';
import {
  lowerCaseHeaderName,
  presentHeaderValue,
} from './internal/header-utils';
import { safeParseURL } from '../domain-utils/domain-utils';
import {
  checkedHostFor,
  matchesReadHostPattern,
  readHostPattern,
  type HostPattern,
} from '../domain-utils/host-filter';
import type {
  ContentType,
  RequestPhaseName,
  HTTPClientConfig,
  SubClientConfig,
  AdapterType,
  HTTPMethod,
  RequestHeadersInput,
  AdapterResponse,
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
 * Whether `url` is an absolute http(s) URL on its own, as a request is sent: `''`, a
 * relative path and a protocol-relative `//host` are not (see {@link tryAbsoluteWebHref}).
 */
export function isAbsoluteWebURL(url: string): boolean {
  return tryAbsoluteWebHref(url) !== null;
}

/**
 * `qs.stringify`'s `depth` option (qs 6.16), which `@types/qs` does not list yet: a value
 * deeper than {@link MAX_PARAM_DEPTH} is refused with its `RangeError` rather than
 * overflowing the stack.
 */
const QS_STRINGIFY_DEPTH: qs.IStringifyOptions & { depth: number } = {
  depth: MAX_PARAM_DEPTH,
};

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

/**
 * A param value with every object `qs` walks into copied, each member read once: the
 * override check and the query both read the copy, so a nested getter cannot answer one
 * of them differently from the other, and `qs`, which reads only the copy, runs none of
 * the caller's code. An array is copied into an array, and any other object `qs` walks by
 * its own enumerable keys - a plain record, a function, a class instance - into a plain
 * record, which `qs` writes as it would the original, its keys in the order the original
 * lists them (a `Proxy`'s `ownKeys` order included). A value that is not an object is
 * kept as it is, and a `Date` and a value `qs` writes as a buffer (see
 * {@link qsBufferRead}) are written as the text `qs` would write for them. A cycle, and
 * an entry deeper than `MAX_PARAM_DEPTH`, are refused as `qs` refuses them, with its
 * `RangeError`; a collection `qs` would write nothing for (a `Set` a getter answers, say)
 * as `.params()` refuses one, with a `TypeError` naming its key (see
 * `unreadableCollectionRefusal`). An object reached by more than one path is copied once
 * for each, as `qs` reads it once for each - a getter in it included.
 *
 * `read` holds the members of `value` already read - the `isBuffer` of an object read as
 * its holder's `constructor` - which are not read again.
 *
 * An array is copied by the keys `qs` serializes it by, as a record is - its own
 * enumerable keys, so a hole is skipped and a key that is not an index (`list.extra`) kept.
 *
 * Kept separate from `.params()`'s check (`assertSerializableParams`), which must run no
 * getter, since this read is the one `qs` serializes, and reads through them.
 *
 * What it promises is the query `qs` would write for the values as read here, and that
 * the override check reads the same values. The hooks `qs` itself consults
 * (`constructor`, `isBuffer`, `toString`) are read once on the common paths, but a value
 * whose hooks change the value while they are read (an `isBuffer` that defines an own
 * `constructor`, say) is outside that promise: matching `qs` there would take
 * property checks `qs` does not make, which would run a `Proxy`'s traps `qs` never runs.
 */
function snapshotParamValue(
  value: unknown,
  depth: number,
  walk: ParamSnapshotWalk,
  read?: ReadonlyMap<string, unknown>,
): unknown {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return value;
  }

  // As `qs` writes a `Date` by default, and throws for an invalid one.
  if (value instanceof Date) {
    return Date.prototype.toISOString.call(value);
  }

  const source = value as Record<string, unknown>;
  // The `isBuffer` read off `value` itself, when it is its own `constructor`.
  let ownIsBuffer: unknown = NOT_READ;
  const member = (key: string): unknown => {
    if (read?.has(key) === true) {
      return read.get(key);
    }
    return key === 'isBuffer' && ownIsBuffer !== NOT_READ
      ? ownIsBuffer
      : source[key];
  };

  // Read once: told a buffer by, and copied as the entry it is when it is an own one -
  // its `isBuffer` with it, read once too. `qs` does not ask a function.
  const constructor: unknown =
    typeof value === 'object' ? member('constructor') : NOT_READ;
  const buffer = qsBufferRead(value, constructor);
  if (buffer.text !== undefined) {
    return buffer.text;
  }
  if (constructor === value) {
    ownIsBuffer = buffer.isBuffer;
  }

  const collectionRefusal = unreadableCollectionRefusal(value, walk);
  if (collectionRefusal !== undefined) {
    throw collectionRefusal;
  }

  if (walk.ancestors.has(value)) {
    throw new RangeError('Cyclic object value');
  }

  const keys = Object.keys(source);
  if (exceedsParamDepth(keys.length, depth)) {
    throw new RangeError(PARAM_DEPTH_EXCEEDED_MESSAGE);
  }

  walk.ancestors.add(value);
  const copy = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
  for (const key of keys) {
    walk.path.push(key);
    const isConstructor = key === 'constructor' && constructor !== NOT_READ;
    const entry = isConstructor ? constructor : member(key);
    defineEntry(
      copy,
      key,
      snapshotParamValue(
        entry,
        depth + 1,
        walk,
        isConstructor && buffer.isBuffer !== NOT_READ
          ? new Map([['isBuffer', buffer.isBuffer]])
          : undefined,
      ),
    );
    walk.path.pop();
  }

  walk.ancestors.delete(value);
  return inKeyOrder(copy, keys);
}

/**
 * A member not read: a function's `constructor`, which `qs` does not ask whether it is a
 * buffer, or the `isBuffer` of a falsy `constructor`, which `qs` does not read.
 */
const NOT_READ: unique symbol = Symbol('not read');

/**
 * Whether `qs` takes `value` for a buffer - an object whose `constructor`, read once by
 * the caller, has an `isBuffer` that answers truthy for it: a `Buffer`, or a polyfill's
 * where there is no global one - and if so the text `qs` writes for it, by `String`, as
 * `qs` does. `isBuffer` is the member read off `constructor` ({@link NOT_READ} when none
 * was), so a copy of `constructor` does not read it again.
 */
function qsBufferRead(
  value: object,
  constructor: unknown,
): { text: string | undefined; isBuffer: unknown } {
  if (constructor === NOT_READ || !constructor) {
    return { text: undefined, isBuffer: NOT_READ };
  }

  const isBuffer: unknown = (constructor as { isBuffer?: unknown }).isBuffer;
  const text =
    typeof isBuffer === 'function' &&
    Reflect.apply(isBuffer, constructor, [value])
      ? // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a buffer's own `toString`, reached by `String` as `qs` reaches it
        String(value)
      : undefined;
  return { text, isBuffer };
}

interface ParamSnapshotWalk extends CollectionLookup {
  /** The objects the entry being copied is nested inside. */
  readonly ancestors: Set<object>;
}

/** `params` with its nested values snapshot (see {@link snapshotParamValue}). */
function snapshotParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const walk: ParamSnapshotWalk = {
    path: [],
    ancestors: new Set(),
    collectionReads: undefined,
  };
  const snapshot: Record<string, unknown> = {};
  const keys = Object.keys(params);

  for (const key of keys) {
    walk.path.push(key);
    defineEntry(snapshot, key, snapshotParamValue(params[key], 0, walk));
    walk.path.pop();
  }

  // In the order the caller's record lists its keys, as a nested record is kept.
  return inKeyOrder(snapshot, keys);
}

/**
 * The key a query pair from the wire sets at the top level, as `qs` reads it: split at
 * its first `]=` when it has one, after the `]` - so `[a=b]=1` sets `a=b` - and otherwise
 * at its first `=`.
 */
function topLevelQueryKey(wirePair: string): string | undefined {
  // `qs` reads an encoded bracket as a bracket before it splits or decodes a pair.
  const pair = wirePair.replace(/%5B/gi, '[').replace(/%5D/gi, ']');
  const bracketEquals = pair.indexOf(']=');
  const end = bracketEquals === -1 ? pair.indexOf('=') : bracketEquals + 1;
  const rawKey = (end === -1 ? pair : pair.slice(0, end)).replace(/\+/g, ' ');
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
 * straight here - it is a name `qs` will encode, not one to decode. `undefined` for a
 * key that opens with `[]`, which has no name of its own (see below).
 */
function topLevelKeyOf(key: string): string | undefined {
  const bracket = key.indexOf('[');
  if (bracket !== 0) {
    return bracket > 0 ? key.slice(0, bracket) : key;
  }

  // A key that opens with a bracket (`[x]=1`) is read by `qs` as the name inside it, up
  // to the bracket that closes it, brackets nested inside counted: `[item[id]old]` is
  // `item[id]old`. One never closed is the whole key, as `qs` keeps it. One that opens
  // with `[]` has no name: `qs` numbers it by the pairs around it (`[]=1&[]=2` is `0`
  // and `1`, `[][a]=1&[]=2` both `0`), so it matches no `.params()` key, and no other key
  // matches it - not even `[[]]`, whose name is `[]`.
  let level = 0;
  for (let index = 0; index < key.length; index++) {
    const char = key[index];
    if (char === '[') {
      level++;
    } else if (char === ']') {
      level--;
      if (level === 0) {
        return index > 1 ? key.slice(1, index) : undefined;
      }
    }
  }

  return key;
}

/**
 * Builds a request URL string from `baseURL`, `path`, and optional query params
 * (`qs` — nested objects and arrays supported).
 *
 * **Relative paths (usual case)** — When `baseURL` is set and `path` is not
 * absolute, `path` is joined to `baseURL` (leading slash normalized). Example:
 * `baseURL: https://api.test`, `path: /v1/users` → `https://api.test/v1/users`. An empty
 * `path`, or one that is only a query or fragment, is added to `baseURL` as written.
 *
 * **Absolute / protocol-relative `path` (escape hatch)** — If `path` is a full
 * `http://` or `https://` URL, it is **not** prefixed with `baseURL` (after
 * normalization via `URL#href`). With no `baseURL` to stay on, the parser's slashless
 * spellings (`http:host/x`) are read as URLs too. The same applies to protocol-relative URLs
 * (`//cdn.example/x`): they are left for {@link resolveAbsoluteURL} to resolve
 * using the client `baseURL`’s scheme. Use this for one-off cross-origin calls,
 * CDN assets, or URLs returned by APIs; for strict per-origin clients, prefer
 * relative paths and a dedicated client or `HTTPClient.createSubClient()` per
 * origin.
 *
 * `params` is read more than once - the override check and the query - so it is given as
 * `HTTPRequestBuilder.params()` copied it: each top-level value a data property, read once
 * from the caller's object. A nested object is still the caller's: it is read once, into
 * one snapshot both read, which refuses a collection `qs` would write nothing for.
 */
export function buildURL(
  baseURL: string | undefined,
  path: string,
  params?: Record<string, unknown>,
): string {
  let url: string;

  // With a base, an http(s) URL skips the join only if it starts `scheme://`: the parser
  // also reads a host from `http:evil.test` and ` http://evil.test`, spellings that pass
  // a caller's check for `://`, a leading `//` or a leading `http`.
  const absoluteHref =
    baseURL && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)
      ? null
      : tryAbsoluteWebHref(path);

  if (baseURL && absoluteHref === null && !path.startsWith('//')) {
    if (path === '' || path.startsWith('?') || path.startsWith('#')) {
      // No path to join: the base as written, with no slash the caller did not ask for.
      url = `${baseURL}${path}`;
    } else {
      // Avoid double slashes when joining base + path. The base's path is a prefix, not
      // a boundary: dot segments in `path` are resolved later, as any URL's are.
      const base = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
      const p = path.startsWith('/') ? path : `/${path}`;
      url = `${base}${p}`;
    }
  } else if (absoluteHref !== null) {
    url = absoluteHref;
  } else {
    url = path;
  }

  if (params && Object.keys(params).length > 0) {
    // At the first `#` only: `split`'s limit drops everything after a second one.
    const hashIndex = url.indexOf('#');
    const urlWithoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
    // With its `#`, so an empty fragment (`/x#`) is kept as written too.
    const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
    const queryStartIndex = urlWithoutHash.indexOf('?');

    // The query, and the override check, read one snapshot of the nested values (see
    // `snapshotParamValue`).
    const snapshot = snapshotParams(params);

    if (queryStartIndex === -1) {
      const queryString = qs.stringify(snapshot, {
        ...QS_STRINGIFY_DEPTH,
        addQueryPrefix: true,
      });
      url = `${urlWithoutHash}${queryString}${fragment}`;
    } else {
      const basePath = urlWithoutHash.slice(0, queryStartIndex);
      const existingQuery = urlWithoutHash.slice(queryStartIndex + 1);
      // Fragments are preserved only as part of the caller's URL string.
      // They are not transmitted in HTTP requests, but keeping them intact
      // makes buildURL safer as a general-purpose URL composition helper.
      //
      // The existing query is kept as written, pair by pair, rather than parsed and
      // re-serialized: that would rewrite what `qs` reads differently from the server - a
      // repeated key into `tag[0]`, `%E9` into `%25E9`, `constructor=1` dropped - though
      // nothing asks to change it. Only a pair whose top-level key `params` also names is
      // left out, so the `params` value wins.
      // Top-level keys on both sides, as the docs state the rule: `page[number]` in params
      // replaces the path's `page[...]` pairs as `{ page: { number } }` would.
      // A key whose value is `undefined` - or an object of nothing but `undefined` - is
      // not given, so it leaves the path's pairs alone: `.params({ page: options.page })`
      // with no page keeps `?page=2`. An empty array or object is given, and clears them.
      const overridden = new Set(
        Object.keys(snapshot)
          .filter((key) => isGivenParam(snapshot[key]))
          .map(topLevelKeyOf)
          .filter((key) => key !== undefined),
      );
      const pairs = existingQuery.split('&').filter((pair) => pair !== '');
      const kept = pairs.filter((pair) => {
        const key = topLevelQueryKey(pair);
        return key === undefined || !overridden.has(key);
      });
      const added = qs.stringify(snapshot, QS_STRINGIFY_DEPTH);

      // Params that add nothing and replace no pair of the path's - each unset, or given
      // empty for a key the path does not have - leave the URL as written, its query
      // included: an empty one (`/x?`) or empty pairs (`?a=1&&b=2`), which a signed URL's
      // signature covers.
      if (added !== '' || kept.length < pairs.length) {
        const query = [...kept, ...(added ? [added] : [])].join('&');
        url = `${basePath}${query ? `?${query}` : ''}${fragment}`;
      }
    }
  }

  return url;
}

/**
 * Best-effort absolute URL for a request: the `baseURL` step of
 * {@link resolveAbsoluteURLForRuntime}, which resolves every request URL before
 * interceptors and dispatch.
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
 * Whether `toURL` is on a different origin (scheme, host and port) from `fromURL` - the
 * rule a redirect hop's credentials, socket path and client certificate follow. A URL
 * that does not parse counts as cross-origin: nothing is carried on a doubt. So does an
 * opaque origin (a `file:` or other non-special URL), which `URL` spells `'null'` for
 * all of them alike: each parse is a fresh origin, the same as no other.
 */
export function isCrossOrigin(
  fromURL: string | URL,
  toURL: string | URL,
): boolean {
  try {
    const fromOrigin = (
      typeof fromURL === 'string' ? new URL(fromURL) : fromURL
    ).origin;
    const toOrigin = (typeof toURL === 'string' ? new URL(toURL) : toURL)
      .origin;

    return (
      fromOrigin === 'null' || toOrigin === 'null' || fromOrigin !== toOrigin
    );
  } catch {
    return true;
  }
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
 * A string that does not parse - a `Location` with a port out of range, a broken IPv6
 * literal - has the userinfo cut from its authority as written (see
 * {@link withoutTextualUserinfo}): it is still recorded in `redirectHistory` and reported
 * as the hop's URL, and nothing is sent to it.
 *
 * @param url - The URL to strip.
 * @returns The URL without userinfo.
 */
export function stripURLCredentials(url: string): string {
  try {
    const parsed = new URL(url);

    if (!parsed.username && !parsed.password) {
      return url;
    }

    return withoutUserinfo(parsed, false);
  } catch {
    return withoutTextualUserinfo(url);
  }
}

/**
 * `url` with the userinfo of its authority cut out as the text reads, for a string the
 * URL parser refuses: everything after `//` (or `\\`, as the parser reads a special
 * scheme's; after a special scheme, any number of slashes, none included, as the parser
 * reads `https:u:p@host`) up to the last `@` before the authority ends at `/`, `\`, `?`
 * or `#`. The `@` itself is kept, so the host after it is read exactly as before and the
 * string is still refused: cut with it, `https://u:p@/evil.test/x` would become
 * `https:///evil.test/x`, which the parser reads as `https://evil.test/x`. Read without
 * the tabs, newlines and edge controls the parser drops, which a cut string is left
 * without too. Unchanged when it has no authority or no `@` in it, or, as a last guard,
 * when the cut would parse.
 */
function withoutTextualUserinfo(url: string): string {
  // Read as the parser reads it: without the tabs and newlines it removes anywhere, nor
  // the C0 controls and spaces it trims from either end, so `ht\ttps://u:p@...` is cut
  // as `https://u:p@...` is. The pattern's own leading `\s*` goes further, past
  // whitespace the parser keeps (a no-break space): such a string is refused anyway, and
  // reading past it cuts its userinfo too.
  // Trimmed by index: a regex's unanchored `+$` rescans an inner run of spaces from each
  // of its positions, quadratic in a server's `Location`.
  const text = trimWhere(url.replace(/[\t\n\r]/g, ''), (code) => code <= 0x20);
  const authority =
    /^(\s*(?:(?:https?|wss?|ftp|file):[/\\]*|(?:[a-z][a-z\d+.-]*:)?[/\\]{2}))([^/\\?#]*)/i.exec(
      text,
    );
  if (authority === null) {
    return url;
  }

  const [whole, prefix, host] = authority;
  const at = host.lastIndexOf('@');
  if (at === -1) {
    return url;
  }

  const cut = prefix + host.slice(at) + text.slice(whole.length);

  try {
    new URL(cut);
    return url;
  } catch {
    return cut;
  }
}

/**
 * `target`'s href with its userinfo cleared - without its scheme when `isNetworkPath`, so
 * a caller's network-path reference (`//host/path`) stays one. Clears it on `target`.
 */
function withoutUserinfo(target: URL, isNetworkPath: boolean): string {
  target.username = '';
  target.password = '';

  return isNetworkPath
    ? target.href.slice(target.protocol.length)
    : target.href;
}

/**
 * Withhold URL userinfo when an adapter is dispatching a hop to an origin other than
 * the one the caller addressed.
 *
 * HTTPClient sanitizes its own redirect requests, but adapters are public and can be
 * driven directly. `initialURL` is the adapter-level trust boundary for that path. An
 * unparseable initial URL fails closed: it cannot prove that the credentials belong to
 * the target origin, so they are stripped.
 *
 * The same rule decides what a reported `detectedRedirectURL` may carry, with the URL
 * that was answered as `initialURL`: see {@link detectedRedirectTarget}, and the client's
 * reading of an adapter's own answer.
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
    // (`\\host`, `/\host`, a leading space or tab), which a `startsWith('//')` check
    // would let through with their credentials.
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

      return withoutUserinfo(target, true);
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

    // The client's cross-origin rule rather than comparing `origin`s: every opaque origin
    // reads `'null'`, so `foo://a.test/` and `foo://u:p@b.test/x` would compare equal.
    if (!isCrossOrigin(initial, target)) {
      return requestURL;
    }

    if (!target.username && !target.password) {
      return requestURL;
    }

    // Keep the caller's network-path form; both browser adapters support relative URLs.
    return withoutUserinfo(target, requestURL.startsWith('//'));
  } catch {
    // The origins cannot be shown to match, so fail closed below.
  }

  return stripURLCredentials(requestURL);
}

/**
 * Browser-aware absolute URL resolution used by HTTPClient before interceptors
 * and adapter dispatch. Starts with normal baseURL resolution, then falls back
 * to the current page/worker location when running in a browser-like runtime.
 *
 * That fallback resolves as `fetch` and XHR do, against the base URL as it stands:
 * `api/start` on `https://app.test/dir/page` is `https://app.test/dir/api/start`. The
 * trailing `/` {@link resolveAbsoluteURL} adds is for a configured `baseURL`, a prefix
 * the path is appended to; a page's URL names a document, not a directory.
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

  return resolveBrowserRequestURL(resolved) ?? resolved;
}

/**
 * `url` resolved for a browser request: itself when it parses on its own as an absolute
 * URL, else against {@link getBrowserResolutionBase} - the document's base URL in a
 * window, the `location` in a worker; `undefined` when it is relative and there is no
 * base, or does not resolve against it. Tested with `new URL` in a `try`: `URL.canParse`
 * is missing from older browsers and early Node 18, and a check that throws there must
 * not fail every request.
 */
export function resolveBrowserRequestURL(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    // Relative: resolved below, where there is a base.
  }

  const base = getBrowserResolutionBase();

  if (base === undefined) {
    return undefined;
  }

  try {
    return new URL(url, base).href;
  } catch {
    return undefined;
  }
}

/**
 * A browser adapter's `initialURL`, for {@link stripCrossOriginURLCredentials} to compare
 * the request with. Absent stays absent; an absolute one is taken as it parses.
 *
 * Only one whose first character is `/` - root-relative (`/start`) or protocol-relative
 * (`//api.test/start`) - is resolved against the page, as its request URL is (see
 * {@link resolveBrowserRequestURL}): it names an origin of its own - the page's, or the one
 * written - so same-origin credentials are not withheld for want of a parse. Every other
 * relative one is handed back as written and the comparison fails closed: `''`, `#top`,
 * `?q`, `.` and `start` name no origin, only the page itself, and resolved they would
 * take the page for the request's origin and keep the userinfo of a request to it with
 * nothing to show it belongs there. Other spellings a browser also reads as root- or
 * protocol-relative - `\\app.test/x`, a leading space or tab - fail closed too, withholding
 * same-origin credentials rather than guessing. So does a `/` one with no page to resolve
 * it against.
 */
export function resolveBrowserInitialURL(
  initialURL: string | undefined,
): string | undefined {
  if (initialURL === undefined) {
    return undefined;
  }

  try {
    return new URL(initialURL).href;
  } catch {
    // Relative: resolved below only when it names an origin.
  }

  if (!initialURL.startsWith('/')) {
    return initialURL;
  }

  // Not absolute - it failed to parse above - so only the page can resolve it.
  const base = getBrowserResolutionBase();

  if (base === undefined) {
    return initialURL;
  }

  try {
    return new URL(initialURL, base).href;
  } catch {
    return initialURL;
  }
}

/**
 * The URL a browser adapter sends `requestURL` to, or the non-retryable error it is refused
 * with - `adapterName` naming the adapter in its message. Resolved as the browser resolves
 * it (see {@link resolveBrowserRequestURL}), with credentials withheld from the resolved
 * URL, not the one written: `//u:p@host/x` on an `http:` page is an `http:` URL, another
 * origin than an `https:` initial URL. A root- or protocol-relative initial URL is resolved
 * the same way, so `/start` names the page's origin; any other relative one, or one that
 * does not resolve, fails closed (see {@link resolveBrowserInitialURL}).
 *
 * Refused as NodeAdapter refuses it, as the non-retryable `adapter_error` it is: the same
 * URL fails the same way on every attempt. A relative URL with no base to resolve it
 * against (an adapter driven directly outside a browser), or one that is not a URL, cannot
 * be sent, nor compared with where an answer came from; any other scheme than http(s)
 * would be loaded where the runtime loads one - a `file:` URL read off the local disk.
 * The client always sends an absolute http(s) URL.
 */
export function resolveBrowserDispatchURL(
  requestURL: string,
  initialURL: string | undefined,
  adapterName: 'FetchAdapter' | 'XHRAdapter',
): string | Error {
  const resolvedURL = resolveBrowserRequestURL(requestURL);

  if (resolvedURL === undefined) {
    return nonRetryableAdapterErrorFrom(
      new TypeError(
        `${adapterName} request URL could not be resolved to an absolute URL (no document or location base, or not a valid URL)`,
      ),
    );
  }

  const dispatchedURL = stripCrossOriginURLCredentials(
    resolvedURL,
    resolveBrowserInitialURL(initialURL),
  );

  if (!isAbsoluteWebURL(dispatchedURL)) {
    return nonRetryableAdapterErrorFrom(
      new TypeError(
        `${adapterName} sends http: and https: URLs only (got ${dispatchedURL.slice(0, dispatchedURL.indexOf(':') + 1)})`,
      ),
    );
  }

  return dispatchedURL;
}

/**
 * The base a browser resolves a relative request URL against, as `fetch` and XHR do: the
 * document's base URL in a window (which a `<base href>` sets), else the page's or the
 * worker's `location`. `undefined` where there is none. The one lookup both browser
 * adapters and the client resolve with, so all three agree on where a relative URL goes.
 *
 * Read through guarded accessors: a runtime whose `document` or `location` getter throws
 * has no base, rather than failing every request.
 */
export function getBrowserResolutionBase(): string | undefined {
  const documentBase = readUnknownMember(
    readUnknownMember(globalThis, 'document'),
    'baseURI',
  );

  if (typeof documentBase === 'string' && documentBase) {
    return documentBase;
  }

  return findBrowserPage()?.href;
}

/**
 * The page or worker {@link findBrowserPage} finds: its global, its `location`, and that
 * location's `href`.
 */
export interface BrowserPage {
  scope: unknown;
  location: unknown;
  href: string;
}

/**
 * The page or worker running a request: the first global scope whose `location` has an
 * `href`, searched in the order `window` - the page's global in a window - then
 * `globalThis` - the window or the worker itself - then `self`, a worker's name for its
 * global. `undefined` where none has one, as outside a browser.
 *
 * In a browser those scopes are one object wherever more than one exists, so the order
 * decides only in a runtime that shims them apart. There, everything that reads the page
 * reads this one: the `location` a relative request URL falls back to when the document
 * has no base URL of its own (see {@link getBrowserResolutionBase}) and the origin a
 * response is compared with come from the same scope, never from a scope that has no
 * `location` at all. A `<base href>` moves the base, not the page: the origin is still
 * this page's. Read through guarded accessors, as the members read from it are.
 */
export function findBrowserPage(): BrowserPage | undefined {
  for (const scope of [
    readUnknownMember(globalThis, 'window'),
    globalThis,
    readUnknownMember(globalThis, 'self'),
  ]) {
    const location = readUnknownMember(scope, 'location');
    const href = readUnknownMember(location, 'href');

    if (typeof href === 'string' && href) {
      return { scope, location, href };
    }
  }

  return undefined;
}

/**
 * What is wrong with `candidate` as a request method - completing "the method …" - or
 * `undefined` when nothing is: a `CONNECT`, or what {@link describeMalformedHTTPMethod}
 * refuses: `request()`'s rule. Request filters and the interceptor phases check
 * {@link describeMalformedHTTPMethod}, as an interceptor may hand a `CONNECT` to the next;
 * the phases refuse one once the chain's URL is checked (see
 * `_assertRequestShapeIsSupported`).
 */
export function describeInvalidHTTPMethod(
  candidate: unknown,
): string | undefined {
  const malformed = describeMalformedHTTPMethod(candidate);
  if (malformed !== undefined) {
    return malformed;
  }
  // CONNECT asks for a tunnel rather than a response, which no adapter here handles:
  // NodeAdapter would wait on it until the attempt timed out, or forever.
  if (asciiUppercase(candidate as string) === 'CONNECT') {
    return CONNECT_METHOD_PROBLEM;
  }
  return undefined;
}

/** What {@link describeInvalidHTTPMethod} says of a `CONNECT`. */
export const CONNECT_METHOD_PROBLEM =
  'is CONNECT, which opens a tunnel and is not supported';

/**
 * What is wrong with `candidate` as the name of a method, as
 * {@link describeInvalidHTTPMethod} words it, or `undefined` when nothing is. A method is
 * a non-empty string of RFC 9110 token characters; every adapter refuses anything else,
 * but only at dispatch, where a caller's typo reads as a failed send. The rule of the
 * interceptor snapshot and of request filters: a `CONNECT` is a method name, refused once
 * the chain's URL is checked, so a filter can select one an interceptor handed on.
 */
export function describeMalformedHTTPMethod(
  candidate: unknown,
): string | undefined {
  if (typeof candidate !== 'string') {
    return `is not a string (got ${describeValue(candidate)})`;
  }
  return describeNonTokenMethod(candidate);
}

/**
 * A filter's `methods`, checked and normalized once when its callback is registered, so
 * matching a request is a plain lookup. Nullish means no method filter. Anything else must
 * be an array of method names, each held to the rule an interceptor's method is (see
 * `describeMalformedHTTPMethod`); anything else throws a `TypeError` naming `label`.
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
      `${label} filter methods must be an array of method names (got ${describeValue(methods)})`,
    );
  }
  // Copied first, by index, as the other lists are (see `copyArrayValue`): the caller's
  // own `map` and iterator are not called, and a hole is read as the `undefined` it is,
  // and refused.
  const entries = copyArrayValue(
    methods as unknown[],
    `${label} filter methods`,
  );
  if (entries.length === 0) {
    throw new TypeError(
      `${label} filter methods is empty, which would match no request; omit it to match every method`,
    );
  }
  const normalized: HTTPMethod[] = [];
  for (const [index, entry] of entries.entries()) {
    // Held to the rule an interceptor's method is, so an entry no request can have - `''`,
    // `'GET, POST'` - is refused rather than registered to match nothing, while a `CONNECT`
    // one interceptor hands the next can be selected. Named by its place in the list, as
    // every other filter list's entries are.
    const problem = describeMalformedHTTPMethod(entry);
    if (problem !== undefined) {
      throw new TypeError(
        `${label} filter methods[${String(index)}] ${problem}`,
      );
    }
    normalized.push(normalizeStandardMethod(entry as string));
  }
  return normalized;
}

/**
 * Merges multiple request-header objects, normalizing keys to lowercase.
 * Later objects win on conflict. Array values replace earlier scalars/arrays
 * wholesale, and single-item arrays are collapsed back to a plain string. A later
 * `null` or `undefined` value removes the header an earlier object set - a request
 * dropping a client default such as `authorization` - rather than being sent. Names that
 * differ only in case, in one object or several, are that same conflict: the last wins, so
 * `{ ...defaults, 'content-type': type }` replaces a default `Content-Type`.
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
    // (`application/jsonl`) is not JSON. The JSON MIME types are the MIME Sniffing
    // standard's: `application/json`, `text/json`, and any subtype ending in `+json`.
    const lower = normalizeMimeType(contentTypeHeader);

    if (
      lower === 'application/json' ||
      lower === 'text/json' ||
      lower.endsWith('+json')
    ) {
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
        `HTTPClient ${name} must be a boolean (got ${describeValue(value)})`,
      );
    }
  }

  const userAgent: unknown = config.userAgent;
  if (!isNullish(userAgent) && typeof userAgent !== 'string') {
    throw new TypeError(
      `HTTPClient userAgent must be a string (got ${describeValue(userAgent)})`,
    );
  }

  // Empty - an unset environment variable - would be replaced by the default, with nothing
  // said.
  if (userAgent === '') {
    throw new TypeError('HTTPClient userAgent must not be empty');
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
  // object would pass `new URL()` here and then fail every request at `endsWith`. And no
  // query or fragment - a path is appended to it, so `/v1?key=abc` would send `/users`
  // inside the query. `null` is unset, as it is for the options around it.
  const baseURL: unknown = config.baseURL;
  if (!isNullish(baseURL)) {
    if (typeof baseURL !== 'string') {
      throw new TypeError(
        `HTTPClient baseURL must be a string (got ${describeValue(baseURL)})`,
      );
    }
    if (baseURL.includes('?') || baseURL.includes('#')) {
      throw new Error(
        'HTTPClient baseURL must not carry a query or fragment: request paths are appended to it. Pass query values as params.',
      );
    }
  }

  if (
    !isNullish(config.baseURL) &&
    requiresAbsoluteBaseURL(adapterType, isBrowserRuntime)
  ) {
    assertValidBaseURL(config.baseURL);
  }

  // Nullish reads as unset, as for `followRedirects` above.
  if (!isNullish(config.maxRedirects) && config.followRedirects !== true) {
    throw new Error('HTTPClient maxRedirects requires followRedirects: true.');
  }

  if (
    !isNullish(config.maxRedirects) &&
    // A whole number, as every other count option is: `1.5` would otherwise be accepted
    // and act as 1.
    (!Number.isInteger(config.maxRedirects) || config.maxRedirects < 1)
  ) {
    throw new Error(
      'HTTPClient maxRedirects must be an integer greater than or equal to 1 when followRedirects is true.',
    );
  }

  if (adapterType === 'xhr' && config.followRedirects === true) {
    throw new Error(
      'HTTPClient redirect handling is not supported with XHRAdapter. Set followRedirects: false or use a different adapter/runtime.',
    );
  }

  if (adapterType === 'xhr' && !hasXMLHttpRequestGlobal()) {
    throw new Error(
      'HTTPClient XHRAdapter is not supported when XMLHttpRequest is unavailable. Use a browser runtime, install a test shim, or switch to the FetchAdapter/NodeAdapter.',
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
      `HTTPClient cookieJar is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHRAdapter'} in browser environments. Browsers manage cookies automatically.`,
    );
  }

  if ((adapterType === 'fetch' || adapterType === 'xhr') && config.userAgent) {
    throw new Error(
      `HTTPClient userAgent is not supported with ${adapterType === 'fetch' ? 'FetchAdapter' : 'XHRAdapter'} in browser environments. Browsers do not allow overriding the User-Agent header.`,
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

/**
 * The first of a `Location` that fetch or XHR joined from repeated headers, or the value
 * whole. A value that is one non-empty target repeated (`next, next` - a header a server
 * or proxy sent twice - or `Smith, John.pdf, Smith, John.pdf`) is that target. That
 * target, or the value, is then split only where what follows the `, ` starts as a URL
 * target does - a path (`/`, `./`, `../`), a query (`?`), a fragment (`#`) or
 * `scheme://` - and only before its first `?` or `#`, so `/a, /b` sent twice is `/a`. A
 * single value with a raw space (`/files/Smith, John.pdf`) is kept whole, as is one whose
 * query or fragment holds such a `, ` (`/r?to=/a, /b`), which is followed as fetch
 * follows it. A path with an unencoded `, /`, `, ./`, `, ../`, `, ?`, `, #` or
 * `, scheme://` in it (`/a, /b`) is cut there, as is one that is a target written twice
 * (`a, a`): fetch and XHR join repeats into the same text, so the two cannot be told
 * apart. Two different targets the first of which has a query or fragment (`/a?x, /b`)
 * are followed as one. A server percent-encodes the space in such a value. An empty
 * `Location` among them (`/a, `, `, /b`, `/a, , /b`) is dropped first, as browsers follow
 * the first that is not empty; one made of nothing else (`, `) is empty, as no
 * `Location` at all; one of HTTP whitespace alone is empty too, as every adapter reads a
 * repeat. One at the start or end is dropped even past a `?` or `#`, as a
 * single value neither starts nor ends with a space; one between two others only before
 * the first `?` or `#`, so a query or fragment holding `, , `
 * (`/search?q=a, , b`) is kept whole, unless the value is one target repeated around it
 * (`/a?x, , /a?x`). A path holding `, , ` (`/files/a, , b.pdf`) cannot be told from one
 * joined with an empty repeat, and is read as one.
 */
export function firstJoinedLocation(value: string): string {
  // Split and joined once each, so a long run of `, ` costs its length, not its square.
  const parts = value.split(', ');
  let start = 0;
  let end = parts.length;

  while (start < end && isEmptyHeaderValue(parts[start])) {
    start++;
  }

  while (end > start && isEmptyHeaderValue(parts[end - 1])) {
    end--;
  }

  const kept: string[] = [];
  let isInQuery = false;
  let hasKeptEmpty = false;

  for (let index = start; index < end; index++) {
    const part = parts[index];

    if (isEmptyHeaderValue(part)) {
      if (!isInQuery) {
        continue;
      }

      hasKeptEmpty = true;
    }

    kept.push(part);
    isInQuery ||= /[?#]/.test(part);
  }

  const joined = kept.join(', ');
  // The repeated unit is split as any value is: `/a, /b` sent twice is `/a`. Looked for
  // in the value as kept, so a query holding `, , ` sent twice keeps it, and then with
  // every empty repeat dropped, so a target with a query sent twice around an empty one
  // (`/a?x, , /a?x`) is still that target.
  const candidate =
    repeatedTarget(joined) ??
    (hasKeptEmpty
      ? repeatedTarget(
          parts
            .slice(start, end)
            .filter((part) => !isEmptyHeaderValue(part))
            .join(', '),
        )
      : undefined) ??
    joined;
  const separator = candidate.search(
    /, (?:\/|\.\.?\/|\?|#|[a-z][a-z\d+.-]*:\/\/)/i,
  );
  // A query or fragment can hold `, /` itself, so a `, ` past its start is kept.
  const queryStart = candidate.search(/[?#]/);

  return separator === -1 || (queryStart !== -1 && separator > queryStart)
    ? candidate
    : candidate.slice(0, separator);
}

/**
 * The non-empty target `value` is two or more copies of, joined by `, `, or `undefined`.
 * Only a length that divides the value evenly is tried, each compared in place, copy by
 * copy, so a long header costs one pass over it per such length, not one per `, ` in it.
 */
function repeatedTarget(value: string): string | undefined {
  const joined = `${value}, `;

  for (
    let comma = value.indexOf(', ');
    comma !== -1;
    comma = value.indexOf(', ', comma + 1)
  ) {
    const span = comma + 2;
    // A `, ` at the start is an empty target, which the value is no copies of.
    if (comma === 0 || joined.length % span !== 0) {
      continue;
    }

    const unit = joined.slice(0, span);
    let offset = span;
    while (offset < joined.length && joined.startsWith(unit, offset)) {
      offset += span;
    }

    if (offset === joined.length) {
      return value.slice(0, comma);
    }
  }

  return undefined;
}

/**
 * The first of a repeated header's values that is not empty or HTTP whitespace alone,
 * as browsers follow the first `Location` that is not empty, or `undefined` when none is.
 */
export function firstNonEmptyValue(
  values: readonly string[],
): string | undefined {
  return values.find((value) => !isEmptyHeaderValue(value));
}

/**
 * Whether a header value, or one repeat of a joined one, is empty or HTTP whitespace
 * alone: the one test every reading of a repeated `Location` drops a repeat by.
 */
function isEmptyHeaderValue(value: string): boolean {
  return trimHTTPWhitespace(value) === '';
}

/**
 * Whether a `Set-Cookie` line may hold several cookies a runtime joined with commas: a
 * comma before another `name=value`. Such a comma may be a cookie boundary, a valid part
 * of a `Path` or extension attribute, or an invalid cookie-value octet a permissive server
 * sent, so the line cannot be read safely: splitting it can invent cookies or broaden
 * their scope, and keeping it whole can apply one cookie's attributes to another. An
 * ordinary `Expires` date's comma has no `=` before the next delimiter, and is not one.
 */
export function isAmbiguousSetCookieLine(line: string): boolean {
  return /,[^;,]*=/.test(line);
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
      // Kept as fetch joined it, single-value headers included, as `fetch` itself exposes
      // it: a `Content-Type` cannot be split at a comma safely - a quoted parameter may
      // hold one - and the client's readers take the joined form (the first media type of
      // a `Content-Type`, a `Content-Length` only when its values agree). Only a repeated
      // `Location` is narrowed to its first value, below.
      defineEntry(result, lower, value);
    }
  }

  // A `Location` fetch joined from repeats keeps its first value that is not empty, as
  // browsers follow it, rather than being followed and reported as the one mangled URL
  // `a,%20b`. See `firstJoinedLocation` for where it splits: a single value with a raw
  // space (`/files/Smith, John.pdf`) is kept whole and percent-encoded when followed, as
  // NodeAdapter and browsers follow it.
  const location = result['location'];

  if (typeof location === 'string') {
    result['location'] = firstJoinedLocation(location);
  }

  // Use getSetCookie() when available (Bun, Node 18.14+, modern browsers)
  if (typeof headers.getSetCookie === 'function') {
    const setCookies = headers.getSetCookie();

    if (setCookies.length > 0) {
      result['set-cookie'] = setCookies;
    }
  } else {
    // Legacy Headers implementations can combine cookie lines: an ambiguous one is
    // dropped (see `isAmbiguousSetCookieLine`).
    const raw = headers.get('set-cookie');

    if (raw && !isAmbiguousSetCookieLine(raw)) {
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
 *   value of a header that holds one ({@link SINGLE_VALUE_RESPONSE_HEADERS}; for
 *   `location`, the first that is not empty, as browsers follow it),
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
  // header - the content type, `Set-Cookie` - would be silently dropped. Refused, as the
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
    // Copied first, by index (see `copyArrayValue`): the adapter's own `filter`, and the
    // `constructor` it builds through, are not called.
    const value: unknown[] = Array.isArray(rawValue)
      ? copyArrayValue(
          rawValue as unknown[],
          'HTTPClient adapter response header value',
        ).filter((item) => !isNullish(item))
      : [rawValue];

    if (value.length === 0) {
      continue;
    }

    // The adapter's malformed answer, said as one: an object value would be read as
    // `'[object Object]'` - a `content-type` of one would read the body as binary - and a
    // `set-cookie` line that is not a string, left for the cookie jar to trip over, would
    // surface as the jar failing. A finite number, as a mock's `content-length: 2`, is
    // its text.
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
      // (`content-type`), and the rest joined. A `Location`'s first that is not empty,
      // as the built-in adapters keep it, or its first when all are.
      const existing = Object.hasOwn(result, lower) ? result[lower] : undefined;
      const all =
        existing === undefined ? lines : [existing as string, ...lines];
      defineEntry(
        result,
        lower,
        lower === 'location'
          ? (firstNonEmptyValue(all) ?? all[0])
          : SINGLE_VALUE_RESPONSE_HEADERS.has(lower)
            ? all[0]
            : all.join(', '),
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
 * A response's `Location`, or `undefined` for none: one of nothing but whitespace names no
 * target, as an empty one does - resolved, it would be the request's own URL, and a
 * redirect to itself until the limit.
 */
export function locationHeader(
  headers: Record<string, string | string[]>,
): string | undefined {
  const location = scalarHeader(headers, 'location');

  return location === undefined || trimHTTPWhitespace(location) === ''
    ? undefined
    : location;
}

/**
 * A `Location` header's value as the URL it names is written, before it is resolved: its
 * bytes read as UTF-8, as browsers and `fetch` read them. A runtime hands a header value
 * over a character per byte (latin1), so a server's raw `/caf\xC3\xA9` arrives as
 * `/cafÃ©`, which would otherwise be followed as `/caf%C3%83%C2%A9` rather than the
 * `/caf%C3%A9` it means. A value holding a character past one byte is already text, and
 * one whose bytes are not valid UTF-8 is kept as it came.
 *
 * The decoder refuses invalid bytes and keeps a BOM: a `Location` of nothing but one must
 * not read as empty, which resolves to the request's own URL. Made here rather than as the
 * module loads, and kept as it came on a runtime that has none or refuses these options
 * (React Native's), so that importing the client does not depend on it.
 */
export function locationText(value: string): string {
  // eslint-disable-next-line no-control-regex -- every byte past ASCII, as a byte
  if (!/[\u0080-\u00ff]/.test(value) || /[^\u0000-\u00ff]/.test(value)) {
    return value;
  }

  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    bytes[index] = value.charCodeAt(index);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return value;
  }
}

/**
 * A redirect's `Location` resolved against the URL that was answered, carrying that URL's
 * fragment over when `location` has none of its own, as the Fetch Standard's location
 * URL does: `/next` answered for `/start#sec` points to `/next#sec`. A `Location` with a
 * fragment of its own, even an empty one (`/next#`), keeps it. With no `base`, only an
 * absolute `location` resolves. Throws as `new URL` does when it does not resolve.
 */
export function resolveRedirectLocation(
  location: string,
  base: string | URL | undefined,
): URL {
  const baseURL = typeof base === 'string' ? new URL(base) : base;
  const target = new URL(location, baseURL);
  const baseHref = baseURL?.href ?? '';
  const fragmentAt = baseHref.indexOf('#');

  // A serialized URL has a `#` only before its fragment, so this finds a fragment set
  // even when it is empty, where `hash` reads `''` for both.
  if (fragmentAt !== -1 && !target.href.includes('#')) {
    // The setter drops the leading `#`, so a bare `#` gives an empty fragment.
    target.hash = baseHref.slice(fragmentAt);
  }

  return target;
}

/**
 * Where a redirect's `Location` points, as `detectedRedirectURL` reports it: resolved
 * against the URL that was answered, taking its fragment when the `Location` has none
 * ({@link resolveRedirectLocation}), without that URL's userinfo. A relative `Location`
 * names no credentials, so the caller's own are not copied into a field that reports the
 * server's target. Userinfo the server wrote into the `Location` itself is kept only on a
 * target of the request's own origin, and only when it is not the request URL's own
 * ({@link reportedRedirectTarget}): on any other origin, the client's redirect loop
 * strips it from the URL it follows, so it is not reported either.
 *
 * A `Location` that does not resolve to a URL reports no target at all, rather than the
 * raw string handed on as though it were one. An absolute one still resolves when the
 * request URL does not parse (an adapter driven directly with a relative one): it needs
 * no base, and counts as cross-origin.
 */
export function detectedRedirectTarget(
  location: string,
  requestURL: string,
): string | undefined {
  let base: URL | undefined;
  try {
    base = new URL(requestURL);
    base.username = '';
    base.password = '';
  } catch {
    // No base: only an absolute `Location` resolves.
  }

  let target: string;
  try {
    target = resolveRedirectLocation(locationText(location), base).href;
  } catch {
    return undefined;
  }

  return reportedRedirectTarget(target, requestURL);
}

/**
 * A redirect target as `detectedRedirectURL` reports it, whoever resolved it - the
 * built-in adapters, the client, or a custom adapter's own value: held to
 * {@link stripCrossOriginURLCredentials} against the URL that was answered, and without
 * userinfo identical to that URL's own on a target of its origin. Those are the
 * request's credentials, copied in by resolving a relative `Location` against the
 * request URL (a custom adapter's `new URL(location, requestURL)`), not the server's:
 * nothing tells the two apart, so they are not reported. Userinfo the server wrote that
 * differs from the request's is kept on the request's own origin.
 */
export function reportedRedirectTarget(
  targetURL: string,
  requestURL: string,
): string {
  const reported = stripCrossOriginURLCredentials(targetURL, requestURL);

  try {
    const request = new URL(requestURL);
    const { username, password } = request;
    // A relative target is resolved against the request URL without its userinfo, so
    // only userinfo written into the target itself is found on it.
    request.username = '';
    request.password = '';
    let target: URL;
    try {
      target = new URL(reported);
    } catch {
      target = new URL(reported, request);
    }

    if (
      (target.username || target.password) &&
      target.username === username &&
      target.password === password &&
      !isCrossOrigin(request, target)
    ) {
      // Kept in its network-path form, as `stripCrossOriginURLCredentials` keeps one.
      return withoutUserinfo(target, reported.startsWith('//'));
    }
  } catch {
    // A request URL that does not parse has no userinfo to match, and the cross-origin
    // rule above already failed closed on it.
  }

  return reported;
}

/** The redirect fields of an answer: whether it was a redirect, and where it pointed. */
export type AdapterRedirectFields = Pick<
  AdapterResponse,
  'wasRedirectDetected' | 'detectedRedirectURL'
>;

/**
 * The redirect fields of an answer, derived from its status and `Location` - for an
 * adapter reporting one, and for the client rebuilding one from a stream error the
 * adapter threw with the status and headers tagged on it - so a truncated `3xx` still
 * reports where it pointed.
 */
export function derivedRedirectFields(
  requestURL: string,
  status: number,
  headers: Record<string, string | string[]>,
): AdapterRedirectFields {
  if (!REDIRECT_STATUS_CODES.has(status)) {
    return { wasRedirectDetected: false };
  }

  const location = locationHeader(headers);
  const detectedRedirectURL = location
    ? detectedRedirectTarget(location, requestURL)
    : undefined;

  return {
    wasRedirectDetected: true,
    ...(detectedRedirectURL ? { detectedRedirectURL } : {}),
  };
}

export function assertValidBaseURL(baseURL: string): void {
  if (!isAbsoluteWebURL(baseURL)) {
    throw new Error(
      'HTTPClient baseURL must be an absolute http(s) URL (for example "https://api.example.com").',
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
 * Serializes the request body and returns the body + inferred content-type. `jsonText`,
 * when given, is the JSON text a JSON body is already known to serialize to - a copy the
 * client took (see `copiedJSONText`) - and is sent as it is, not serialized again.
 */
export function serializeBody(
  body: unknown,
  jsonText?: string,
): {
  body: string | Uint8Array | FormData | null;
  contentType: string | null;
} {
  assertSupportedRequestBody(body);

  if (isFormData(body)) {
    return { body, contentType: null }; // browser/runtime sets multipart boundary automatically
  } else if (body === undefined || body === null) {
    return { body: null, contentType: null };
  } else if (typeof body === 'string') {
    return { body, contentType: 'text/plain; charset=utf-8' };
  } else if (isRequestBodyBytes(body)) {
    return { body, contentType: 'application/octet-stream' };
  } else if (Array.isArray(body) || isPlainRecord(body)) {
    // `JSON.stringify` answers `undefined` for a top-level `toJSON` that does: nothing is
    // sent, so nothing is typed as JSON either.
    const serialized: unknown = jsonText ?? JSON.stringify(body);

    return typeof serialized === 'string'
      ? { body: serialized, contentType: 'application/json; charset=utf-8' }
      : { body: null, contentType: null };
  } else {
    // Reached by a `Proxy` whose prototype answers differently than it did to the check.
    throw new TypeError(UNSUPPORTED_REQUEST_BODY_MESSAGE);
  }
}

/** The refusal of a request body of a type no adapter sends, wherever it is refused. */
export const UNSUPPORTED_REQUEST_BODY_MESSAGE =
  'Unsupported request body type. Supported types: string, Uint8Array, FormData, plain object, array, null, and undefined.';

/**
 * The refusal of a React Native `FormData`, which has no `has()` (see
 * `isMethodlessFormData`): the client copies a form and reads its entries, which such a
 * form does not let it, so the refusal names the adapters that send one as it is.
 */
export const METHODLESS_FORM_DATA_BODY_MESSAGE =
  'Unsupported request body type: a FormData with no has() (React Native) cannot be copied or read by HTTPClient. Send it through FetchAdapter or XHRAdapter driven directly.';

/** {@link UNSUPPORTED_REQUEST_BODY_MESSAGE}, or for a React Native form its own refusal. */
export function unsupportedRequestBodyMessage(body: unknown): string {
  return isMethodlessFormData(body)
    ? METHODLESS_FORM_DATA_BODY_MESSAGE
    : UNSUPPORTED_REQUEST_BODY_MESSAGE;
}

/**
 * Refuse a request body the client neither sends as it is (see `isAdapterRequestBody`)
 * nor serializes as JSON (a plain object or an array).
 */
export function assertSupportedRequestBody(body: unknown): void {
  if (
    isAdapterRequestBody(body) ||
    Array.isArray(body) ||
    isPlainRecord(body)
  ) {
    return;
  }

  throw new TypeError(unsupportedRequestBodyMessage(body));
}

/**
 * Whether a request body is bytes: a `Uint8Array` - a `Buffer` included - told by its
 * internal slot (see `typedArrayNameOf`), so from any realm: a `vm` context's, or a
 * `Buffer` under jsdom, which `instanceof Uint8Array` misses. A `Proxy` over one has no
 * slot, and nothing could copy its bytes, so it is not.
 */
export function isRequestBodyBytes(body: unknown): body is Uint8Array {
  return isUint8ArrayValue(body);
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

/** A body's contents as `matchesFilter` reads them where nothing is parsed: the body. */
function bodyAsItIs(body: Record<string, unknown>): Record<string, unknown> {
  return body;
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

    // Own keys only: `in` would also find inherited names, so `constructor` or
    // `a.toString` would match every object body.
    if (!Object.hasOwn(current, part)) {
      return false;
    }

    current = current[part];
  }

  return true;
}

// The first media type of a header fetch or XHR joined from repeats
// (`application/json, application/json`), without its parameters, trimmed of HTTP
// whitespace and lowercased in ASCII only, as the Fetch standard parses a MIME type.
function normalizeMimeType(value: string): string {
  return asciiLowercase(
    trimHTTPWhitespace(value.split(',', 1)[0].split(';', 1)[0]),
  );
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
 * Whether a filter's `phases` reach `phaseType`: no list reaches every phase. A
 * registered filter always has one - its own, never empty, as adding the callback refuses
 * an empty list, or the kind's default. Asked before {@link matchesFilter}, which reads
 * the request and leaves `phases` to this: it reads only the filter, so the interceptor
 * chain asks it before it copies the request the rest reads, and an observer the phase
 * never reaches reads nothing.
 */
export function matchesFilterPhase(
  phases: readonly RequestPhaseName[] | undefined,
  phaseType: RequestPhaseName,
): boolean {
  return !phases || phases.includes(phaseType);
}

/**
 * The request URL each filter context was parsed to by `matchesFilter`, with the URL it
 * read: the observers of one phase - a parent client's and a sub-client's - are matched
 * against one context, and the filters of an interceptor chain against one while its
 * request is unchanged, so their host and scheme checks share one parse. Kept only while
 * the context is.
 */
const parsedURLByContext = new WeakMap<
  object,
  { requestURL: string | undefined; parsed: URL | null }
>();

/**
 * Tests whether a request context matches an interceptor/observer filter, its `phases`
 * aside: those are {@link matchesFilterPhase}'s, asked first.
 *
 * Each filter field is optional — omitting it skips that check entirely.
 * All specified fields must match for the function to return true.
 * Within each field, values are matched with OR logic (any one match is sufficient).
 *
 * An interceptor's context always has a `requestURL` and a `method`: it is the request
 * the client built, or an earlier interceptor's result as `snapshotInterceptedRequest`
 * copied it, which refuses one without them. An observer's is read before the first
 * observer runs, from the request the client sent. A context without one matches no
 * filter that names `methods`, `hosts` or `schemes`, so a scoped callback does not hear
 * about a request it cannot place.
 *
 * - `statusCodes`: skipped if `context.status` is absent.
 * - `methods`: a method that is not a string matches nothing.
 * - `hosts`: supports exact hostnames and wildcard patterns. `*.example.com` matches
 *   exactly one subdomain label; `**.example.com` matches any depth. Neither matches the
 *   apex — list it explicitly. A public suffix or pseudo-TLD tail is matched as written
 *   (`*.internal`, `*.com`), but never a host under a public suffix beneath the tail.
 *   `*` is a global wildcard that matches any hostname a URL can carry.
 * - `schemes`: `'http'` or `'https'`. `requestURL` is absolute whenever the
 *   request could be resolved before dispatch. For `MockAdapter`, path-only
 *   requests without a client `baseURL` are materialized as `http://localhost/...`;
 *   browser adapters fall back to `window.location`, and the Node adapter requires
 *   absolute URLs.
 * - `bodyContainsKeys`: supports dot paths (e.g. `data.results`). Each segment in
 *   the path must resolve to a plain object for traversal to continue — the final
 *   value can be anything (array, string, null, etc). Array indexing is not supported.
 *   Skipped when `kind` is `'error'`. A body that is no plain object matches none; one
 *   that is has its contents read through `readBodyContents`, which answers the body
 *   itself unless the caller passes its own.
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
  kind: 'request' | 'response' | 'error',
  readBodyContents: (
    body: Record<string, unknown>,
  ) => Record<string, unknown> = bodyAsItIs,
): boolean {
  if (filter.statusCodes && context.status !== undefined) {
    if (!filter.statusCodes.includes(context.status)) {
      return false;
    }
  }

  // Checked whenever the filter names methods: `''`, or no method at all, matches none
  // rather than skipping the filter.
  if (filter.methods) {
    // Compared as the request is sent: a `'post'` is `POST`. The filter's own entries
    // were normalized when it was registered. A method that is not a string matches
    // nothing.
    const candidate: unknown = context.method;
    if (
      typeof candidate !== 'string' ||
      !filter.methods.includes(normalizeStandardMethod(candidate))
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

  // Checked whenever the filter names hosts or schemes, as `methods` is: a request whose
  // URL could not be read (`''`), or that has none, matches no host or scheme rather
  // than skipping the filter, so a host-scoped observer does not hear about other hosts.
  // Parsed only when one of them reads it, and once for every filter matched against the
  // same context - one per phase - by its URL as read then (see `parsedURLByContext`).
  const { requestURL } = context;
  const readRequestURL = (): URL | null => {
    const known = parsedURLByContext.get(context);
    if (known !== undefined && known.requestURL === requestURL) {
      return known.parsed;
    }

    const parsed = safeParseURL(requestURL ?? '');
    parsedURLByContext.set(context, { requestURL, parsed });
    return parsed;
  };

  if (filter.hosts) {
    const host = checkedHostFor(readRequestURL()?.hostname ?? '');
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

  if (filter.schemes && filter.schemes.length > 0) {
    const protocol = readRequestURL()?.protocol;
    const scheme =
      protocol === 'http:' ? 'http' : protocol === 'https:' ? 'https' : null;

    if (!scheme || !filter.schemes.includes(scheme)) {
      return false;
    }
  }

  // Last, since its keys are read through `readBodyContents` - which parses a request
  // interceptor's JSON body copy (see `readRequestBodyContents`) - so a filter that cannot
  // match on the rest never reads them.
  if (
    kind !== 'error' &&
    filter.bodyContainsKeys &&
    filter.bodyContainsKeys.length > 0
  ) {
    const { body } = context;

    // A plain object, as documented: a typed array or a boxed string has index keys,
    // so `'0'` would match every binary body. Told before its contents are read, so an
    // array is never parsed.
    if (!isPlainRecord(body)) {
      return false;
    }

    const contents = readBodyContents(body);

    if (!filter.bodyContainsKeys.some((k) => hasNestedKey(contents, k))) {
      return false;
    }
  }

  return true;
}
