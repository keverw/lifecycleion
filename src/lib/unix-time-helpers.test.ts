import {
  convertMSToUnix,
  convertUnixToMS,
  ms,
  performance,
  unix,
} from './unix-time-helpers';
import { describe, expect, it } from 'bun:test';

describe('Unix TimeHelpers', () => {
  it('should return unix time in seconds', (done) => {
    const time = unix();

    expect(typeof time).toEqual('number');
    expect(time).toBeGreaterThan(0);

    setTimeout(() => {
      const newTime = unix();
      expect(newTime).toBeGreaterThan(time);
      done();
    }, 2000);
  });

  it('ms() should return a unix time in milliseconds', (done) => {
    const time = ms();

    expect(typeof time).toEqual('number');
    expect(time).toBeGreaterThan(0);

    setTimeout(() => {
      const newTime = ms();
      expect(newTime).toBeGreaterThan(time);
      done();
    }, 2000);
  });

  it('performance() should return a unix time in milliseconds', (done) => {
    const time = performance();

    expect(typeof time).toEqual('number');
    expect(time).toBeGreaterThan(0);

    setTimeout(() => {
      const newTime = ms();
      expect(newTime).toBeGreaterThan(time);
      done();
    }, 2000);
  });

  it('convertMS() should convert from milliseconds timestamp to unix seconds', () => {
    expect(convertMSToUnix(1593189055006)).toEqual(1593189055);
  });

  it('convertUnix() should convert a unix timestamp from seconds to milliseconds', () => {
    const input = 1593189055;
    const expectedOutput = 1593189055000;
    const result = convertUnixToMS(input);

    expect(result).toBe(expectedOutput);
  });
});
