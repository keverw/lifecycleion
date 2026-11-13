import { BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES } from '../consts';
import { asciiLowercase, asciiUppercase } from '../../internal/ascii-text';

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
