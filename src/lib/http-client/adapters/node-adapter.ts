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
} from '../types';
import {
  NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG,
  REDIRECT_STATUS_CODES,
  RESPONSE_STREAM_ABORT_FLAG,
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
      let uploadedBodyBytes = 0;

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

        uploadedBodyBytes = Math.max(uploadedBodyBytes, event.loaded);
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

            let writable: WritableLike | null;

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
              writable?.destroy();
              return;
            }

            if (writable === null) {
              // Factory declined to stream — user-initiated cancel. Fire the stream
              // signal so any cleanup listeners wired in the factory run, then throw
              // AbortError so the client's cancel path takes over (isCancelled: true).
              streamAbort.abort();
              req.destroy();
              const abortErr = new Error(
                'Request cancelled by streamResponse factory',
              );
              abortErr.name = 'AbortError';
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
          reject(error instanceof Error ? error : new Error(String(error)));
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

        const isRetryableTransportError = uploadedBodyBytes === 0;

        // All other transport errors (ECONNREFUSED, ENOTFOUND, etc.) → status 0
        resolveAdapterResponse(
          resolve,
          req,
          request.requestURL,
          request.headers,
          {
            status: 0,
            isTransportError: true,
            isRetryable: isRetryableTransportError,
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
                status: 0,
                isTransportError: true,
                isRetryable: false,
                headers: {},
                body: null,
                errorCause:
                  error instanceof Error ? error : new Error(String(error)),
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
                status: 0,
                isTransportError: true,
                isRetryable: false,
                headers: {},
                body: null,
                errorCause:
                  error instanceof Error ? error : new Error(String(error)),
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
          if (error || isSettled) {
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
        settle({
          code: 'stream_write_error',
          cause: error instanceof Error ? error : new Error(String(error)),
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
        writable.end(() => {
          if (isSettled) {
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
        settle({
          code: 'stream_write_error',
          cause: error instanceof Error ? error : new Error(String(error)),
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

function removeWritableListener(
  writable: WritableLike,
  event: 'drain' | 'error',
  listener: (() => void) | ((error: Error) => void),
): void {
  const removable = writable as WritableLike & {
    off?: (
      event: 'drain' | 'error',
      listener: (() => void) | ((error: Error) => void),
    ) => WritableLike;
  };

  removable.off?.(event, listener);
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
  const normalized = error instanceof Error ? error : new Error(String(error));
  const tagged = normalized as Error &
    Partial<
      Record<typeof NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG, boolean>
    >;

  tagged[NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG] = true;
  Object.assign(normalized, { [STREAM_FACTORY_ERROR_FLAG]: true });
  Object.assign(normalized, {
    effectiveRequestHeaders: snapshotEffectiveRequestHeaders(
      req,
      fallbackHeaders,
    ),
  });

  return normalized;
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
