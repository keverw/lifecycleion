import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import { LifecycleManager } from '../lifecycle-manager';
import { Plain } from '../test-helpers';

class Listening extends Plain {
  public received: unknown[] = [];

  constructor(logger: Logger, name: string) {
    super(logger, name);
    (this as unknown as { onMessage: (payload: unknown) => string }).onMessage =
      (payload) => {
        this.received.push(payload);
        return 'ok';
      };
  }
}

test('broadcast does not send to a replacement an isComponentRunning() override registered', async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  let isArmed = false;
  let replacement: Listening | undefined;

  class ReplacingManager extends LifecycleManager {
    public override isComponentRunning(name: string): boolean {
      // The broadcast's eligibility read for the selected `b`: swap in a replacement.
      if (isArmed && name === 'b') {
        isArmed = false;
        void this.unregisterComponent('b');
        replacement = new Listening(logger, 'b');
        void this.registerComponent(replacement);
      }

      return super.isComponentRunning(name);
    }
  }

  const manager = new ReplacingManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const original = new Listening(logger, 'b');
  await manager.registerComponent(original);
  isArmed = true;

  const results = await manager.broadcastMessage('hello', {
    componentNames: ['b'],
    includeStopped: true,
  });

  expect(manager.getComponentInstance('b')).toBe(replacement);
  expect(results).toHaveLength(1);
  expect(results[0].sent).toBe(false);
  expect(results[0].code).toBe('stopped');
  expect(replacement?.received).toEqual([]);
  expect(original.received).toEqual([]);
});
