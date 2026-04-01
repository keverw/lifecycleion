const CERT_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
  'ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
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
