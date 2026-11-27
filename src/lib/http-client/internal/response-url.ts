import { parseURL } from '../../domain-utils/helpers';
import { readUnknownMember } from '../../internal/read-member';
import {
  findBrowserPage,
  stripURLCredentials,
  type BrowserPage,
} from '../utils';
import { asciiUppercase } from '../../internal/ascii-text';
import { isLoopbackHost } from './loopback-host';

/** `text` parsed as an absolute URL, or `null` for one that does not parse. */
export function parsedOrNull(text: string): URL | null {
  try {
    return parseURL(text);
  } catch {
    return null;
  }
}

/**
 * The origin of the page or worker running the request, which a browser holds a response
 * to for CORS. Its `location`'s, which a page's script cannot replace, except where the
 * global's own `origin` is the one that differs by right: `'null'` in a sandboxed frame,
 * which matches none, or the creator's origin in a document whose URL names none
 * (`about:blank`, `about:srcdoc`), whose `location` reads `'null'`. Any other `origin`
 * that differs from the `location`'s is not taken: the global's `origin` is
 * replaceable, so a classic script's `var origin = '…'` rewrites it, and read as the
 * page's it would make an `http:` page look `https:` (see `isOnHTTPSPage`). A `location`
 * that names no origin, as a shim's may not, leaves the global's.
 *
 * The page is the scope whose `location` a relative request URL falls back to when the
 * document has no base URL of its own (see `findBrowserPage`); a `<base href>` can
 * resolve the URL elsewhere, but the origin is still that page's. `undefined` where there
 * is no page, or it names no origin, as outside a browser.
 */
export function readPageOrigin(
  page: BrowserPage | undefined = findBrowserPage(),
): string | undefined {
  if (page === undefined) {
    return undefined;
  }

  const scopeOrigin = readUnknownMember(page.scope, 'origin');
  const locationOrigin = readUnknownMember(page.location, 'origin');

  if (typeof locationOrigin !== 'string') {
    return typeof scopeOrigin === 'string' ? scopeOrigin : undefined;
  }

  return typeof scopeOrigin === 'string' &&
    (scopeOrigin === 'null' || locationOrigin === 'null')
    ? scopeOrigin
    : locationOrigin;
}

/**
 * How `responseURL` stands to `dispatchedURL`, the absolute URL `send` opened, compared
 * as browsers evaluate request destinations:
 * - userinfo (omitted by `responseURL`) and hash fragments (not sent over HTTP) are
 *   stripped
 * - URL normalization makes equivalent forms equal (default ports, dot segments,
 *   encoding normalization, etc.), and so does RFC 3986's for what the parser leaves
 *   spelled apart (see `equivalentHref`): a percent-escape's hex in either case, an
 *   unreserved character escaped or not, and an empty query (`/a?`) as none. Any other
 *   difference - `|` against `%7C`, which the RFC does not make equal - stays one
 *
 * The same URL is `'same'`. On an `https:` page, an `http:` URL answered from its own
 * `https:` form - the scheme changed, a default port staying the default and any other
 * kept - is `'upgraded'`, with that form as `upgradedURL`: a browser blocks a plain
 * `http:` request from such a page as mixed content, so one that was answered there was
 * upgraded before it was sent - by the page's `upgrade-insecure-requests` policy, or
 * HSTS - and no server redirected it, as FetchAdapter's `fetch` reports it. Not for a
 * host of this machine's (see `isLoopbackHost`), which a browser lets through over
 * `http:`, so a local proxy's redirect to the same URL over `https:` - a `301` that
 * turned a `POST` into a `GET` among them - is not mistaken for an upgrade. On an
 * `http:` page an upgrade looks exactly like a server's redirect to `https:`, and is
 * reported as one. Anything else is `'redirected'`, a `responseURL` that does not parse
 * among them, since it cannot name `dispatchedURL`.
 */
export function compareResponseURL(
  responseURL: string,
  dispatchedURL: string,
): { kind: 'same' | 'redirected' } | { kind: 'upgraded'; upgradedURL: string } {
  const normalizedResponse = parsedOrNull(responseURL);

  if (normalizedResponse === null) {
    return { kind: 'redirected' };
  }

  normalizedResponse.hash = '';
  dropEmptyQuery(normalizedResponse);
  const responseHref = equivalentHref(
    stripURLCredentials(normalizedResponse.href),
  );

  const request = parseURL(dispatchedURL);
  // Taken from the serialized URL, not `hash`, which reads `''` for an empty fragment
  // (`/a#`) as for none: a `Location` inherits an empty one too, as Fetch has it.
  const fragmentIndex = request.href.indexOf('#');
  const fragment =
    fragmentIndex === -1 ? '' : request.href.slice(fragmentIndex);
  request.hash = '';
  dropEmptyQuery(request);

  if (responseHref === equivalentHref(stripURLCredentials(request.href))) {
    return { kind: 'same' };
  }

  if (
    request.protocol !== 'http:' ||
    isLoopbackHost(request.hostname) ||
    !isOnHTTPSPage()
  ) {
    return { kind: 'redirected' };
  }

  request.protocol = 'https:';

  if (responseHref !== equivalentHref(stripURLCredentials(request.href))) {
    return { kind: 'redirected' };
  }

  return { kind: 'upgraded', upgradedURL: `${request.href}${fragment}` };
}

/** RFC 3986's unreserved characters (section 2.3), which escaping does not change. */
const UNRESERVED_CHARACTER = /^[A-Za-z0-9\-._~]$/;

/**
 * A serialized URL with no fragment, spelled as RFC 3986's normalization (section 6.2.2)
 * spells it where the URL parser leaves two spellings of one resource apart: each
 * percent-escape's hex in uppercase, and an escaped unreserved character as itself - the
 * spellings a networking layer that re-serializes the URL may answer with. An empty
 * query is dropped from the URL first (see `dropEmptyQuery`).
 */
function equivalentHref(href: string): string {
  return href.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const character = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return UNRESERVED_CHARACTER.test(character)
      ? character
      : asciiUppercase(escape);
  });
}

/**
 * Drops a query with nothing in it (`/a?`), read off the parsed URL: one that ends in a
 * `?` of its own (`/a?q?`) is not empty, and keeps it.
 */
function dropEmptyQuery(url: URL): void {
  if (url.search === '') {
    url.search = '';
  }
}

/**
 * Whether the page or worker running the request is an `https:` one, whose `http:`
 * requests a browser blocks as mixed content: its origin (see `readPageOrigin`), or - for
 * a page whose origin is `'null'`, as a sandboxed frame's is - its `location`.
 */
export function isOnHTTPSPage(): boolean {
  const page = findBrowserPage();

  return (
    page !== undefined &&
    (readPageOrigin(page)?.startsWith('https:') === true ||
      page.href.startsWith('https:'))
  );
}
