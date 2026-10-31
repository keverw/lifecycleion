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
]);

/** `CRL` or `CRLS` as an underscore-delimited token, anywhere in a code. */
const CRL_CODE_PATTERN = /(?:^|_)CRLS?(?:_|$)/;

/**
 * Node system error codes that name a DNS or socket failure, so whatever the
 * message says, the connection is what failed. Consulted only to suppress the
 * message fallback.
 *
 * Deliberately not NodeAdapter's `PRE_CONNECTION_ERROR_CODES`, which answers a
 * different question (did any bytes reach the server?) and must stay
 * conservative in the opposite direction.
 */
const TRANSPORT_ERROR_CODES = new Set([
  'ENOTFOUND',
  // A resolver's own codes, for one reported with no `syscall`.
  'ENODATA',
  'ESERVFAIL',
  'EREFUSED',
  'ETIMEOUT',
  'EFORMERR',
  'EBADRESP',
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
  // A `socketPath` that is missing, not permitted or not a socket: the message names the
  // path, and `sock/certificates/agent.sock` would match /certificate/ on it alone.
  'ENOENT',
  'EACCES',
  'EINVAL',
  'ENOTSOCK',
]);

/**
 * Node's built-in `fetch` is backed by Undici, which uses its own `UND_ERR_*`
 * namespace for transport and protocol failures instead of the system codes
 * above. Keep the namespaces separate so this does not imply NodeAdapter —
 * which uses `node:http` / `node:https` — emits Undici errors too.
 */
const UNDICI_TRANSPORT_ERROR_PREFIX = 'UND_ERR_';

/**
 * Every getaddrinfo failure (`EAI_AGAIN`, `EAI_FAIL`, `EAI_SYSTEM`, ...), whatever the
 * message says about the host (`certificates.internal.corp`). Node reports `EAI_NONAME` and
 * `EAI_NODATA` as `ENOTFOUND`.
 */
const GETADDRINFO_ERROR_PREFIX = 'EAI_';

/**
 * Whether the system call that failed resolves a name or opens the socket, which is before
 * any certificate exists: a code of any kind, `EBADNAME` from `queryA` or `ENOTDIR` from a
 * `socketPath`'s `connect`, says nothing of one. A TLS failure comes from `read` or `write`
 * (`EPROTO`), and stays with the message.
 */
function isBeforeTLS(syscall: unknown): boolean {
  return (
    typeof syscall === 'string' &&
    (syscall === 'connect' ||
      syscall === 'getaddrinfo' ||
      syscall.startsWith('query'))
  );
}

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
  // ERROR_IN_CRL_NEXT_UPDATE_FIELD, DIFFERENT_CRL_SCOPE, …), and a list written
  // by hand misses whichever of them it leaves out. They are all
  // revocation-check failures, and enumerating them means being wrong
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

  // `UNKNOWN_CA` too: the server's alert that it does not trust the client certificate's
  // issuer (`ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`), the mTLS refusal the other certificate
  // alerts already are - it fails the same way every time.
  if (
    (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) &&
    (code.includes('CERT') || code.includes('UNKNOWN_CA'))
  ) {
    return true;
  }

  // A code that names a transport failure is authoritative, so the message is
  // never consulted for one. The message test below runs against a runtime-built
  // string with the hostname interpolated in, so `getaddrinfo EAI_AGAIN
  // certificates.internal.corp` matches /certificate/ on the host name alone —
  // and any deployment calling a `certificates.*` host would have every DNS
  // blip resolve as a permanent 495 with `isRetryable: false`.
  //
  // Only the fallback is suppressed; the code checks above still run first.
  if (
    TRANSPORT_ERROR_CODES.has(code) ||
    code.startsWith(GETADDRINFO_ERROR_PREFIX) ||
    code.startsWith(UNDICI_TRANSPORT_ERROR_PREFIX) ||
    isBeforeTLS(readMember(error, 'syscall'))
  ) {
    return false;
  }

  // Reached with no code, or a code the checks above do not recognize — which is
  // why the fallback cannot be dropped for any error carrying one. OpenSSL has
  // more permanent verification failures than the set names (UNABLE_TO_GET_ISSUER_CERT,
  // CERT_CHAIN_TOO_LONG, …), and a runtime may report one with no code at all.
  const message = readMember(error, 'message');

  return typeof message === 'string'
    ? /certificate|self signed|unable to verify|altname|subtree violation|critical extension|path length constraint|issuer public key|alert unknown ca/i.test(
        message,
      )
    : false;
}
