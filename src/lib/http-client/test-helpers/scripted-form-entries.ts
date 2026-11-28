import { afterAll, beforeAll } from 'bun:test';

const scriptedEntries = new WeakMap<object, () => Iterator<unknown>>();

/**
 * Has `form`'s entries, as the client reads them - through `FormData.prototype.entries`,
 * never an `entries` the form declares - be what `entries` yields, in a test file that
 * calls `useScriptedFormEntries`. Bun's `FormData` keeps its own copy of a `File` appended
 * to it, where Node's keeps the caller's object, a subclass with its own `size`, `type` or
 * `stream()` included: this reaches what a Node form holds, and a form that changes or
 * fails as it is read.
 */
export function scriptFormEntries(
  form: FormData,
  entries: () => Iterator<unknown>,
): FormData {
  scriptedEntries.set(form, entries);
  return form;
}

/**
 * Patches `FormData.prototype.entries` for the calling test file, so a form given to
 * `scriptFormEntries` yields its scripted entries and any other form its own, and restores
 * it after.
 */
export function useScriptedFormEntries(): void {
  // Read when the file's tests start, not when it is loaded, so what is restored is what
  // was there then.
  let descriptor: PropertyDescriptor | undefined;

  beforeAll(() => {
    const original = Object.getOwnPropertyDescriptor(
      FormData.prototype,
      'entries',
    ) as PropertyDescriptor;
    const intrinsicEntries = original.value as FormData['entries'];

    descriptor = original;
    Object.defineProperty(FormData.prototype, 'entries', {
      ...original,
      value: function entries(this: FormData): Iterator<unknown> {
        const scripted = scriptedEntries.get(this);
        return scripted !== undefined
          ? scripted()
          : Reflect.apply(intrinsicEntries, this, []);
      },
    });
  });
  afterAll(() => {
    if (descriptor !== undefined) {
      Object.defineProperty(FormData.prototype, 'entries', descriptor);
    }
  });
}
