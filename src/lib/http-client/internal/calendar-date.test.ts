import { describe, expect, test } from 'bun:test';
import {
  LONG_MONTH_NAMES,
  SHORT_MONTH_NAMES,
  monthIndexOf,
  utcMoment,
} from './calendar-date';

describe('monthIndexOf', () => {
  test('every short and long month name is its month, in any ASCII case', () => {
    for (const [index, name] of SHORT_MONTH_NAMES.entries()) {
      expect(monthIndexOf(name)).toBe(index);
      expect(monthIndexOf(name.toUpperCase())).toBe(index);
      expect(monthIndexOf(LONG_MONTH_NAMES[index])).toBe(index);
    }
  });

  test('a name that begins with no month is -1', () => {
    for (const name of ['', 'No', 'Xyz', 'Mon', 'ja']) {
      expect(monthIndexOf(name)).toBe(-1);
    }
  });
});

describe('utcMoment', () => {
  test('a real date and time is its epoch time, a year below 100 as written', () => {
    expect(utcMoment(2026, 10, 8, 12, 0, 30)).toBe(
      Date.UTC(2026, 10, 8, 12, 0, 30),
    );
    expect(
      new Date(utcMoment(26, 0, 1, 0, 0, 0) as number).getUTCFullYear(),
    ).toBe(26);
  });

  test('a date or time that names no moment is undefined', () => {
    for (const parts of [
      [2026, -1, 1, 0, 0, 0],
      [2026, 12, 1, 0, 0, 0],
      [2026, 1, 29, 0, 0, 0],
      [2026, 0, 0, 0, 0, 0],
      [2026, 0, 32, 0, 0, 0],
      [2026, 0, 1, 24, 0, 0],
      [2026, 0, 1, 0, 60, 0],
      [2026, 0, 1, 0, 0, 60],
    ] as Array<[number, number, number, number, number, number]>) {
      expect(utcMoment(...parts)).toBeUndefined();
    }
  });
});
