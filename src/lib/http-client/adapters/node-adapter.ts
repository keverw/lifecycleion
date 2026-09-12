import * as http from 'node:http';
import { guardProgressCallback } from '../internal/progress';
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
// The shared coercion, not a fourth copy of it. Each adapter carried a near-identical
// body, on the grounds that the HTTP client should not import across module boundaries -
// which it already does for `sleep`, `deep-clone` and `retry-utils`. Aliased so the call
// sites read unchanged.
//
// The *message* is not unchanged, and that is deliberate. The local copies produced
// `new Error(String(value))`; `toError` produces
// `new Error('Non-error value thrown: <description>', { cause: value })`. So a non-`Error`
// rejection - `throw 'socket hang up'` - now reaches `AdapterResponse.errorCause` with the
// prefix on `message` and the original value on `cause`, where before it carried only the
// coerced text. See the 1.0.0 changelog entry: "HTTP adapters preserve non-`Error`
// rejection values on `cause`."
import { toError as normalizeError } from '../../to-error';
import { reportToHost } from '../../internal/report-to-host';
import { readUnknownMember as readObjectMember } from '../../internal/read-member';

// The pending-error absorber, in one place, because the shape of it is easy to misread.
//
// **What it is.** A writable handed to `streamResponse` belongs to the caller. A failed
// write destroys it and emits `'error'` on a later tick - for a real `fs.WriteStream`, a
// whole poll phase later, after its `fs.close(fd)` - by which time the request has settled
// and `cleanup` has taken its own listeners off. An `'error'` with no listener is an
// uncaught exception that ends the process, so one listener stays behind to catch it.
//
// **One per writable, not one per request.** `streamResponse` may hand the same sink to a
// dozen concurrent requests; a listener each is the `MaxListenersExceededWarning` this
// exists to avoid. Keyed through {@link pendingWritableErrorAbsorbers}, attached with `on`
// rather than `once` so it keeps covering siblings after the first error.
//
// **It is not a guarantee, it is a bound.** Nothing can establish that a stream will never
// emit again - the OS does not offer that, and a caller's sink may emit an hour from now.
// So this does not wait for certainty. It waits for the first of: the error arriving
// ({@link PendingWritableErrorEntry.absorb}, released a turn later so siblings are still
// covered), `'close'` (released at once), {@link PENDING_WRITABLE_ERROR_WINDOW_MS} with
// neither, or {@link MAX_PENDING_WRITABLE_ERROR_LIFETIME_MS} since it attached.
//
// **It does not live forever.** That last bound is the one that makes the statement true:
// every request relying on the absorber restarts the window, and a caller streaming
// steadily into `process.stdout` or a pooled sink would otherwise restart it forever. The
// ceiling is per absorber, not per writable and not per process - a request settling after
// it attaches a *fresh* absorber with a fresh ceiling - so continuous traffic does keep a
// listener on the sink continuously, while no single request's closure is pinned to the
// caller's stream for longer than the ceiling.
//
// An error arriving past all of that is the caller's to handle, which is the ordinary
// contract for a stream they own. Documented for them under "Writing your own
// `WritableLike`" in `docs/http-client.md`; keep the two in step.

/**
 * How long a pending-error absorber may stay on a caller's writable.
 *
 * The absorber's own signals - the error arriving, or `'close'` - bound it for any stream
 * that eventually says something. This bounds it for one that does not: a writable handed
 * to `streamResponse` is the caller's, and `process.stdout` or a pooled sink neither errors
 * nor closes. Without a ceiling the absorber outlives the request by the life of the
 * process, swallowing the caller's own later errors and pinning the request scope it closes
 * over.
 *
 * A second is far past the poll-phase delay this exists to cover - `fs.WriteStream` closes
 * its descriptor asynchronously and emits after it - and far short of forever.
 */
const PENDING_WRITABLE_ERROR_WINDOW_MS = 1000;

/**
 * The longest an absorber may stay attached however many requests keep asking for it.
 *
 * {@link PENDING_WRITABLE_ERROR_WINDOW_MS} is per *request*, and it has to be: one absorber
 * covers every request sharing the writable, so a request that settles while it is already
 * attached needs a full window of its own - see {@link PendingWritableErrorEntry}. Restarted
 * without a ceiling, though, that is a deadline that never arrives: `cleanup` asks on every
 * settle of every request, so a caller streaming steadily into `process.stdout` or a pooled
 * sink - the very writables that never error and never close - pushes it out forever, and
 * the absorber stays for the life of the process swallowing the caller's own first genuine
 * error and pinning the *first* request's scope with it. That is the hazard the window
 * exists for, reached by extension rather than by never bounding it at all.
 *
 * Counted from when the absorber was attached, so it bounds one listener's whole life
 * rather than any one request's share of it. Five windows: enough that an ordinary burst of
 * concurrent requests each gets its full second, short enough that "forever" is still never
 * the answer.
 *
 * A cap on each absorber, not on how many a writable may see. A request arriving after the
 * cap has expired attaches a *fresh* one - it must, or it would settle with no `'error'`
 * listener at all - so a caller failing continuously into one long-lived sink does keep a
 * listener on it continuously. That is the same coverage a continuous stream of requests
 * gets anyway, and it is the closure behind it, not the listener, that this bounds: no
 * single request's scope is pinned to the writable for longer than this.
 */
const MAX_PENDING_WRITABLE_ERROR_LIFETIME_MS =
  PENDING_WRITABLE_ERROR_WINDOW_MS * 5;

/**
 * One writable's absorber, and the means to push its deadline out.
 *
 * `extend` is carried alongside the listener because the absorber is shared but its
 * {@link PENDING_WRITABLE_ERROR_WINDOW_MS} backstop was not: only the request that
 * *attached* it scheduled one. A later request finding an absorber already in place
 * inherited whatever was left of the first request's second - which for a request settling
 * at the end of that window is no window at all - and its own `onWritableError` had just
 * been taken off by `cleanup`, so the late `'error'` it was covering for arrived with no
 * listener at all. Every request that relies on the absorber pushes the deadline out, up to
 * {@link MAX_PENDING_WRITABLE_ERROR_LIFETIME_MS}.
 */
interface PendingWritableErrorEntry {
  readonly absorb: (error: Error) => void;
  /**
   * Push this absorber's deadline out, and say whether it survived.
   *
   * `false` means the absorber has spent its
   * {@link MAX_PENDING_WRITABLE_ERROR_LIFETIME_MS} and detached itself, so the caller is
   * covered by nothing and must attach one of its own. Returning it is what closes the
   * gap: the extension was treated as unconditional, so a request finding an expired
   * absorber had it torn down on its behalf and then returned satisfied, while `cleanup`
   * took its own `onWritableError` off a turn later - leaving the writable with no
   * `'error'` listener at all, which is the uncaught exception this whole mechanism
   * exists to prevent.
   */
  readonly extend: () => boolean;
}

/**
 * The absorber currently attached to a writable, if any.
 *
 * Module-level and keyed on the writable, because `streamResponse` may hand the same sink
 * to several concurrent requests: a per-request absorber let a dozen simultaneous write
 * failures attach a dozen listeners inside one turn. See `absorbPendingWritableError`.
 */
/**
 * Writable errors a request has already handed to its caller, so the absorber does not
 * report them a second time.
 *
 * The absorber reports what it eats, because an error that reaches it after the request
 * settled has nowhere else to go. An error that *caused* the settle is different: it is
 * already on the response as `errorCause`, and reporting it on the global `'error'` channel
 * as well would double every ordinary streamed-download failure. The two listeners are
 * normally not attached at the same time, but nothing guarantees it, so the identity of the
 * emitted value is the check - the same shape as `NamedPipeSink.suppressedWriteErrors`.
 */
const deliveredWritableErrors = new WeakSet<object>();

/**
 * Mark a writable error as already handed to its caller, so the absorber stays quiet
 * about it.
 *
 * Called from every route that settles a request with a writable failure, not only from
 * the `'error'` listener. Node hands the *same* error object to `write`'s callback and
 * then emits it as `'error'`, and by then `cleanup` has taken `onWritableError` off - so
 * claiming it in that listener alone left the absorber reporting every ordinary
 * streamed-download failure a second time, on the global channel, for an error the caller
 * already had as `errorCause`.
 */
function claimWritableError(error: unknown): void {
  try {
    if (typeof error === 'object' && error !== null) {
      deliveredWritableErrors.add(error);
    }
  } catch {
    // Not a usable `WeakSet` key. At worst this error is reported twice, which is the safe
    // direction of the two.
  }
}

const pendingWritableErrorAbsorbers = new WeakMap<
  WritableLike,
  PendingWritableErrorEntry
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
    // Guarded once, at the boundary, so every call site below is covered - including the
    // ones handed to `streamResponseBody`, `writeRequestBodyChunked` and
    // `serializeMultipartFormData`. Progress reporting is advisory and must not be able to
    // change whether a request succeeded; a throwing callback used to propagate out and be
    // classified as a transport failure. See `guardProgressCallback`.
    const guardedUploadProgress = guardProgressCallback(
      request.onUploadProgress,
      'onUploadProgress',
    );
    const guardedDownloadProgress = guardProgressCallback(
      request.onDownloadProgress,
      'onDownloadProgress',
    );

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

      /**
       * Whether the server has already answered.
       *
       * A body write that fails after this is not the failure worth reporting. A server is
       * free to send a complete early response - a 413 or a 401 with `Connection: close` -
       * while the body is still uploading, and tearing that socket down is how it says so.
       * The writers then reject (the chunk truly was not accepted), and the `catch`
       * handlers below used to answer that with `req.destroy()` and a synthetic
       * `status: 0, isTransportError: true`, racing the real response to `resolve`: the
       * caller got a fabricated transport error instead of the server's actual status,
       * and the destroy tore down the connection the response was still arriving on.
       * With a response in hand the response path is the one that gets to answer.
       */
      let didReceiveResponse = false;

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

        guardedUploadProgress?.(event);
      };

      // 0% upload progress before any bytes leave the process
      reportUploadProgress({ loaded: 0, total: 0, progress: 0 });

      // The http callback is typed as (res: IncomingMessage) => void, so we
      // cannot make it async directly. We use a void IIFE that routes any
      // unhandled rejections back to the outer promise's reject.
      const req = httpModule.request(options, (res) => {
        didReceiveResponse = true;

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
                // `destroyWritableQuietly`, as the two sibling cleanup sites already use.
                // A bare `destroy()` is caller code: a throw from it lands in the IIFE's
                // `.catch` below, which calls `reject` on a promise the abort listener has
                // already settled - a no-op - so the cleanup silently did not happen.
                destroyWritableQuietly(writable);
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
              guardedDownloadProgress,
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

            guardedDownloadProgress?.({
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
              guardedDownloadProgress?.({
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
            // See `didReceiveResponse`: the server has already answered, so the
            // write failing is how that answer arrived, not a transport failure
            // to report over it. The response path resolves with the real status.
            if (didReceiveResponse) {
              return;
            }

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
            // See `didReceiveResponse`: the server has already answered, so the
            // write failing is how that answer arrived, not a transport failure
            // to report over it. The response path resolves with the real status.
            if (didReceiveResponse) {
              return;
            }

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
        const existing = pendingWritableErrorAbsorbers.get(writable);

        if (existing !== undefined && existing.extend()) {
          // One is already attached to this writable and still absorbing. Its deadline is
          // pushed out to a full window from *here*, because this request is now relying
          // on it and has no listener of its own left.
          return;
        }

        // `extend` answered that the absorber was out of lifetime and took itself off, so
        // there is nothing on this writable now. Falling through attaches a fresh one,
        // which is exactly the path a writable with no absorber at all takes - a new
        // request getting its own window is what the cap is for, as against one absorber
        // extending itself forever.
      } catch {
        // Not a usable `WeakMap` key, so it cannot be tracked or protected.
        return;
      }

      // Whether the `WeakMap` still names this absorber. A read that throws answers `true`
      // - the safe direction, since the cost of believing an absorber is present is one
      // late error absorbed twice, and the cost of believing it is gone is a second
      // listener attached on top of one that never came off.
      const isStillAttached = (): boolean => {
        try {
          return pendingWritableErrorAbsorbers.get(writable)?.absorb === absorb;
        } catch {
          return true;
        }
      };

      // Takes the absorber back off, whichever signal got here first. Guarded on the
      // `WeakMap` still naming this absorber so a second call, or a removal that has
      // already run, does nothing.
      const detach = (): void => {
        try {
          if (pendingWritableErrorAbsorbers.get(writable)?.absorb !== absorb) {
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

        // Nothing left for it to do, and it holds this closure until it fires otherwise.
        if (backstop !== undefined) {
          clearTimeout(backstop);
          backstop = undefined;
        }
      };

      // Detach on the next turn of the loop rather than now, so an error delivered in
      // this one still finds the listener. `unref` so a pending removal cannot hold the
      // process open.
      //
      // Cancelled by a renewal, which is what `generation` counts. The queued removal
      // only knows that *at the time it was scheduled* nothing further was expected; a
      // request settling in the meantime calls `extend` and is handed a fresh window, and
      // tearing the absorber down anyway left that request covered by nothing - the same
      // uncaught-`'error'` gap, reached from the other side. The `'close'` and backstop
      // paths call `detach` directly and are unaffected: those are deliveries, not
      // guesses about one.
      const scheduleDetach = (): void => {
        const scheduledAt = generation;

        try {
          const removal = setImmediate(() => {
            if (generation !== scheduledAt) {
              return;
            }

            detach();
          });

          removal.unref?.();
        } catch {
          // No way to schedule it, so the listener stays. `'close'` may still take it off,
          // and holding one absorber is the safe direction of the two.
        }
      };

      const absorb = (error?: unknown): void => {
        // Reported, then absorbed. "Already reported through `settle`" held while this
        // listener only ever ran after a failed request had been settled with the error in
        // hand; it stopped holding once the absorber was attached on the success path too.
        // A sink that accepted every byte and then failed its own `close(fd)` inside this
        // window - a truncated file, reported to the caller as a completed download - had
        // its error discarded here with no trace anywhere: not on the response, not on the
        // global `'error'` channel, not in the log. Absorbing an event so it cannot kill
        // the process is the job; deciding nobody needs to know is not.
        //
        // Guarded, and deliberately not allowed to rethrow: this runs as an `'error'`
        // listener, and a listener that throws is the uncaught exception this whole
        // mechanism exists to prevent.
        // Decided a turn later, not now. Whether this error has a home depends on listener
        // order, and that order is not this function's to control: one absorber covers
        // every request sharing a writable, so a sibling's absorber can already be attached
        // when a later request registers its own `onWritableError` - and `EventEmitter`
        // then runs the absorber first, before the listener that would have claimed the
        // error. Asking after the emit has finished lets every listener have its say, and
        // the answer is the same for the ordinary case where the claim came first.
        const reportIfUnclaimed = (): void => {
          let wasDelivered = false;

          try {
            wasDelivered =
              typeof error === 'object' &&
              error !== null &&
              deliveredWritableErrors.delete(error);
          } catch {
            // Unreadable as a key; treated as undelivered, so it is reported rather than
            // lost.
          }

          if (wasDelivered) {
            return;
          }

          try {
            reportToHost(
              normalizeError(
                error ??
                  new Error(
                    'A writable passed to streamResponse emitted an error after the request settled',
                  ),
              ),
            );
          } catch {
            // Nothing left to report with; the event is still absorbed either way.
          }
        };

        try {
          const deferred = setImmediate(reportIfUnclaimed);

          deferred.unref?.();
        } catch {
          // No way to schedule it, so the question is answered now. Reporting an error the
          // caller also received is the safe direction; losing one silently is not.
          reportIfUnclaimed();
        }

        // Beyond the report, this exists to keep the event from
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

      // Restarts the backstop from now, within the absorber's own lifetime cap. Called once
      // below for the request that attaches the absorber, and again by every later request
      // that finds it already in place, so the window each of them gets is its own full one
      // rather than the remainder of the first request's.
      let backstop: ReturnType<typeof setTimeout> | undefined;
      const attachedAt = Date.now();

      // Bumped by every renewal, so a `detach` already queued by `scheduleDetach` knows
      // its answer is stale. See `scheduleDetach`.
      let generation = 0;

      /**
       * @param isRenewal Whether a *later* request is asking, rather than the attach below.
       *        Only a renewal invalidates a queued detach: the attach path runs after the
       *        `'close'` fallback may have scheduled one, and that fallback is the only
       *        bound a writable refusing listeners has.
       * @returns Whether an absorber is still attached afterwards.
       */
      const extend = (isRenewal: boolean = false): boolean => {
        const remainingLifetime =
          MAX_PENDING_WRITABLE_ERROR_LIFETIME_MS - (Date.now() - attachedAt);

        // Out of lifetime, so this is the last word rather than another window: see
        // `MAX_PENDING_WRITABLE_ERROR_LIFETIME_MS` for why an unconditional restart is a
        // deadline that never arrives.
        if (remainingLifetime <= 0) {
          detach();

          // Not simply `false`: `detach` returns early when the writable refuses to give
          // the listener back, and the bookkeeping is deliberately kept in that case
          // because the listener really is still attached and still absorbing. The caller
          // is covered, so it must not add a second one on top.
          return isStillAttached();
        }

        try {
          // Scheduled before the old one is cleared, never after. A `setTimeout` that
          // refuses would otherwise leave this absorber with the bound it already had
          // cleared and no replacement - unbounded, by way of the code that bounds it.
          const next = setTimeout(
            detach,
            Math.min(PENDING_WRITABLE_ERROR_WINDOW_MS, remainingLifetime),
          );

          next.unref?.();

          if (backstop !== undefined) {
            clearTimeout(backstop);
          }

          backstop = next;

          if (isRenewal) {
            generation++;
          }
        } catch {
          // No way to schedule it. Whatever was already pending still stands, and on the
          // attach path that is nothing - the two signals above are the bound, which is the
          // behaviour that shipped before this one existed.
        }

        return true;
      };

      try {
        writable.on('error', absorb);
        pendingWritableErrorAbsorbers.set(writable, {
          absorb,
          extend: () => extend(true),
        });
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

      // A last bound, because the two above only cover streams that eventually say
      // something. A writable handed to `streamResponse` belongs to the *caller* and may
      // well outlive the request without ever closing - `process.stdout`, a pooled sink, a
      // long-lived socket - and for one of those neither `'error'` nor `'close'` is coming.
      // Left unbounded, this absorber would stay on the caller's stream for the life of the
      // process: swallowing the first genuine error it emits long after this request
      // succeeded, and pinning the whole request scope - `res`, its listeners, the
      // accumulated state - to the stream it closes over. That is the hazard the comment
      // above names, and it applied to the throw paths before this was reached from
      // `cleanup` on every settle.
      //
      // Long enough for the case the `'close'` listener exists for - a real `fs.WriteStream`
      // destroys itself through an asynchronous `fs.close(fd)` and emits a poll phase later,
      // which a `setImmediate` lands before - and short enough that "for the life of the
      // process" is never the answer. `unref` so a pending removal cannot hold the process
      // open on its own.
      extend();
    };

    const cleanup = (): void => {
      // Before the removal, and on *every* settle path rather than only the three that
      // asked for it explicitly. `cleanup` takes `onWritableError` off unconditionally, so
      // the moment it runs the writable has no `'error'` listener of ours left - and an
      // `'error'` event with no listener is an uncaught exception that ends the process.
      //
      // The three call sites that asked were the ones where a `write`/`end` throw made the
      // late error obvious, which left the ordinary paths uncovered: `settle(true)` on
      // success, and all four response-side settles. A real `fs.WriteStream` closes its
      // descriptor asynchronously *after* `'finish'`, so streaming a 200 to a file, then
      // having `fs.close(fd)` fail with `EIO` or `ENOSPC`, emitted `'error'` into exactly
      // that gap. Nothing about that path throws, so nothing about it looked like it
      // needed an absorber.
      //
      // Cheap and idempotent to call here: it is keyed on the writable through a `WeakMap`,
      // returns immediately when one is already attached, and takes itself back off on
      // delivery or on `'close'`.
      absorbPendingWritableError();

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
      // Claimed before `settle`, which runs `cleanup` and can let the absorber see this
      // same event.
      claimWritableError(error);

      // Normalized like every other failure path in this function. The parameter is typed
      // `Error` because `WritableLike` declares the listener that way, but the value is
      // whatever the writable emitted, and a hand-written one is under no obligation to
      // emit an `Error` at all - so this was the last route by which a non-`Error` could
      // reach `AdapterResponse.errorCause`, which also declares an `Error`.
      settle({
        code: 'stream_write_error',
        cause: normalizeError(error),
      });
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
            claimWritableError(error);
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
        // its own `error` event is still on the way - carrying this same object, which is
        // why it is claimed here rather than left for the absorber to report again.
        claimWritableError(error);
        absorbPendingWritableError();
        settle({
          code: 'stream_write_error',
          cause: normalizeError(error),
        });
        return;
      }

      // `isSettled` as well as the backpressure signal. `WritableLike` allows a write to
      // fail through the callback given to `write`, and nothing obliges that callback to
      // be asynchronous: a writable that calls it with an error and then returns `false`
      // settles this request from inside the `write` above and still arrives here. The
      // pause would then be applied after `settle` ran `cleanup`, so the `'drain'`
      // listener that undoes it is already detached and nothing can ever resume the
      // response. A real Node stream does not do this - it is a hand-written writable
      // that reports synchronously - and the caller destroys the request on a stream
      // failure, so today this pauses a response that is about to be torn down anyway.
      // Pausing a stream whose resume path has been dismantled is wrong regardless of
      // who cleans up after it.
      if (!canContinue && !isSettled) {
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
          // Handed back as-is for the truthiness test and normalization below, rather
          // than narrowed to `Error` here: a runtime that records a failure as something
          // other than an `Error` would have its broken download settled as a success.
          const writeFailure =
            endError ?? readObjectMember(writable, 'errored');

          if (writeFailure) {
            claimWritableError(writeFailure);
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
        claimWritableError(error);
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
