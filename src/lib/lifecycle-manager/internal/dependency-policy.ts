import type { BaseComponent } from '../base-component';
import { DependencyCycleError } from '../errors';

/**
 * The most dependencies one component's `getDependencies()` is read for. See
 * `tryReadDependencies()`.
 */
const MAX_DECLARED_DEPENDENCIES = 10_000;

/** One read of a component's `getDependencies()`; see `tryReadDependencies()`. */
export type DependencyRead =
  { dependencies: string[]; invalidEntry?: TypeError } | { error: unknown };

/**
 * The list a read yields, tolerantly: its string entries, or none for a read that
 * failed - or for a component with no read.
 */
export function dependenciesOf(read: DependencyRead | undefined): string[] {
  return read !== undefined && 'dependencies' in read ? read.dependencies : [];
}

/** Read a bounded dependency list without reporting caller failures. */
export function tryReadDependencies(component: BaseComponent): DependencyRead {
  try {
    const dependencies: unknown = component.getDependencies();

    if (Array.isArray(dependencies)) {
      const copy: string[] = [];
      const length = Number(Reflect.get(dependencies, 'length'));

      // Bounded before the loop: a proxy passes `Array.isArray` and can report any
      // `length` - `Infinity` would block the event loop in the copy below, with no
      // timeout to rescue it. Far more dependencies than any component declares is a
      // broken list, not one to read.
      if (
        !Number.isInteger(length) ||
        length < 0 ||
        length > MAX_DECLARED_DEPENDENCIES
      ) {
        return {
          error: new TypeError(
            `getDependencies() returned an implausible length: ${String(length)}`,
          ),
        };
      }

      let invalidEntry: TypeError | undefined;

      for (let index = 0; index < length; index++) {
        const dependency: unknown = Reflect.get(dependencies, index);

        if (typeof dependency === 'string') {
          copy.push(dependency);
        } else {
          // Kept out of the copy, but not silently: the component's own start fails
          // on it, and validation lists it, so every caller hears about it.
          // Described by type, not `String()`: that throws for some values - a
          // null-prototype object - and would discard the valid entries too.
          invalidEntry ??= new TypeError(
            `getDependencies() returned a non-string entry (${dependency === null ? 'null' : typeof dependency})`,
          );
        }
      }

      return invalidEntry === undefined
        ? { dependencies: copy }
        : { dependencies: copy, invalidEntry };
    }

    return {
      error: new TypeError('getDependencies() did not return an array'),
    };
  } catch (error) {
    return { error };
  }
}

/**
 * Stable dependency-aware order. The callbacks retain the manager's naming and
 * dependency-read policy, including registration candidates and snapshots.
 * All names are captured before any dependency reads, and dependencies are read
 * lazily from the original component-array iterator after graph setup.
 */
export function getStartupOrder<T>(
  components: T[],
  nameOf: (component: T) => string,
  readDependencies: (component: T) => string[],
): string[] {
  const names = components.map(nameOf);
  const regIndex = new Map<string, number>(
    names.map((name, idx) => [name, idx]),
  );

  const adjacency = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const name of names) {
    adjacency.set(name, new Set());
    inDegree.set(name, 0);
  }

  // Build edges: dependency -> dependent (only when dependency is registered)
  for (const [index, component] of components.entries()) {
    const dependent = names[index];
    const dependencies = readDependencies(component);

    for (const dep of dependencies) {
      if (!regIndex.has(dep)) {
        continue;
      }
      const neighbors = adjacency.get(dep);
      if (!neighbors) {
        continue;
      }
      if (neighbors.has(dependent)) {
        continue;
      }
      neighbors.add(dependent);
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
    }
  }

  const available = new Set<string>();
  for (const name of names) {
    if ((inDegree.get(name) ?? 0) === 0) {
      available.add(name);
    }
  }

  const order: string[] = [];
  while (available.size > 0) {
    // Stable pick: lowest registration index. Scanned rather than sorted - a sort per
    // step made ordering O(n² log n), and it runs on every registration.
    let next = '';
    let nextIndex = Infinity;

    for (const candidateName of available) {
      const index = regIndex.get(candidateName) ?? 0;

      if (index < nextIndex) {
        next = candidateName;
        nextIndex = index;
      }
    }

    available.delete(next);
    order.push(next);

    for (const neighbor of adjacency.get(next) ?? []) {
      const nextInDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, nextInDegree);
      if (nextInDegree === 0) {
        available.add(neighbor);
      }
    }
  }

  if (order.length !== names.length) {
    const ordered = new Set(order);
    const remaining = names.filter((n) => !ordered.has(n));
    const cycle = findDependencyCycle(adjacency);
    throw new DependencyCycleError({
      cycle: cycle.length > 0 ? cycle : remaining,
    });
  }

  return order;
}

/**
 * Find a single dependency cycle (for error reporting during registration)
 * Returns the first cycle found, or empty array if no cycle exists
 *
 * Performance note: This method exits early after finding the first cycle,
 * which is optimal for hot paths (registration, startup order resolution).
 * For comprehensive validation that needs ALL cycles, use findAllCircularCycles().
 */
export function findDependencyCycle(
  adjacency: Map<string, Set<string>>,
): string[] {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  const visit = (node: string): string[] | null => {
    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        const result = visit(neighbor);
        if (result) {
          return result;
        }
      } else if (inStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor);
        return cycleStart >= 0 ? path.slice(cycleStart) : [neighbor];
      }
    }

    inStack.delete(node);
    path.pop();
    return null;
  };

  for (const node of adjacency.keys()) {
    if (visited.has(node)) {
      continue;
    }
    const result = visit(node);
    if (result) {
      return result;
    }
  }

  return [];
}

/**
 * Find circular dependency cycles using Depth-First Search (DFS) with cycle detection.
 *
 * Algorithm: DFS with visited set and recursion stack tracking
 * - Uses 'visited' set to ensure each node is processed exactly once (prevents infinite loops)
 * - Uses 'inStack' set to track the current DFS recursion path
 * - When a node in the current path is encountered again, a cycle is detected
 * - Extracts the cycle from the path and continues searching for more cycles
 *
 * Time Complexity: O(V + E) where V = components, E = dependency edges
 * Space Complexity: O(V) for visited/inStack sets and recursion stack
 *
 * Performance note: This method finds a representative set of cycles while ensuring
 * each node is visited once (prevents infinite loops). For hot paths that only need
 * one cycle, use findDependencyCycle() which exits early.
 *
 * Returns an array of detected cycles, where each cycle is an array of component names.
 */
export function findAllCircularCycles(
  adjacency: Map<string, Set<string>>,
): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  const visit = (node: string): void => {
    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        // Continue DFS to unvisited neighbor
        visit(neighbor);
      } else if (inStack.has(neighbor)) {
        // Found a cycle - extract it from the path
        const cycleStart = path.indexOf(neighbor);
        if (cycleStart >= 0) {
          const cycle = path.slice(cycleStart);
          cycles.push(cycle);
        }
      }
    }

    inStack.delete(node);
    path.pop();
  };

  // Visit all nodes to find all cycles (including disconnected components)
  for (const node of adjacency.keys()) {
    if (!visited.has(node)) {
      visit(node);
    }
  }

  return cycles;
}
