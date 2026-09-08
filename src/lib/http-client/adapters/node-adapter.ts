import * as http from 'node:http';
import * as https from 'node:https';
import { urlToHttpOptions } from 'node:url';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterProgressEvent,
  AdapterType,
  WritableLike,
  StreamResponseCancel,
} from '../types';
import {
  NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
  REDIRECT_STATUS_CODES,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_FACTORY_CANCEL_KEY,
  STREAM_FACTORY_ERROR_FLAG,
} from '../consts';
import {
  generateMultipartBoundary,
  serializeMultipartFormData,
} from '../internal/multipart';
import { writeRequestBodyChunked } from '../internal/request-body-writer';
import { isTLSCertificateError } from '../internal/tls-error-utils';
import {
  materializeNodeRequestHeaders,
  normalizeNodeRequestHeaders,
} from './node-adapter-utils';
import { resolveDetectedRedirectURL } from '../utils';
// The shared coercion, not a fourth copy of it. Each adapter carried a body that
// was behaviourally identical to this one, message included, on the grounds that the
// HTTP client should not import across module boundaries - which it already does for
// `sleep`, `deep-clone` and `retry-utils`. Aliased so the call sites read unchanged.
import { toError as normalizeError } from '../../to-error';

/**
 * The absorber currently attached to a writable, if any.
 *
 * Module-level and keyed on the writable, because `streamResponse` may hand the same sink
 * to several concurrent requests: a per-request absorber let a dozen simultaneous write
 * failures attach a dozen listeners inside one turn. See `absorbPendingWritableError`.
 */
const pendingWritableErrorAbsorbers = new WeakMap<
  WritableLike,
  (error: Error) => void
>();

type StreamResponseBodyResult =
  | true
  | {
      code: 'stream_write_error' | 'stream_response_error';
      cause: Error;
    };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NodeAdapterConfig {
  /**
   * Unix domain socket path. When set, the HTTP connection routes through
   * the socket instead of TCP. The URL host in baseURL is ignored for routing
   * but is still used for the HTTP Host header — so a placeholder like
   * 'http://localhost' is required even when all traffic goes through the socket.
   *
   *   const client = new HTTPClient({
   *     adapter: new NodeAdapter({ socketPath: '/var/run/docker.sock' }),
   *     baseURL: 'http://localhost', // host ignored; only path matters
   *   });
   */
  socketPath?: string;

  /**
   * Mutual TLS credentials. When set on an https: request, the adapter
   * presents the client certificate to the server. Cert errors return
   * status 495 (non-standard but widely understood for client cert failure)
   * rather than throwing. The client treats 495 as a transport-level failure,
   * so it resolves through the failed/error path instead of response observers
   * and is NOT retryable.
   */
  mtls?: {
    cert: string | Buffer;
    key: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
  };

  /**
   * Trusted CA certificate(s) for verifying the server's TLS certificate.
   * Use this when connecting to internal services that use a private CA not
   * in the system trust store. Accepts PEM string, Buffer, or an array of
   * either. Does not require a client certificate — use `mtls` for that.
   */
  ca?: string | Buffer | Array<string | Buffer>;

  /**
   * TLS server name (SNI) to send in the handshake and verify the server
   * certificate against. Required when dialing by IP address but the server
   * cert's SAN lists a DNS name — without this, TLS verification fails because
   * the IP does not match the DNS SAN.
   *
   * Typical pattern when using a service registry:
   *   baseURL: 'https://10.0.0.5:443'  ← IP from the registry (where bytes go)
   *   servername: 'billing.internal'   ← DNS name on the cert (TLS identity)
   *
   * The Host header defaults to the baseURL hostname (the IP). If the backend
   * routes by Host, also set defaultHeaders: { host: 'billing.internal' }.
   */
  servername?: string;

  /**
   * Certificate revocation list(s), used to reject a server certificate whose
   * serial has been revoked even though its chain and hostname still check out.
   * A revoked certificate fails the handshake with `CERT_REVOKED`.
   *
   * Accepts whatever your CA tooling produced. A PEM string holding SEVERAL
   * concatenated CRLs — the format Apache's `SSLCARevocationFile`, nginx's
   * `ssl_crl` and HAProxy's `crl-file` all expect, and what `openssl ca
   * -gencrl` output is usually assembled into — is split into the array Node
   * requires. A single CRL, a DER `Buffer`, or an array you built yourself is
   * passed through untouched.
   *
   * The split exists because Node reads only the FIRST CRL of a concatenated
   * string and silently ignores the rest, unlike `ca`, which reads every
   * certificate in a bundle. See docs/http-client.md.
   *
   * Two things to know before using this:
   *
   * - **Every certificate in the chain needs a covering CRL.** Node enables
   *   `X509_V_FLAG_CRL_CHECK_ALL`, so supplying a CRL for one root while
   *   connecting through another fails with `UNABLE_TO_GET_CRL` even when
   *   nothing was revoked. Cover every root you talk to, or scope the client.
   * - **CRLs expire.** Past `nextUpdate` the handshake fails with
   *   `CRL_HAS_EXPIRED`, including for certificates that were never revoked.
   *   Re-pass a fresh CRL before then; the refresh cadence is yours to own.
   *
   * Both failures are fail-closed, so a stale CRL never silently stops
   * enforcing — but both can take out healthy connections.
   */
  crl?: string | Buffer | Array<string | Buffer>;

  /**
   * Set to false to accept self-signed certificates in dev/test environments.
   * Defaults to true (Node.js default — rejects invalid certs).
   */
  rejectUnauthorized?: boolean;
}

// ---------------------------------------------------------------------------
// NodeAdapter
// ---------------------------------------------------------------------------

export class NodeAdapter implements HTTPAdapter {
  private _config: NodeAdapterConfig;

  constructor(config: NodeAdapterConfig = {}) {
    this._config = config;
  }

  public getType(): AdapterType {
    return 'node';
  }

  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    const parsedURL = new URL(request.requestURL);
    const urlOptions = urlToHttpOptions(parsedURL);
    const isHTTPS = parsedURL.protocol === 'https:';
    const httpModule = isHTTPS ? https : http;

    const options: http.RequestOptions = {
      method: request.method,
      headers: materializeNodeRequestHeaders(request.headers),
      // Timeout is managed by the client via abort signal — the adapter does
      // not impose its own timeout so the client retains full control.
    };

    if (urlOptions.auth) {
      options.auth = urlOptions.auth;
    }

    if (this._config.socketPath) {
      // Unix socket: the TCP connection goes to the socket path, not the host.
      // We still need options.path so the HTTP request line has the right path.
      // Preserve the URL host/port too so Node generates the correct Host
      // header for virtual-hosted services behind the socket.
      options.socketPath = this._config.socketPath;
      options.hostname = urlOptions.hostname;
      options.port = urlOptions.port;
      options.path = urlOptions.path;
    } else {
      options.hostname = urlOptions.hostname;
      options.port = urlOptions.port ?? (isHTTPS ? 443 : 80);
      options.path = urlOptions.path;
    }

    if (isHTTPS) {
      const httpsOptions = options as https.RequestOptions;

      // custom CA trust store
      if (this._config.ca) {
        httpsOptions.ca = this._config.ca;
      }

      // SNI hostname — required when dialing by IP with a DNS-named cert
      if (this._config.servername) {
        httpsOptions.servername = this._config.servername;
      }

      if (this._config.mtls) {
        // mTLS: present client cert. rejectUnauthorized stays true so the
        // server cert is still validated even though we're sending our own.
        httpsOptions.cert = this._config.mtls.cert;
        httpsOptions.key = this._config.mtls.key;

        if (this._config.mtls.ca) {
          httpsOptions.ca = this._config.mtls.ca;
        }

        httpsOptions.rejectUnauthorized = true;
      }

      if (this._config.crl !== undefined) {
        httpsOptions.crl = normalizeCRL(this._config.crl);
      }

      if (this._config.rejectUnauthorized === false) {
        // Dev-only: accept self-signed certs. Explicit false required — we do
        // not default to insecure, this must be an intentional opt-in.
        httpsOptions.rejectUnauthorized = false;
      }
    }

    return new Promise<AdapterResponse>((resolve, reject) => {
      let activeResponseStream:
        | {
            status: number;
            headers: Record<string, string | string[]>;
            writable: WritableLike;
          }
        | undefined;
      let activeBufferedResponse:
        | {
            status: number;
            headers: Record<string, string | string[]>;
          }
        | undefined;
      let isStreamFactoryPending = false;

      // Deduplication guard — Node's upload path can reach 100% from multiple
      // sources (final drain callback and the upload-complete signal). Once
      // 100% is reported any further calls are dropped.
      let didFireUpload100 = false;

      const reportUploadProgress = (event: AdapterProgressEvent): void => {
        if (didFireUpload100) {
          return;
        }

        if (event.progress === 1) {
          didFireUpload100 = true;
        }

        request.onUploadProgress?.(event);
      };

      // 0% upload progress before any bytes leave the process
      reportUploadProgress({ loaded: 0, total: 0, progress: 0 });

      // The http callback is typed as (res: IncomingMessage) => void, so we
      // cannot make it async directly. We use a void IIFE that routes any
      // unhandled rejections back to the outer promise's reject.
      const req = httpModule.request(options, (res) => {
        void (async () => {
          const status = res.statusCode ?? 0;
          const headers = normalizeResponseHeaders(res.headers);

          // --- Response streaming (NodeAdapter-only feature) ---
          //
          // Only offered on HTTP 200 responses. All other statuses bypass the
          // factory and return a normal buffered response. This prevents:
          //   1. Accidentally streaming error bodies (you'd lose the error detail)
          //   2. The mistake of buffering a large 200 into memory when you forgot
          //      to check the status — factory null = cancel, not buffer
          if (request.streamResponse && status === 200) {
            // Per-attempt abort controller for the stream context signal. This is
            // separate from the top-level request signal so we can fire it on local
            // write failures (disk full, etc.) without aborting the request itself —
            // the factory's cleanup listener fires, and we resolve with isStreamError.
            const streamAbort = new AbortController();

            // Propagate external cancellation (user abort, timeout) into the
            // factory's signal so cleanup listeners fire in all terminal cases.
            if (request.signal) {
              if (request.signal.aborted) {
                streamAbort.abort();
              }

              request.signal.addEventListener(
                'abort',
                () => {
                  streamAbort.abort();
                },
                { once: true },
              );
            }

            let writable: WritableLike | null | StreamResponseCancel;

            try {
              isStreamFactoryPending = true;
              writable = await request.streamResponse(
                {
                  status: 200,
                  headers,
                  url: request.requestURL,
                  attempt: request.attemptNumber ?? 1,
                  requestID: request.requestID ?? '',
                },
                { signal: streamAbort.signal },
              );
            } catch (error) {
              isStreamFactoryPending = false;
              // Factory threw — non-retryable setup error, equivalent to an
              // interceptor throw. Abort the stream signal so any partial cleanup
              // listeners run, destroy the request, and propagate as a setup failure.
              streamAbort.abort();
              req.destroy();
              reject(markStreamFactoryError(error, req, request.headers));
              return;
            }
            isStreamFactoryPending = false;

            // The request may have been cancelled or timed out while an async
            // factory was still setting up its sink. In that case the outer
            // promise has already settled through the abort listener; make a
            // best effort to close the newly created writable and stop here.
            if (streamAbort.signal.aborted) {
              if (writable && !isStreamResponseCancel(writable)) {
                writable.destroy();
              }

              return;
            }

            if (writable === null || isStreamResponseCancel(writable)) {
              // Factory declined to stream — user-initiated cancel. Fire the stream
              // signal so any cleanup listeners wired in the factory run, then throw
              // AbortError so the client's cancel path takes over (isCancelled: true).
              const cancelReason =
                writable !== null
                  ? readObjectMember(writable, 'reason')
                  : undefined;

              streamAbort.abort();
              req.destroy();
              const abortErr = new Error(
                'Request cancelled by streamResponse factory',
              );
              abortErr.name = 'AbortError';
              Object.assign(abortErr, {
                [STREAM_FACTORY_CANCEL_KEY]: cancelReason ?? true,
              });
              reject(abortErr);
              return;
            }

            activeResponseStream = {
              status,
              headers,
              writable,
            };

            const totalBytes =
              parseInt(String(headers['content-length'] ?? '0'), 10) || 0;

            // Pipe the response into the caller's writable. Extracted to a
            // module-level function to keep callback nesting within ESLint's
            // max-nested-callbacks limit. Returns true on success, or the
            // writable error when the local sink fails (disk full, etc.).
            const streamResult = await streamResponseBody(
              res,
              writable,
              totalBytes,
              request.onDownloadProgress,
            );

            if (streamResult === true) {
              activeResponseStream = undefined;
              resolveAdapterResponse(
                resolve,
                req,
                request.requestURL,
                request.headers,
                {
                  status,
                  headers,
                  body: null,
                  isStreamed: true,
                },
              );
            } else {
              activeResponseStream = undefined;
              // Body streaming failure after headers (disk full, writable
              // destroyed, upstream socket reset, etc.)
              //
              // The server already returned a real 200 response, so retries are no
              // longer safe: the caller's sink may already contain partial bytes.
              // We therefore preserve the real HTTP status and resolve with
              // isStreamError rather than throwing/retrying.
              //   - The stream signal fires so factory cleanup listeners run
              //   - Non-retryable once streaming has started
              streamAbort.abort();
              destroyWritableQuietly(writable);
              req.destroy();
              resolveAdapterResponse(
                resolve,
                req,
                request.requestURL,
                request.headers,
                {
                  status,
                  headers,
                  body: null,
                  isStreamError: true,
                  streamErrorCode: streamResult.code,
                  errorCause: streamResult.cause,
                },
              );
            }

            return;
          }

          // --- Normal buffered response ---
          activeBufferedResponse = {
            status,
            headers,
          };
          const chunks: Buffer[] = [];
          let loadedBytes = 0;

          // Deduplication guard — when Content-Length is known and the last
          // `data` chunk fills the body exactly, progress: 1 fires there.
          // The `end` event fires unconditionally afterward, so skip the
          // completion event if the last chunk already reported 100%.
          let didFireDownload100 = false;

          const totalBytes =
            parseInt(String(headers['content-length'] ?? '0'), 10) || 0;

          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            loadedBytes += chunk.length;

            // progress: -1 when Content-Length is absent (chunked transfer,
            // compressed response, etc.) — callers treat -1 as "length unknown".
            const progress = totalBytes > 0 ? loadedBytes / totalBytes : -1;

            // Track whether the final chunk already closed out 100% so the
            // `end` handler can skip a duplicate event.
            if (progress === 1) {
              didFireDownload100 = true;
            }

            request.onDownloadProgress?.({
              loaded: loadedBytes,
              // When total is unknown fall back to loaded so the event always
              // has a sensible non-zero total.
              total: totalBytes > 0 ? totalBytes : loadedBytes,
              progress,
            });
          });

          res.on('end', () => {
            activeBufferedResponse = undefined;

            // Final 100% download event — skipped when the last `data` chunk
            // already reported it (Content-Length known, body filled exactly).
            if (!didFireDownload100) {
              request.onDownloadProgress?.({
                loaded: loadedBytes,
                total: loadedBytes,
                progress: 1,
              });
            }

            const body =
              chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : null;

            resolveAdapterResponse(
              resolve,
              req,
              request.requestURL,
              request.headers,
              {
                status,
                headers,
                body,
              },
            );
          });

          res.on('error', (err: Error) => {
            if (!activeBufferedResponse) {
              return;
            }

            activeBufferedResponse = undefined;
            resolveAdapterResponse(
              resolve,
              req,
              request.requestURL,
              request.headers,
              {
                status,
                headers,
                body: null,
                isStreamError: true,
                streamErrorCode: 'stream_response_error',
                errorCause: makeResponseStreamError(
                  'Response stream error',
                  err,
                ),
              },
            );
          });

          res.on('aborted', () => {
            if (!activeBufferedResponse) {
              return;
            }

            activeBufferedResponse = undefined;
            resolveAdapterResponse(
              resolve,
              req,
              request.requestURL,
              request.headers,
              {
                status,
                headers,
                body: null,
                isStreamError: true,
                streamErrorCode: 'stream_response_error',
                errorCause: makeResponseStreamError('Response stream aborted'),
              },
            );
          });

          res.on('close', () => {
            if (!activeBufferedResponse) {
              return;
            }

            activeBufferedResponse = undefined;
            resolveAdapterResponse(
              resolve,
              req,
              request.requestURL,
              request.headers,
              {
                status,
                headers,
                body: null,
                isStreamError: true,
                streamErrorCode: 'stream_response_error',
                errorCause: makeResponseStreamError(
                  'Response stream closed before completion',
                ),
              },
            );
          });
        })().catch((error: unknown) => {
          reject(normalizeError(error));
        });
      });

      // Network / transport errors (DNS failure, connection refused, cert errors)
      req.on('error', (error) => {
        // Abort signal fired before network error — priorities the abort path
        if (request.signal?.aborted) {
          const abortErr = new Error('Request aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
          return;
        }

        // TLS certificate errors → 495. This is non-standard but widely
        // understood for client cert / server cert validation failures. We
        // preserve the diagnostic 495 status, but still flag it as a transport
        // failure so the client routes it through the failed/error path and
        // never retries it.
        if (isTLSCertificateError(error)) {
          resolveAdapterResponse(
            resolve,
            req,
            request.requestURL,
            request.headers,
            {
              status: 495,
              isTransportError: true,
              isRetryable: false,
              headers: {},
              body: null,
              errorCause: error,
            },
          );
          return;
        }

        // Only `wasDefinitelyNotSent` is claimed here, and only the transport
        // error code can supply it. No `isRetryable: false` alongside: that flag
        // blocks every method, so it would stop retrying an idempotent PUT after
        // an ordinary socket error and override retryNonIdempotentMethods.
        // Whether a partly-sent request may be replayed is the client's method
        // rule to answer, and withholding the proof is what answers it.
        //
        // A body-byte count cannot supply it in either direction: an empty-body
        // POST writes headers and nothing else, and the counter tracks bytes
        // handed to the stream rather than bytes on the wire. The error code is
        // also the only signal that behaves the same on Node and Bun, where
        // `socket.bytesWritten` and `socket.connecting` are unreliable.
        //
        // Set only when proven, never as `false` — absence means "not known", so
        // an explicit `false` would read as proof of delivery.
        const wasDefinitelyNotSent = isPreConnectionError(error);

        // All other transport errors (ECONNREFUSED, ENOTFOUND, etc.) → status 0
        resolveAdapterResponse(
          resolve,
          req,
          request.requestURL,
          request.headers,
          {
            status: 0,
            isTransportError: true,
            ...(wasDefinitelyNotSent ? { wasDefinitelyNotSent: true } : {}),
            headers: {},
            body: null,
            errorCause: error,
          },
        );
      });

      // Wire abort signal — destroy the underlying socket when fired.
      // Reject immediately rather than waiting for the 'error' event; some
      // runtimes (e.g. Bun) do not emit 'error' on req.destroy(), so waiting
      // leaves the promise unsettled. Promise resolution is idempotent, so any
      // subsequent error event is a safe no-op.
      if (request.signal) {
        if (request.signal.aborted) {
          // Signal already aborted before we even started (e.g., pre-cancelled builder)
          req.destroy();
          const abortErr = new Error('Request aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
          return;
        }

        request.signal.addEventListener(
          'abort',
          () => {
            if (activeResponseStream) {
              const { status, headers, writable } = activeResponseStream;
              activeResponseStream = undefined;
              destroyWritableQuietly(writable);
              req.destroy();

              const error = new Error(
                'Request aborted during response streaming',
              );
              error.name = 'AbortError';
              reject(
                markResponseStreamAbortError(
                  error,
                  req,
                  request.headers,
                  status,
                  headers,
                ),
              );
              return;
            }

            if (activeBufferedResponse) {
              const { status, headers } = activeBufferedResponse;
              activeBufferedResponse = undefined;
              req.destroy();

              const error = new Error(
                'Request aborted during response streaming',
              );
              error.name = 'AbortError';
              reject(
                markResponseStreamAbortError(
                  error,
                  req,
                  request.headers,
                  status,
                  headers,
                ),
              );
              return;
            }

            if (isStreamFactoryPending) {
              req.destroy();
              const abortErr = new Error(
                'Request aborted during streamResponse setup',
              );
              abortErr.name = 'AbortError';
              reject(markStreamFactoryError(abortErr, req, request.headers));
              return;
            }

            req.destroy();
            const abortErr = new Error('Request aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          },
          { once: true },
        );
      }

      // Write request body
      if (request.body instanceof FormData) {
        // FormData → multipart/form-data with exact Content-Length so upload
        // progress is length-computable (not chunked-transfer guesswork).
        const boundary = generateMultipartBoundary();

        serializeMultipartFormData(
          request.body,
          req,
          boundary,
          reportUploadProgress,
        )
          .then(() => {
            req.end();
          })
          .catch((error: unknown) => {
            req.destroy();
            resolveAdapterResponse(
              resolve,
              req,
              request.requestURL,
              request.headers,
              {
                // No isRetryable veto: that would stop retrying an idempotent
                // PUT or DELETE. Delivery is unproven rather than disproven, so
                // nothing is claimed and the client's method rule decides.
                status: 0,
                isTransportError: true,
                headers: {},
                body: null,
                errorCause: normalizeError(error),
              },
            );
          });
      } else if (
        typeof request.body === 'string' ||
        request.body instanceof Uint8Array
      ) {
        // String or Uint8Array body — write in chunks so upload progress fires
        // at meaningful granularity rather than one giant 100% event at the end.
        const bytes =
          typeof request.body === 'string'
            ? Buffer.from(request.body, 'utf8')
            : Buffer.from(request.body);

        req.setHeader('Content-Length', bytes.length.toString());

        writeRequestBodyChunked(bytes, req, reportUploadProgress)
          .then(() => {
            req.end();
          })
          .catch((error: unknown) => {
            req.destroy();
            resolveAdapterResponse(
              resolve,
              req,
              request.requestURL,
              request.headers,
              {
                // No isRetryable veto: that would stop retrying an idempotent
                // PUT or DELETE. Delivery is unproven rather than disproven, so
                // nothing is claimed and the client's method rule decides.
                status: 0,
                isTransportError: true,
                headers: {},
                body: null,
                errorCause: normalizeError(error),
              },
            );
          });
      } else {
        // No body — fire 100% upload immediately and end the request
        reportUploadProgress({ loaded: 0, total: 0, progress: 1 });
        req.end();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Streaming pipe helper
// ---------------------------------------------------------------------------

// Extracted to module scope so its internal callback nesting starts from 1,
// keeping each level within ESLint's max-nested-callbacks limit of 3.
//
// Returns true when the response body was fully written to the writable, or the
// underlying streaming failure when delivery fails after headers (disk full,
// writable destroyed, upstream response stream error, etc.). The caller maps
// that error into isStreamError rather than throwing, so the real HTTP status
// is preserved and the failure stays non-retryable once streaming has started.
async function streamResponseBody(
  res: http.IncomingMessage,
  writable: WritableLike,
  totalBytes: number,
  onProgress?: (e: AdapterProgressEvent) => void,
): Promise<StreamResponseBodyResult> {
  return new Promise((resolve) => {
    let loadedBytes = 0;

    // Deduplication guard — same as buffered download: when Content-Length is
    // known and the last write callback fills the body exactly, progress: 1
    // fires there. The `end` → writable.end callback fires unconditionally
    // afterward, so skip the completion event if the write already reported 100%.
    let didFireDownload100 = false;
    let isPaused = false;
    let isSettled = false;
    let didReceiveEnd = false;

    /**
     * Absorb an `error` the writable has not delivered yet.
     *
     * A failed write destroys the stream and emits its `error` on a later tick, usually
     * after this request has settled and its listeners are gone - and an `error` event
     * with no listener is an uncaught exception that takes the process down.
     *
     * Keyed on the writable rather than on the request, because `streamResponse` may hand
     * the same sink to several requests at once. A per-request absorber meant a dozen
     * concurrent failures on one shared writable attached a dozen listeners within the
     * same turn, before any removal ran, which is the `MaxListenersExceededWarning` this
     * is meant to avoid. One absorber per writable is also all that is needed: it is
     * attached with `on`, not `once`, so it keeps absorbing for as long as it is there
     * instead of standing down after the first error and leaving a sibling's unhandled.
     *
     * Its lifetime is bounded by the stream's own delivery: the absorber removes itself
     * once the error arrives, and a `'close'` listener removes it once the stream has
     * finished tearing down. A `setImmediate` is the fallback, and only for a writable
     * that would not take a `'close'` listener - a hand-written {@link WritableLike} that
     * throws from `write` or `end` is not obliged to emit anything afterwards, so a
     * listener waiting for delivery could otherwise wait forever.
     *
     * Skipped entirely for a writable with no listener-removal method, because an
     * absorber attached to one could never be taken back: the `setImmediate` would drop
     * the `WeakMap` entry while the listener stayed, and the next failure would attach
     * another, which is the unbounded growth this exists to prevent. Nothing is lost by
     * skipping it - `cleanup` could not have detached `onWritableError` from such a
     * writable either, so that listener is still attached and absorbs the late error on
     * its own, settling nothing because `settle` has already run.
     */
    const absorbPendingWritableError = (): void => {
      // Captured once, here, rather than looked up again inside the removal below. Two
      // lookups is two answers: the member is caller code and could be gone, or changed,
      // by the time the removal runs, and a removal that cannot find its method is one
      // that silently does not happen.
      const removeListener = getWritableListenerRemover(writable);

      if (removeListener === null) {
        return;
      }

      try {
        if (pendingWritableErrorAbsorbers.has(writable)) {
          // One is already attached to this writable and still absorbing.
          return;
        }
      } catch {
        // Not a usable `WeakMap` key, so it cannot be tracked or protected.
        return;
      }

      // Takes the absorber back off, whichever signal got here first. Guarded on the
      // `WeakMap` still naming this absorber so a second call, or a removal that has
      // already run, does nothing.
      const detach = (): void => {
        try {
          if (pendingWritableErrorAbsorbers.get(writable) !== absorb) {
            return;
          }
        } catch {
          return;
        }

        try {
          removeListener('error', absorb);
        } catch {
          // The removal itself is caller code and can refuse. The listener is therefore
          // still attached, so the bookkeeping that says so is kept: dropping it would
          // let the next failure add a second listener on top of one that never came
          // off, which is the accumulation being prevented. The one still attached goes
          // on absorbing, so nothing is left uncovered.
          return;
        }

        try {
          removeListener('close', onClose);
        } catch {
          // Not the same trade as the `'error'` removal above, because the `'error'`
          // listener is already off by the time this runs. Keeping the entry here said
          // an absorber was attached when none was, so every later failure on this
          // writable short-circuited and attached nothing - and `cleanup` had taken that
          // request's own `onWritableError` off too, leaving the late `'error'` event
          // with no listener at all, which is the uncaught exception this exists to
          // prevent. A stale `onClose` is the lesser cost and an inert one: it only
          // calls `detach`, which returns immediately once the entry below is gone.
        }

        pendingWritableErrorAbsorbers.delete(writable);
      };

      // Detach on the next turn of the loop rather than now, so an error delivered in
      // this one still finds the listener. `unref` so a pending removal cannot hold the
      // process open.
      const scheduleDetach = (): void => {
        try {
          const removal = setImmediate(detach);

          removal.unref?.();
        } catch {
          // No way to schedule it, so the listener stays. `'close'` may still take it off,
          // and holding one absorber is the safe direction of the two.
        }
      };

      const absorb = (): void => {
        // Already reported through `settle`; this exists only to keep the event from
        // going unhandled.
        //
        // Stands down a turn after delivery, not on it. `streamResponse` may hand the same
        // writable to several requests at once and one absorber covers them all, so
        // detaching the moment the first error lands would leave a sibling's unhandled -
        // but staying attached until a `'close'` that a writable is not obliged to emit
        // keeps this closure, and with it the whole request scope it was declared in,
        // alive for as long as the writable is. Deferring by one turn covers the siblings
        // and still bounds it.
        scheduleDetach();
      };

      const onClose = (): void => {
        // The stream has finished tearing down, so nothing further is coming.
        detach();
      };

      try {
        writable.on('error', absorb);
        pendingWritableErrorAbsorbers.set(writable, absorb);
      } catch {
        // A writable that will not take a listener cannot be protected. Nothing else
        // here depends on it.
        return;
      }

      // Bounded by delivery, and by the stream's own teardown, rather than by a turn of
      // the loop counted from here.
      //
      // A `setImmediate` scheduled at this point used to remove it unconditionally, on the
      // measurement that a failed write emits within the same turn. That is not true of
      // every stream: a real `fs.WriteStream` destroys itself through an asynchronous
      // `fs.close(fd)` before it emits, so the error lands a poll phase later - after the
      // removal had run and after `cleanup` had taken `onWritableError` off too. With no
      // listener left, Node turned a `stream_write_error` this had already reported
      // correctly into an uncaught exception that killed the process. It could not be
      // caught here either: Bun emits inside the window, so the suite never saw it.
      //
      // Both signals are used because neither alone is enough. `absorb` cannot cover a
      // writable that is never going to emit at all - a hand-written {@link WritableLike}
      // that throws from `write` or `end` is not obliged to. `'close'` cannot cover one
      // that emits `'error'` and nothing after it, and waiting on a close that never comes
      // is what would pin this closure, and the request scope around it, to the writable's
      // lifetime.
      try {
        writable.on('close', onClose);
      } catch {
        // Neither bound is available: this writable would not take the `'close'` listener,
        // and `absorb` only fires if the error actually arrives. A writable that emits
        // nothing at all would keep the absorber, and the request scope it closes over,
        // for as long as it lives - so fall back to the turn-counted removal. It is the
        // timing that was wrong for a real stream, and a writable that refuses a listener
        // is not one.
        scheduleDetach();
      }
    };

    const cleanup = (): void => {
      removeWritableListener(writable, 'drain', onWritableDrain);
      removeWritableListener(writable, 'error', onWritableError);

      res.off('data', onResponseData);
      res.off('end', onResponseEnd);
      res.off('error', onResponseError);
      res.off('aborted', onResponseAborted);
      res.off('close', onResponseClose);
    };

    const settle = (result: StreamResponseBodyResult): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      cleanup();
      resolve(result);
    };

    // Register the drain handler once at this level (depth 2) rather than
    // inside the data callback (depth 3+). Uses a flag instead of a one-shot
    // .once() to handle spurious drains gracefully.
    const onWritableDrain = (): void => {
      if (isPaused) {
        isPaused = false;
        res.resume();
      }
    };

    // Writable write failure (disk full, closed stream, etc.) resolves the
    // original error instead of rejecting so the caller can return the real
    // HTTP status code in an isStreamError response rather than surfacing a
    // thrown error.
    const onWritableError = (error: Error): void => {
      settle({ code: 'stream_write_error', cause: error });
    };

    const onResponseData = (chunk: Buffer): void => {
      if (isSettled) {
        return;
      }

      let canContinue: boolean;

      try {
        canContinue = writable.write(chunk, (error) => {
          if (isSettled) {
            return;
          }

          // `write`'s callback is a failure channel in its own right, as `WritableLike`
          // says: a write fails "either through the callback given to `write`/`end` or as
          // an `'error'` event". Dropping the error here was the one hole left in the set
          // of signals this function already honours - `end`'s callback and `errored` -
          // and it settled a truncated download as a success for a writable that reports
          // only this way. A real Node stream also emits `'error'`, and `settle` is
          // idempotent, so the two cannot both take effect.
          //
          // Absorbed first, exactly as the `write`-throw and `end`-callback paths do:
          // `settle` runs `cleanup`, which detaches the `'error'` listener, so a real
          // stream's event arriving on the next tick would otherwise be uncaught.
          if (error) {
            absorbPendingWritableError();
            settle({
              code: 'stream_write_error',
              cause: normalizeError(error),
            });

            return;
          }

          loadedBytes += chunk.length;

          // progress: -1 when Content-Length is absent — callers treat -1 as
          // "length unknown". Track 100% to avoid a duplicate from onResponseEnd.
          const progress = totalBytes > 0 ? loadedBytes / totalBytes : -1;

          if (progress === 1) {
            didFireDownload100 = true;
          }

          onProgress?.({
            loaded: loadedBytes,
            // Fall back to loaded when total is unknown so the event always
            // has a sensible non-zero total.
            total: totalBytes > 0 ? totalBytes : loadedBytes,
            progress,
          });
        });
      } catch (error) {
        // The throw came out of `write`, which means the stream is being torn down and
        // its own `error` event is still on the way.
        absorbPendingWritableError();
        settle({
          code: 'stream_write_error',
          cause: normalizeError(error),
        });
        return;
      }

      if (!canContinue) {
        // Writable signalled backpressure — pause the readable until the
        // drain event fires (handled above) to keep memory bounded.
        isPaused = true;
        res.pause();
      }
    };

    const onResponseEnd = (): void => {
      if (isSettled) {
        return;
      }

      didReceiveEnd = true;

      try {
        writable.end((endError?: Error | null) => {
          if (isSettled) {
            return;
          }

          // The callback's error argument is not optional to honour. A write that
          // failed destroys the stream, so `end` reports here rather than succeeding -
          // and the writable's own `error` event may not have been delivered yet, so
          // ignoring this settles a broken download as a success. `errored` is
          // consulted too, for a runtime that destroys the stream without passing the
          // error along - read through a guard, like every other member of a
          // caller-supplied writable, because this callback runs on a later tick with
          // no `try` above it: a throwing accessor here would be an uncaught exception
          // rather than a failed download.
          const writeFailure = endError ?? readWritableErrored(writable);

          if (writeFailure) {
            absorbPendingWritableError();
            settle({
              code: 'stream_write_error',
              cause: normalizeError(writeFailure),
            });

            return;
          }

          // Fire 100% download progress on successful completion, unless a
          // data chunk already reported exactly 100% (Content-Length known and
          // last chunk completed the body).
          if (!didFireDownload100) {
            onProgress?.({
              loaded: loadedBytes,
              total: loadedBytes,
              progress: 1,
            });
          }

          settle(true);
        });
      } catch (error) {
        // Same reasoning as the `write` throw above: a throw out of `end` means the
        // stream is being torn down, and its own `error` event is still on the way -
        // after `settle` has removed every listener this function registered.
        absorbPendingWritableError();
        settle({
          code: 'stream_write_error',
          cause: normalizeError(error),
        });
      }
    };

    const onResponseError = (err: Error): void => {
      // Response stream error after headers is terminal for streamed 200
      // responses too: bytes may already have been written to the caller's
      // sink, so retrying would risk duplicate/corrupt output.
      const streamError = new Error('Response stream error');
      streamError.cause = err;
      settle({ code: 'stream_response_error', cause: streamError });
    };

    const onResponseAborted = (): void => {
      const streamError = new Error('Response stream aborted');
      settle({ code: 'stream_response_error', cause: streamError });
    };

    const onResponseClose = (): void => {
      if (didReceiveEnd || isSettled) {
        return;
      }

      const streamError = new Error('Response stream closed before completion');
      settle({ code: 'stream_response_error', cause: streamError });
    };

    writable.on('drain', onWritableDrain);
    writable.on('error', onWritableError);
    res.on('data', onResponseData);
    res.on('end', onResponseEnd);
    res.on('error', onResponseError);
    res.on('aborted', onResponseAborted);
    res.on('close', onResponseClose);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Matches one PEM-armoured CRL. The armour is fixed by RFC 7468, so this is a
// constant rather than an option — there is exactly one correct value for it.
const PEM_CRL_HEADER = '-----BEGIN X509 CRL-----';

const PEM_CRL_BLOCK = /-----BEGIN X509 CRL-----[\s\S]*?-----END X509 CRL-----/g;

// Anything at all left over once every COMPLETE block has been removed.
//
// The rule is exact rather than a heuristic, and that is the point. Earlier
// versions tried to tell a damaged CRL apart from a human-readable annotation
// — first by searching for well-formed `-----BEGIN X509 CRL-----`, which
// missed `----BEGIN` and a clipped tail; then by any triple hyphen, which
// refused a Markdown rule; then by a hyphen run fused to text, which refused
// an issuer CN of `ACME---Production`. Each narrowing traded a false negative
// for a false positive, and a false negative here is a CRL dropped in silence.
//
// There is no line to draw, because a truncated CRL and a line of prose are
// the same thing to a parser: bytes that are not a PEM block. So require that
// there be none. Everything outside a complete block must be whitespace, which
// makes the accepted input exactly "PEM blocks, in any order, separated by
// whitespace" — what every producer of a CRL bundle emits by default.
//
// The cost is `openssl ca -gencrl -text` output, whose decoded header is not
// whitespace. That is refused with an error saying so, which is a better
// outcome than a rule that accepts it and, in the same breath, accepts a CRL
// that was cut in half.
const RESIDUE_OUTSIDE_PEM_BLOCKS = /\S/;

/**
 * Normalizes whatever the caller supplied as `crl` into the shape Node needs.
 *
 * Node reads only the FIRST CRL of a PEM string and silently ignores the rest
 * — unlike `ca`, which reads every certificate in a bundle. The asymmetry is
 * easy to miss because the failure is `UNABLE_TO_GET_CRL`, which reads as "no
 * CRL supplied" rather than "your bundle was truncated", and because a bundle
 * whose first entry happens to cover the root in use appears to work until the
 * roster or the export order changes.
 *
 * The bundle is the standard interchange format — Apache documents
 * `SSLCARevocationFile` as "the concatenation of the various PEM-encoded CRL
 * files", nginx and HAProxy agree, and `openssl verify -CRLfile` reads a whole
 * bundle — so callers reasonably hand one over. Splitting it here means they
 * do not have to know about Node's divergence from the library it links.
 *
 * The truncation applies per STRING, not per argument, so an array is walked
 * and each string element split in turn: `[bundleOfTwo, oneCrl]` would
 * otherwise contribute one CRL where it should contribute three. A string
 * inside an array is treated exactly like a string passed on its own.
 *
 * Anything that is not a multi-CRL string is returned untouched: a Buffer may
 * be DER, and a string with exactly one match is passed through so Node
 * reports its own error rather than having one masked here.
 *
 * A string with NO complete block does not reach that pass-through: unless it
 * is entirely whitespace, the residue check below throws. That is the case a
 * caller hits when a download truncated to nothing or a path pointed at a file
 * with no CRL in it, and the explicit error names the problem where Node would
 * only report `UNABLE_TO_GET_CRL` at handshake time.
 */
function normalizeCRL(
  crl: string | Buffer | Array<string | Buffer>,
): string | Buffer | Array<string | Buffer> {
  if (Array.isArray(crl)) {
    return crl.flatMap((entry) => normalizeCRLEntry(entry));
  }

  return normalizeCRLEntry(crl);
}

/**
 * One `crl` value — or one element of an array of them.
 *
 * Buffers cannot simply be passed through. `fs.readFileSync('bundle.pem')`
 * without an encoding returns a Buffer, which is the DEFAULT way to load a
 * file, and its contents are PEM text like any other bundle — so Node reads
 * only its first CRL exactly as it would from a string. Measured: a stale CRL
 * followed by one revoking the server's certificate accepted the connection as
 * a Buffer, and rejected it once split.
 *
 * So the question is not "string or Buffer" but "PEM or DER". A Buffer holding
 * PEM goes through the same splitting and validation as a string; a Buffer
 * holding DER — which has no armour to look for — is passed through untouched,
 * since DER encodes exactly one CRL and there is nothing to split.
 */
function normalizeCRLEntry(entry: string | Buffer): string | Buffer | string[] {
  if (typeof entry === 'string') {
    return splitCRLString(entry);
  }

  // latin1 is a byte-for-byte mapping, so PEM (which is ASCII) survives
  // exactly and DER cannot be corrupted by the round trip — it is only being
  // inspected, and is returned as the original Buffer either way.
  const text = entry.toString('latin1');

  if (!text.includes(PEM_CRL_HEADER)) {
    return entry;
  }

  const split = splitCRLString(text);

  // A single block stays a Buffer: it needed no splitting, so hand back what
  // the caller gave rather than a re-encoded copy of it.
  return Array.isArray(split) ? split : entry;
}

function splitCRLString(crl: string): string | string[] {
  const blocks = crl.match(PEM_CRL_BLOCK) ?? [];

  // Returning only the complete blocks would DISCARD whatever did not match,
  // so a truncated or corrupted CRL in the bundle would vanish silently and
  // the caller would enforce a set they did not supply. With the rest of the
  // bundle still present, a stale-but-complete CRL for the same issuer stays
  // in force while the newer, broken one is dropped.
  //
  // Passing the original string through instead does not help: Node reads its
  // first CRL and ignores the remainder, so a bundle whose first entry is
  // intact still swallows the damage without an error.
  //
  // So refuse anything that is not a complete block or whitespace.
  const residue = crl.replace(PEM_CRL_BLOCK, '');

  if (RESIDUE_OUTSIDE_PEM_BLOCKS.test(residue)) {
    throw new Error(
      'NodeAdapter: the `crl` value contains content outside any complete ' +
        '-----BEGIN/END X509 CRL----- block. Only PEM CRL blocks separated ' +
        'by whitespace are accepted, because a truncated CRL and a line of ' +
        'commentary are indistinguishable — accepting the second would mean ' +
        'silently dropping the first and enforcing an incomplete revocation ' +
        'set. Common causes: a partial download, a clipped or mistyped ' +
        'delimiter, or decoded text from `openssl ... -text`, which must be ' +
        'stripped before the bundle is passed here.',
    );
  }

  return blocks.length > 1 ? blocks : crl;
}

function normalizeResponseHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    // Keys are already lowercase from Node's http parser
    result[key] = Array.isArray(value) ? value : String(value);
  }

  return result;
}

function snapshotEffectiveRequestHeaders(
  req: http.ClientRequest,
  fallbackHeaders: Record<string, string | string[]>,
): Record<string, string | string[]> {
  return normalizeNodeRequestHeaders({
    // Start with the client-level attempt headers, then overlay any adapter-side
    // mutations (for example multipart Content-Type/Content-Length).
    ...fallbackHeaders,
    ...req.getHeaders(),
  });
}

function resolveAdapterResponse(
  resolve: (response: AdapterResponse | PromiseLike<AdapterResponse>) => void,
  req: http.ClientRequest,
  requestURL: string,
  fallbackHeaders: Record<string, string | string[]>,
  response: Omit<AdapterResponse, 'effectiveRequestHeaders'>,
): void {
  const detectedRedirectURL = resolveDetectedRedirectURL(
    requestURL,
    response.status,
    response.headers,
  );

  resolve({
    ...response,
    // Flag redirect responses so HTTPClient can surface wasRedirectDetected on
    // the final HTTPResponse consistently across all adapters. The actual
    // follow-or-disable decision is still made by HTTPClient's redirect loop.
    wasRedirectDetected: REDIRECT_STATUS_CODES.has(response.status),
    ...(detectedRedirectURL ? { detectedRedirectURL } : {}),
    effectiveRequestHeaders: snapshotEffectiveRequestHeaders(
      req,
      fallbackHeaders,
    ),
  });
}

function destroyWritableQuietly(writable: WritableLike): void {
  try {
    writable.destroy();
  } catch {
    // Best-effort cleanup only. Preserve the original stream failure.
  }
}

type WritableListenerRemover = (
  event: 'drain' | 'error' | 'close',
  listener: (() => void) | ((error: Error) => void),
) => unknown;

/**
 * The writable's own listener-removal method, or `null` when it has none.
 *
 * `removeListener` as well as `off`, because both are `EventEmitter`'s and a hand-written
 * {@link WritableLike} may define either. Neither is required by the interface, so a
 * structurally valid writable can have no way to take a listener back at all.
 */
function getWritableListenerRemover(
  writable: WritableLike,
): WritableListenerRemover | null {
  try {
    const removable = writable as WritableLike & {
      off?: WritableListenerRemover;
      removeListener?: WritableListenerRemover;
    };

    if (typeof removable.off === 'function') {
      return removable.off.bind(removable);
    }

    if (typeof removable.removeListener === 'function') {
      return removable.removeListener.bind(removable);
    }
  } catch {
    // Reading or binding a member runs code this adapter does not own.
  }

  return null;
}

/**
 * The writable's `errored`, or `undefined` when it has none this can read.
 *
 * A Node stream exposes it as a plain data property, but {@link WritableLike} is
 * caller-supplied and may define it as an accessor - and the one place it is read is
 * inside the `end` callback, which a real stream invokes on a later tick, outside the
 * `try` that wraps the `end` call itself. An unguarded throw there is an uncaught
 * exception, not a failed download.
 *
 * Whatever it holds is handed back as-is for the caller to test for truthiness and
 * normalize, exactly as reading the member directly did. Narrowing to `Error` here would
 * be a second change riding along with the guard, and the direction it errs in is the
 * worse one: a runtime that records a failure as something other than an `Error` would
 * have its broken download settled as a success.
 */
function readWritableErrored(writable: WritableLike): unknown {
  try {
    return writable.errored;
  } catch {
    // Unreadable, so it says nothing about whether the write failed. The `end`
    // callback's own error argument, and the writable's `'error'` event, both remain.
    return undefined;
  }
}

function removeWritableListener(
  writable: WritableLike,
  event: 'drain' | 'error',
  listener: (() => void) | ((error: Error) => void),
): void {
  try {
    getWritableListenerRemover(writable)?.(event, listener);
  } catch {
    // A removal that throws leaves the listener attached, which is the same place a
    // writable with no removal method leaves it. Nothing here depends on it, and this
    // runs from `cleanup`, on the settle path.
  }
}

/**
 * Transport error codes that mean no connection was ever established, so no
 * request bytes can have reached the server. Anything else — `ECONNRESET`,
 * `EPIPE`, `ETIMEDOUT`, a bare socket hang up — is treated as possible delivery,
 * since an unrecognized code must fall on the side of "may already have been
 * applied".
 *
 * `EHOSTUNREACH` and `ENETUNREACH` are absent despite reading like connect-time
 * failures: an ICMP unreachable for an established connection is reported on that
 * connection with the same code. Verified to agree on both Node and Bun.
 */
const PRE_CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
]);

/** Whether an error proves the request never left for a connected peer. */
function isPreConnectionError(error: unknown): boolean {
  const code = readObjectMember(error, 'code');

  return typeof code === 'string' && PRE_CONNECTION_ERROR_CODES.has(code);
}

function makeResponseStreamError(message: string, cause?: Error): Error {
  const error = new Error(message);

  if (cause) {
    error.cause = cause;
  }

  return error;
}

function markStreamFactoryError(
  error: unknown,
  req: http.ClientRequest,
  fallbackHeaders: Record<string, string | string[]>,
): Error {
  const normalized = normalizeError(error);
  const marks = {
    [NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG]: true,
    [STREAM_FACTORY_ERROR_FLAG]: true,
    effectiveRequestHeaders: snapshotEffectiveRequestHeaders(
      req,
      fallbackHeaders,
    ),
  };

  // Tagged in place when possible, so the caller still sees the error its own
  // `streamResponse` factory threw, with its identity and stack intact.
  try {
    Object.assign(normalized, marks);

    return normalized;
  } catch {
    // The factory threw something frozen or sealed, and in strict mode assigning to it
    // raises `TypeError: object is not extensible`. Falling through with an untagged
    // error is the damaging outcome: the client reads both flags to classify this as a
    // non-retryable `stream_setup_error`, so without them the failure lands in the
    // generic retry arm and the factory is invoked again. A fresh carrier keeps the
    // classification and preserves the original on `cause`, the same way
    // `markResponseStreamAbort` does in the fetch adapter.
  }

  const carrier = new Error(
    readErrorMessage(normalized) ?? 'Stream factory failed',
    { cause: error },
  );

  const originalName = readObjectMember(normalized, 'name');

  if (typeof originalName === 'string') {
    carrier.name = originalName;
  }

  Object.assign(carrier, marks);

  return carrier;
}

/** `message` is an ordinary property, so a frozen or exotic error may not yield one. */
function readErrorMessage(error: Error): string | undefined {
  const message = readObjectMember(error, 'message');

  return typeof message === 'string' && message.length > 0
    ? message
    : undefined;
}

function markResponseStreamAbortError(
  error: Error,
  req: http.ClientRequest,
  fallbackHeaders: Record<string, string | string[]>,
  status: number,
  headers: Record<string, string | string[]>,
): Error {
  const tagged = error as Error &
    Partial<Record<typeof RESPONSE_STREAM_ABORT_FLAG, boolean>> & {
      effectiveRequestHeaders?: Record<string, string | string[]>;
      streamAbortStatus?: number;
      streamAbortHeaders?: Record<string, string | string[]>;
    };

  // Keep the flag sourced from consts while avoiding eslint's false-positive
  // on direct computed assignment into an Error-typed value.
  Object.assign(tagged, { [RESPONSE_STREAM_ABORT_FLAG]: true });
  tagged.effectiveRequestHeaders = snapshotEffectiveRequestHeaders(
    req,
    fallbackHeaders,
  );
  tagged.streamAbortStatus = status;
  tagged.streamAbortHeaders = headers;

  return error;
}

function isStreamResponseCancel(value: unknown): value is StreamResponseCancel {
  return readObjectMember(value, 'cancel') === true;
}

/** Read replaceable/runtime-owned metadata without letting a getter escape. */
function readObjectMember(source: unknown, key: string): unknown {
  if (
    source === null ||
    (typeof source !== 'object' && typeof source !== 'function')
  ) {
    return undefined;
  }

  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}
