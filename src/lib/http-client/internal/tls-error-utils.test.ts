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

  test('does not misclassify non-certificate transport failures', () => {
    expect(
      isTLSCertificateError(makeError('connect ECONNREFUSED 127.0.0.1:443')),
    ).toBe(false);
  });
});
