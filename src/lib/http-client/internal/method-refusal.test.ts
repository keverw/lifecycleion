import { expect, test } from 'bun:test';
import { FetchAdapter } from '../adapters/fetch-adapter';
import { HTTPClient } from '../http-client';
import {
  bodyOnBodilessMethodMessage,
  forbiddenMethodMessage,
  isBodilessMethod,
  isForbiddenBrowserMethod,
} from './method-refusal';

test('the rules read a method by its ASCII case alone', () => {
  expect(['CONNECT', 'trace', 'Track'].map(isForbiddenBrowserMethod)).toEqual([
    true,
    true,
    true,
  ]);
  expect(isForbiddenBrowserMethod('POST')).toBe(false);
  expect(['GET', 'head'].map(isBodilessMethod)).toEqual([true, true]);
  expect(isBodilessMethod('POST')).toBe(false);
});

test('FetchAdapter driven directly refuses as the client does, in the same words', async () => {
  const adapter = new FetchAdapter();
  const refusals: string[] = [];

  for (const request of [
    { method: 'TRACE', body: undefined },
    { method: 'GET', body: 'x' },
    { method: 'head', body: '' },
  ] as const) {
    try {
      await adapter.send({
        requestURL: 'https://api.example.com/x',
        headers: {},
        ...request,
      });
    } catch (error) {
      refusals.push((error as Error).message);
    }
  }

  const client = new HTTPClient({ adapter });
  const builder = client.request('TRACE', 'https://api.example.com/x');
  await builder.send();
  const reported = builder.error?.cause;

  expect(refusals).toEqual([
    forbiddenMethodMessage('FetchAdapter', 'TRACE'),
    bodyOnBodilessMethodMessage('fetch', 'GET'),
    bodyOnBodilessMethodMessage('fetch', 'HEAD'),
  ]);
  expect(builder.error?.code).toBe('request_setup_error');
  expect(
    reported instanceof Error ? reported.message : builder.error?.message,
  ).toBe(forbiddenMethodMessage('FetchAdapter', 'TRACE'));
});
