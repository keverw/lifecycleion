import { expect, spyOn, test } from 'bun:test';
import {
  deferredBodyCopy,
  deferredJSONRawBody,
  handedBodyValue,
} from './observed-bodies';
import type { HeldAttemptRequest } from './observed-bodies';
import type { AttemptRequest } from '../types';

test('a token is built once, the first time it is asked for, and answers that value after', () => {
  const parse = spyOn(JSON, 'parse');
  try {
    const token = deferredJSONRawBody('{"a":1}');

    expect(parse).toHaveBeenCalledTimes(0);

    const first = handedBodyValue(token);

    expect(first).toEqual({ a: 1 });
    expect(handedBodyValue(token)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});

test('a build that throws is not run again: each later ask throws the error it threw', () => {
  const form = new FormData();
  form.append('field', 'value');
  const token = deferredBodyCopy(form);
  const failure = new Error('copy failed');
  const append = spyOn(FormData.prototype, 'append').mockImplementation(() => {
    throw failure;
  });
  try {
    expect(() => handedBodyValue(token)).toThrow(failure);
    expect(() => handedBodyValue(token)).toThrow(failure);
    expect(append).toHaveBeenCalledTimes(1);
  } finally {
    append.mockRestore();
  }
});

test('a value that is no token is answered as it is', () => {
  const bytes = new Uint8Array([1]);

  expect(handedBodyValue(bytes)).toBe(bytes);
  expect(handedBodyValue('text')).toBe('text');
  expect(handedBodyValue(null)).toBeNull();
});

test('a request holding a token is not an AttemptRequest to the type checker', () => {
  const held: HeldAttemptRequest = {
    requestURL: 'https://api.example.com/x',
    method: 'PUT',
    headers: {},
    body: deferredBodyCopy(new Uint8Array([1])),
  };
  // @ts-expect-error - a token in `body` must be read into a copy before caller code is
  // handed the request.
  const leaked: AttemptRequest = held;

  expect(leaked.body).not.toBeInstanceOf(Uint8Array);
});
