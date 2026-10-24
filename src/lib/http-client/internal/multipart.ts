// cspell:ignore WHATWG
/**
 * Multipart/form-data serialization for Node.js HTTP requests.
 *
 * RFC 7578 defines the multipart/form-data wire format. Each field in the
 * FormData becomes a "part" in the body, separated by a boundary string:
 *
 *   --<boundary>\r\n
 *   Content-Disposition: form-data; name="username"\r\n
 *   \r\n
 *   alice\r\n
 *   --<boundary>\r\n
 *   Content-Disposition: form-data; name="avatar"; filename="photo.jpg"\r\n
 *   Content-Type: image/jpeg\r\n
 *   \r\n
 *   <binary file bytes>\r\n
 *   --<boundary>--\r\n        ← trailing "--" marks end of body
 *
 * The boundary is a random string that must not appear in any field value or
 * file content. Each part has its own mini-headers (Content-Disposition,
 * optionally Content-Type), followed by a blank line, then the value.
 *
 * This module uses a two-pass approach:
 *   Pass 1 — calculateMultipartFormDataSize: walk all fields, count exact byte length.
 *   Pass 2 — serializeMultipartFormData: write boundary + headers + value for each field.
 *
 * Knowing the total size upfront lets us set an exact Content-Length header,
 * which makes upload progress length-computable (a real 0–100%) rather than
 * indeterminate. Without Content-Length the browser/server can't tell the
 * client how far along it is.
 *
 * File/blob parts are read chunk-by-chunk via the Web Streams API reader (a
 * WHATWG standard — available in browsers, Node 18+, and Bun) so large files
 * are never fully buffered in memory. String fields are already in memory so
 * they are written in one shot.
 *
 * The functions accept a RequestBodyWritable instead of a concrete
 * http.ClientRequest so they can be tested and reused without a live socket.
 * http.ClientRequest satisfies the interface structurally.
 */

import { markNonRetryableAdapterError } from './adapter-error';
import type { AdapterProgressEvent } from '../types';
import type { RequestBodyWritable } from './request-body-writable';

/**
 * Escape a field name or filename for its quoted Content-Disposition parameter, as the
 * WHATWG multipart/form-data encoding does and as `fetch` sends a `FormData` (undici,
 * Bun, browsers): `"`, CR and LF are percent-encoded, nothing is backslash-escaped, and
 * the name is otherwise sent as UTF-8.
 *
 * Matched exactly rather than improved on, because the servers on the other end parse
 * what browsers send. RFC 7578 4.2 forbids `filename*=` in multipart/form-data and the
 * WHATWG parsers (Bun, undici/Node, Deno, Workers) ignore it, so the RFC 5987 form and
 * the lossy ASCII fallback this used to send turned `résumé.pdf` into `resume.pdf` and
 * `日本語.pdf` into `.pdf` there; and a backslash-escaped `a\"b` reached them as `a\\"b`.
 * With CR and LF encoded a name still cannot start a header of its own.
 */
function escapeDispositionValue(value: string): string {
  return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

/** Line breaks as CRLF, as the WHATWG encoding writes field names and string values. */
function normalizeLinefeeds(value: string): string {
  return value.replace(/\r?\n|\r/g, '\r\n');
}

/** A field name as the WHATWG encoding writes it: line breaks normalized, then escaped. */
function formatFieldName(name: string): string {
  return escapeDispositionValue(normalizeLinefeeds(name));
}

/** A filename as the WHATWG encoding writes it: escaped, never renamed. */
function formatFilename(filename: string): string {
  return `filename="${escapeDispositionValue(filename)}"`;
}

/**
 * Sanitizes a MIME type string for safe use in a multipart Content-Type header.
 *
 * Browser and Node.js `File.type` values are normally clean, but a
 * programmatically constructed File could carry CR/LF sequences that would
 * inject extra headers into the multipart part. Stripping line breaks
 * eliminates that risk while still forwarding the intended media type.
 */
export function sanitizeContentType(raw: string): string {
  return raw.replace(/\r\n|\r|\n/g, '');
}

/**
 * Generates a random boundary string for use as the multipart delimiter.
 *
 * The boundary must not appear anywhere in the body content (RFC 7578 §4.1).
 * A fresh 128-bit cryptographic suffix makes collisions impractical without
 * scanning or buffering streamed file contents. Content is not collision-checked.
 */
export function generateMultipartBoundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const suffix = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

  return `----NodeAdapterFormBoundary${suffix}`;
}

/**
 * Returns the exact byte length of the multipart body for a given FormData
 * and boundary — without writing anything.
 *
 * This mirrors the exact structure that serializeMultipartFormData will
 * produce, so the two functions must stay in sync.
 *
 * Why this exists: Node can stream the body without precomputing it, but then
 * upload progress would be indeterminate. By counting the exact bytes first,
 * we can set Content-Length up front and report real 0–100% progress during
 * serialization instead of guesswork.
 */
export function calculateMultipartFormDataSize(
  formData: FormData,
  boundary: string,
): number {
  return measureMultipartFormData(formData, boundary).totalSize;
}

function measureMultipartFormData(
  formData: FormData,
  boundary: string,
): { totalSize: number; partSizes: number[] } {
  let size = 0;
  const partSizes: number[] = [];

  for (const [name, value] of formData.entries()) {
    const fieldName = formatFieldName(name);

    // Every part starts with its own opening boundary line.
    size += Buffer.byteLength(`--${boundary}\r\n`);

    if (typeof value === 'string') {
      // String part wire format:
      //   Content-Disposition header
      //   blank line
      //   raw string value
      //   trailing CRLF before the next boundary
      size += Buffer.byteLength(
        `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n${normalizeLinefeeds(value)}\r\n`,
      );
    } else {
      // A `File` named `''` is sent as `filename=""`, as browsers send it (a server reads
      // it as no file chosen); only a part with no name at all is `blob`.
      const partName: unknown = (value as File).name;
      const filename = typeof partName === 'string' ? partName : 'blob';
      const contentType =
        sanitizeContentType((value as File).type) || 'application/octet-stream';

      // File/blob part wire format:
      //   Content-Disposition header (with filename)
      //   Content-Type header
      //   blank line
      //   raw file bytes
      //   trailing CRLF before the next boundary
      size += Buffer.byteLength(
        `Content-Disposition: form-data; name="${fieldName}"; ${formatFilename(filename)}\r\nContent-Type: ${contentType}\r\n\r\n`,
      );
      // Blob.size is already the exact byte length of the binary payload.
      const partSize = (value as Blob).size;
      partSizes.push(partSize);
      size += partSize;
      size += Buffer.byteLength('\r\n');
    }
  }

  // Final terminating boundary line — note the extra trailing `--`.
  size += Buffer.byteLength(`--${boundary}--\r\n`);
  return { totalSize: size, partSizes };
}

/**
 * Writes a FormData body into a RequestBodyWritable following the
 * multipart/form-data wire format (RFC 7578), setting Content-Type and
 * Content-Length headers first.
 *
 * This does not build one giant multipart buffer in memory. It writes the
 * envelope (boundaries + headers) directly and streams file/blob payloads
 * chunk-by-chunk from Blob.stream().
 */
export async function serializeMultipartFormData(
  formData: FormData,
  req: RequestBodyWritable,
  boundary: string,
  onProgress?: (e: AdapterProgressEvent) => void,
  /**
   * Told when the writer is parked waiting on the *source* - a `Blob.stream()` read that
   * has not answered - rather than on the socket, and again when the read comes back.
   * A stall watchdog reads byte progress, and a slow disk makes none; without this it
   * could not tell a file still being read from a receiver that stopped accepting.
   */
  onSourceWait?: (isWaiting: boolean) => void,
): Promise<void> {
  const { totalSize, partSizes } = measureMultipartFormData(formData, boundary);
  let partIndex = 0;

  // Servers need the boundary to parse the multipart body. We set an exact
  // Content-Length too, so upload progress is based on known total bytes
  // rather than HTTP chunked-transfer behavior.
  req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
  req.setHeader('Content-Length', totalSize.toString());

  let uploadedBytes = 0;
  const closingDelimiter = `--${boundary}--\r\n`;
  // What the parts may take: the closing delimiter is always written last, so a part
  // that reaches into its bytes is already more than was counted.
  const closingBytes = Buffer.byteLength(closingDelimiter);
  const partsBudget = totalSize - closingBytes;
  // Refused writes name the bytes held for the closing delimiter too: a part refused for
  // reaching into them names a total that is still within `Content-Length`.
  const overrunMessage = (written: number, refused: number): string =>
    `Request body source produced more than its Content-Length of ${String(totalSize)}: ${String(written)} bytes written and a further ${String(refused)} refused, with ${String(closingBytes)} kept for the closing delimiter`;

  // The write itself, unchecked: through `write` below for every part, and directly for
  // the closing delimiter, which always fits - every part's write was held to
  // `partsBudget`, so at least `closingBytes` remain.
  const writeToRequest = (data: string | Buffer | Uint8Array): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let hasWriteReturned = false;
      let isWriteCallbackDone = false;
      let isDrainDone = true;
      // The same guard `writeRequestBodyChunked` keeps, and for the same reason. Every
      // path here settles the one promise, and a settled promise ignores a second call -
      // but `maybeResolve` does more than resolve: it advances `uploadedBytes` and fires
      // `onProgress`. Now that `onClose` *rejects*, the two can both run. Under
      // backpressure a `'drain'` may arrive before the write callback, so `cleanup` has not
      // run and the listeners are still attached; `req` then emits `'close'` and the upload
      // rejects; the write callback lands afterwards and `maybeResolve` fires an
      // upload-progress event for a request already reported as a transport error, having
      // counted bytes the stream never accepted.
      let isSettled = false;

      const cleanup = (): void => {
        req.off('drain', onDrain);
        req.off('close', onClose);
        req.off('error', onError);
      };

      const maybeResolve = (): void => {
        if (isSettled || !isWriteCallbackDone || !isDrainDone) {
          return;
        }

        isSettled = true;
        cleanup();
        uploadedBytes += Buffer.byteLength(data);

        onProgress?.({
          loaded: uploadedBytes,
          total: totalSize,
          progress: uploadedBytes / totalSize,
        });
        resolve();
      };

      const onDrain = (): void => {
        isDrainDone = true;
        maybeResolve();
      };

      const onClose = (): void => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        cleanup();

        // Rejects, for the reason `writeRequestBodyChunked`'s does: a stream that closes
        // mid-write has not accepted what it was given, and resolving reported a part as
        // written when it was not. Worse here than there, because the body is assembled
        // across many writes - a close partway through leaves the multipart payload
        // without its closing `--boundary--` delimiter, and the server is handed a body it
        // will read as truncated while this side called it a success.
        reject(
          new Error('Request stream closed before the body was fully written'),
        );
      };

      const onError = (error: Error): void => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        cleanup();
        reject(error);
      };

      const canContinue = req.write(data, (error: Error | null | undefined) => {
        if (error) {
          if (isSettled) {
            return;
          }

          isSettled = true;
          cleanup();
          reject(error);
          return;
        }

        isWriteCallbackDone = true;
        if (hasWriteReturned) {
          maybeResolve();
        }
      });
      hasWriteReturned = true;

      // Armed whether or not the write was backpressured. A chunk the buffer took without
      // asking for a drain still has a callback that only Node will call, and a socket that dies
      // while it sits there never calls it: with the listeners attached only under backpressure,
      // nothing rejected and nothing resolved, so the writer's promise stayed pending for good.
      // That is the promise `requestBodySettled` hands the caller - an early-ack `200` whose
      // connection then dropped left an `await` on it hanging forever - and the adapter's own
      // upload-stall watchdog could not help: it destroys the request, which is precisely the
      // event nothing was listening for.
      //
      // `'drain'` stays conditional: only a backpressured write has one coming.
      //
      // `!isSettled` throughout. The write callback can run synchronously with an error - a
      // `ClientRequest` already destroyed answers that way - settling the write and running
      // `cleanup()` before any listener exists. Attaching listeners afterwards armed nothing that
      // could take them off again: the `req.destroyed` guard calls `onClose`, which returns on
      // `isSettled`, so they stayed on `req` for the life of the request - once per chunk, which
      // is the `MaxListenersExceededWarning` path.
      if (!isSettled) {
        if (!canContinue) {
          isDrainDone = false;
          req.once('drain', onDrain);
        }

        req.once('close', onClose);
        req.once('error', onError);

        if (req.destroyed) {
          onClose();
        }
      }

      maybeResolve();
    });

  // Every part's write: refused before it is written, since bytes past the
  // `Content-Length` already on the wire would be read by the server as the start of
  // another message. Reached when the FormData changed after the sizing pass - a field
  // appended mid-upload, a later part's headers grown longer - as the per-part check
  // below is for a file that grew. Held to the parts' share of it, not the whole: a new
  // part's `--boundary` line fits in the bytes kept for the closing delimiter, and would
  // otherwise go out before its headers were refused.
  const write = (data: string | Buffer | Uint8Array): Promise<void> =>
    uploadedBytes + Buffer.byteLength(data) > partsBudget
      ? Promise.reject(
          sourceMismatch(
            overrunMessage(uploadedBytes, Buffer.byteLength(data)),
          ),
        )
      : writeToRequest(data);

  for (const [name, value] of formData.entries()) {
    const fieldName = formatFieldName(name);

    if (req.destroyed) {
      break;
    }

    // Start this part with its boundary delimiter.
    await write(`--${boundary}\r\n`);

    if (typeof value === 'string') {
      // Simple field: one header, blank line, then the field value.
      await write(
        `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n${normalizeLinefeeds(value)}\r\n`,
      );
    } else {
      // A `File` named `''` is sent as `filename=""`, as browsers send it (a server reads
      // it as no file chosen); only a part with no name at all is `blob`.
      const partName: unknown = (value as File).name;
      const filename = typeof partName === 'string' ? partName : 'blob';
      const contentType =
        sanitizeContentType((value as File).type) || 'application/octet-stream';

      // File/blob field: multipart headers first, then the binary payload.
      await write(
        `Content-Disposition: form-data; name="${fieldName}"; ${formatFilename(filename)}\r\nContent-Type: ${contentType}\r\n\r\n`,
      );

      // Compare against the sizing pass, even if the source's size later changes.
      const partSize = partSizes[partIndex++];
      if (partSize === undefined) {
        throw sourceMismatch(
          'Multipart body changed after Content-Length was calculated',
        );
      }
      let partBytes = 0;

      // Blob.stream() lets us forward large files piece-by-piece instead of
      // concatenating the whole payload into a single upload buffer.
      // Opening it can fail as a read can (Bun opens a missing file here): see
      // `sourceReadFailure` below.
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = (value as Blob).stream().getReader();
      } catch (error) {
        throw sourceReadFailure(error);
      }

      try {
        while (true) {
          if (req.destroyed) {
            await cancelReaderQuietly(reader);
            break;
          }

          onSourceWait?.(true);

          let isDone: boolean;
          let chunk: Uint8Array | undefined;

          try {
            ({ done: isDone, value: chunk } = await reader.read());
          } catch (error) {
            // The caller's source failed - a `File` whose backing file is gone or
            // unreadable - and it fails the same way on every attempt, as a source that
            // changed size does: not a network error to retry, re-sending the headers
            // and first boundary each time.
            throw sourceReadFailure(error);
          } finally {
            onSourceWait?.(false);
          }

          if (isDone) {
            break;
          }

          if (req.destroyed) {
            await cancelReaderQuietly(reader);
            break;
          }

          if (chunk) {
            // Refused *before* the write, not counted after it: a `File` that grew after
            // the sizing pass would otherwise have its surplus on the wire past a
            // `Content-Length` the server reads as the start of the next request, and no
            // later check could take those bytes back. Held to this part's own measured
            // size, so the message names the part that outgrew it; `write` holds the
            // chunk to `partsBudget` as well. The shortfall check below the loop has no
            // equivalent problem - bytes that were never written need no undoing.
            if (partBytes + chunk.byteLength > partSize) {
              await cancelReaderQuietly(reader);

              // What actually went on the wire, and the chunk that was refused, kept
              // apart: counting the refused chunk into the written total would name up to
              // a whole chunk that never left this process.
              throw sourceMismatch(
                `Request body source did not match its Content-Length: part expected ${String(partSize)} bytes, produced more - ${String(partBytes)} written and a further ${String(chunk.byteLength)} refused`,
              );
            }

            // Each chunk contributes to upload progress immediately after write.
            await write(chunk);
            partBytes += chunk.byteLength;
          }
        }
      } finally {
        // Unconditionally, not only when the stream was destroyed. `await write(chunk)`
        // above can reject without anything being destroyed - the write callback delivers
        // an error, or an `'error'` event fires - and that rejection leaves this block
        // with the reader still locked and the blob's underlying stream never cancelled,
        // which for a disk-backed `File` is a handle held for the life of the process.
        // Cancelling a reader whose stream has already closed is a no-op, so the ordinary
        // `isDone` exit costs nothing by coming through here too.
        await cancelReaderQuietly(reader);
      }

      if (!req.destroyed && partBytes !== partSize) {
        throw sourceMismatch(
          `Request body source did not match its Content-Length: part expected ${String(partSize)} bytes, received ${String(partBytes)}`,
        );
      }

      if (!req.destroyed) {
        // Multipart parts are separated by CRLF after the value bytes too.
        await write('\r\n');
      }
    }
  }

  // The other exit, and the one every `req.destroyed` break above arrives at. `onClose`
  // rejects a write that was waiting for its callback or its drain, but a stream destroyed
  // between writes - with nothing under backpressure, so no `'close'` listener was ever
  // attached - used to fall through here and resolve. That is worse than the same gap in
  // `writeRequestBodyChunked`: the body is assembled across many writes, so what is
  // finalized by `node-adapter`'s following `req.end()` is a payload missing its closing
  // `--boundary--` delimiter, against an exact `Content-Length`. The server reads it as
  // truncated while this side called it a success.
  if (req.destroyed) {
    throw new Error('Request stream closed before the body was fully written');
  }

  // Closing delimiter that tells the server there are no more parts.
  await writeToRequest(closingDelimiter);

  // Bytes, not just `req.destroyed`, matching what `writeRequestBodyChunked` checks.
  // `Content-Length` is computed in the sizing pass from each `Blob.size`, but this pass
  // writes whatever `Blob.stream()` actually yields - and a `File` backed by a file
  // another process is rotating can yield fewer. The inner loop then exits through
  // `isDone` with nothing destroyed, every delimiter is written, and the body goes out
  // short of the length already on the wire. Node does not check a `ClientRequest` for a
  // Content-Length shortfall, so the server simply waits for bytes that never arrive and
  // the caller hangs until its own timeout rather than seeing the transport error it
  // should have.
  //
  // Only a shortfall reaches here. An overrun cannot: every part's write is refused
  // before it would pass `partsBudget`, so the closing delimiter lands at most at
  // `totalSize`.
  if (uploadedBytes < totalSize) {
    throw sourceMismatch(
      `Request body source produced fewer bytes than its Content-Length: ${String(uploadedBytes)} of ${String(totalSize)}`,
    );
  }
}

async function cancelReaderQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Best-effort cancellation only. Preserve the original request outcome.
  }
}

/**
 * A body source that did not match the size it was sent with. The source is the caller's
 * value and reads the same way again, so it fails once as a non-retryable `adapter_error`
 * rather than being retried as a network error.
 */
function sourceMismatch(message: string): Error {
  const error = new Error(message);
  markNonRetryableAdapterError(error);
  return error;
}

/** A body source whose read failed, with that failure as its `cause`. Non-retryable. */
function sourceReadFailure(cause: unknown): Error {
  const error = new Error('Request body source could not be read', { cause });
  markNonRetryableAdapterError(error);
  return error;
}
