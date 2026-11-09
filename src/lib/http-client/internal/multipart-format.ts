/**
 * The multipart/form-data encoding's text - field names, filenames, string values, part
 * headers - and a form's encoded size, as the WHATWG algorithm `fetch` uses writes them
 * (see `multipart.ts`, which writes the body). Kept free of Node modules, so MockAdapter
 * reads a form as a server would receive it on any platform.
 */

import { filePartNameToSend, formEntries } from './form-entries';
import { isByteCount } from './progress';
import { utf8ByteLength } from './utf8-length';

/**
 * A string's UTF-8 byte length: Node's native count where there is a `Buffer` - a large
 * string field is counted on every send - and counted here where there is none, as in a
 * browser running MockAdapter. The two agree, a lone surrogate counted as U+FFFD's three
 * bytes by both.
 */
const byteLength: (text: string) => number =
  typeof Buffer === 'function'
    ? (text) => Buffer.byteLength(text)
    : utf8ByteLength;

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
export function escapeDispositionValue(value: string): string {
  return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

/** Line breaks as CRLF, as the WHATWG encoding writes field names and string values. */
export function normalizeLinefeeds(value: string): string {
  return value.replace(/\r?\n|\r/g, '\r\n');
}

/** A field name as the WHATWG encoding writes it: line breaks normalized, then escaped. */
export function formatFieldName(name: string): string {
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

/** A string part, whole - its Content-Disposition, value and trailing CRLF - as both passes write it. */
export function formatStringPart(fieldName: string, value: string): string {
  return `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n${normalizeLinefeeds(value)}\r\n`;
}

/**
 * A file part's headers - its Content-Disposition with the filename, and its Content-Type -
 * as both passes write them. Reads the caller's `name` and `type`, so it can throw: a
 * getter that throws, or a `type` that is not a string, is refused with a `TypeError` the
 * callers turn into {@link sourceReadFailure}.
 */
export function formatFilePartHeaders(
  fieldName: string,
  value: unknown,
): string {
  // A `File` named `''` is sent as `filename=""`, as browsers send it (a server reads it as
  // no file chosen); only a part with no name at all is `blob`.
  const partName = filePartNameToSend((value as File).name);
  const filename = typeof partName === 'string' ? partName : 'blob';
  const type: unknown = (value as Blob).type;

  if (typeof type !== 'string') {
    throw new TypeError('Request body part has a type that is not a string');
  }

  const contentType = sanitizeContentType(type) || 'application/octet-stream';

  return `Content-Disposition: form-data; name="${fieldName}"; ${formatFilename(filename)}\r\nContent-Type: ${contentType}\r\n\r\n`;
}

/**
 * Returns the exact byte length of the multipart body for a given FormData
 * and boundary — without writing anything.
 *
 * This mirrors the exact structure `serializeMultipartFormData` (in `multipart.ts`)
 * writes, so the two must stay in sync: both build each part from the helpers above.
 *
 * Why this exists: Node can stream the body without precomputing it, but then
 * upload progress would be indeterminate. By counting the exact bytes first,
 * NodeAdapter sets Content-Length up front and reports real 0–100% progress during
 * serialization instead of guesswork. MockAdapter reports the same Content-Length to a
 * route, under its own boundary.
 */
export function measureMultipartFormData(
  formData: FormData,
  boundary: string,
): { totalSize: number; partSizes: number[] } {
  return measureMultipartEntries(formEntries(formData), boundary);
}

/**
 * {@link measureMultipartFormData} for a form's entries already read: for a caller that
 * reads them once and makes more than one use of them.
 */
export function measureMultipartEntries(
  entries: Iterable<[string, FormDataEntryValue]>,
  boundary: string,
): { totalSize: number; partSizes: number[] } {
  let size = 0;
  const partSizes: number[] = [];

  for (const [name, value] of entries) {
    const fieldName = formatFieldName(name);

    // Every part starts with its own opening boundary line.
    size += byteLength(`--${boundary}\r\n`);

    if (typeof value === 'string') {
      // String part wire format:
      //   Content-Disposition header
      //   blank line
      //   raw string value
      //   trailing CRLF before the next boundary
      size += byteLength(formatStringPart(fieldName, value));
    } else {
      // File/blob part wire format:
      //   Content-Disposition header (with filename)
      //   Content-Type header
      //   blank line
      //   raw file bytes
      //   trailing CRLF before the next boundary
      size += byteLength(formatFilePartHeaders(fieldName, value));
      // Blob.size is already the exact byte length of the binary payload - for a real
      // `Blob`. A subclass's getter can answer anything, and a non-integer here would go
      // out as the `Content-Length`.
      const partSize: unknown = (value as Blob).size;

      if (!isByteCount(partSize)) {
        throw new TypeError(
          'Request body part has a size that is not a byte count',
        );
      }

      partSizes.push(partSize);
      size += partSize;
      size += byteLength('\r\n');
    }
  }

  // Final terminating boundary line — note the extra trailing `--`.
  size += byteLength(`--${boundary}--\r\n`);
  return { totalSize: size, partSizes };
}
