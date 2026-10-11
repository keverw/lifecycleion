import { isObjectLike } from './is-object-like';

/**
 * How a {@link SharedSlot}'s state records that it is taken. Called on states read from
 * the global slot, so either may throw or be ignored; the slot repairs that.
 */
export interface SharedSlotOptions<T extends object> {
  /** The `Symbol.for` key the state lives under. */
  key: symbol;
  /** Whether a slot value is a usable state. Reads descriptors only. */
  isValid: (value: unknown) => value is T;
  /** A fresh, free state. */
  create: () => T;
  /** Whether `state` is taken. */
  isHeld: (state: T) => boolean;
  /** Mark `state` taken or free. */
  setHeld: (state: T, isHeld: boolean) => void;
}

/**
 * The value of `value`'s own writable data property `key`, read without invoking an
 * accessor; `undefined` when there is none. For an {@link SharedSlotOptions.isValid} check.
 */
export function readOwnWritableValue(value: unknown, key: string): unknown {
  if (!isObjectLike(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.writable === true ? descriptor.value : undefined;
}

/**
 * A guard every bundled copy of the library in a realm agrees on: a state object shared on
 * `globalThis` under a `Symbol.for` key, taken by one holder at a time - and the one
 * repair strategy for when it proves unusable.
 *
 * The slot is read on every call, so a copy follows a state another copy installed; the
 * state last validated is kept, so a repeat read is compared by identity rather than
 * validated again. Taking and releasing read the slot as an own data property, so an
 * accessor someone put there is never invoked. {@link isHeld} - on the hot path of every
 * guarded callback, emit and log call - compares a plain read instead, which allocates
 * nothing: once this copy or another has installed the slot it holds a data property, so
 * the read invokes nothing unless something else defines an accessor under the key -
 * before the first install or after it - which is tampering outside what this defends;
 * even then a throw is caught and the slot read the guarded way.
 * Anything that is not a valid state is replaced with a fresh
 * one, and so is a valid-looking state that proves unusable when taken or released - a
 * `Proxy` whose flag throws, a write that does not take: replacing the slot repairs every
 * copy reading it, where keeping a state of one's own would leave the others on the
 * broken one.
 *
 * What it cannot tell apart is a state left taken by a holder that will never release it
 * from one another copy holds right now: both read as taken, and taking it waits. The
 * slot defends against values that misbehave when used, not against a global tampered
 * with to look busy.
 *
 * Only a global that refuses the slot - non-extensible, or a non-configurable property
 * under the key that cannot hold a data value - leaves this copy on a state of its own.
 * That refusal is permanent (neither can be undone), so it is remembered and the slot is
 * not tried again. A definition that throws instead says nothing permanent, and the slot
 * is tried again next time.
 */
export class SharedSlot<T extends object> {
  private readonly options: SharedSlotOptions<T>;
  /** This copy's own state, used once the global refuses the slot. */
  private readonly local: T;
  /** The state last read from the slot and found valid, so a repeat read skips `isValid`. */
  private cached: T | undefined;
  private isRefused = false;

  constructor(options: SharedSlotOptions<T>) {
    this.options = options;
    this.local = options.create();
  }

  /** Whether the state is taken - by this copy or another. */
  public isHeld(): boolean {
    let state: T;

    try {
      state =
        this.readCached(
          (globalThis as Record<symbol, unknown>)[this.options.key],
        ) ?? this.current();
    } catch {
      state = this.current();
    }

    try {
      return this.options.isHeld(state);
    } catch {
      this.replaceIfInSlot(state);
    }

    try {
      return this.options.isHeld(this.current());
    } catch {
      // Only for a slot that went hostile again between two statements: no report is
      // running that this copy can see.
      return false;
    }
  }

  /**
   * Take the state. The state taken, to hand to {@link release}, or `undefined` when it is
   * already taken. A state that throws, or ignores the write, is replaced and the fresh one
   * taken instead, with the same checks.
   */
  public acquire(): T | undefined {
    const taken = this.take(this.current());

    if (taken !== 'unusable') {
      return taken;
    }

    const retaken = this.take(this.replace());

    // Only for a fresh state that went hostile between two statements.
    return retaken === 'unusable' ? undefined : retaken;
  }

  /**
   * Free a state {@link acquire} returned. One that will not be freed is replaced, so no
   * copy is left waiting on it - if the slot still holds it: one another copy has
   * already replaced is dropped, rather than replacing the healthy state now in its place.
   */
  public release(state: T): void {
    try {
      this.options.setHeld(state, false);

      if (!this.options.isHeld(state)) {
        return;
      }
    } catch {
      // Refused: a state that can never be freed, as an ignored write is.
    }

    this.replaceIfInSlot(state);
  }

  /**
   * Replace `state`, which proved unusable, if the slot still holds it. One another copy
   * has already replaced is dropped, rather than replacing the healthy state now in its
   * place. This copy's own state is never unusable.
   */
  private replaceIfInSlot(state: T): void {
    if (state === this.local) {
      return;
    }

    let isInSlot = false;

    try {
      isInSlot =
        Object.getOwnPropertyDescriptor(globalThis, this.options.key)?.value ===
        state;
    } catch {
      // Unreadable: nothing here to say it still holds this state.
    }

    if (isInSlot) {
      this.replace();
    }
  }

  /** The shared state, installing a fresh one when the slot holds anything else. */
  private current(): T {
    if (this.isRefused) {
      return this.local;
    }

    try {
      const existing: unknown = Object.getOwnPropertyDescriptor(
        globalThis,
        this.options.key,
      )?.value;
      const cached = this.readCached(existing);

      if (cached !== undefined) {
        return cached;
      }

      if (this.options.isValid(existing)) {
        this.cached = existing;
        return existing;
      }
    } catch {
      // A hostile value under the key: replaced below like any other invalid one.
    }

    return this.replace();
  }

  /**
   * The state last validated, if `slotValue` - however the slot was read - is that same
   * object, so a repeat read skips `isValid`; otherwise `undefined`.
   */
  private readCached(slotValue: unknown): T | undefined {
    return slotValue !== undefined && slotValue === this.cached
      ? this.cached
      : undefined;
  }

  /** Take `state`: it, `undefined` when already taken, or `'unusable'` when it cannot be. */
  private take(state: T): T | undefined | 'unusable' {
    try {
      if (this.options.isHeld(state)) {
        return undefined;
      }

      this.options.setHeld(state, true);

      if (this.options.isHeld(state)) {
        return state;
      }

      // The write was ignored rather than refused: this state cannot guard anything.
    } catch {
      // It threw: unusable, as an ignored write is.
    }

    return 'unusable';
  }

  /**
   * Install a fresh state in place of whatever the slot holds, and return it - or this
   * copy's own state when the global refuses the slot. A refusal answered `false` is
   * permanent and remembered; one that throws may not be, so this call uses its own state
   * and the next one tries the slot again.
   */
  private replace(): T {
    if (this.isRefused) {
      return this.local;
    }

    const fresh = this.options.create();
    const key = this.options.key;

    try {
      // A fresh data property, replacing even an accessor or a read-only value. On a
      // non-configurable key that is refused, but a writable one still takes a new value:
      // the second definition changes the value alone, as an assignment from an older
      // copy would, without invoking an accessor.
      if (
        Reflect.defineProperty(globalThis, key, {
          value: fresh,
          configurable: true,
          writable: true,
        }) ||
        Reflect.defineProperty(globalThis, key, { value: fresh })
      ) {
        this.cached = fresh;
        return fresh;
      }
    } catch {
      // Not an answer about the slot - the global's `defineProperty` itself threw - so not
      // remembered as one.
      return this.local;
    }

    this.isRefused = true;
    this.cached = undefined;

    return this.local;
  }
}
