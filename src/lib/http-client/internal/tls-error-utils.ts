const CERT_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
  'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_REVOKED',
]);

/** `CRL` or `CRLS` as an underscore-delimited token, anywhere in a code. */
const CRL_CODE_PATTERN = /(?:^|_)CRLS?(?:_|$)/;

/**
 * Codes that name a DNS or socket failure, so whatever the message says, the
 * connection is what failed. Consulted only to suppress the message fallback.
 *
 * Deliberately not NodeAdapter's `PRE_CONNECTION_ERROR_CODES`, which answers a
 * different question (did any bytes reach the server?) and must stay
 * conservative in the opposite direction.
 */
const TRANSPORT_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
]);

/**
 * Best-effort classification for TLS certificate failures that should be
 * treated as non-retryable transport errors by NodeAdapter.
 */
export function isTLSCertificateError(error: Error): boolean {
  if (isTLSCertificateErrorSelf(error)) {
    return true;
  }

  // Bun puts the OpenSSL code on the rejected error itself; Node wraps it as
  // `TypeError: fetch failed` and hangs the real error off `cause`. Checking the
  // error plus exactly one cause link covers both.
  //
  // One link, not a walk: `cause` is library-controlled and may point back at its
  // own error, and nothing in either runtime nests deeper. A browser has nothing
  // to follow, so this stays a server-side classification.
  const cause = readMember(error, 'cause');

  return isErrorValue(cause) ? isTLSCertificateErrorSelf(cause) : false;
}

/** Check Error identity without trusting a Proxy's prototype trap. */
function isErrorValue(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

/**
 * Classify a single error, without consulting its `cause`. Every field is read
 * through {@link readMember}, since the error is whatever a runtime, a library,
 * or a caller's mocked `fetch` rejected with.
 */
function isTLSCertificateErrorSelf(error: Error): boolean {
  const rawCode = readMember(error, 'code');
  const code = typeof rawCode === 'string' ? rawCode : '';

  if (CERT_ERROR_CODES.has(code)) {
    return true;
  }

  // Every CRL-related verification code, by property rather than by name.
  // OpenSSL exposes twelve of them (UNABLE_TO_GET_CRL,
  // UNABLE_TO_DECRYPT_CRL_SIGNATURE, CRL_HAS_EXPIRED, KEYUSAGE_NO_CRL_SIGN,
  // ERROR_IN_CRL_NEXT_UPDATE_FIELD, DIFFERENT_CRL_SCOPE, …) and an earlier
  // version of this listed six by hand and missed the other six. They are all
  // revocation-check failures, and enumerating them means being wrong again
  // the next time OpenSSL adds one — so ask whether the code concerns a CRL
  // instead. The message fallback below does not catch them: 'CRL has expired'
  // and "format error in CRL's lastUpdate field" contain none of the words it
  // looks for, so without this they resolve as status 0 rather than 495.
  //
  // Matched as an underscore-delimited token, not a substring, which closes the
  // one word that shares the prefix by accident: CRLF. No code uses it today, but
  // header and framing errors are where one would be minted, and those are
  // connection problems. The plural is allowed for NO_CRLS_INCLUDED.
  if (CRL_CODE_PATTERN.test(code)) {
    return true;
  }

  if (
    (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) &&
    code.includes('CERT')
  ) {
    return true;
  }

  // A code that names a transport failure is authoritative, so the message is
  // never consulted for one. The message test below runs against a runtime-built
  // string with the hostname interpolated in, so `getaddrinfo EAI_AGAIN
  // certificates.internal.corp` matches /certificate/ on the host name alone —
  // and any deployment calling a `certificates.*` host would have had every DNS
  // blip resolve as a permanent 495 with `isRetryable: false`.
  //
  // Only the fallback is suppressed; the code checks above still run first.
  if (TRANSPORT_ERROR_CODES.has(code)) {
    return false;
  }

  // Reached with no code, or a code the checks above do not recognize — which is
  // why the fallback cannot be dropped for any error carrying one. OpenSSL has
  // many more permanent verification failures (CERT_UNTRUSTED, HOSTNAME_MISMATCH,
  // UNABLE_TO_GET_ISSUER_CERT, INVALID_CA, …) that match no code rule above.
  const message = readMember(error, 'message');

  return typeof message === 'string'
    ? /certificate|self signed|unable to verify|altname/i.test(message)
    : false;
}

/**
 * Read a field off an error without trusting it.
 *
 * This classifier runs inside adapter error handling, where a throwing getter
 * would replace a normalized `status: 0` transport response with the getter's own
 * error. Unreadable is treated as absent, on every field rather than only on
 * `cause` — the outer error is no more this module's own than the nested one.
 */
function readMember(error: object, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
