import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import { DependencyCycleError } from '../errors';
import {
  type DependencyRead,
  dependenciesOf,
  getStartupOrder,
} from './dependency-policy';
import type { ManagerCore } from './manager-core';

/**
 * The manager's startup order: the registry in dependency order, as `getStartupOrder()`
 * answers it, a bulk startup starts it, a shutdown pass stops it in reverse, and
 * registration checks a placement against it - and the one way all of them answer a
 * failure to compute it.
 *
 * Shared by those owners rather than held by any one of them. It supplies the recorded
 * names and the dependency lists to the graph helper in `dependency-policy.ts`, and owns
 * no state of its own.
 */
export class StartupOrdering {
  constructor(private readonly core: ManagerCore) {}

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
