import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import { BaseComponent } from '../base-component';
import { claimReports } from '../test-helpers';
import { dispatchAnnouncedHook } from './component-dispatch';

class DispatchComponent extends BaseComponent {
  public start() {}
  public stop() {}
}

test('a timeout whose late-failure observation throws is a manager failure, not the handler throwing', async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const component = new DispatchComponent(logger, { name: 'target' });
  const failure = new Error('observer broke');
  const context = {
    logger: logger.service('dispatch-test'),
    observeFailureAfterTimeout: (): void => {
      throw failure;
    },
  };
  const { reports, release } = claimReports();
  let dispatch;
  try {
    dispatch = await dispatchAnnouncedHook(context, {
      name: 'target',
      component,
      handler: () => new Promise<never>(() => {}),
      args: [],
      timeoutMS: 5,
      announce: () => {},
      recheck: () => undefined,
      timeoutLog: 'Handler timed out',
      timeoutLogParams: {},
      lateFailureMessage: 'Handler failed after it had already timed out',
    });
  } finally {
    release();
  }

  // The handler did time out; that it threw would blame the component's code for the
  // manager's own failure.
  expect(dispatch).toEqual({ status: 'timed_out' });
  expect(reports).toHaveLength(1);
  expect((reports[0] as Error).message).toBe(
    'Error in a callback lifecycle-manager late failure observation for target',
  );
  expect((reports[0] as Error).cause).toBe(failure);
});
