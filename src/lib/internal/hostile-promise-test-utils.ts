/**
 * Test-only helper: rejected native promises that hide from naive handling, for the
 * suites that check a returned promise is adopted rather than trusted. One carries an own
 * `then` that is not a function, so a `then`-check misses it; one an own `then` that does
 * nothing, so `Promise.resolve()` hands it back and `.catch` calls that `then`; and one
 * adds its own `constructor`, which makes even `await` call it. Handled naively, the
 * rejection goes unhandled, or the caller waits forever.
 */
export const hostileRejections: Array<
  [label: string, make: (error: Error) => Promise<never>]
> = [
  [
    'a non-function own then',
    (error) => Object.assign(Promise.reject(error), { then: 1 }),
  ],
  [
    'an own no-op then',
    (error) => {
      const promise = Promise.reject(error);
      void Object.defineProperty(promise, 'then', { value: () => undefined });

      return promise;
    },
  ],
  // `await` and `Promise.resolve()` ignore an own `then` on a native promise whose
  // `constructor` is `Promise`, but not on one carrying its own: they wrap it, and the
  // wrapper calls the no-op `then`.
  [
    'an own constructor and no-op then',
    (error) => {
      const promise = Promise.reject(error);
      void Object.defineProperty(promise, 'constructor', { value: Object });
      void Object.defineProperty(promise, 'then', { value: () => undefined });

      return promise;
    },
  ],
];
