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

/**
 * Best-effort classification for TLS certificate failures that should be
 * treated as non-retryable transport errors by NodeAdapter.
 */
export function isTLSCertificateError(error: Error): boolean {
  if (isTLSCertificateErrorSelf(error)) {
    return true;
  }

  // `fetch` reports a TLS failure differently depending on the runtime: Bun puts
  // the OpenSSL code on the rejected error itself, while Node wraps it as
  // `TypeError: fetch failed` and hangs the real error off `cause`. Checking the
  // error and exactly one cause link covers both without the callers needing to
  // know which they are on.
  //
  // Exactly one link, not a walk: `cause` is attacker- or library-controlled and
  // may point back at its own error, so recursing would hang or overflow instead
  // of returning a transport error. Nothing in either runtime nests deeper.
  //
  // In a browser there is nothing to follow — a TLS failure surfaces as an
  // opaque `TypeError` with no code and no cause — so this stays a server-side
  // classification.
  const cause = readMember(error, 'cause');

  return cause instanceof Error ? isTLSCertificateErrorSelf(cause) : false;
}

/**
 * Classify a single error, without consulting its `cause`.
 *
 * Every field is read through {@link readMember}. The error is whatever a
 * runtime, a library, or a caller's mocked `fetch` rejected with, so its
 * accessors are not this module's to rely on — and see {@link readMember} for
 * what an escaping throw would cost here.
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
  if (code.includes('CRL')) {
    return true;
  }

  if (
    (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) &&
    code.includes('CERT')
  ) {
    return true;
  }

  const message = readMember(error, 'message');

  return typeof message === 'string'
    ? /certificate|self signed|unable to verify|altname/i.test(message)
    : false;
}

/**
 * Read a field off an error without trusting it.
 *
 * Reading a property runs its getter, and a getter can throw. This classifier
 * runs inside adapter error handling — FetchAdapter's catch, and NodeAdapter's
 * `error` listener — where an escaping throw would replace a normalized
 * `status: 0` transport response with the getter's own error, or surface as an
 * unhandled one. Unreadable is treated as absent.
 *
 * Applied to every field rather than only to `cause`: the outer error is no more
 * this module's own than the one hanging off it.
 */
function readMember(error: object, key: string): unknown {
  try {
    return (error as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
