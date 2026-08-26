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

  test('does not misclassify Undici transport failures', () => {
    expect(
      isTLSCertificateError(
        makeError(
          'Connect Timeout Error (attempted address: certificates.internal:443)',
          'UND_ERR_CONNECT_TIMEOUT',
        ),
      ),
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

  test('survives a cause Proxy whose prototype trap throws', () => {
    const hostileCause = new Proxy(new Error('inner'), {
      getPrototypeOf(): never {
        throw new Error('hostile prototype trap');
      },
    });
    const wrapper = new Error('fetch failed') as Error & { cause?: unknown };
    wrapper.cause = hostileCause;

    // `instanceof Error` consults [[GetPrototypeOf]], so it needs the same
    // containment as an ordinary throwing field getter.
    expect(() => isTLSCertificateError(wrapper)).not.toThrow();
    expect(isTLSCertificateError(wrapper)).toBe(false);
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

  test('classifies verification codes the code rules do not name', () => {
    // OpenSSL exposes far more verification failures than CERT_ERROR_CODES
    // lists, and none of these match any code rule: not the set, not the CRL
    // token, not the ERR_TLS_/ERR_SSL_ prefixes. The message fallback is the
    // only thing that catches them, which is exactly why it cannot be skipped
    // for every error that merely carries a code. All are permanent.
    const uncodedByRule: Array<[string, string]> = [
      ['certificate not trusted', 'CERT_UNTRUSTED'],
      ['certificate rejected', 'CERT_REJECTED'],
      ['certificate signature failure', 'CERT_SIGNATURE_FAILURE'],
      ['certificate is not yet valid', 'CERT_NOT_YET_VALID'],
      ['certificate chain too long', 'CERT_CHAIN_TOO_LONG'],
      ['unable to get issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT'],
      [
        "unable to decrypt certificate's signature",
        'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
      ],
      [
        "Hostname/IP does not match certificate's altnames",
        'HOSTNAME_MISMATCH',
      ],
      ['invalid CA certificate', 'INVALID_CA'],
    ];

    for (const [message, code] of uncodedByRule) {
      expect(isTLSCertificateError(makeError(message, code))).toBe(true);
    }
  });

  test('a transport code outranks certificate wording in its message', () => {
    // Node interpolates the hostname into these messages, so a host named
    // `certificates.*` put /certificate/ in the message of an ordinary DNS
    // blip. Classifying that as a certificate failure meant 495 with
    // isRetryable: false — a veto that holds for every method, turning the
    // most transient error there is into a permanent one.
    const transportFailures: Array<[string, string]> = [
      ['getaddrinfo EAI_AGAIN certificates.internal.corp', 'EAI_AGAIN'],
      [
        'connect ECONNREFUSED certificate-authority.internal:443',
        'ECONNREFUSED',
      ],
      ['getaddrinfo ENOTFOUND self-signed-certs.example.com', 'ENOTFOUND'],
      ['socket hang up', 'ECONNRESET'],
    ];

    for (const [message, code] of transportFailures) {
      expect(isTLSCertificateError(makeError(message, code))).toBe(false);
    }
  });

  test('a transport code on the cause does not veto a cert error on the outer', () => {
    // Each link is classified on its own, so suppressing the fallback for one
    // must not suppress it for the other.
    const wrapped = makeError('unable to verify the first certificate');

    (wrapped as Error & { cause?: unknown }).cause = makeError(
      'getaddrinfo EAI_AGAIN api.example.com',
      'EAI_AGAIN',
    );

    expect(isTLSCertificateError(wrapped)).toBe(true);
  });

  test('does not treat CRLF codes as CRL codes', () => {
    // CRL is matched as an underscore-delimited token, so the one word that
    // shares its prefix by accident cannot claim a permanent cert verdict.
    // These are framing errors — connection problems, and retryable.
    for (const code of [
      'ERR_INVALID_CRLF',
      'ERR_CRLF_EXPECTED',
      'CHARACTER_CRLF',
    ]) {
      expect(isTLSCertificateError(makeError('bad framing', code))).toBe(false);
    }

    // The plural form is still a CRL code.
    expect(
      isTLSCertificateError(makeError('no CRLs included', 'NO_CRLS_INCLUDED')),
    ).toBe(true);
  });

  test('ignores a non-Error cause', () => {
    const withStringCause = makeError('boom') as Error & { cause?: unknown };
    withStringCause.cause = 'CERT_HAS_EXPIRED';

    expect(isTLSCertificateError(withStringCause)).toBe(false);
  });
});
