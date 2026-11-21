import { expect, test } from 'bun:test';
import { claimReports, deferred, Plain, setup } from './test-helpers';
import type { RegisterComponentResult } from './types';

function expectRegistrationShape(result: RegisterComponentResult): void {
  expect(result.action).toBe('register');
  for (const key of [
    'requestedPosition',
    'actualPosition',
    'manualPositionRespected',
    'targetFound',
  ]) {
    expect(Object.keys(result)).not.toContain(key);
  }
  if (result.autoStartDeferred !== true) {
    expect(Object.keys(result)).not.toContain('autoStartDeferred');
  }
}

test('successful registration omits insertion metadata', async () => {
  const { logger, manager } = setup();
  const result = await manager.registerComponent(new Plain(logger, 'a'));
  expect(result).toMatchObject({
    success: true,
    registered: true,
    componentName: 'a',
    registrationIndexBefore: null,
    registrationIndexAfter: 0,
    startupOrder: ['a'],
  });
  expectRegistrationShape(result);
});

test('refused registration omits insertion metadata and preserves the refusal', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  await manager.registerComponent(component);
  const result = await manager.registerComponent(component);
  expect(result).toMatchObject({
    success: false,
    registered: false,
    componentName: 'a',
    code: 'duplicate_instance',
  });
  expectRegistrationShape(result);
});

test('crashed registration omits insertion metadata and preserves its error', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const error = new Error('getName failed');
  component.getName = (): string => {
    throw error;
  };
  const { release } = claimReports();
  try {
    const result = await manager.registerComponent(component);
    expect(result).toMatchObject({
      success: false,
      registered: false,
      code: 'operation_crashed',
    });
    expect(result.error).toBe(error);
    expectRegistrationShape(result);
  } finally {
    release();
  }
});

test('registration preserves deferred auto-start without insertion metadata', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const entered = deferred();
  const gate = deferred();
  component.start = (): Promise<void> => {
    entered.resolve();
    return gate.promise;
  };
  await manager.registerComponent(component);
  const startup = manager.startAllComponents();
  await entered.promise;
  try {
    const result = await manager.registerComponent(new Plain(logger, 'b'), {
      autoStart: true,
    });
    expect(result).toMatchObject({
      success: true,
      registered: true,
      autoStartDeferred: true,
      autoStartAttempted: false,
    });
    expectRegistrationShape(result);
  } finally {
    gate.resolve();
    await startup;
    await manager.stopAllComponents();
  }
});

test('insertion still returns its position metadata', async () => {
  const { logger, manager } = setup();
  const result = await manager.insertComponentAt(new Plain(logger, 'a'), 'end');
  expect(result).toMatchObject({
    action: 'insert',
    success: true,
    requestedPosition: { position: 'end' },
    actualPosition: { index: 0 },
    manualPositionRespected: true,
  });
});
