/**
 * A state object shared on `globalThis` under a `Symbol.for` key, so every bundled copy of
 * the library in a realm agrees on it - and the one repair strategy for when it proves
 * unusable.
 *
 * The slot is read on every call rather than cached, so a copy follows a state another
 * copy installed. It is read as an own data property, so an accessor someone put there is
 * never invoked. Anything that is not a valid state is replaced with a fresh one through
 * `Reflect.defineProperty`, and so is a valid-looking state that later proves hostile - a
 * `Proxy` whose flag throws, a write that does not take - via {@link replace}: replacing
 * the slot repairs every copy reading it, where keeping a state of one's own would leave
 * the others on the broken one.
 *
 * Only a global that refuses the definition - non-extensible, or a non-configurable
 * property under the key - leaves this copy on a state of its own. That refusal is
 * permanent (neither can be undone), so it is remembered and the slot is not tried again.
 */
export class SharedSlot<T extends object> {
  private isRefused = false;

  /**
   * @param key The `Symbol.for` key the state lives under.
   * @param isValid Whether a slot value is a usable state. Reads descriptors only.
   * @param create A fresh state.
   * @param local This copy's own state, used once the global refuses the slot.
   */
  constructor(
    private readonly key: symbol,
    private readonly isValid: (value: unknown) => value is T,
    private readonly create: () => T,
    public readonly local: T,
  ) {}

  /** The shared state, installing a fresh one when the slot holds anything else. */
  public current(): T {
    if (this.isRefused) {
      return this.local;
    }

    try {
      const existing: unknown = Object.getOwnPropertyDescriptor(
        globalThis,
        this.key,
      )?.value;

      if (this.isValid(existing)) {
        return existing;
      }
    } catch {
      // A hostile value under the key: replaced below like any other invalid one.
    }

    return this.replace();
  }

  /**
   * Install a fresh state in place of whatever the slot holds, and return it - or this
   * copy's own state once the global refuses the slot.
   */
  public replace(): T {
    if (this.isRefused) {
      return this.local;
    }

    const fresh = this.create();

    try {
      if (
        Reflect.defineProperty(globalThis, this.key, {
          value: fresh,
          configurable: true,
          writable: true,
        })
      ) {
        return fresh;
      }
    } catch {
      // Refused by throwing rather than by answering false: the same refusal.
    }

    this.isRefused = true;

    return this.local;
  }
}
