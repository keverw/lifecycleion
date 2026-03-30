import type { HTTPMethod } from './types';

/**
 * HTTP responses that are plausibly transient and worth retrying when a retry
 * policy is explicitly enabled.
 *
 * `status === 0` is included on purpose because browser/XHR-style adapters can
 * surface "no real HTTP response" that way when the network is unavailable or
 * the request otherwise fails before a normal status code is received.
 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  // 0: Browser/XHR-style "no response" status.
  0,

  // 408 Request Timeout
  408,
  // 429 Too Many Requests
  429,

  // 500 Internal Server Error
  500,
  // 502 Bad Gateway
  502,
  // 503 Service Unavailable
  503,
  // 504 Gateway Timeout
  504,

  // 507 Insufficient Storage
  507,
  // 509 Bandwidth Limit Exceeded (non-standard)
  509,
  // 520 Unknown Error (Cloudflare)
  520,
  // 521 Web Server Is Down (Cloudflare)
  521,
  // 522 Connection Timed Out (Cloudflare)
  522,
  // 523 Origin Is Unreachable (Cloudflare)
  523,
  // 524 A Timeout Occurred (Cloudflare)
  524,
  // 598 Network Read Timeout Error (non-standard)
  598,
  // 599 Network Connect Timeout Error (non-standard)
  599,
]);

export const DEFAULT_TIMEOUT_MS = 30_000;

export const DEFAULT_REQUEST_ID_HEADER = 'x-request-id';

export const DEFAULT_REQUEST_ATTEMPT_HEADER = 'x-request-attempt';

export const DEFAULT_USER_AGENT = 'lifecycleion-http-client';

export const HTTP_METHODS: ReadonlyArray<HTTPMethod> = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
];

/**
 * Exact-match request headers that browsers either forbid outright or do not
 * let this client set reliably via plain Fetch/XHR headers.
 *
 * Prefix-based rules like `proxy-*` and `sec-*` are handled in `header-utils.ts`.
 */
export const BROWSER_RESTRICTED_HEADERS: ReadonlySet<string> = new Set([
  // Encoding / CORS negotiation headers controlled by the browser.
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'access-control-request-private-network',

  // Connection-level transport headers.
  'connection',
  'content-length',
  'date',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',

  // Browser-managed request context / privacy headers.
  'cookie',
  'dnt',
  'origin',
  'referer',
  'set-cookie',
  'user-agent',
]);

export const BROWSER_RESTRICTED_HEADER_PREFIXES: ReadonlyArray<string> = [
  'proxy-',
  'sec-',
];

/**
 * Headers that can tunnel the real method through POST. Browsers block these
 * when they try to smuggle forbidden transport methods.
 */
export const BROWSER_METHOD_OVERRIDE_HEADER_NAMES: ReadonlySet<string> =
  new Set(['x-http-method', 'x-http-method-override', 'x-method-override']);

/**
 * Methods that browsers do not allow request headers to tunnel via the
 * override headers above.
 */
export const BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES: ReadonlySet<string> =
  new Set(['connect', 'trace', 'track']);

export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Redirect responses that carry a follow-up `Location` hop. `300` and `304`
 * are excluded because they do not represent an automatic redirect here.
 */
export const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([
  // 301 Moved Permanently
  301,
  // 302 Found
  302,

  // 303 See Other
  303,

  // 307 Temporary Redirect
  307,
  // 308 Permanent Redirect
  308,
]);
