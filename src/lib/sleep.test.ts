import { performance } from './unix-time-helpers';
import { expect, it } from 'bun:test';
import { sleep } from './sleep';

it('should sleep', async () => {
  const time = performance();

  await sleep(1000); // 1 second worth of time

  const timeRan = performance() - time;

  expect(timeRan).toBeGreaterThanOrEqual(1000);
  expect(timeRan).toBeLessThanOrEqual(2000);
});
