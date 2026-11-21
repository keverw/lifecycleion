import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import type { ComponentOptions } from './types';

class Plain extends BaseComponent {
  constructor(options: Partial<ComponentOptions> = {}) {
    super(new Logger({ sinks: [], callProcessExit: false }), {
      name: 'plain',
      ...options,
    });
  }

  public start(): void {}
  public stop(): void {}
}

test('optional defaults to false and keeps a boolean as given', () => {
  expect(new Plain().optional).toBe(false);
  expect(new Plain({ optional: true }).optional).toBe(true);
  expect(new Plain({ optional: false }).optional).toBe(false);
  expect(new Plain({ optional: null as unknown as boolean }).optional).toBe(
    false,
  );
});

test.each([['yes'], [1], [{}], [0]])(
  'the constructor refuses a non-boolean optional (%p)',
  (value) => {
    expect(() => new Plain({ optional: value as unknown as boolean })).toThrow(
      new TypeError('optional must be a boolean'),
    );
  },
);
