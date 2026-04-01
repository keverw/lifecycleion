import {
  BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES,
  BROWSER_METHOD_OVERRIDE_HEADER_NAMES,
  BROWSER_RESTRICTED_HEADERS,
  BROWSER_RESTRICTED_HEADER_PREFIXES,
} from '../consts';

export function isBrowserRestrictedHeader(
  key: string,
  value: string | undefined,
): boolean {
  const lowerKey = key.toLowerCase();

  // Straight denylist: browsers block these header names outright.
  if (BROWSER_RESTRICTED_HEADERS.has(lowerKey)) {
    return true;
  }

  // Prefix-based denylist for browser-owned header namespaces like `sec-*`.
  if (
    BROWSER_RESTRICTED_HEADER_PREFIXES.some((prefix) =>
      lowerKey.startsWith(prefix),
    )
  ) {
    return true;
  }

  // Method-override headers are only restricted when they try to tunnel a
  // forbidden method such as TRACE/CONNECT/TRACK through an allowed verb.
  if (BROWSER_METHOD_OVERRIDE_HEADER_NAMES.has(lowerKey) && value) {
    return value
      .split(',')
      .some((method) =>
        BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES.has(
          method.trim().toLowerCase(),
        ),
      );
  }

  return false;
}

/**
 * Throws if any of the given headers are browser-restricted.
 * Used by Fetch and XHR adapters to fail fast during development.
 */
export function assertNoBrowserRestrictedHeaders(
  headers: Record<string, string | string[]>,
  adapterName: string,
): void {
  for (const [key, value] of Object.entries(headers)) {
    if (
      isBrowserRestrictedHeader(
        key,
        Array.isArray(value) ? value.join(', ') : value,
      )
    ) {
      throw new Error(
        `[${adapterName}] Cannot set browser-restricted header "${key}". ` +
          `Browsers silently ignore this header — remove it to avoid subtle bugs.`,
      );
    }
  }
}

/**
 * Returns true if the content-type indicates a JSON body.
 */
export function isJSONContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  const lower = contentType.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json');
}

/**
 * Returns true if the content-type indicates a text body.
 */
export function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.toLowerCase().includes('text/');
}
