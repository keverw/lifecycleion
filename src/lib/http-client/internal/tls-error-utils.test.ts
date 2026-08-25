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

describe('isTLSCertificateError cause handling', () => {
  test('classifies a wrapped cause, as Node reports it from fetch', () => {
    // Node rejects with `TypeError: fetch failed` and hangs the real error off
    // `cause`; Bun puts the code on the error itself.
    const wrapper = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    wrapper.cause = makeError(
      'unable to verify the first certificate',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    );

    expect(isTLSCertificateError(wrapper)).toBe(true);
  });

  test('terminates on a self-referential cause', () => {
    const looping = makeError('boom') as Error & { cause?: unknown };
    looping.cause = looping;

    // `cause` is library- or attacker-controlled, so a walk would hang or
    // overflow here instead of returning a plain transport error.
    expect(isTLSCertificateError(looping)).toBe(false);
  });

  test('terminates on a cause cycle between two errors', () => {
    const first = makeError('first') as Error & { cause?: unknown };
    const second = makeError('second') as Error & { cause?: unknown };
    first.cause = second;
    second.cause = first;

    expect(isTLSCertificateError(first)).toBe(false);
  });

  test('does not look past a single cause link', () => {
    const inner = makeError('bad cert', 'CERT_HAS_EXPIRED');
    const middle = makeError('middle') as Error & { cause?: unknown };
    const outer = makeError('outer') as Error & { cause?: unknown };
    middle.cause = inner;
    outer.cause = middle;

    // One link is what both runtimes need; going deeper is what makes cycles
    // reachable, so nesting beyond that is deliberately not classified.
    expect(isTLSCertificateError(middle)).toBe(true);
    expect(isTLSCertificateError(outer)).toBe(false);
  });

  test('survives a throwing cause getter', () => {
    const hostile = new Error('boom');

    Object.defineProperty(hostile, 'cause', {
      get(): never {
        throw new Error('hostile cause getter');
      },
      configurable: true,
    });

    // This runs inside adapter error handling, so an escaping throw would
    // replace a normalized transport response with the getter's own error.
    expect(() => isTLSCertificateError(hostile)).not.toThrow();
    expect(isTLSCertificateError(hostile)).toBe(false);
  });

  test('still classifies the error itself when its cause getter throws', () => {
    const hostile = makeError('bad cert', 'CERT_HAS_EXPIRED');

    Object.defineProperty(hostile, 'cause', {
      get(): never {
        throw new Error('hostile cause getter');
      },
      configurable: true,
    });

    expect(isTLSCertificateError(hostile)).toBe(true);
  });

  test('survives a cause whose own fields throw', () => {
    const hostileCause = new Error('inner');

    for (const field of ['code', 'message']) {
      Object.defineProperty(hostileCause, field, {
        get(): never {
          throw new Error(`hostile ${field} getter`);
        },
        configurable: true,
      });
    }

    const wrapper = new TypeError('fetch failed') as TypeError & {
      cause?: unknown;
    };
    wrapper.cause = hostileCause;

    // Guarding the `cause` read alone is not enough — the error it returns is
    // just as untrusted, and its fields are read next.
    expect(() => isTLSCertificateError(wrapper)).not.toThrow();
    expect(isTLSCertificateError(wrapper)).toBe(false);
  });

  test('survives an outer error whose own fields throw', () => {
    const hostile = new Error('outer');

    for (const field of ['code', 'message']) {
      Object.defineProperty(hostile, field, {
        get(): never {
          throw new Error(`hostile ${field} getter`);
        },
        configurable: true,
      });
    }

    expect(() => isTLSCertificateError(hostile)).not.toThrow();
    expect(isTLSCertificateError(hostile)).toBe(false);
  });

  test('classifies a valid cause even when the outer fields throw', () => {
    const wrapper = new Error('outer');

    Object.defineProperty(wrapper, 'message', {
      get(): never {
        throw new Error('hostile message getter');
      },
      configurable: true,
    });

    Object.defineProperty(wrapper, 'cause', {
      value: makeError('bad cert', 'CERT_HAS_EXPIRED'),
      configurable: true,
    });

    // Degrading must not mean giving up: an unreadable field is skipped, not
    // treated as a verdict.
    expect(isTLSCertificateError(wrapper)).toBe(true);
  });

  test('ignores a non-Error cause', () => {
    const withStringCause = makeError('boom') as Error & { cause?: unknown };
    withStringCause.cause = 'CERT_HAS_EXPIRED';

    expect(isTLSCertificateError(withStringCause)).toBe(false);
  });
});
