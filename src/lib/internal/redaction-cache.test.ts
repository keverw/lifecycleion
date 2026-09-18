import { expect, test } from 'bun:test';
import { redactValue, stringifyValue } from '../stringify-value';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';

const SECRET = 'TOPSECRET-VALUE-cache-regression';
const redactedKeys = ['p.q', 'z.secret'];
const cappedDepths = Array.from({ length: 14 }, (_, index) => index + 47);

function twoRoutes(depth: number, isReversed: boolean) {
  const z: { secret: string; c?: object } = { secret: SECRET };
  const shared = { up: z };
  const chain = (): object => {
    let node: object = shared;
    for (let index = 0; index < depth; index++) {
      node = { c: node };
    }
    return node;
  };
  // Distinct chains reach the same node at the same depth. On the p route,
  // shared.up reaches z before z is an ancestor; on the z route it closes a cycle.
  z.c = chain();
  const p = { q: 'mask-me', c: chain() };
  return isReversed ? { z, p } : { p, z };
}

for (const isReversed of [false, true]) {
  test.each(cappedDepths)(
    `a depth-capped cache cannot leak through a second route (isReversed=${String(isReversed)}, depth=%d)`,
    (depth) => {
      const input = twoRoutes(depth, isReversed);
      const result = redactValue(input, { redactedKeys }) as typeof input;
      // Inspect the returned subtree too: rendering alone could conceal an unsafe
      // reference behind its own depth limit.
      expect(JSON.stringify(result.z)).not.toContain(SECRET);
      expect(stringifyValue(result.z)).not.toContain(SECRET);
      expect(input.z.secret).toBe(SECRET);
      expect(result.p.q).not.toBe(input.p.q);
    },
  );

  test.each(cappedDepths)(
    `logger templates cannot reuse a depth-capped cache (isReversed=${String(isReversed)}, depth=%d)`,
    (depth) => {
      const sink = new ArraySink();
      const logger = new Logger({ sinks: [sink], callProcessExit: false });
      logger.info('{{z}}', {
        params: twoRoutes(depth, isReversed),
        redactedKeys,
      });
      expect(sink.logs).toHaveLength(1);
      expect(sink.logs[0].message).toContain('secret');
      expect(sink.logs[0].message).not.toContain(SECRET);
    },
  );
}
