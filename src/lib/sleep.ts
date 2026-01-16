/**
 * Sleeps the function for the specified number of milliseconds
 * Your code will not do it's next step during this time while you await
 *
 *  ```typescript
 * await sleep(1000);
 * ```
 */

export async function sleep(time: number): Promise<void> {
  return new Promise<void>(function (resolve) {
    setTimeout(function () {
      resolve();
    }, time);
  });
}
