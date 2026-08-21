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
  const code = (error as NodeJS.ErrnoException).code ?? '';

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

  return /certificate|self signed|unable to verify|altname/i.test(
    error.message,
  );
}
