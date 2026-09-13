import { describe, expect, test } from 'bun:test';
import { renderJSONLine } from './render-json-line';
import { TRUNCATED_LENGTH } from '../../../internal/render-budget';
import type { LogEntry } from '../../types';

const base: LogEntry = {
  timestamp: 1_700_000_000_000,
  type: 'info',
  serviceName: 'svc',
  template: 'hello',
  message: 'hello',
};

describe('renderJSONLine', () => {
  test('is one parseable object, with the envelope JSON.stringify would produce', () => {
    const line = renderJSONLine(
      { ...base, redactedParams: { userID: 7, tags: ['a', 'b'] } },
      () => {},
    );

    expect(JSON.parse(line)).toEqual({
      timestamp: 1_700_000_000_000,
      type: 'info',
      serviceName: 'svc',
      message: 'hello',
      params: { userID: 7, tags: ['a', 'b'] },
    });
  });

  test('omits params when the entry has none, as the old envelope did', () => {
    expect(JSON.parse(renderJSONLine(base, () => {}))).not.toHaveProperty(
      'params',
    );
  });

  test('renders what JSON.stringify refuses, as markers inside valid JSON', () => {
    const cyclic: Record<string, unknown> = { a: 1 };

    cyclic.self = cyclic;

    const line = renderJSONLine(
      {
        ...base,
        redactedParams: {
          big: 1n,
          gone: undefined,
          fn: () => 1,
          when: new Date(0),
          cyclic,
        },
      },
      () => {},
    );

    const parsed = JSON.parse(line) as { params: Record<string, unknown> };

    expect(parsed.params['big']).toBe('1');
    expect(parsed.params['gone']).toBe('[undefined]');
    expect(parsed.params['fn']).toBe('[Function: fn]');
    expect(parsed.params['when']).toBe('1970-01-01T00:00:00.000Z');
    expect((parsed.params['cyclic'] as Record<string, unknown>)['self']).toBe(
      '[circular]',
    );
  });

  test('reports a value that would not render, once, and keeps the line', () => {
    const reports: Error[] = [];

    const line = renderJSONLine(
      {
        ...base,
        redactedParams: {
          ok: 1,
          get boom(): never {
            throw new Error('getter exploded');
          },
          get again(): never {
            throw new Error('second getter');
          },
        },
      },
      (error) => reports.push(error),
    );

    const parsed = JSON.parse(line) as { params: Record<string, unknown> };

    expect(parsed.params['ok']).toBe(1);
    expect(parsed.params['boom']).toBe('[unrenderable: value]');
    // Once per line, not once per value: the first is the informative one.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.message).toContain('getter exploded');
  });

  test('stays JSON when the params are cut at the render cap', () => {
    // The renderer's own cap applies to the bag, and the cut lands inside a string. The
    // truncation marker is escaped like any other text, so the line still parses and
    // the marker is visible where the value ended.
    const line = renderJSONLine(
      { ...base, redactedParams: { huge: 'x'.repeat(2_000_000), after: 1 } },
      () => {},
    );

    const parsed = JSON.parse(line) as { params: Record<string, unknown> };

    expect(line.length).toBeLessThan(1_100_000);
    expect(String(parsed.params['huge']).endsWith(TRUNCATED_LENGTH)).toBe(true);
  });

  test('stays JSON when the bag itself cannot be rendered', () => {
    // A revoked Proxy for the whole bag renders to bare `[object Object]` at
    // stringifyValue's top level, which is template text rather than JSON. Rendered one
    // level down it is a quoted marker, and the line still parses.
    const { proxy, revoke } = Proxy.revocable<Record<string, unknown>>({}, {});

    revoke();

    const line = renderJSONLine({ ...base, redactedParams: proxy }, () => {});
    const parsed = JSON.parse(line) as { params: unknown };

    expect(typeof parsed.params).toBe('string');
  });
});
