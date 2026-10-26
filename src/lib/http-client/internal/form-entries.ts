/**
 * `form`'s entries, read through the intrinsic `FormData.prototype.entries`, as the client
 * reads a form everywhere: a subclass's or a `Proxy`'s own `entries` would report entries
 * the form does not hold, and a `Proxy` over a form, which has no internal slots, throws
 * here. Read live, so an entry appended while they are read is reached.
 */
export function formEntries(form: FormData): ReturnType<FormData['entries']> {
  return FormData.prototype.entries.call(form);
}
