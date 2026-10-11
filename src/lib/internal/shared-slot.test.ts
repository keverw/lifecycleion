import { afterEach, expect, spyOn, test } from 'bun:test';
import { isObjectLike } from './is-object-like';
import { SharedSlot } from './shared-slot';

interface TestState {
  held: boolean;
}

function isTestState(value: unknown): value is TestState {
  if (!isObjectLike(value)) {
    return false;
  }
  const held = Object.getOwnPropertyDescriptor(value, 'held');
  return typeof held?.value === 'boolean' && held.writable === true;
}

let keyCount = 0;
const configurableKeys: symbol[] = [];

/**
 * A key of the test's own, so nothing leaks into the library's slots or between tests. A
 * key made non-configurable cannot be removed, which is why each test gets a fresh one.
 */
function testKey(): symbol {
  const key = Symbol.for(`lifecycleion.sharedSlot.test.${String(++keyCount)}`);
  configurableKeys.push(key);
  return key;
}

/** One bundled copy's view of the slot under `key`. */
function slot(key: symbol): SharedSlot<TestState> {
  return new SharedSlot<TestState>({
    key,
    isValid: isTestState,
    create: () => ({ held: false }),
    isHeld: (state) => state.held,
    setHeld: (state, isHeld) => {
      state.held = isHeld;
    },
  });
}

function slotValue(key: symbol): unknown {
  return Object.getOwnPropertyDescriptor(globalThis, key)?.value;
}

afterEach(() => {
  for (const key of configurableKeys.splice(0)) {
    // Fails quietly for a key a test made non-configurable.
    Reflect.deleteProperty(globalThis, key);
  }
});

test('copies share the state the first one installs', () => {
  const key = testKey();
  const first = slot(key);
  const second = slot(key);

  const state = first.acquire();

  expect(state).toBeDefined();
  expect(slotValue(key)).toBe(state);
  // Taken in one copy is taken in every copy.
  expect(second.isHeld()).toBe(true);
  expect(second.acquire()).toBeUndefined();

  first.release(state as TestState);
  expect(second.isHeld()).toBe(false);
  expect(second.acquire()).toBe(state);
});

test('a copy follows a state another copy installed in place of the one it last read', () => {
  const key = testKey();
  const copy = slot(key);
  expect(copy.isHeld()).toBe(false);
  const original = slotValue(key);

  // What another copy's repair leaves in the slot: a fresh state, here already taken.
  const installed: TestState = { held: true };
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: installed,
  });

  expect(installed).not.toBe(original);
  expect(copy.isHeld()).toBe(true);
  expect(copy.acquire()).toBeUndefined();
  installed.held = false;
  expect(copy.acquire()).toBe(installed);
});

test('a state whose descriptor read throws is replaced', () => {
  const key = testKey();
  const squatter = new Proxy(
    { held: false },
    {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor unavailable');
      },
    },
  );
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: squatter,
  });

  const state = slot(key).acquire();

  expect(state).toBeDefined();
  expect(state).not.toBe(squatter);
  expect(slotValue(key)).toBe(state);
});

test('a state that will not be freed is replaced for every copy', () => {
  const key = testKey();
  const first = slot(key);
  const second = slot(key);
  let writes = 0;
  const target = { held: false };
  // Takes the write that marks it held, and throws on the one that would free it.
  const squatter = new Proxy(target, {
    set(object, property, value: unknown) {
      if (++writes > 1) {
        throw new Error('stuck');
      }
      return Reflect.set(object, property, value);
    },
  });
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: squatter,
  });

  const taken = first.acquire();
  expect(taken).toBe(squatter);
  first.release(squatter);

  expect(target.held).toBe(true);
  expect(slotValue(key)).not.toBe(squatter);
  expect(second.isHeld()).toBe(false);
  expect(second.acquire()).toBe(slotValue(key) as TestState);
});

test('a stuck state another copy already replaced is dropped, not replaced again', () => {
  const key = testKey();
  const copy = slot(key);
  let writes = 0;
  // Takes the write that marks it held, and throws on the one that would free it.
  const stuck = new Proxy(
    { held: false },
    {
      set(object, property, value: unknown) {
        if (++writes > 1) {
          throw new Error('stuck');
        }
        return Reflect.set(object, property, value);
      },
    },
  );
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: stuck,
  });
  expect(copy.acquire()).toBe(stuck);

  // Meanwhile another copy repaired the slot, and holds the healthy state right now.
  const healthy: TestState = { held: true };
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: healthy,
  });

  copy.release(stuck);

  expect(slotValue(key)).toBe(healthy);
  expect(healthy.held).toBe(true);
  expect(copy.isHeld()).toBe(true);
});

test('a state whose flag throws after another copy replaced it is dropped, not replaced again', () => {
  const key = testKey();
  const copy = slot(key);
  const healthy: TestState = { held: true };
  // Valid by its descriptor; reading its flag throws - by then another copy has
  // replaced it in the slot, and holds the healthy state.
  const outdated = new Proxy(
    { held: false },
    {
      get() {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          writable: true,
          value: healthy,
        });
        throw new Error('flag unavailable');
      },
    },
  );
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: outdated,
  });

  expect(copy.isHeld()).toBe(true);
  expect(slotValue(key)).toBe(healthy);
});

test('a definition that throws is not remembered as a refusal', () => {
  const key = testKey();
  const copy = slot(key);
  const defineProperty = spyOn(
    Reflect,
    'defineProperty',
  ).mockImplementationOnce(() => {
    throw new Error('defineProperty unavailable for a moment');
  });

  try {
    // This call falls back to a state of its own...
    const own = copy.acquire();
    expect(own).toBeDefined();
    expect(slotValue(key)).toBeUndefined();
    copy.release(own as TestState);

    // ...and the next one tries the slot again, and shares it.
    const shared = copy.acquire();
    expect(shared).not.toBe(own);
    expect(slotValue(key)).toBe(shared);
    expect(slot(key).isHeld()).toBe(true);
  } finally {
    defineProperty.mockRestore();
  }
});

test('a state that ignores the write that takes it is replaced, and the fresh one taken', () => {
  const key = testKey();
  const squatter = new Proxy(
    { held: false },
    {
      set: () => true,
    },
  );
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: squatter,
  });

  const state = slot(key).acquire();

  expect(state).not.toBe(squatter);
  expect(state?.held).toBe(true);
  expect(slotValue(key)).toBe(state);
});

test('a non-configurable but writable key still takes a fresh state', () => {
  const key = testKey();
  Object.defineProperty(globalThis, key, {
    configurable: false,
    writable: true,
    value: 'not a state',
  });

  const state = slot(key).acquire();

  // Shared through the slot, not a state of this copy's own.
  expect(state).toBeDefined();
  expect(slotValue(key)).toBe(state);
  expect(slot(key).isHeld()).toBe(true);
});

test('a key that cannot hold a state leaves each copy on its own, and is not tried again', () => {
  const key = testKey();
  Object.defineProperty(globalThis, key, {
    configurable: false,
    writable: false,
    value: 'not a state',
  });
  const defineProperty = spyOn(Reflect, 'defineProperty');
  const attemptsOnKey = (): number =>
    defineProperty.mock.calls.filter(
      ([target, property]) => target === globalThis && property === key,
    ).length;

  try {
    const first = slot(key);
    const second = slot(key);
    const own = first.acquire();

    expect(own).toBeDefined();
    expect(slotValue(key)).toBe('not a state');
    const attempts = attemptsOnKey();
    expect(attempts).toBeGreaterThan(0);

    // Latched: the same state of its own, with no further attempt on the global.
    first.release(own as TestState);
    expect(first.isHeld()).toBe(false);
    expect(first.acquire()).toBe(own);
    expect(attemptsOnKey()).toBe(attempts);

    // Each copy keeps its own, so the other is not blocked by this one's hold.
    const secondOwn = second.acquire();
    expect(secondOwn).toBeDefined();
    expect(secondOwn).not.toBe(own);
  } finally {
    defineProperty.mockRestore();
  }
});
