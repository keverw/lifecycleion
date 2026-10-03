import type { BaseComponent } from '../base-component';

/**
 * How many rounds of reads `readRegistry()` makes before it
 * gives up on a registry that every read changes. Each round reads only the components
 * registered by the round before, so ordinary lazy wiring settles in one or two.
 */
const MAX_REGISTRY_READ_ROUNDS = 16;

/** Tracks read answers by registration identity, not merely component instance. */
export class RegistrationReadTracker {
  private registrationCount = 0;
  private readonly registrationGenerations = new WeakMap<
    BaseComponent,
    number
  >();
  private readonly readGenerations = new WeakMap<
    ReadonlyMap<BaseComponent, unknown>,
    Map<BaseComponent, number | undefined>
  >();

  constructor(private readonly source: () => BaseComponent[]) {}

  public currentGeneration(component: BaseComponent): number | undefined {
    return this.registrationGenerations.get(component);
  }

  public readGeneration(
    reads: ReadonlyMap<BaseComponent, unknown>,
    component: BaseComponent,
  ): number | undefined {
    return this.readGenerations.get(reads)?.get(component);
  }

  // Published provisionally before registration hooks. Rollback restores the prior
  // generation without reusing the allocated number; unregister retains identity.
  public advanceRegistration(component: BaseComponent): void {
    this.registrationGenerations.set(component, ++this.registrationCount);
  }

  public restoreRegistration(
    component: BaseComponent,
    generation: number | undefined,
  ): void {
    if (generation === undefined) {
      this.registrationGenerations.delete(component);
    } else {
      this.registrationGenerations.set(component, generation);
    }
  }

  public recordRead<T>(
    reads: Map<BaseComponent, T>,
    component: BaseComponent,
    read: T,
    generation: number | undefined,
  ): void {
    let generations = this.readGenerations.get(reads);
    if (generations === undefined) {
      generations = new Map();
      this.readGenerations.set(reads, generations);
    }
    reads.set(component, read);
    generations.set(component, generation);
  }

  /**
   * Whether `reads` holds an answer from `component`'s current registration - not one
   * read before it was unregistered and registered again.
   */
  public isReadCurrent(
    reads: ReadonlyMap<BaseComponent, unknown>,
    component: BaseComponent,
  ): boolean {
    return (
      reads.has(component) &&
      this.readGenerations.get(reads)?.get(component) ===
        this.registrationGenerations.get(component)
    );
  }

  /**
   * `read` applied to every registered component, until reading stops changing the
   * registry: a read that registers another component has that one read too. The
   * registry itself is the live one afterwards - a component unregistered meanwhile is
   * simply not in it - and, once `isSettled`, every component in it has a current answer
   * here, so the checks that use them run none of the caller's code. One unregistered
   * and registered again after its read is read again: its answer was for a
   * registration that is gone. Not settled when the registry was still growing after
   * `MAX_REGISTRY_READ_ROUNDS` rounds of reads.
   */
  public readRegistry<T>(
    read: (component: BaseComponent) => T,
    // Answers already read, to continue from: only components missing here are read.
    reads: Map<BaseComponent, T> = new Map(),
    // Asked before each read; once it answers `false` the reads stop, unsettled.
    canContinue: () => boolean = () => true,
    // Run each time every component has been read. It may run the caller's code and
    // register more, which are then read in turn, within the same bound.
    onSettled?: () => void,
    source: () => BaseComponent[] = this.source,
  ): {
    reads: Map<BaseComponent, T>;
    isSettled: boolean;
  } {
    // Whether the round before read anything: `onSettled` is for what the reads may
    // have changed, and a registry that was already read has nothing new to ask about.
    let didRead = false;
    const isUnread = (component: BaseComponent): boolean =>
      !this.isReadCurrent(reads, component);

    for (let round = 0; ; round++) {
      let unread = source().filter(isUnread);

      if (
        unread.length === 0 &&
        didRead &&
        onSettled !== undefined &&
        canContinue()
      ) {
        didRead = false;
        onSettled();
        unread = source().filter(isUnread);
      }

      if (unread.length === 0) {
        return { reads, isSettled: true };
      }

      if (round === MAX_REGISTRY_READ_ROUNDS) {
        return { reads, isSettled: false };
      }

      for (const component of unread) {
        if (!canContinue()) {
          return { reads, isSettled: false };
        }

        // Taken before the read, which may itself register the instance again.
        const generation = this.registrationGenerations.get(component);
        this.recordRead(reads, component, read(component), generation);
        didRead = true;
      }
    }
  }
}
