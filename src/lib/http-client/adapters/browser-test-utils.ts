export interface BrowserTestResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface BrowserTestSuite {
  passed: boolean;
  results: BrowserTestResult[];
}

export type Matcher = {
  toBe(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toContain(str: string): void;
  toBeInstanceOf(cls: new (...args: never[]) => unknown): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeUint8Array(): void;
};

function serialize(v: Record<string, unknown> | null): string {
  return JSON.stringify(v) ?? 'null';
}

export function browserExpect(value: unknown): Matcher {
  const str = (): string => {
    if (value === null) {
      return 'null';
    }

    switch (typeof value) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'bigint':
      case 'undefined':
        return `${value}`;
      case 'symbol':
        return value.toString();
      case 'function':
        return `[Function ${(value as () => void).name || 'anonymous'}]`;
      default:
        return serialize(value as Record<string, unknown>);
    }
  };

  return {
    toBe(expected) {
      if (value !== expected) {
        throw new Error(
          `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
        );
      }
    },
    toBeTruthy() {
      if (!value) {
        throw new Error(`Expected truthy, got ${str()}`);
      }
    },
    toBeFalsy() {
      if (value) {
        throw new Error(`Expected falsy, got ${str()}`);
      }
    },
    toBeNull() {
      if (value !== null) {
        throw new Error(`Expected null, got ${str()}`);
      }
    },
    toBeDefined() {
      if (value === undefined) {
        throw new Error(`Expected defined, got ${str()}`);
      }
    },
    toBeUndefined() {
      if (value !== undefined) {
        throw new Error(`Expected undefined, got ${str()}`);
      }
    },
    toContain(sub) {
      if (typeof value !== 'string' || !value.includes(sub)) {
        throw new Error(`Expected "${str()}" to contain "${sub}"`);
      }
    },
    toBeInstanceOf(cls) {
      if (!(value instanceof cls)) {
        throw new TypeError(`Expected instance of ${cls.name}, got ${str()}`);
      }
    },
    toBeGreaterThanOrEqual(n) {
      if (typeof value !== 'number' || value < n) {
        throw new Error(`Expected >= ${n}, got ${str()}`);
      }
    },
    toBeUint8Array() {
      if (!(value instanceof Uint8Array)) {
        throw new TypeError(`Expected Uint8Array, got ${str()}`);
      }
    },
  };
}

export function createBrowserTestRunner() {
  const results: BrowserTestResult[] = [];

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  }

  function finish(): BrowserTestSuite {
    return {
      passed: results.every((r) => r.passed),
      results,
    };
  }

  return { test, finish };
}
