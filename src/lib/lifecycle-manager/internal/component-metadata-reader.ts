import type { BaseComponent } from '../base-component';
import { reportCallbackError } from '../../safe-handle-callback';
import {
  dependenciesOf,
  tryReadDependencies,
  type DependencyRead,
} from './dependency-policy';

/** The report marks that preceded a provisional registration. */
export interface MetadataReportMarks {
  readonly dependencies: boolean;
  readonly optional: boolean;
}

/** Owns guarded component metadata reads and their per-registration reports. */
export class ComponentMetadataReader {
  private readonly reportedDependencyReadFailures =
    new WeakSet<BaseComponent>();
  private readonly reportedOptionalReadFailures = new WeakSet<BaseComponent>();

  constructor(private readonly nameOf: (component: BaseComponent) => string) {}

  public reportMarks(component: BaseComponent): MetadataReportMarks {
    return {
      dependencies: this.reportedDependencyReadFailures.has(component),
      optional: this.reportedOptionalReadFailures.has(component),
    };
  }

  /** A later registration of the same instance reports broken metadata afresh. */
  public clearReports(component: BaseComponent): void {
    this.reportedDependencyReadFailures.delete(component);
    this.reportedOptionalReadFailures.delete(component);
  }

  /** Clear only marks made by the provisional registration that rolled back. */
  public rollBackReports(
    component: BaseComponent,
    previous: MetadataReportMarks,
  ): void {
    // A previously marked component may have been unregistered by a hook. Do not
    // recreate that mark: rollback only removes reports belonging to its attempt.
    if (!previous.dependencies) {
      this.reportedDependencyReadFailures.delete(component);
    }
    if (!previous.optional) {
      this.reportedOptionalReadFailures.delete(component);
    }
  }

  /**
   * Another component's declared dependencies, read for a check about *other*
   * components - dependents, validation, shutdown protection - where that component
   * breaking its contract must not fail the check. A `getDependencies()` that throws, or
   * returns something that is not an array (an override that forgot to `return`), is
   * reported on the global channel and read as declaring none.
   *
   * Also what startup ordering reads, so one broken list cannot break the order for every
   * component. Not for a component's own start: there a broken list fails that start.
   */
  public readDependencies(component: BaseComponent, context: string): string[] {
    // Everything that touches the returned value runs inside the guard too, and what
    // comes back is a plain copy of its string entries: callers iterate it and call
    // `includes` on it, and an array subclass, a proxy, or own `includes` /
    // `Symbol.iterator` properties would otherwise run the component's code there, past
    // the guard - `Array.isArray` itself throws for a revoked proxy.
    const read = this.readDependenciesReported(component, context);

    return dependenciesOf(read);
  }

  /**
   * {@link tryReadDependencies}, with a failure - a throw, a non-array, an implausible
   * length, a non-string entry - reported once per registration. The one place that
   * pairs the read with its report; callers decide what a failure means.
   */
  public readDependenciesReported(
    component: BaseComponent,
    context: string,
  ): DependencyRead {
    const read = tryReadDependencies(component);

    if (!('dependencies' in read)) {
      this.reportDependencyReadFailureOnce(component, context, read.error);
    } else if (read.invalidEntry !== undefined) {
      this.reportDependencyReadFailureOnce(
        component,
        context,
        read.invalidEntry,
      );
    }

    return read;
  }

  /**
   * Whether a component is optional, as startup and validation both decide it: only an
   * `isOptional()` that answers exactly `true`. One that throws counts as required - the
   * conservative answer, since a required failure is rolled back - and is reported once
   * per registration rather than crashing the startup that asked.
   */
  public isComponentOptional(component: BaseComponent): boolean {
    try {
      return component.isOptional() === true;
    } catch (error) {
      if (!this.reportedOptionalReadFailures.has(component)) {
        this.reportedOptionalReadFailures.add(component);
        reportCallbackError(
          `lifecycle-manager isOptional of ${this.nameOf(component)}`,
          error,
        );
      }

      return false;
    }
  }

  /**
   * Report a broken `getDependencies()` once per registration of the component, labelled
   * only then: its lists are read for every component on every stop, restart and
   * unregister, recursively in a shutdown pass, and on every start - a report per read
   * flooded the channel with the same failure.
   */
  public reportDependencyReadFailureOnce(
    component: BaseComponent,
    context: string,
    failure: unknown,
    // For a registration candidate, not recorded yet: named by what registration read.
    name?: string,
  ): void {
    if (this.reportedDependencyReadFailures.has(component)) {
      return;
    }

    // Looked up only for the report actually made - not as a parameter default, which
    // ran on every failing read of an already-reported list. Before the mark, so a
    // lookup that throws leaves the one report still to be made.
    const label = name ?? this.nameOf(component);
    this.reportedDependencyReadFailures.add(component);
    reportCallbackError(
      `lifecycle-manager ${context} dependencies of ${label}`,
      failure,
    );
  }
}
