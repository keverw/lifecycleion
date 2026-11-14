import { BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES } from '../consts';
import {
  asciiLowercase,
  asciiUppercase,
  trimHTTPWhitespace,
} from '../../internal/ascii-text';
import { safeParseURL } from '../../domain-utils/domain-utils';

/**
 * The refusals `HTTPClient` and the browser adapters make of a request their transport
 * cannot send as asked, worded once: the client refuses one up front, before an
 * attempt, and an adapter driven directly refuses it again. Each caller decides when a
 * rule applies - the adapter, the runtime, whether the body is one - and how it marks
 * its error. A `CONNECT` the client refuses as an invalid method, before this, and an
 * adapter by `connectRefusal`.
 */

/** Whether `method` is one the Fetch Standard forbids: CONNECT, TRACE or TRACK. */
export function isForbiddenBrowserMethod(method: string): boolean {
  return BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES.has(asciiLowercase(method));
}

/** The refusal of a CONNECT, TRACE or TRACK request, by the adapter it was meant for. */
export function forbiddenMethodMessage(
  adapterName: string,
  method: string,
): string {
  return `[${adapterName}] Cannot send a ${method} request: the Fetch Standard forbids the CONNECT, TRACE and TRACK methods, so ${adapterName} does not send them.`;
}

/** Whether `method` is GET or HEAD, which `fetch` refuses and XHR sends without a body. */
export function isBodilessMethod(method: string): boolean {
  const upper = asciiUppercase(method);
  return upper === 'GET' || upper === 'HEAD';
}

/** The refusal of a GET or HEAD request with a body, by the adapter it was meant for. */
export function bodyOnBodilessMethodMessage(
  adapter: 'fetch' | 'xhr',
  method: string,
): string {
  return adapter === 'fetch'
    ? `[FetchAdapter] Cannot send a ${method} request with a body: fetch refuses one. Use NodeAdapter, or send the body with POST.`
    : `[XHRAdapter] Cannot send a ${method} request with a body: XMLHttpRequest drops it. Send the body with POST.`;
}

/**
 * The ports the Fetch Standard's "bad port" list blocks
 * (https://fetch.spec.whatwg.org/#port-blocking), as Node's undici and browsers block
 * them, for `fetch` and XHR alike.
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<string> = new Set(
  (
    '1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 ' +
    '110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 ' +
    '530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 ' +
    '4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080'
  ).split(' '),
);

/**
 * The port `url` (an absolute http(s) URL) names when the Fetch Standard blocks it, and
 * `undefined` otherwise: a default port is never blocked, and a `URL` leaves it out.
 */
export function fetchBlockedPort(url: string): string | undefined {
  const port = safeParseURL(url)?.port ?? '';
  return FETCH_BLOCKED_PORTS.has(port) ? port : undefined;
}

/** The refusal of a request to a port the Fetch Standard blocks, by its adapter. */
export function blockedPortMessage(adapterName: string, port: string): string {
  return `[${adapterName}] The Fetch Standard blocks port ${port}, so ${adapterName} does not send to it.`;
}

/**
 * Request headers `fetch` refuses whatever their value: the Fetch Standard forbids them,
 * and Node's undici refuses each at dispatch, since it frames and keeps connections
 * itself, switches no protocols and waits for no `100 Continue`. By lowercase name, each
 * to what a refusal calls it.
 */
const FETCH_REFUSED_HEADERS: ReadonlyMap<string, string> = new Map([
  ['transfer-encoding', 'a Transfer-Encoding header'],
  ['keep-alive', 'a Keep-Alive header'],
  ['upgrade', 'an Upgrade header'],
  ['expect', 'an Expect header'],
]);

/**
 * What a refusal names of a header in `headers` that `fetch` refuses - one of
 * {@link FETCH_REFUSED_HEADERS}, or a `Connection` other than `close` or `keep-alive`, the
 * two undici takes - or `undefined`. Asked of the headers alone, on every runtime.
 * Bun's `fetch` sends them, a `Transfer-Encoding` beside the `Content-Length` it frames
 * the body with (RFC 9112 6.1 forbids both on one message). A browser's drops them, and
 * a `Connection` of any value, though only one other than `close` or `keep-alive` is
 * refused here, as undici refuses it. Node's refusing one at dispatch anyway is still
 * read as the refusal it is, for a header this list does not know of.
 */
export function fetchRefusedHeader(
  headers: Record<string, string | string[]>,
): string | undefined {
  /** Every `Connection` value, whatever the case of its name, as `fetch` merges them. */
  const connection: string[] = [];

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = asciiLowercase(name);
    const refused = FETCH_REFUSED_HEADERS.get(lowerName);
    if (refused !== undefined) {
      return refused;
    }

    if (lowerName === 'connection') {
      connection.push(...(Array.isArray(value) ? value : [value]));
    }
  }

  // As `fetch` hands it on: each value trimmed, the values joined.
  const text = asciiLowercase(
    connection.map((part) => trimHTTPWhitespace(part)).join(', '),
  );

  return connection.length === 0 || text === 'close' || text === 'keep-alive'
    ? undefined
    : 'a Connection header other than close or keep-alive';
}

/** The refusal of a request carrying a header `fetch` refuses (see {@link fetchRefusedHeader}). */
export function fetchRefusedHeaderMessage(
  adapterName: string,
  refusedHeader: string,
): string {
  return `[${adapterName}] Cannot send a request with ${refusedHeader}: the Fetch Standard forbids one, so ${adapterName} does not send it.`;
}

/**
 * Request headers NodeAdapter refuses by name, each with why, for it and for MockAdapter,
 * which mirrors it: both frame the body themselves with a `Content-Length`, switch no
 * protocols and wait for no `100 Continue`.
 */
const FRAMING_REFUSED_HEADERS: ReadonlyMap<string, string> = new Map([
  [
    'transfer-encoding',
    'frames request bodies itself; a Transfer-Encoding request header is not supported',
  ],
  [
    'upgrade',
    'does not switch protocols; an Upgrade request header is not supported',
  ],
  [
    'expect',
    'does not wait for 100 Continue; an Expect request header is not supported',
  ],
]);

/**
 * The refusal of the first header in `headerNames` that NodeAdapter and MockAdapter
 * refuse (see {@link FRAMING_REFUSED_HEADERS}), by the adapter named, or `undefined`.
 * Names are read whatever their case.
 */
export function framingRefusedHeaderMessage(
  adapterName: string,
  headerNames: Iterable<string>,
): string | undefined {
  for (const name of headerNames) {
    const reason = FRAMING_REFUSED_HEADERS.get(asciiLowercase(name));
    if (reason !== undefined) {
      return `${adapterName} ${reason}`;
    }
  }

  return undefined;
}
