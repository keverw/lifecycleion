import type { Logger } from './logger';
import type { LoggerService } from './logger/logger-service';

import type {
  InsertComponentAtResult,
  InsertPosition,
  RegisterComponentResult,
  RegisterOptions,
  RegistrationFailureCode,
  LifecycleManagerOptions,
} from './lifecycle-manager/types';
import { DependencyCycleError } from './lifecycle-manager/errors';
import type { BaseComponent } from './lifecycle-manager/base-component';

/**
 * LifecycleManager
 *
 * Note: This file is the package export surface (`src/index.ts` exports from here).
 * The rest of the lifecycle-manager module lives in `src/lib/lifecycle-manager/*`.
 */
export class LifecycleManager {
  private readonly name: string;
  private readonly rootLogger: Logger;
  private readonly logger: LoggerService;

  private components: BaseComponent[] = [];

  // Registration/runtime state
  private isShuttingDown = false;

  constructor(options: LifecycleManagerOptions & { logger: Logger }) {
    this.name = options.name ?? 'lifecycle-manager';
    this.rootLogger = options.logger;
    this.logger = this.rootLogger.service(this.name);
  }

  /**
   * Register a component at the end of the registry list.
   */
  public registerComponent(
    component: BaseComponent,
    _options?: RegisterOptions,
  ): RegisterComponentResult {
    const componentName = component.getName();
    const registrationIndexBefore = this.getComponentIndex(componentName);

    if (this.isShuttingDown) {
      return this.buildRegisterResultFailure({
        componentName,
        registrationIndexBefore,
        code: 'shutdown_in_progress',
        reason:
          'Cannot register component while shutdown is in progress (isShuttingDown=true).',
      });
    }

    if (registrationIndexBefore !== null) {
      return this.buildRegisterResultFailure({
        componentName,
        registrationIndexBefore,
        code: 'duplicate_name',
        reason: `Component "${componentName}" is already registered.`,
      });
    }

    this.components.push(component);
    (component as unknown as { lifecycle: unknown }).lifecycle = this;

    const startupOrder = this.getStartupOrderInternal();

    return {
      action: 'register',
      success: true,
      registered: true,
      componentName,
      registrationIndexBefore: null,
      registrationIndexAfter: this.getComponentIndex(componentName),
      startupOrder,
    };
  }

  /**
   * Insert a component at a specific position within the registry list.
   *
   * Notes:
   * - The registry list is a manual ordering preference only.
   * - Dependencies may override this preference; the result object includes `startupOrder`
   *   and `manualPositionRespected` so callers can see if the request was achievable.
   */
  public insertComponentAt(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName?: string,
    _options?: RegisterOptions,
  ): InsertComponentAtResult {
    const componentName = component.getName();
    const registrationIndexBefore = this.getComponentIndex(componentName);

    if (!this.isInsertPosition(position)) {
      return this.buildInsertResultFailure({
        componentName,
        position,
        targetComponentName,
        registrationIndexBefore,
        code: 'invalid_position',
        reason: `Invalid insert position: "${String(position)}". Expected one of: start, end, before, after.`,
        targetFound: undefined,
      });
    }

    if (this.isShuttingDown) {
      return this.buildInsertResultFailure({
        componentName,
        position,
        targetComponentName,
        registrationIndexBefore,
        code: 'shutdown_in_progress',
        reason:
          'Cannot register component while shutdown is in progress (isShuttingDown=true).',
        targetFound: undefined,
      });
    }

    if (registrationIndexBefore !== null) {
      return this.buildInsertResultFailure({
        componentName,
        position,
        targetComponentName,
        registrationIndexBefore,
        code: 'duplicate_name',
        reason: `Component "${componentName}" is already registered.`,
        targetFound: undefined,
      });
    }

    const insertIndex = this.getInsertIndex(position, targetComponentName);
    if (insertIndex === null) {
      const startupOrder = this.getStartupOrderInternal();
      return {
        action: 'insert',
        success: false,
        registered: false,
        componentName,
        code: 'target_not_found',
        reason: `Target component "${targetComponentName ?? ''}" not found in registry.`,
        registrationIndexBefore: null,
        registrationIndexAfter: null,
        startupOrder,
        requestedPosition: { position, targetComponentName },
        manualPositionRespected: false,
        targetFound: false,
      };
    }

    this.components.splice(insertIndex, 0, component);
    (component as unknown as { lifecycle: unknown }).lifecycle = this;

    const startupOrder = this.getStartupOrderInternal();
    const isManualPositionRespected = this.isManualPositionRespected({
      componentName,
      position,
      targetComponentName,
      startupOrder,
    });

    return {
      action: 'insert',
      success: true,
      registered: true,
      componentName,
      registrationIndexBefore: null,
      registrationIndexAfter: this.getComponentIndex(componentName),
      startupOrder,
      requestedPosition: { position, targetComponentName },
      manualPositionRespected: isManualPositionRespected,
      targetFound:
        position === 'before' || position === 'after'
          ? this.getComponentIndex(targetComponentName ?? '') !== null
          : undefined,
    };
  }

  /**
   * Get resolved startup order after applying dependency constraints.
   */
  public getStartupOrder(): string[] {
    return this.getStartupOrderInternal();
  }

  private buildRegisterResultFailure(input: {
    componentName: string;
    registrationIndexBefore: number | null;
    code: RegistrationFailureCode;
    reason: string;
  }): RegisterComponentResult {
    const startupOrder = this.getStartupOrderInternal();
    return {
      action: 'register',
      success: false,
      registered: false,
      componentName: input.componentName,
      code: input.code,
      reason: input.reason,
      registrationIndexBefore: input.registrationIndexBefore,
      registrationIndexAfter: input.registrationIndexBefore,
      startupOrder,
    };
  }

  private buildInsertResultFailure(input: {
    componentName: string;
    position: InsertPosition | (string & {});
    targetComponentName?: string;
    registrationIndexBefore: number | null;
    code: RegistrationFailureCode;
    reason: string;
    targetFound?: boolean;
  }): InsertComponentAtResult {
    const startupOrder = this.getStartupOrderInternal();
    return {
      action: 'insert',
      success: false,
      registered: false,
      componentName: input.componentName,
      code: input.code,
      reason: input.reason,
      registrationIndexBefore: input.registrationIndexBefore,
      registrationIndexAfter: input.registrationIndexBefore,
      startupOrder,
      requestedPosition: {
        position: input.position,
        targetComponentName: input.targetComponentName,
      },
      manualPositionRespected: false,
      targetFound: input.targetFound,
    };
  }

  private getComponentIndex(name: string): number | null {
    const idx = this.components.findIndex((c) => c.getName() === name);
    return idx === -1 ? null : idx;
  }

  private isInsertPosition(value: unknown): value is InsertPosition {
    return (
      value === 'start' ||
      value === 'end' ||
      value === 'before' ||
      value === 'after'
    );
  }

  private getInsertIndex(
    position: InsertPosition,
    targetComponentName?: string,
  ): number | null {
    if (position === 'start') {
      return 0;
    } else if (position === 'end') {
      return this.components.length;
    } else if (position !== 'before' && position !== 'after') {
      return null;
    }

    const targetIdx = this.getComponentIndex(targetComponentName ?? '');
    if (targetIdx === null) {
      return null;
    }
    if (position === 'before') {
      return targetIdx;
    } else {
      return targetIdx + 1;
    }
  }

  private isManualPositionRespected(input: {
    componentName: string;
    position: InsertPosition;
    targetComponentName?: string;
    startupOrder: string[];
  }): boolean {
    const compIdx = input.startupOrder.indexOf(input.componentName);
    if (compIdx === -1) {
      return false;
    }

    if (input.position === 'start') {
      return compIdx === 0;
    } else if (input.position === 'end') {
      return compIdx === input.startupOrder.length - 1;
    } else if (input.position === 'before' || input.position === 'after') {
      const targetIdx = input.startupOrder.indexOf(
        input.targetComponentName ?? '',
      );
      if (targetIdx === -1) {
        return false;
      }
      if (input.position === 'before') {
        return compIdx < targetIdx;
      }
      return compIdx > targetIdx;
    }

    return false;
  }

  /**
   * Dependency-aware startup order.
   *
   * - Only registered components are included.
   * - Missing dependencies are ignored for ordering (they are validated at start time).
   * - Cycles throw DependencyCycleError (programmer error).
   */
  private getStartupOrderInternal(): string[] {
    const names = this.components.map((c) => c.getName());
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
    for (const component of this.components) {
      const dependent = component.getName();
      for (const dep of component.getDependencies()) {
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
      // Stable pick: lowest registration index
      const next = [...available].sort((a, b) => {
        return (regIndex.get(a) ?? 0) - (regIndex.get(b) ?? 0);
      })[0];

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
      const remaining = names.filter((n) => !order.includes(n));
      throw new DependencyCycleError({ cycle: remaining });
    }

    return order;
  }
}
