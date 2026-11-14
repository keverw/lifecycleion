import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { isBunRuntime } from './is-bun-runtime';

/** The module evaluated in a fresh global, so its `Bun` can be one of the test's own. */
function evaluateIn(defineGlobals: (global: object) => void): unknown {
  const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    readFileSync(path.join(import.meta.dir, 'is-bun-runtime.ts'), 'utf8'),
  );
  const context = vm.createContext({});
  defineGlobals(vm.runInContext('globalThis', context) as object);

  return vm.runInContext(
    `${source.replace(/export\s+const\s+isBunRuntime/, 'var isBunRuntime')}; isBunRuntime`,
    context,
  );
}

describe('isBunRuntime', () => {
  test('is true on Bun', () => {
    expect(isBunRuntime).toBe(true);
  });

  test('is false where there is no Bun global', () => {
    expect(evaluateIn(() => undefined)).toBe(false);
  });

  test('is false, rather than failing the import, where the Bun global throws', () => {
    expect(
      evaluateIn((global) => {
        Object.defineProperty(global, 'Bun', {
          get() {
            throw new Error('sandboxed');
          },
        });
      }),
    ).toBe(false);
  });
});
