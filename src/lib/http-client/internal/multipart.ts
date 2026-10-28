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

import { types } from 'node:util';
import { plainBytesView } from '../../internal/binary-view';
import { markNonRetryableAdapterError } from './adapter-error';
import { formEntries } from './form-entries';
import type { AdapterProgressEvent } from '../types';
import type { RequestBodyWritable } from './request-body-writable';
import {
  REQUEST_BODY_CHUNK_SIZE,
  writeChunkWithBackpressure,
} from './request-body-writer';

/**
 * Escape a field name or filename for its quoted Content-Disposition parameter, as the
 * WHATWG multipart/form-data encoding does and as `fetch` sends a `FormData` (undici,
 * Bun, browsers): `"`, CR and LF are percent-encoded, nothing is backslash-escaped, and
 * the name is otherwise sent as UTF-8.
 *
 * Matched exactly rather than improved on, because the servers on the other end parse
 * what browsers send. RFC 7578 4.2 forbids `filename*=` in multipart/form-data and the
 * WHATWG parsers (Bun, undici/Node, Deno, Workers) ignore it, so with the RFC 5987 form
 * and a lossy ASCII fallback they would read `résumé.pdf` as `resume.pdf` and `日本語.pdf`
 * as `.pdf`; and a backslash-escaped `a\"b` would reach them as `a\\"b`.
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
 * A file part's headers - its Content-Disposition with the filename, and its Content-Type -
 * as both passes write them. Reads the caller's `name` and `type`, so it can throw: a
 * getter that throws, or a `type` that is not a string, is refused with a `TypeError` the
 * callers turn into {@link sourceReadFailure}.
 */
function formatFilePartHeaders(fieldName: string, value: unknown): string {
  // A `File` named `''` is sent as `filename=""`, as browsers send it (a server reads it as
  // no file chosen); only a part with no name at all is `blob`.
  const partName: unknown = (value as File).name;
  const filename = typeof partName === 'string' ? partName : 'blob';
  const type: unknown = (value as Blob).type;

  if (typeof type !== 'string') {
    throw new TypeError('Request body part has a type that is not a string');
  }

  const contentType = sanitizeContentType(type) || 'application/octet-stream';

  return `Content-Disposition: form-data; name="${fieldName}"; ${formatFilename(filename)}\r\nContent-Type: ${contentType}\r\n\r\n`;
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

  for (const [name, value] of formEntries(formData)) {
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
      // File/blob part wire format:
      //   Content-Disposition header (with filename)
      //   Content-Type header
      //   blank line
      //   raw file bytes
      //   trailing CRLF before the next boundary
      size += Buffer.byteLength(formatFilePartHeaders(fieldName, value));
      // Blob.size is already the exact byte length of the binary payload - for a real
      // `Blob`. A subclass's getter can answer anything, and a non-integer here would go
      // out as the `Content-Length`.
      const partSize: unknown = (value as Blob).size;

      if (
        typeof partSize !== 'number' ||
        !Number.isSafeInteger(partSize) ||
        partSize < 0
      ) {
        throw new TypeError(
          'Request body part has a size that is not a byte count',
        );
      }

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
  // Guarded as the reads of a part's stream are, and for the same reason: the sizing pass
  // runs the caller's code - a `File` subclass's `name`, `type` or `size` getter - and
  // reads a form that may be none, a `Proxy` over one; a throw there, or a value of the
  // wrong type, fails the same way on every attempt. Untagged, it would reach the adapter
  // as a transport error and be retried for an idempotent method, failing identically
  // each time.
  let measured: { totalSize: number; partSizes: number[] };

  try {
    measured = measureMultipartFormData(formData, boundary);
  } catch (error) {
    throw sourceReadFailure(error);
  }

  const { totalSize, partSizes } = measured;
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
    // Bytes counted, and progress reported, only once the writable has accepted them: a
    // write the stream closed or errored under is rejected uncounted.
    writeChunkWithBackpressure(req, data, () => {
      uploadedBytes += Buffer.byteLength(data);

      onProgress?.({
        loaded: uploadedBytes,
        total: totalSize,
        progress: uploadedBytes / totalSize,
      });
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

  // Read again, and live: a form changed after the sizing pass is caught against the
  // measured sizes below.
  for (const [name, value] of formEntries(formData)) {
    if (req.destroyed) {
      break;
    }

    // A string field's whole part, or a file part's headers. Read again here, so guarded
    // again: a getter that answered the sizing pass can still throw on this one.
    let partHead: string;

    try {
      const fieldName = formatFieldName(name);

      partHead =
        typeof value === 'string'
          ? `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n${normalizeLinefeeds(value)}\r\n`
          : formatFilePartHeaders(fieldName, value);
    } catch (error) {
      throw sourceReadFailure(error);
    }

    // Start this part with its boundary delimiter.
    await write(`--${boundary}\r\n`);

    // Simple field: one header, blank line, then the field value. File/blob field:
    // multipart headers first, then the binary payload below.
    await write(partHead);

    if (typeof value !== 'string') {
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

          // A stream torn down while this read is outstanding - by the caller's side after
          // the response, or by the peer closing - has no pending `write` to reject, so
          // nothing else would wake this writer: it would stay parked on a source that may
          // never answer, holding the file open and leaving the upload unsettled.
          // Cancelling the reader ends the read as done, and the `req.destroyed` checks
          // below take it from there.
          const cancelOnClose = (): void => {
            void cancelReaderQuietly(reader);
          };

          req.once('close', cancelOnClose);

          try {
            ({ done: isDone, value: chunk } = await reader.read());
          } catch (error) {
            // The caller's source failed - a `File` whose backing file is gone or
            // unreadable - and it fails the same way on every attempt, as a source that
            // changed size does: not a network error to retry, re-sending the headers
            // and first boundary each time.
            throw sourceReadFailure(error);
          } finally {
            req.off('close', cancelOnClose);
            onSourceWait?.(false);
          }

          if (isDone) {
            break;
          }

          if (req.destroyed) {
            await cancelReaderQuietly(reader);
            break;
          }

          // Refused as the caller's source failing, not handed to `req.write`: a custom
          // `stream()` can yield anything, and the write's own refusal of a value that is
          // not bytes is untagged - it would be retried as a transport error - and quotes
          // the value.
          // Read by its internal slot rather than `instanceof`, so bytes made in another
          // realm - a `vm` context, Jest's node environment, whose `Blob.stream()` chunks
          // come from the host - are not mistaken for something else.
          if (chunk !== undefined && !types.isUint8Array(chunk)) {
            throw sourceMismatch(
              'Request body source produced a chunk that is not a Uint8Array',
            );
          }

          if (chunk !== undefined) {
            // Every count, check and slice below is made on a plain view of the chunk's
            // bytes, never on the chunk: a `Uint8Array` subclass from a custom `stream()`
            // can answer `byteLength` with anything - Node's `Buffer.byteLength` reads it
            // too, so a chunk that said 1 would pass its part's size check and put its real
            // bytes on the wire past the `Content-Length` - and can override `subarray`.
            let bytes: Uint8Array;

            try {
              bytes = plainBytesView(chunk);
            } catch (error) {
              throw sourceReadFailure(error);
            }

            // Refused *before* the write, not counted after it: a `File` that grew after
            // the sizing pass would otherwise have its surplus on the wire past a
            // `Content-Length` the server reads as the start of the next request, and no
            // later check could take those bytes back. Held to this part's own measured
            // size, so the message names the part that outgrew it; `write` holds the
            // chunk to `partsBudget` as well. The shortfall check below the loop has no
            // equivalent problem - bytes that were never written need no undoing.
            if (partBytes + bytes.byteLength > partSize) {
              await cancelReaderQuietly(reader);

              // What actually went on the wire, and the chunk that was refused, kept
              // apart: counting the refused chunk into the written total would name up to
              // a whole chunk that never left this process.
              throw sourceMismatch(
                `Request body source did not match its Content-Length: part expected ${String(partSize)} bytes, produced more - ${String(partBytes)} written and a further ${String(bytes.byteLength)} refused`,
              );
            }

            // Written in slices of the size the bytes writer uses, each awaited. Node's
            // `Blob.stream()` yields an in-memory `Blob` as one chunk - a whole 64 MiB
            // `File` in a single write - and progress is counted on a write's callback,
            // so written whole that upload would report nothing between 0 and 100%, and
            // the stall watchdog, which reads that progress, would destroy an upload the
            // server had acked early and was still reading. The slices are views, not
            // copies.
            for (
              let offset = 0;
              offset < bytes.byteLength && !req.destroyed;
              offset += REQUEST_BODY_CHUNK_SIZE
            ) {
              const slice = bytes.subarray(
                offset,
                offset + REQUEST_BODY_CHUNK_SIZE,
              );

              await write(slice);
              partBytes += slice.byteLength;
            }
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
  // rejects a write that was waiting for its callback, but a stream destroyed between
  // writes - with no write waiting, so no `'close'` listener attached - would otherwise
  // fall through here and resolve. That would be worse than the same gap in
  // `writeRequestBodyChunked`: the body is assembled across many writes, so what
  // `node-adapter`'s following `req.end()` finalized would be a payload missing its
  // closing `--boundary--` delimiter, against an exact `Content-Length`. The server would
  // read it as truncated while this side called it a success.
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
