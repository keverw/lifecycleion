import { expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { NodeAdapter } from './node-adapter';
import { REQUEST_BODY_SETTLED_KEY } from '../consts';
import type { AdapterRequest } from '../types';

test.each(['string', 'bytes', 'multipart'] as const)(
  '%s upload settles and reports a throw in its failure handler',
  async (kind) => {
    const writeFailure = new Error('request end failed');
    const handlerFailure = new Error('signal getter failed during recovery');
    let hasWriteFailed = false;
    const req = Object.assign(new EventEmitter(), {
      destroyed: false,
      setHeader() {},
      write(_data: unknown, callback?: (error: Error | null) => void) {
        callback?.(null);
        return true;
      },
      end() {},
      destroy() {
        this.destroyed = true;
        return this;
      },
    });
    const endSpy = spyOn(req, 'end').mockImplementation(() => {
      hasWriteFailed = true;
      throw writeFailure;
    });
    const requestSpy = spyOn(http, 'request').mockImplementation(
      () => req as unknown as http.ClientRequest,
    );
    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };
    globalThis.addEventListener('error', onError);
    const form = new FormData();
    form.append('field', 'payload');
    try {
      const request: AdapterRequest = {
        requestURL: 'http://example.test/upload',
        method: 'POST',
        headers: {},
        body:
          kind === 'multipart'
            ? form
            : kind === 'bytes'
              ? new TextEncoder().encode('payload')
              : 'payload',
        get signal() {
          if (hasWriteFailed) {
            throw handlerFailure;
          }
          return undefined;
        },
      };
      const pending = new NodeAdapter().send(request);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const bounded = Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('Adapter remained pending')),
              200,
            );
          }),
        ]);
        const failure = await bounded.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toBe(handlerFailure);
      } finally {
        clearTimeout(deadline);
      }
      expect(reports).toHaveLength(1);
      expect((reports[0] as Error).cause).toBeInstanceOf(AggregateError);
      expect(((reports[0] as Error).cause as AggregateError).errors).toEqual([
        writeFailure,
        handlerFailure,
      ]);
      const outcome = Reflect.get(handlerFailure, REQUEST_BODY_SETTLED_KEY);
      expect(outcome).toBeDefined();
      expect(await outcome).toBe(writeFailure);
      expect(req.destroyed).toBe(true);
    } finally {
      globalThis.removeEventListener('error', onError);
      requestSpy.mockRestore();
      endSpy.mockRestore();
    }
  },
  1000,
);
