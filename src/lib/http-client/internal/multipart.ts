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

import type { AdapterProgressEvent } from '../types';
import type { RequestBodyWritable } from './request-body-writable';

/**
 * Formats the filename parameter for a multipart Content-Disposition header.
 *
 * Every filename includes a quoted `filename="<fallback>"` parameter so older
 * multipart parsers still see a usable name.
 *
 * When the original name is not already safe printable ASCII, we also emit an
 * RFC 5987 `filename*=` parameter carrying the exact UTF-8 filename:
 *
 *   filename*=UTF-8''<percent-encoded-name>
 *
 * Including both forms maximizes compatibility: RFC 5987-aware parsers use
 * `filename*=` to recover the exact original filename, while older or lenient
 * parsers can still fall back to the sanitized ASCII `filename=` value.
 * Servers that normalize, strip, or rename uploads on their side will use
 * whichever form they support.
 *
 * The quoted `filename=` fallback is intentionally ASCII-safe and lossy when
 * needed. That avoids parser-dependent handling of quoted-string escaping while
 * still preserving a broadly compatible fallback for runtimes that ignore
 * `filename*=`.
 *
 * The RFC 5987 encoding here is `encodeURIComponent(...)` plus escaping for
 * `'`, `(`, `)`, and `*`, which must also be percent-encoded.
 */
function formatFilename(filename: string): string {
  const fallback = toSafeASCIIQuotedFilenameFallback(filename);
  const base = isSafeASCIIQuotedFilename(filename)
    ? `filename="${filename}"`
    : `filename="${fallback}"`;

  if (isSafeASCIIQuotedFilename(filename)) {
    return base;
  }

  const encoded = encodeURIComponent(filename)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');

  return `${base}; filename*=UTF-8''${encoded}`;
}

function isSafeASCIIQuotedFilename(value: string): boolean {
  return /^[\u0020-\u007E]+$/.test(value) && !/["\\]/.test(value);
}

function toSafeASCIIQuotedFilenameFallback(value: string): string {
  const normalized = value.normalize('NFKD');
  let result = '';
  let wasUnderscore = false;

  for (const char of normalized) {
    const code = char.charCodeAt(0);

    // Drop combining marks introduced by NFKD decomposition.
    if (code >= 0x0300 && code <= 0x036f) {
      continue;
    }

    // Allow a narrow filename-safe ASCII subset in the quoted fallback.
    // Everything else collapses to `_` so older parsers still get a stable,
    // unambiguous name without needing quoted-string escaping.
    const isSafeASCII =
      // 0-9
      (code >= 0x30 && code <= 0x39) ||
      // A-Z
      (code >= 0x41 && code <= 0x5a) ||
      // a-z
      (code >= 0x61 && code <= 0x7a) ||
      char === '.' ||
      char === '-' ||
      char === '_';

    if (isSafeASCII) {
      result += char;
      wasUnderscore = false;
    } else if (!wasUnderscore) {
      result += '_';
      wasUnderscore = true;
    }
  }

  result = result.replace(/^_+|_+$/g, '');

  // Avoid an empty fallback if every character was replaced.
  return result.length > 0 ? result : 'file';
}

/**
 * Formats a multipart field name for the quoted `name="..."` parameter.
 *
 * Field names are not lossy-sanitized like filenames because servers typically
 * expect the original key. We preserve the name while making it safe for a
 * quoted-string parameter by:
 *   1. Collapsing CRLF / CR / LF sequences to a single space so a malicious
 *      key cannot inject new headers
 *   2. Stripping remaining control characters (0x00–0x08, 0x0B, 0x0C,
 *      0x0E–0x1F, 0x7F) that are invalid inside a quoted-string per
 *      RFC 7230 §3.2.6
 *   3. Escaping `\` and `"` per quoted-string rules
 */
function formatFieldName(name: string): string {
  return (
    name
      .replace(/\r\n|\r|\n/g, ' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
  );
}

/**
 * Sanitizes a MIME type string for safe use in a multipart Content-Type header.
 *
 * Browser and Node.js `File.type` values are normally clean, but a
 * programmatically constructed File could carry CR/LF sequences that would
 * inject extra headers into the multipart part. Stripping line breaks
 * eliminates that risk while still forwarding the intended media type.
 */
function sanitizeContentType(raw: string): string {
  return raw.replace(/\r\n|\r|\n/g, '');
}

/**
 * Generates a random boundary string for use as the multipart delimiter.
 *
 * The boundary must not appear anywhere in the body content (RFC 7578 §4.1).
 * The "----" prefix and random suffix make accidental collision essentially
 * impossible for normal payloads. For adversarial inputs (a file that happens
 * to contain the boundary string) you would need boundary detection — we don't
 * do that here, matching browser FormData behavior.
 */
export function generateMultipartBoundary(): string {
  return `----NodeAdapterFormBoundary${Math.random().toString(36).slice(2)}`;
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
  let size = 0;

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
        `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`,
      );
    } else {
      const filename = (value as File).name || 'blob';
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
      size += (value as Blob).size;
      size += Buffer.byteLength('\r\n');
    }
  }

  // Final terminating boundary line — note the extra trailing `--`.
  size += Buffer.byteLength(`--${boundary}--\r\n`);
  return size;
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
): Promise<void> {
  const totalSize = calculateMultipartFormDataSize(formData, boundary);

  // Servers need the boundary to parse the multipart body. We set an exact
  // Content-Length too, so upload progress is based on known total bytes
  // rather than HTTP chunked-transfer behavior.
  req.setHeader('Content-Type', `multipart/form-data; boundary=${boundary}`);
  req.setHeader('Content-Length', totalSize.toString());

  let uploadedBytes = 0;

  const write = (data: string | Buffer | Uint8Array): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let hasWriteReturned = false;
      let isWriteCallbackDone = false;
      let isDrainDone = true;

      const cleanup = (): void => {
        req.off('drain', onDrain);
        req.off('close', onClose);
        req.off('error', onError);
      };

      const maybeResolve = (): void => {
        if (isWriteCallbackDone && isDrainDone) {
          cleanup();
          uploadedBytes += Buffer.byteLength(data);

          onProgress?.({
            loaded: uploadedBytes,
            total: totalSize,
            progress: uploadedBytes / totalSize,
          });
          resolve();
        }
      };

      const onDrain = (): void => {
        isDrainDone = true;
        maybeResolve();
      };

      const onClose = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const canContinue = req.write(data, (error: Error | null | undefined) => {
        if (error) {
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

      if (!canContinue) {
        isDrainDone = false;
        req.once('drain', onDrain);
        req.once('close', onClose);
        req.once('error', onError);

        if (req.destroyed) {
          onClose();
        }
      }

      maybeResolve();
    });

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
        `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n`,
      );
    } else {
      const filename = (value as File).name || 'blob';
      const contentType =
        sanitizeContentType((value as File).type) || 'application/octet-stream';

      // File/blob field: multipart headers first, then the binary payload.
      await write(
        `Content-Disposition: form-data; name="${fieldName}"; ${formatFilename(filename)}\r\nContent-Type: ${contentType}\r\n\r\n`,
      );

      // Blob.stream() lets us forward large files piece-by-piece instead of
      // concatenating the whole payload into a single upload buffer.
      const reader = (value as Blob)
        .stream()
        .getReader() as ReadableStreamDefaultReader<Uint8Array>;

      try {
        while (true) {
          if (req.destroyed) {
            await cancelReaderQuietly(reader);
            break;
          }

          const { done: isDone, value: chunk } = await reader.read();

          if (isDone) {
            break;
          }

          if (req.destroyed) {
            await cancelReaderQuietly(reader);
            break;
          }

          if (chunk) {
            // Each chunk contributes to upload progress immediately after write.
            await write(chunk);
          }
        }
      } finally {
        if (req.destroyed) {
          await cancelReaderQuietly(reader);
        }
      }

      if (!req.destroyed) {
        // Multipart parts are separated by CRLF after the value bytes too.
        await write('\r\n');
      }
    }
  }

  if (!req.destroyed) {
    // Closing delimiter that tells the server there are no more parts.
    await write(`--${boundary}--\r\n`);
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
