import { describe, expect, test } from 'bun:test';
import type { Logger } from '../logger';
import type { BaseComponent } from './base-component';
import { Plain, setup } from './test-helpers';
import type { InsertComponentAtResult } from './types';

// The timeout hooks the abort signals replaced. A component that still defines one would
// otherwise be silently ignored, so registration refuses it instead.
const REMOVED_HOOKS = [
  [
    'onStartupAborted',
    'onStartupAborted() was removed: use the AbortSignal passed to start(); set ownsLateStartCleanup: true if the component cleans up a late start itself',
  ],
  [
    'onGracefulStopTimeout',
    'onGracefulStopTimeout() was removed: use the AbortSignal passed to stop()',
  ],
  [
    'onShutdownForceAborted',
    'onShutdownForceAborted() was removed: use the AbortSignal passed to onShutdownForce()',
  ],
] as const;

type HookName = (typeof REMOVED_HOOKS)[number][0];

// The ways a component can still carry a removed hook.
const DEFINITIONS: [
  string,
  (logger: Logger, hook: HookName) => BaseComponent,
][] = [
  [
    'a class method',
    (logger, hook) => {
      class Legacy extends Plain {}
      Object.defineProperty(Legacy.prototype, hook, {
        value: (): void => {},
        configurable: true,
      });
      return new Legacy(logger, 'legacy');
    },
  ],
  [
    'an inherited method',
    (logger, hook) => {
      class LegacyBase extends Plain {}
      Object.defineProperty(LegacyBase.prototype, hook, {
        value: (): void => {},
        configurable: true,
      });
      class Legacy extends LegacyBase {}
      return new Legacy(logger, 'legacy');
    },
  ],
  [
    'an own property',
    (logger, hook) => {
      const component = new Plain(logger, 'legacy');
      Object.assign(component, { [hook]: (): void => {} });
      return component;
    },
  ],
  [
    'a getter that throws',
    (logger, hook) => {
      const component = new Plain(logger, 'legacy');
      Object.defineProperty(component, hook, {
        get: (): never => {
          throw new Error('hook getter exploded');
        },
        configurable: true,
      });
      return component;
    },
  ],
];

const ACTIONS: [
  string,
  (
    manager: ReturnType<typeof setup>['manager'],
    component: BaseComponent,
  ) => Promise<InsertComponentAtResult>,
][] = [
  [
    'registerComponent()',
    async (manager, component) =>
      (await manager.registerComponent(
        component,
      )) as unknown as InsertComponentAtResult,
  ],
  [
    'insertComponentAt()',
    (manager, component) => manager.insertComponentAt(component, 'start'),
  ],
];

describe('components that define a removed timeout hook', () => {
  for (const [hook, message] of REMOVED_HOOKS) {
    for (const [definition, make] of DEFINITIONS) {
      for (const [action, register] of ACTIONS) {
        test(`${action} refuses ${hook} defined as ${definition}`, async () => {
          const { logger, manager } = setup();
          const rejected: { reason: string; message: string }[] = [];
          manager.on(
            'component:registration-rejected',
            (data: { reason: string; message: string }) => {
              rejected.push(data);
            },
          );
          const component = make(logger, hook);

          const result = await register(manager, component);

          expect(result.success).toBe(false);
          expect(result.registered).toBe(false);
          expect(result.code).toBe('invalid_options');
          expect(result.reason).toBe(
            `Component "legacy" defines a removed hook: ${message}`,
          );
          expect(result.error).toBeInstanceOf(TypeError);
          expect(result.error?.message).toBe(result.reason);
          expect(result.registrationIndexAfter).toBeNull();
          expect(rejected).toEqual([
            expect.objectContaining({
              reason: 'invalid_options',
              message: result.reason,
            }) as { reason: string; message: string },
          ]);
          expect(manager.hasComponent('legacy')).toBe(false);
          expect(component._isRegisteredWithManager()).toBe(false);
        });
      }
    }
  }

  test('every removed hook a component defines is named', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'legacy');
    Object.assign(component, {
      onGracefulStopTimeout: (): void => {},
      onStartupAborted: (): void => {},
    });

    const result = await manager.registerComponent(component);

    expect(result.code).toBe('invalid_options');
    expect(result.reason).toBe(
      `Component "legacy" defines removed hooks: ${REMOVED_HOOKS[0][1]}; ${REMOVED_HOOKS[1][1]}`,
    );
  });

  test('a hook property left undefined is not refused, and the component registers once the hook is gone', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'legacy');
    // A declared-but-unset class field (`useDefineForClassFields`) defines no hook.
    Object.assign(component, { onStartupAborted: undefined });

    expect((await manager.registerComponent(component)).success).toBe(true);
    expect((await manager.unregisterComponent('legacy')).success).toBe(true);

    Object.assign(component, { onShutdownForceAborted: (): void => {} });
    expect((await manager.registerComponent(component)).code).toBe(
      'invalid_options',
    );
    Reflect.deleteProperty(component, 'onShutdownForceAborted');
    expect((await manager.registerComponent(component)).success).toBe(true);
  });

  test('a refused registration does not consume the name', async () => {
    const { logger, manager } = setup();
    const legacy = new Plain(logger, 'shared');
    Object.assign(legacy, { onGracefulStopTimeout: (): void => {} });

    expect((await manager.registerComponent(legacy)).code).toBe(
      'invalid_options',
    );
    expect(
      (await manager.registerComponent(new Plain(logger, 'shared'))).success,
    ).toBe(true);
  });
});
