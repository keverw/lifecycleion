import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import { DependencyCycleError } from '../errors';
import { Plain } from '../test-helpers';
import {
  dependenciesOf,
  findAllCircularCycles,
  findDependencyCycle,
  getStartupOrder,
  tryReadDependencies,
} from './dependency-policy';

test('ordering keeps registration priority among available nodes and ignores missing or duplicate edges', () => {
  const dependencies: Record<string, string[]> = {
    consumer: ['provider', 'provider', 'missing'],
    independent: [],
    provider: [],
  };
  expect(
    getStartupOrder(
      Object.keys(dependencies),
      (name) => name,
      (name) => dependencies[name],
    ),
  ).toEqual(['independent', 'provider', 'consumer']);
});

test('all names are captured before dependency suppliers run, once per component', () => {
  const calls: string[] = [];
  const components = [{ name: 'consumer' }, { name: 'provider' }];
  const order = getStartupOrder(
    components,
    (component) => {
      calls.push(`name:${component.name}`);
      return component.name;
    },
    (component) => {
      calls.push(`dependencies:${component.name}`);
      if (component === components[0]) {
        components[0].name = 'changed-after-naming';
        return ['provider'];
      }
      return [];
    },
  );
  expect(order).toEqual(['provider', 'consumer']);
  expect(calls).toEqual([
    'name:consumer',
    'name:provider',
    'dependencies:consumer',
    'dependencies:provider',
  ]);
});

test('cycle discovery covers disconnected cycles and ordering rejects cyclic graphs', () => {
  const graph = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
    ['c', new Set(['c'])],
  ]);
  expect(findDependencyCycle(graph)).toEqual(['a', 'b']);
  expect(findAllCircularCycles(graph)).toEqual([['a', 'b'], ['c']]);
  expect(() =>
    getStartupOrder(
      [...graph.keys()],
      (name) => name,
      (name) => [...(graph.get(name) ?? [])],
    ),
  ).toThrow(DependencyCycleError);
});

test('duplicate names fail as a broken invariant, not as an empty dependency cycle', () => {
  let failure: unknown;
  try {
    getStartupOrder(
      ['first', 'second', 'first'],
      (name) => name,
      () => [],
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(DependencyCycleError);
  expect((failure as Error).message).toContain(
    '"first" appears more than once',
  );
});

test('dependency reads retain valid entries while exposing a malformed entry', () => {
  const component = new Plain(
    new Logger({ sinks: [], callProcessExit: false }),
    'example',
  );
  Object.defineProperty(component, 'getDependencies', {
    value: () => ['first', Object.create(null), 'last'],
  });
  const read = tryReadDependencies(component);
  expect(dependenciesOf(read)).toEqual(['first', 'last']);
  expect('invalidEntry' in read && read.invalidEntry).toBeInstanceOf(TypeError);
  expect(dependenciesOf(undefined)).toEqual([]);
});

test('implausible proxy lengths are refused without reading entries', () => {
  const component = new Plain(
    new Logger({ sinks: [], callProcessExit: false }),
    'example',
  );
  let entryReads = 0;
  const list = new Proxy([], {
    get: (_target, property) => {
      if (property === 'length') {
        return Infinity;
      }
      entryReads++;
      throw new Error('entry must not be read');
    },
  });
  Object.defineProperty(component, 'getDependencies', { value: () => list });
  const read = tryReadDependencies(component);
  expect('error' in read && read.error).toBeInstanceOf(TypeError);
  expect(entryReads).toBe(0);
  expect(dependenciesOf(read)).toEqual([]);
});

test.each<unknown>([
  Symbol('length'),
  {
    valueOf() {
      throw new Error('valueOf ran');
    },
  },
  '1',
])(
  'a non-number proxy length (%p) is refused as a read error, not thrown',
  (length) => {
    const component = new Plain(
      new Logger({ sinks: [], callProcessExit: false }),
      'example',
    );
    const list = new Proxy(['dependency'], {
      get: (target, property, receiver) =>
        property === 'length'
          ? length
          : (Reflect.get(target, property, receiver) as unknown),
    });
    Object.defineProperty(component, 'getDependencies', { value: () => list });
    const read = tryReadDependencies(component);
    expect('error' in read && read.error).toBeInstanceOf(TypeError);
    expect('error' in read && (read.error as Error).message).toContain(
      'implausible length: a non-number',
    );
  },
);

test('a thrown dependency getter preserves the original failure', () => {
  const component = new Plain(
    new Logger({ sinks: [], callProcessExit: false }),
    'example',
  );
  const failure = new Error('unreadable dependencies');
  Object.defineProperty(component, 'getDependencies', {
    get: () => {
      throw failure;
    },
  });
  expect(tryReadDependencies(component)).toEqual({ error: failure });
});

test('cycle search handles a chain deeper than the call stack', () => {
  const depth = 200_000;
  const graph = new Map<string, Set<string>>();
  for (let index = 0; index < depth; index++) {
    graph.set(`c${index}`, new Set(index + 1 < depth ? [`c${index + 1}`] : []));
  }

  expect(findAllCircularCycles(graph)).toEqual([]);
  expect(findDependencyCycle(graph)).toEqual([]);

  graph.get(`c${depth - 1}`)?.add('c0');
  expect(findDependencyCycle(graph)).toHaveLength(depth);
  expect(findAllCircularCycles(graph)).toHaveLength(1);
});

test('cycle discovery bounds the names it reports for a densely connected graph', () => {
  // Every back edge closes a cycle: unbounded, 800 mutually dependent components
  // reported about 85 million names.
  const count = 800;
  const names = Array.from({ length: count }, (_, index) => `c${index}`);
  const graph = new Map(
    names.map((name) => [
      name,
      new Set(names.filter((other) => other !== name)),
    ]),
  );

  const cycles = findAllCircularCycles(graph);
  const reported = cycles.reduce((total, cycle) => total + cycle.length, 0);
  expect(cycles.length).toBeGreaterThan(0);
  // The bound is reached, and the cycle that reaches it is reported whole.
  expect(reported).toBeGreaterThanOrEqual(10_000);
  expect(reported).toBeLessThan(10_000 + count);
  for (const cycle of cycles) {
    for (let index = 0; index < cycle.length; index++) {
      expect(
        graph.get(cycle[index])?.has(cycle[(index + 1) % cycle.length]),
      ).toBe(true);
    }
  }
});

// The order before the pick moved to a heap: scan every available name for the lowest
// registration index. Kept as the reference the heap must reproduce exactly.
function referenceStartupOrder(
  names: string[],
  dependencies: Record<string, string[]>,
): string[] {
  const regIndex = new Map(names.map((name, index) => [name, index]));
  const adjacency = new Map(names.map((name) => [name, new Set<string>()]));
  const inDegree = new Map(names.map((name) => [name, 0]));
  for (const dependent of names) {
    for (const dependency of dependencies[dependent]) {
      const neighbors = adjacency.get(dependency);
      if (neighbors === undefined || neighbors.has(dependent)) {
        continue;
      }
      neighbors.add(dependent);
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
    }
  }
  const available = new Set(names.filter((name) => inDegree.get(name) === 0));
  const order: string[] = [];
  while (available.size > 0) {
    let next = '';
    let nextIndex = Infinity;
    for (const name of available) {
      const index = regIndex.get(name) ?? 0;
      if (index < nextIndex) {
        next = name;
        nextIndex = index;
      }
    }
    available.delete(next);
    order.push(next);
    for (const neighbor of adjacency.get(next) ?? []) {
      const remaining = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, remaining);
      if (remaining === 0) {
        available.add(neighbor);
      }
    }
  }
  return order;
}

test('ordering matches the lowest-registration-index scan on random acyclic graphs', () => {
  // A small deterministic generator, so a failure reproduces.
  let seed = 0x2f6b1d;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  for (let round = 0; round < 200; round++) {
    const size = 1 + Math.floor(random() * 40);
    // Acyclic by construction: each node depends only on lower ranks, and the ranks
    // are then shuffled into a different registration order.
    const ranked = Array.from({ length: size }, (_, index) => `c${index}`);
    const dependencies: Record<string, string[]> = {};
    for (const [rank, name] of ranked.entries()) {
      dependencies[name] = ranked
        .slice(0, rank)
        .filter(() => random() < 0.15)
        .concat(random() < 0.1 ? ['missing'] : []);
    }
    const names = [...ranked];
    for (let index = names.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [names[index], names[other]] = [names[other], names[index]];
    }

    expect(
      getStartupOrder(
        names,
        (name) => name,
        (name) => dependencies[name],
      ),
    ).toEqual(referenceStartupOrder(names, dependencies));
  }
});

test('ordering a wide registry with no dependencies keeps registration order', () => {
  const names = Array.from({ length: 5_000 }, (_, index) => `c${index}`);
  expect(
    getStartupOrder(
      names,
      (name) => name,
      () => [],
    ),
  ).toEqual(names);
});
