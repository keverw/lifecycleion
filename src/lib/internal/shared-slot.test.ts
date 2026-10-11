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

  const state = first.current();

  expect(slotValue(key)).toBe(state);
  expect(second.current()).toBe(state);

  const taken = first.acquire();
  expect(taken).toBe(state);
  // Taken in one copy is taken in every copy.
  expect(second.isHeld()).toBe(true);
  expect(second.acquire()).toBeUndefined();

  first.release(state);
  expect(second.isHeld()).toBe(false);
  expect(second.acquire()).toBe(state);
});

test('a copy follows a state another copy installed in place of the one it last read', () => {
  const key = testKey();
  const first = slot(key);
  const second = slot(key);
  const original = second.current();

  const replacement = first.replace();

  expect(replacement).not.toBe(original);
  expect(second.current()).toBe(replacement);
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

  const state = slot(key).current();

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

test('a non-configurable but writable key still takes a fresh state', () => {
  const key = testKey();
  Object.defineProperty(globalThis, key, {
    configurable: false,
    writable: true,
    value: 'not a state',
  });

  const first = slot(key);
  const state = first.current();

  // Shared through the slot, not a state of this copy's own.
  expect(slotValue(key)).toBe(state);
  expect(slot(key).current()).toBe(state);
});

test('a key that cannot hold a state leaves each copy on its own, and is not tried again', () => {
  const key = testKey();
  Object.defineProperty(globalThis, key, {
    configurable: false,
    writable: false,
    value: 'not a state',
  });
  const defineProperty = spyOn(Reflect, 'defineProperty');

  try {
    const first = slot(key);
    const second = slot(key);
    const own = first.current();

    expect(slotValue(key)).toBe('not a state');
    const attempts = defineProperty.mock.calls.filter(
      ([target, property]) => target === globalThis && property === key,
    ).length;
    expect(attempts).toBeGreaterThan(0);

    // Latched: the same state of its own, with no further attempt on the global.
    expect(first.current()).toBe(own);
    expect(first.replace()).toBe(own);
    expect(first.acquire()).toBe(own);
    expect(
      defineProperty.mock.calls.filter(
        ([target, property]) => target === globalThis && property === key,
      ).length,
    ).toBe(attempts);

    // Each copy keeps its own, so the other is not blocked by this one's hold.
    expect(second.acquire()).not.toBe(own);
    first.release(own);
    expect(first.isHeld()).toBe(false);
  } finally {
    defineProperty.mockRestore();
  }
});
