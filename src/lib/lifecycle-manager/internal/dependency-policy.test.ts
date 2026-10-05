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
