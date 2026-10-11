import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import { DependencyCycleError } from '../errors';
import type { DependencyValidationResult, StartupOrderResult } from '../types';
import {
  type DependencyRead,
  dependenciesOf,
  findAllCircularCycles,
  getStartupOrder,
} from './dependency-policy';
import type { ManagerCore } from './manager-core';

/**
 * The manager's startup order: the registry in dependency order, as `getStartupOrder()`
 * answers it, a bulk startup starts it, a shutdown pass stops it in reverse, and
 * registration checks a placement against it - and the one way all of them answer a
 * failure to compute it. `getStartupOrder()` and `validateDependencies()`'s bodies live
 * here too: both read every registered component's list until the reads settle.
 *
 * Shared by those owners rather than held by any one of them. It supplies the recorded
 * names and the dependency lists to the graph helper in `dependency-policy.ts`, and owns
 * no state of its own.
 */
export class StartupOrdering {
  constructor(private readonly core: ManagerCore) {}

  /** `getStartupOrder()`'s body: the order over the registry once its reads settle. */
  public getStartupOrderOperation(): StartupOrderResult {
    try {
      // Read until the reads stop changing the registry, as `validateDependencies()`
      // and a bulk startup read it: a `getDependencies()` that registers or unregisters
      // a component re-entrantly left an order over the registry as it was when the
      // reads began - naming a component that was gone. Ordered over the live registry
      // once they settle, from the lists already read, so ordering runs no caller code.
      const { reads, isSettled } = this.core.registryReads.readRegistry(
        (component) =>
          this.core.componentMetadata.readDependenciesReported(
            component,
            'ordering',
          ),
      );
      if (!isSettled) {
        throw new Error(
          'The registry kept changing while the startup order was being read',
        );
      }

      return {
        success: true,
        startupOrder: this.getStartupOrderInternal(
          this.core.state.components,
          undefined,
          reads,
        ),
      };
    } catch (error) {
      return {
        success: false,
        startupOrder: [],
        ...this.answerStartupOrderFailure(
          error,
          'lifecycle-manager getStartupOrder',
        ),
      };
    }
  }

  /**
   * `validateDependencies()`'s body: every component's dependency list read once,
   * guarded, until the reads stop changing the registry, then checked for missing
   * dependencies, unreadable lists and cycles. Never throws.
   */
  public validateDependenciesOperation(): DependencyValidationResult {
    const missingDependencies: Array<{
      componentName: string;
      componentIsOptional: boolean;
      missingDependency: string;
    }> = [];

    // Each component read once, guarded: the reads run its own code, and one whose
    // `getDependencies()` or `isOptional()` threw made this - documented as not
    // throwing - throw to its caller. A component whose dependencies cannot be read is
    // reported, listed in `invalidDependencyLists`, and makes the result invalid: its own
    // start fails on the same list, so "valid" would be a promise it cannot keep. An
    // `isOptional()` that throws does not: startup reads it as required and starts the
    // component normally, so validation answers the same.
    const invalidDependencyLists: Array<{
      componentName: string;
      error: Error;
    }> = [];
    const graph: Array<{
      name: string;
      isOptional: boolean;
      dependencies: string[];
    }> = [];

    // Read until the reads stop changing the registry, as registration reads it: they
    // run components' code, which can register or unregister re-entrantly, and a check
    // over the registry as it was when the loop began listed components that were gone
    // and missed ones that had arrived - `valid: true` for a registry whose startup then
    // failed. The graph is the live registry once the reads settle.
    const { reads } = this.core.registryReads.readRegistry((component) => ({
      // The one rule startup applies, through the one helper: a throw is reported once
      // and read as required.
      isOptional: this.core.componentMetadata.isComponentOptional(component),
      // Reported once per registration, like every other read of it: the failure is in
      // the result already, and a caller polling this would flood the channel.
      read: this.core.componentMetadata.readDependenciesReported(
        component,
        'validateDependencies',
      ),
    }));

    for (const component of this.core.state.components) {
      const name = this.core.registry.nameOf(component);
      // A registry the reads kept changing can leave a component with a list read for a
      // registration that has since been replaced, or with none at all. Only that
      // component is reported as unread: one holding its current registration's answer
      // is part of an exact snapshot of the live registry, since nothing runs between
      // the last read and this answer.
      const isUnread = !this.core.registryReads.isReadCurrent(reads, component);
      const current = isUnread ? undefined : reads.get(component);
      const { isOptional, read } = current ?? {
        isOptional: false,
        read: {
          error: new Error(
            'The registry kept changing while dependencies were being validated',
          ),
        },
      };

      if (!('dependencies' in read) || read.invalidEntry !== undefined) {
        invalidDependencyLists.push({
          componentName: name,
          error: toError(
            'dependencies' in read ? read.invalidEntry : read.error,
          ),
        });
      }

      graph.push({
        name,
        isOptional,
        dependencies: dependenciesOf(read),
      });
    }

    // Looked up here rather than through the registry per dependency, which rescanned
    // every component for each one.
    const registeredNames = new Set(graph.map(({ name }) => name));

    // Check for missing dependencies
    for (const {
      name: componentName,
      isOptional: isComponentOptional,
      dependencies,
    } of graph) {
      for (const dep of dependencies) {
        if (!registeredNames.has(dep)) {
          missingDependencies.push({
            componentName,
            componentIsOptional: isComponentOptional,
            missingDependency: dep,
          });
        }
      }
    }

    // Build adjacency graph for cycle detection
    const adjacency = new Map<string, Set<string>>();

    for (const { name } of graph) {
      adjacency.set(name, new Set());
    }

    // Build edges: dependency -> dependent (only when dependency is registered)
    for (const { name: dependent, dependencies } of graph) {
      for (const dep of dependencies) {
        if (adjacency.has(dep)) {
          adjacency.get(dep)?.add(dependent);
        }
      }
    }

    // Find circular dependency cycles. Guarded, as `getStartupOrder()` guards its sort:
    // this method is documented as not throwing, and the walk is iterative so chain
    // depth cannot exhaust the stack, but any other failure inside it must not escape
    // either. A graph that could not be checked is no basis for "valid": answered
    // invalid, with the failure on the result and reported as any crash is.
    let circularCycles: string[][] = [];
    let cycleCheckError: Error | undefined;
    try {
      circularCycles = findAllCircularCycles(adjacency);
    } catch (error) {
      cycleCheckError = toError(error);
      reportCallbackError('lifecycle-manager validateDependencies', error);
      this.core.logger.error(
        'Failed to check dependencies for cycles: {{error.message}}',
        { params: { error: cycleCheckError } },
      );
    }

    const isValid =
      missingDependencies.length === 0 &&
      circularCycles.length === 0 &&
      invalidDependencyLists.length === 0 &&
      cycleCheckError === undefined;

    // Calculate summary counts
    const totalMissingDependencies = missingDependencies.length;
    const requiredMissingDependencies = missingDependencies.filter(
      (md) => !md.componentIsOptional,
    ).length;
    const optionalMissingDependencies = missingDependencies.filter(
      (md) => md.componentIsOptional,
    ).length;

    return {
      valid: isValid,
      missingDependencies,
      circularCycles,
      invalidDependencyLists,
      ...(cycleCheckError === undefined ? {} : { cycleCheckError }),
      summary: {
        totalMissingDependencies,
        requiredMissingDependencies,
        optionalMissingDependencies,
        totalCircularCycles: circularCycles.length,
        totalInvalidDependencyLists: invalidDependencyLists.length,
      },
    };
  }

  /**
   * Dependency-aware startup order.
   *
   * - Only registered components are included.
   * - Missing dependencies are ignored for ordering (they are validated at start time).
   * - Cycles throw DependencyCycleError (programmer error).
   */
  public getStartupOrderInternal(
    components: BaseComponent[] = this.core.state.components,
    // Read by registration, which refuses it or reports on it: named by the value
    // registration already read, and ordered by the list it already read.
    candidate?: {
      component: BaseComponent;
      name: string;
      dependencies: string[];
    },
    // Lists already read - by registration, or a bulk startup's reads - so ordering
    // runs none of the caller's code.
    dependencySnapshot?: ReadonlyMap<BaseComponent, DependencyRead>,
  ): string[] {
    // Naming, registration snapshots, and guarded reads remain manager policy. The
    // ordering module preserves names-first acquisition and dependency read order;
    // callbacks here do not publish or cache any additional lifecycle state.
    return getStartupOrder(
      components,
      (component) =>
        component === candidate?.component
          ? candidate.name
          : this.core.registry.nameOf(component),
      (component) =>
        component === candidate?.component
          ? candidate.dependencies
          : dependencySnapshot !== undefined
            ? dependenciesOf(dependencySnapshot.get(component))
            : this.core.componentMetadata.readDependencies(
                component,
                'ordering',
              ),
    );
  }

  /**
   * Classify, report and log a failure to compute the startup order - shared by
   * `getStartupOrder()` and `startAllComponents()`, so the two answer it alike.
   *
   * A cycle is the caller's configuration, answered by its code; anything else is
   * unplanned - dependency lists are read tolerantly there, so not a broken
   * `getDependencies()`, which fails only that component's own start - and is reported
   * on the global channel, as every other `operation_crashed` is.
   */
  public answerStartupOrderFailure(
    error: unknown,
    context: string,
  ): {
    code: 'dependency_cycle' | 'operation_crashed';
    reason: string;
    error: Error;
  } {
    const err = toError(error);
    const code =
      err instanceof DependencyCycleError
        ? 'dependency_cycle'
        : 'operation_crashed';

    if (code === 'operation_crashed') {
      reportCallbackError(context, error);
    }

    this.core.logger.error(
      'Failed to resolve startup order: {{error.message}}',
      {
        params: { error: err },
      },
    );

    return {
      code,
      // `describeError`, not `err.message`: `toError` returns a brand-claiming value
      // unchanged, so `message` can be an accessor that throws - and both callers answer
      // from a `catch` whose whole point is not to throw.
      reason: describeError(err),
      error: err,
    };
  }
}
