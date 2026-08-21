import { describe, expect, test } from 'bun:test';
import { isTLSCertificateError } from './tls-error-utils';

function makeError(message: string, code?: string): Error {
  const error = new Error(message) as Error & { code?: string };

  if (code) {
    error.code = code;
  }

  return error;
}

describe('isTLSCertificateError', () => {
  test('matches known certificate error codes', () => {
    expect(
      isTLSCertificateError(
        makeError(
          'certificate required',
          'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
        ),
      ),
    ).toBe(true);
  });

  test('matches broader TLS/SSL CERT-prefixed codes', () => {
    expect(
      isTLSCertificateError(
        makeError('peer cert rejected', 'ERR_SSL_CERTIFICATE_VERIFY_FAILED'),
      ),
    ).toBe(true);
  });

  test('falls back to certificate wording in the message', () => {
    expect(
      isTLSCertificateError(
        makeError('self signed certificate in certificate chain'),
      ),
    ).toBe(true);
  });

  test('classifies every CRL verification code OpenSSL exposes', () => {
    // Codes and messages from Node's X.509 error list. An earlier version
    // named six of these by hand and missed the other six, which is the same
    // enumeration mistake in miniature — so the classifier now asks whether
    // the code concerns a CRL rather than keeping a list. Note how few of
    // these the message fallback would catch: 'CRL has expired' and "format
    // error in CRL's lastUpdate field" contain none of the words it looks for.
    const crlFailures: Array<[string, string]> = [
      ['unable to get certificate CRL', 'UNABLE_TO_GET_CRL'],
      ["unable to decrypt CRL's signature", 'UNABLE_TO_DECRYPT_CRL_SIGNATURE'],
      ['CRL signature failure', 'CRL_SIGNATURE_FAILURE'],
      ['CRL is not yet valid', 'CRL_NOT_YET_VALID'],
      ['CRL has expired', 'CRL_HAS_EXPIRED'],
      [
        "format error in CRL's lastUpdate field",
        'ERROR_IN_CRL_LAST_UPDATE_FIELD',
      ],
      [
        "format error in CRL's nextUpdate field",
        'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
      ],
      ['key usage does not include CRL signing', 'KEYUSAGE_NO_CRL_SIGN'],
      ['unhandled critical CRL extension', 'UNHANDLED_CRITICAL_CRL_EXTENSION'],
      ['unable to get CRL issuer certificate', 'UNABLE_TO_GET_CRL_ISSUER'],
      ['different CRL scope', 'DIFFERENT_CRL_SCOPE'],
      ['CRL path validation error', 'CRL_PATH_VALIDATION_ERROR'],
    ];

    for (const [message, code] of crlFailures) {
      expect(isTLSCertificateError(makeError(message, code))).toBe(true);
    }
  });

  test('a revoked certificate is still classified', () => {
    // CERT_REVOKED has no 'CRL' in its code, so it is the one revocation
    // outcome the property rule above does not cover.
    expect(
      isTLSCertificateError(makeError('certificate revoked', 'CERT_REVOKED')),
    ).toBe(true);
  });

  test('does not misclassify non-certificate transport failures', () => {
    expect(
      isTLSCertificateError(makeError('connect ECONNREFUSED 127.0.0.1:443')),
    ).toBe(false);
  });
});
