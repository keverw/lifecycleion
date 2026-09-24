/**
 * Test-only helper: rejected native promises that hide from naive handling, for the
 * suites that check a returned promise is adopted rather than trusted. One carries an own
 * `then` that is not a function, so a `then`-check misses it; the other an own `then`
 * that does nothing, so `Promise.resolve()` hands it back and `.catch` calls that `then`.
 * Either way, handled naively, the rejection goes unhandled.
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
];
