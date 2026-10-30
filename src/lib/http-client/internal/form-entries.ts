import { isPlainRecord } from './plain-record';

/**
 * `form`'s entries, read through the intrinsic `FormData.prototype.entries`, as the client
 * reads a form everywhere: a subclass's or a `Proxy`'s own `entries` would report entries
 * the form does not hold, and a `Proxy` over a form, which has no internal slots, throws
 * here. Read live, so an entry appended while they are read is reached.
 */
export function formEntries(form: FormData): ReturnType<FormData['entries']> {
  return FormData.prototype.entries.call(form);
}

/**
 * Whether `value` is a form, told by `FormData`'s own `has` - the intrinsic one, which the
 * runtime answers only for a real form, a subclass's included - as the client tells one
 * everywhere, rather than by `instanceof` alone: an object that only inherits from
 * `FormData.prototype`, or a `Proxy` over a form, has no entries to read and is no form.
 * Where `has` checks the internal slot (Bun, browsers), a form from another realm (an
 * iframe) is one; Node's checks `instanceof` as well. An array, bytes, or a plain record
 * (see `isPlainRecord`, any realm's) - a JSON body - is answered without asking, as `has` throws
 * for anything that is not a form; a form reparented onto one of those is no form here.
 */
export function isFormData(value: unknown): value is FormData {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  try {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
      return false;
    }

    if (isPlainRecord(value)) {
      return false;
    }

    FormData.prototype.has.call(value, '');
    return true;
  } catch {
    return false;
  }
}

const isBunRuntime =
  typeof process === 'object' && typeof process.versions.bun === 'string';

/**
 * The name a file part is sent under on Bun where that is not its own, or `undefined`. A
 * file backed by a path - `Bun.file()`, `openAsBlob` - reports the path as its name, even
 * when appended under another, and a form's entries do not tell it from a `File` named
 * with a slash. So only the last segment is sent, as the form-data package sends it: a
 * local path is no business of the server's. A name ending in a separator has none, and is
 * left as it is.
 */
export function bunFilePartName(value: unknown): string | undefined {
  if (!isBunRuntime) {
    return undefined;
  }

  const name: unknown = (value as File).name;

  if (typeof name !== 'string') {
    return undefined;
  }

  const separator =
    process.platform === 'win32'
      ? Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
      : name.lastIndexOf('/');

  return separator === -1 || separator === name.length - 1
    ? undefined
    : name.slice(separator + 1);
}
