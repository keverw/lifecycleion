// The shared brand check, for the reason the adapters use it: a local `instanceof` misses
// an error built in another realm - a `vm` context, an iframe - and the value tested here
// is exactly that case. Node wraps a TLS failure as `TypeError: fetch failed` and hangs
// the real error off `cause`, so a cross-realm cause would fail a local check and its
// certificate error would be classified as a generic transport failure and retried,
// though a rejected certificate fails identically every time.
import { isErrorValue } from '../../to-error';
// Every field is read through this, since the error is whatever a runtime, a library, or
// a caller's mocked `fetch` rejected with. This classifier runs inside adapter error
// handling, where a throwing getter would replace a normalized `status: 0` transport
// response with the getter's own error, so unreadable is treated as absent on every
// field rather than only on `cause`.
import { readMember } from '../../internal/read-member';

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
  'CERT_UNTRUSTED',
  'HOSTNAME_MISMATCH',
  'INVALID_CA',
  'PERMITTED_VIOLATION',
  'EXCLUDED_VIOLATION',
  'UNHANDLED_CRITICAL_EXTENSION',
  'PATH_LENGTH_EXCEEDED',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'INVALID_PURPOSE',
  'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR',
  'KEYUSAGE_NO_CERTSIGN',
  'SUBJECT_ISSUER_MISMATCH',
  'AKID_SKID_MISMATCH',
  'AKID_ISSUER_SERIAL_MISMATCH',
]);

/** `CERT`, `CRL` or `CRLS` as an underscore-delimited token, anywhere in a code. */
const CERT_OR_CRL_CODE_PATTERN = /(?:^|_)(?:CERT|CRLS?)(?:_|$)/;

/**
 * The wording of a certificate failure, from OpenSSL, Go and rustls, for a runtime that
 * reports one with no code. Phrases rather than the bare word, as a message may name
 * anything else that has `certificate` in it: a host, a path, a URL, a service, or an API's
 * own answer. A failure in other words reads as a network failure, and is retried.
 */
const CERTIFICATE_FAILURE_MESSAGE_PATTERN =
  /\bcertificate(?:_verify|\s(?:verif|signed by|signature|has expired|expired|is not yet valid|not yet valid|is valid for|key too weak|for this server|revoked|not trusted|untrusted|rejected|required|unknown|chain|is invalid))|\b(?:bad|invalid|expired|revoked|untrusted|unsupported|unknown|peer|issuer|non-CA|proxy)\scertificate|does not match certificate|does not include certificate signing|self[\s-]signed\scertificate|unable to verify (?:the first certificate|(?:the )?leaf signature)|subtree violation|unhandled critical (?:crl )?extension|path length constraint|decode issuer public key|issuer public key algorithm mismatch|alert unknown ca/i;

/**
 * Best-effort classification for TLS certificate failures that should be
 * treated as non-retryable transport errors, by NodeAdapter and FetchAdapter.
 *
 * Bun puts the OpenSSL code on the rejected error itself; Node wraps it as
 * `TypeError: fetch failed` and hangs the real error off `cause`. Checking the
 * error plus exactly one cause link covers both.
 *
 * One link, not a walk: `cause` is library-controlled and may point back at its
 * own error, and nothing in either runtime nests deeper. A browser has nothing
 * to follow, so this stays a server-side classification.
 */
export function isTLSCertificateError(error: Error): boolean {
  const code = readMember(error, 'code');
  const cause = readMember(error, 'cause');
  // Any object by its code: a function-style error (node-fetch 2's `FetchError`, built
  // with `Error.call(this)`) has no error slot, so `toError` wraps it and hangs it here,
  // code and all.
  const causeCode =
    typeof cause === 'object' && cause !== null
      ? readMember(cause, 'code')
      : undefined;

  if (isCertificateCode(code) || isCertificateCode(causeCode)) {
    return true;
  }

  // Any other code says what failed, and a wrapper's words do not outrank it.
  if (!mayBeTLSFailureCode(code) || !mayBeTLSFailureCode(causeCode)) {
    return false;
  }

  // A cause's message only if it is an error: a `fetch` wrapper may reject with an API's
  // JSON (`{ message: 'No certificate for this account' }`), and a function-style error's
  // text is on the wrapper already.
  return (
    readsAsCertificateFailure(error) ||
    (isErrorValue(cause) && readsAsCertificateFailure(cause))
  );
}

/**
 * Whether a code leaves the message to decide: none at all, or the ones a TLS alert or
 * handshake failure comes with, whose certificate failures only the text names. And
 * `UNSPECIFIED`, Node's code for a verification failure it has no name for (`permitted
 * subtree violation`).
 */
function mayBeTLSFailureCode(code: unknown): boolean {
  return (
    typeof code !== 'string' ||
    code === '' ||
    code === 'EPROTO' ||
    code === 'UNSPECIFIED' ||
    code.startsWith('ERR_SSL_')
  );
}

/** Whether an error's message words a certificate failure. */
function readsAsCertificateFailure(error: object): boolean {
  const message = readMember(error, 'message');

  return (
    typeof message === 'string' &&
    CERTIFICATE_FAILURE_MESSAGE_PATTERN.test(message)
  );
}

/** Whether `code` names a certificate failure, by the code alone. */
function isCertificateCode(code: unknown): boolean {
  if (typeof code !== 'string') {
    return false;
  }

  if (CERT_ERROR_CODES.has(code)) {
    return true;
  }

  // Every certificate and CRL verification code, by property rather than by name.
  // OpenSSL exposes dozens (UNABLE_TO_GET_ISSUER_CERT, CERT_CHAIN_TOO_LONG,
  // UNABLE_TO_GET_CRL, KEYUSAGE_NO_CRL_SIGN, DIFFERENT_CRL_SCOPE, ...), and a list
  // written by hand misses whichever of them it leaves out.
  //
  // Matched as an underscore-delimited token, not a substring, which closes the
  // one word that shares the prefix by accident: CRLF. No code uses it today, but
  // header and framing errors are where one would be minted, and those are
  // connection problems. The plural is allowed for NO_CRLS_INCLUDED.
  if (CERT_OR_CRL_CODE_PATTERN.test(code)) {
    return true;
  }

  // `UNKNOWN_CA` too: the server's alert that it does not trust the client certificate's
  // issuer (`ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`), the mTLS refusal the other certificate
  // alerts already are - it fails the same way every time.
  if (
    (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) &&
    (code.includes('CERT') || code.includes('UNKNOWN_CA'))
  ) {
    return true;
  }

  return false;
}
