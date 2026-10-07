import { expect, test } from 'bun:test';
import { claimReports } from '../test-helpers';
import { TransitionEventDispatcher } from './transition-event-dispatcher';

test('nested transitions defer notifications and a throwing outer transition still drains them', () => {
  const delivered: string[] = [];
  const dispatcher = new TransitionEventDispatcher((event) =>
    delivered.push(event),
  );
  const failure = new Error('transition failed');
  expect(() =>
    dispatcher.withTransition(() => {
      dispatcher.emit('component:unregistered', { name: 'a' });
      dispatcher.withTransition(() => {
        dispatcher.emit('component:start-skipped', {
          name: 'b',
          reason: 'test',
        });
      });
      expect(delivered).toEqual([]);
      throw failure;
    }),
  ).toThrow(failure);
  expect(delivered).toEqual([
    'component:unregistered',
    'component:start-skipped',
  ]);
  dispatcher.emit('lifecycle-manager:signals-detached', undefined);
  expect(delivered.at(-1)).toBe('lifecycle-manager:signals-detached');
});

test('a control checkpoint interrupts a drain while its notifications join the existing FIFO', () => {
  const order: string[] = [];
  const dispatcher = new TransitionEventDispatcher((event) => {
    order.push(event);
    if (event === 'component:unregistered') {
      dispatcher.emit('lifecycle-manager:signals-attached', undefined);
      order.push('first-delivery-complete');
    } else if (event === 'lifecycle-manager:signals-attached') {
      dispatcher.withTransition(() => {
        dispatcher.emit('lifecycle-manager:signals-detached', undefined);
      });
      order.push('control-delivery-complete');
    }
  });
  dispatcher.withTransition(() => {
    dispatcher.emit('component:unregistered', { name: 'a' });
    dispatcher.emit('component:start-skipped', { name: 'b', reason: 'test' });
  });
  expect(order).toEqual([
    'component:unregistered',
    'lifecycle-manager:signals-attached',
    'control-delivery-complete',
    'first-delivery-complete',
    'component:start-skipped',
    'lifecycle-manager:signals-detached',
  ]);
});

test('delivery failures are reported without losing the remaining queue or holding the drain', () => {
  const delivered: string[] = [];
  const dispatcher = new TransitionEventDispatcher((event) => {
    if (event === 'component:unregistered') {
      throw new Error('delivery failed');
    }
    delivered.push(event);
  });
  const { reports, release } = claimReports();
  try {
    dispatcher.withTransition(() => {
      dispatcher.emit('component:unregistered', { name: 'a' });
      dispatcher.emit('lifecycle-manager:signals-detached', undefined);
    });
    dispatcher.emit('component:unregistered', { name: 'b' });
    dispatcher.emit('lifecycle-manager:signals-attached', undefined);
    expect(delivered).toEqual([
      'lifecycle-manager:signals-detached',
      'lifecycle-manager:signals-attached',
    ]);
    expect(reports).toHaveLength(2);
    expect(dispatcher.pendingEvents).toHaveLength(0);
  } finally {
    release();
  }
});

test('shutdown initiation interrupts a listener before its shutdown work while state events retain FIFO order', () => {
  const order: string[] = [];
  const dispatcher = new TransitionEventDispatcher((event) => {
    order.push(event);
    if (event === 'component:unregistered') {
      dispatcher.withTransition(() => {
        dispatcher.emit('lifecycle-manager:shutdown-initiated', {
          method: 'manual',
          duringStartup: false,
        });
        order.push('shutdown-work');
      });
      order.push('outer-listener-completed');
    } else if (event === 'lifecycle-manager:shutdown-initiated') {
      dispatcher.emit('lifecycle-manager:signals-detached', undefined);
    }
  });
  dispatcher.withTransition(() => {
    dispatcher.emit('component:unregistered', { name: 'a' });
    dispatcher.emit('component:start-skipped', { name: 'b', reason: 'test' });
  });
  expect(order).toEqual([
    'component:unregistered',
    'lifecycle-manager:shutdown-initiated',
    'shutdown-work',
    'outer-listener-completed',
    'component:start-skipped',
    'lifecycle-manager:signals-detached',
  ]);
});
