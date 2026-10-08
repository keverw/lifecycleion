import type { BaseComponent } from '../base-component';
import type { ComponentStatus, InsertPosition } from '../types';
import type { DependencyRead } from './dependency-policy';
import type { ManagerCore } from './manager-core';

/**
 * The registry and the per-component records it keys: looking a committed component up
 * by name, the name each instance was registered under, a component's status and
 * whether it is up, the timestamps and `isStarted` flag a start or stop records, the
 * reservations a registration checks before it commits, where an insertion lands,
 * publishing the committed subset, and the dependency read that is current for a
 * component. They run no caller code - except `nameOf()` for an instance that was never
 * registered.
 *
 * The registry itself is state: `componentEntries` holds every reserved entry,
 * provisional ones included, and `components` with `componentsByName` the committed
 * subset `publishRegistry()` publishes. Registration (`RegistrationOperations`) and
 * unregistration (`UnregistrationOperations`) are what change it.
 */
export class ComponentRegistry {
  constructor(private readonly core: ManagerCore) {}

  /** The committed component registered under `name`. */
  public getComponent(name: string): BaseComponent | undefined {
    return this.core.state.componentsByName.get(name);
  }

  /** Whether a component is registered under `name`, without calling any public method. */
  public isNameRegistered(name: string): boolean {
    return this.core.state.componentsByName.has(name);
  }

  /** The committed registry index of the component registered under `name`, if any. */
  public getComponentIndex(name: string): number | null {
    // The name index holds the first committed entry with this name, published with
    // `components` itself (`publishRegistry()`), so its position is the one a scan by
    // name would find - and a name nothing holds needs no scan at all.
    const component = this.core.state.componentsByName.get(name);
    const idx =
      component === undefined
        ? -1
        : this.core.state.components.indexOf(component);
    return idx === -1 ? null : idx;
  }

  /**
   * A component's name, as recorded when it was registered.
   *
   * Read once, at registration - where it is validated, and where a `getName()` that
   * throws fails the registration and nothing else - and never again. The manager looks
   * names up in dozens of places, including the middle of broadcasts, health checks and
   * shutdown passes; re-reading each time meant a component that broke its contract
   * could crash any of them. The entry outlives an unregister, so work still in flight
   * can name the instance, and a later registration of the same instance reads the name
   * fresh and overwrites it on commit. Falls back to asking the component only for an
   * instance that was never registered.
   */
  public nameOf(component: BaseComponent): string {
    const recordedName = this.core.state.registeredNames.get(component);

    return recordedName !== undefined ? recordedName : component.getName();
  }

  /**
   * {@link nameOf} for the registry entry at `index`, or `undefined` when there is none.
   */
  public nameOfAt(index: number): string | undefined {
    const component = this.core.state.components[index];

    return component === undefined ? undefined : this.nameOf(component);
  }

  /** The status of the component registered under `name`; the caller has checked it is. */
  public statusOf(name: string): ComponentStatus {
    const state = this.core.state.componentStates.get(name) || 'registered';
    const timestamps = this.core.state.componentTimestamps.get(name) || {
      startedAt: null,
      stoppedAt: null,
    };
    const lastError = this.core.state.componentErrors.get(name) || null;
    const stallInfo = this.core.state.stalledComponents.get(name) || null;

    return {
      name,
      state,
      startedAt: timestamps.startedAt,
      stoppedAt: timestamps.stoppedAt,
      lastError,
      stallInfo,
    };
  }

  /**
   * Whether a component is up: running, and not on its way down. A stopping component
   * stays in `runningComponents` until its stop settles. A dependent must not start on
   * one - that stop already checked for running dependents, so the dependent ran on a
   * stopped dependency - and a health check must not call into one mid-stop.
   */
  public isComponentUp(name: string): boolean {
    const state = this.core.state.componentStates.get(name);

    return (
      this.core.state.runningComponents.has(name) &&
      state !== 'stopping' &&
      state !== 'force-stopping'
    );
  }

  /** Recompute `isStarted`: whether any component is running or stalled. */
  public updateStartedFlag(): void {
    this.core.state.isStarted =
      this.core.state.runningComponents.size > 0 ||
      this.core.state.stalledComponents.size > 0;
  }

  /** Record now as `field`, keeping the other timestamp from the component's last run. */
  public stampTimestamp(name: string, field: 'startedAt' | 'stoppedAt'): void {
    const timestamps = this.core.state.componentTimestamps.get(name) ?? {
      startedAt: null,
      stoppedAt: null,
    };
    timestamps[field] = Date.now();
    this.core.state.componentTimestamps.set(name, timestamps);
  }

  /** Whether `component` holds a registry entry, provisional or committed, or a rollback reservation. */
  public isInstanceReserved(component: BaseComponent): boolean {
    return (
      this.core.state.componentEntries.includes(component) ||
      this.core.state.rollbackReservations.has(component)
    );
  }

  /** Whether `name` is held by a registry entry, provisional or committed, or a rollback reservation. */
  public isNameReserved(name: string): boolean {
    if (
      this.core.state.componentEntries.some(
        (component) => this.nameOf(component) === name,
      )
    ) {
      return true;
    }
    for (const reservedName of this.core.state.rollbackReservations.values()) {
      if (reservedName === name) {
        return true;
      }
    }
    return false;
  }

  /**
   * Where in `componentEntries` an insertion at `position` lands, or `null` for a
   * position that is not one or a target that is not registered.
   */
  public getInsertIndex(
    position: InsertPosition,
    targetComponentName?: string,
  ): number | null {
    if (position === 'start') {
      return 0;
    } else if (position === 'end') {
      return this.core.state.componentEntries.length;
    } else if (position !== 'before' && position !== 'after') {
      return null;
    }

    // Targets must be published, but placement is adjacent to that exact instance
    // in the reserved order. Translating through its next committed neighbour would
    // put an "after" insertion beyond an interleaved provisional component.
    const target = this.getComponent(targetComponentName ?? '');
    if (target === undefined) {
      return null;
    }
    const targetIdx = this.core.state.componentEntries.indexOf(target);
    if (position === 'before') {
      return targetIdx;
    } else {
      return targetIdx + 1;
    }
  }

  /** Publish the live committed subset after registry mutations, without caller code. */
  public publishRegistry(): void {
    const published = this.core.state.componentEntries.filter(
      (component) => !this.core.state.pendingRegistrations.has(component),
    );
    if (
      published.length !== this.core.state.components.length ||
      published.some(
        (entry, index) => this.core.state.components[index] !== entry,
      )
    ) {
      this.core.state.components = published;
      const byName = new Map<string, BaseComponent>();
      for (const component of published) {
        const name = this.nameOf(component);
        // The first entry wins, as a scan of the registry would find it.
        if (!byName.has(name)) {
          byName.set(name, component);
        }
      }
      this.core.state.componentsByName = byName;
    }
  }

  /** Current-generation dependency metadata, without running caller getters. */
  public currentReadOf(
    component: BaseComponent,
    snapshot: ReadonlyMap<BaseComponent, DependencyRead>,
    preferred?: ReadonlyMap<BaseComponent, DependencyRead>,
  ): DependencyRead | undefined {
    if (
      preferred !== undefined &&
      this.core.registryReads.isReadCurrent(preferred, component)
    ) {
      return preferred.get(component);
    }
    return (
      (this.core.registryReads.isReadCurrent(snapshot, component)
        ? snapshot.get(component)
        : undefined) ?? this.core.state.committedDependencyReads.get(component)
    );
  }
}
