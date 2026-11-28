import { describe, expect, test } from 'bun:test';
import { assertKnownFields } from './known-fields';

const FIELDS = ['followRedirects', 'timeout', 'maxRetryAfterMS'];

function refusalFor(key: string): string {
  try {
    assertKnownFields({ [key]: 1 }, FIELDS, 'Options');
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('assertKnownFields', () => {
  test('lets known fields, and unknown ones holding null or undefined, through', () => {
    expect(() =>
      assertKnownFields(
        { timeout: 1, extra: undefined, other: null },
        FIELDS,
        'Options',
      ),
    ).not.toThrow();
  });

  test.each([
    'folowRedirects',
    'timout',
    'TIMEOUT',
    'retryDelayMS',
    'maxRetryAfterMs',
  ])('names an unknown key that reads as an option name: %s', (key) => {
    expect(refusalFor(key)).toBe(
      `Options has no ${JSON.stringify(key)} field (it takes ${FIELDS.join(', ')})`,
    );
  });

  test.each([
    'hunter2',
    'correcthorsebatterystaple',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer abc.def',
    'sk_live_51H8',
  ])('does not name a key that may be a secret: %s', (key) => {
    expect(refusalFor(key)).toBe(
      `Options has no field by that name (it takes ${FIELDS.join(', ')})`,
    );
  });

  test('does not name a key longer than any option name, however it reads', () => {
    const key = `a${'Bc'.repeat(500_000)}`;
    const message = refusalFor(key);

    expect(message).toBe(
      `Options has no field by that name (it takes ${FIELDS.join(', ')})`,
    );
    expect(refusalFor(`someLongCamelCaseOptionNameThatGoesOnAndOn`)).toContain(
      'field by that name',
    );
  });
});
