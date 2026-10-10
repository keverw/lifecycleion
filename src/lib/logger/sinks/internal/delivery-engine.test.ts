import { describe, expect, test } from 'bun:test';
import {
  DeliveryEngine,
  FILE_SINK_PRE_ENGINE_BEHAVIOR,
  ORPHAN_SETTLE_MS,
  PRE_ENGINE_BEHAVIOR,
  type DeliveryCompat,
  type DeliverySlot,
  type DestinationAdapter,
  type EndContext,
  type OpenContext,
  type OpenResult,
  type WriteOutcome,
} from './delivery-engine';
import type { SinkFailure, SinkFailureKind } from './sink-failure';
import { markDiagnosticEntry } from '../../internal/sink-failure-routing';
import type { LogEntry } from '../../types';

const entry = (message: string): LogEntry => ({
  timestamp: 0,
  type: 'info',
  template: message,
  message,
});

const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `predicate` holds: a reopen may come from the timer rather than at once. */
async function until(
  predicate: () => boolean,
  timeoutMS = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMS;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not reached');
    }

    await tick(5);
  }
}

interface PendingWrite {
  slot: DeliverySlot;
  done: (outcome: WriteOutcome) => void;
}

/**
 * A destination the test drives by hand: opens answer what they are told, and every write
 * waits until the test settles it.
 */
class FakeDestination implements DestinationAdapter {
  public readonly label = 'FakeSink';
  public readonly maxInFlight: number = Infinity;
  public isOpen = false;
  /** Answers for the next opens, in order; `'pending'` waits for {@link answerOpen}. */
  public openAnswers: Array<OpenResult | 'pending'> = [];
  public defaultOpen: OpenResult = { status: 'open' };
  public readonly opens: OpenContext[] = [];
  public readonly writes: PendingWrite[] = [];
  public readonly delivered: string[] = [];
  /** What `write()` answers: `false` is backpressure. */
  public canContinue = true;
  public readonly drainWaiters: Array<() => void> = [];
  public releases = 0;
  public readonly ends: number[] = [];
  public readonly endContexts: Array<EndContext | undefined> = [];
  /** Whether `write()` hands the line over at once, or leaves it uncommitted. */
  public commitsOnWrite = true;
  /** How many times the engine said close stopped draining. */
  public closedCalls = 0;
  /** Whether `end()` fails the writes still pending, as destroying a stream does. */
  public doesEndFailPending = false;
  public refusal?: Error;
  /** Called with each line as it is handed over. */
  public onWrite?: (slot: DeliverySlot) => void;
  private openWaiter?: (result: OpenResult) => void;

  public target(): string {
    return 'fake://destination';
  }

  public open(context: OpenContext): Promise<OpenResult> {
    this.opens.push(context);

    const answer = this.openAnswers.shift() ?? this.defaultOpen;

    if (answer === 'pending') {
      return new Promise((resolve) => {
        this.openWaiter = (result) => {
          this.isOpen = result.status === 'open';
          resolve(result);
        };
      });
    }

    this.isOpen = answer.status === 'open';

    return Promise.resolve(answer);
  }

  public answerOpen(result: OpenResult): void {
    const waiter = this.openWaiter;

    this.openWaiter = undefined;
    waiter?.(result);
  }

  public isUsable(): boolean {
    return this.isOpen;
  }

  public hasConnection(): boolean {
    return this.isOpen;
  }

  public write(
    slot: DeliverySlot,
    _context: { isClosing: boolean },
    done: (outcome: WriteOutcome) => void,
    onCommitted: () => void,
  ): boolean {
    if (this.commitsOnWrite) {
      onCommitted();
    }

    this.writes.push({ slot, done });
    this.onWrite?.(slot);

    return this.canContinue;
  }

  public onDrain(resume: () => void): boolean {
    this.drainWaiters.push(resume);

    return true;
  }

  public checkReopen(): Error | undefined {
    return this.refusal;
  }

  public release(): void {
    this.releases++;
    this.isOpen = false;
  }

  public onClosed(): void {
    this.closedCalls++;
  }

  public end(timeoutMS: number, context?: EndContext): Promise<number> {
    this.ends.push(timeoutMS);
    this.endContexts.push(context);
    this.isOpen = false;

    if (this.doesEndFailPending) {
      for (const pending of this.writes.splice(0)) {
        pending.done({
          status: 'failed',
          error: new Error('destroyed'),
          isRetryable: true,
        });
      }
    }

    return Promise.resolve(0);
  }

  /** Settle the oldest pending writes as delivered. */
  public succeed(count = 1): void {
    for (let index = 0; index < count; index++) {
      const pending = this.writes.shift();

      if (pending === undefined) {
        throw new Error('no write pending');
      }

      this.delivered.push(pending.slot.line);
      pending.done({ status: 'written' });
    }
  }

  /** Fail the oldest pending write. */
  public fail(
    error: Error = new Error('EPIPE'),
    isRetryable = true,
    extra: { kind?: SinkFailureKind; onRetry?: () => void } = {},
  ): void {
    const pending = this.writes.shift();

    if (pending === undefined) {
      throw new Error('no write pending');
    }

    pending.done({ status: 'failed', error, isRetryable, ...extra });
  }

  /** The lines handed over and not yet settled, oldest first. */
  public pendingLines(): string[] {
    return this.writes.map((pending) => pending.slot.line);
  }
}

/** The engine's private state, for the invariant and queue assertions. */
interface EngineState {
  state: string;
  closing: boolean;
  reopenTimer?: unknown;
  slots: DeliverySlot[];
  inFlightCount: number;
}

function stateOf(engine: DeliveryEngine): EngineState {
  return engine as unknown as EngineState;
}

/** While not connected and not closing: an open in flight, or exactly one timer armed. */
function expectInvariant(engine: DeliveryEngine): void {
  const state = stateOf(engine);

  if (
    state.closing ||
    state.state === 'closed' ||
    state.state === 'connected'
  ) {
    return;
  }

  expect(state.state === 'opening').toBe(state.reopenTimer === undefined);
}

interface Harness {
  engine: DeliveryEngine;
  destination: FakeDestination;
  reports: SinkFailure[];
  write: (message: string, shouldSuppressFailureReport?: boolean) => void;
}

function makeEngine(
  options: {
    compat?: DeliveryCompat;
    maxQueueSize?: number;
    maxRetries?: number;
    closeTimeoutMS?: number;
    createError?: (message: string) => Error;
    /** Handed the harness, so a handler can act on the engine it is reporting for. */
    onError?: (failure: SinkFailure, harness: Harness) => void;
    destination?: FakeDestination;
  } = {},
): Harness {
  const destination = options.destination ?? new FakeDestination();
  const reports: SinkFailure[] = [];
  const harness = { destination, reports } as Harness;
  const engine = new DeliveryEngine({
    adapter: destination,
    maxQueueSize: options.maxQueueSize ?? 100,
    maxRetries: options.maxRetries ?? 3,
    closeTimeoutMS: options.closeTimeoutMS ?? 200,
    backoff: { initialMS: 20, maxMS: 40 },
    messages: {
      queueFull: (limit) => `full at ${String(limit)}`,
      abandoned: (count) => `abandoned ${String(count)}`,
      refusedAfterClose: () => 'refused after close',
      failedAfterClose: () => 'failed after close',
      notRetained: (attempts) => `not retained after ${String(attempts)}`,
      outageCap: (maxReports) => `cap ${String(maxReports)}`,
      reopenFailed: () => 'reopen failed',
      inFlightUnknown: (count) => `${String(count)} in flight, unknown`,
      lostAtClose: (count, bytesLeft) =>
        `${String(count)} lost at close (${String(bytesLeft)} bytes)`,
    },
    createError: options.createError,
    report: (failure) => {
      reports.push(failure);
      options.onError?.(failure, harness);

      return true;
    },
    hasHandler: () => true,
    compat: options.compat,
  });

  harness.engine = engine;
  harness.write = (message, shouldSuppressFailureReport = false) => {
    engine.enqueue({
      line: message,
      entry: entry(message),
      shouldSuppressFailureReport,
    });
  };

  return harness;
}

/** Start the engine and wait until its first open has settled. */
async function started(harness: Harness): Promise<Harness> {
  harness.engine.start();
  await harness.engine.openSettled;

  return harness;
}

const MODES: ReadonlyArray<readonly [string, DeliveryCompat]> = [
  ['engine rules', {}],
  ['pre-engine behavior', PRE_ENGINE_BEHAVIOR],
];

describe.each(MODES)('DeliveryEngine (%s)', (_label, compat) => {
  test('holds lines until the destination opens, then delivers them in order', async () => {
    const destination = new FakeDestination();
    destination.openAnswers = ['pending'];
    const { engine, write } = makeEngine({ compat, destination });

    engine.start();
    write('a');
    write('b');
    write('c');

    expect(engine.getHealth()).toMatchObject({
      isInitialized: false,
      queueSize: 3,
    });
    expect(destination.pendingLines()).toEqual([]);

    destination.answerOpen({ status: 'open' });
    await engine.openSettled;

    expect(destination.pendingLines()).toEqual(['a', 'b', 'c']);

    destination.succeed(3);

    expect(destination.delivered).toEqual(['a', 'b', 'c']);
    expect(engine.getHealth()).toMatchObject({
      isHealthy: true,
      isInitialized: true,
      queueSize: 0,
      droppedEntries: 0,
    });
  });

  test('failed writes keep their place ahead of newer lines across a reconnect', async () => {
    const harness = await started(makeEngine({ compat }));
    const { engine, destination, reports, write } = harness;

    write('a');
    write('b');

    // The connection drops: both writes fail, as a destroyed stream fails them, and the
    // adapter reports the connection gone.
    destination.isOpen = false;
    destination.fail();
    destination.fail();
    write('c');
    engine.connectionLost();
    await until(() => destination.pendingLines().length === 3);

    expect(destination.pendingLines()).toEqual(['a', 'b', 'c']);
    expect(
      reports.map((failure) => [failure.entry?.message, failure.disposition]),
    ).toEqual([
      ['a', 'retrying'],
      ['b', 'retrying'],
    ]);
    expect(reports.every((failure) => failure.attempt === 1)).toBe(true);

    destination.succeed(3);

    expect(destination.delivered).toEqual(['a', 'b', 'c']);
    expect(engine.getHealth().droppedEntries).toBe(0);
  });

  test('retries a line up to maxRetries, then reports it lost once', async () => {
    const { engine, destination, reports, write } = await started(
      makeEngine({ compat, maxRetries: 1 }),
    );

    write('a');
    destination.fail();
    destination.fail();

    expect(
      reports.map((failure) => [failure.disposition, failure.attempt]),
    ).toEqual([
      ['retrying', 1],
      ['lost', 2],
    ]);
    expect(engine.getHealth()).toMatchObject({
      queueSize: 0,
      droppedEntries: 1,
      droppedByKind: { write: 1 },
      consecutiveFailures: 2,
    });
  });

  test('a write that may have delivered part of its line is never replayed', async () => {
    const { engine, destination, reports, write } = await started(
      makeEngine({ compat }),
    );

    write('a');
    destination.fail(new Error('partial'), false);

    expect(reports.map((failure) => failure.disposition)).toEqual(['lost']);
    expect(destination.pendingLines()).toEqual([]);
    expect(engine.getHealth().droppedByKind.write).toBe(1);
  });

  test('a new connection holds newer lines until writes on the old one settle', async () => {
    const { engine, destination, reports, write } = await started(
      makeEngine({ compat }),
    );

    write('a');

    // The connection is replaced while `a` is still in flight on it.
    destination.isOpen = false;
    engine.connectionLost();
    await engine.openSettled;
    write('b');

    // `b` waits: `a` may yet fail and come back ahead of it.
    expect(destination.pendingLines()).toEqual(['a']);

    destination.fail(new Error('late EPIPE'));

    expect(destination.pendingLines()).toEqual(['a', 'b']);
    // A late failure belongs to the connection that is gone.
    expect(reports[0]).toMatchObject({ disposition: 'retrying' });
    expect(engine.getHealth().consecutiveFailures).toBe(0);

    destination.succeed(2);

    expect(destination.delivered).toEqual(['a', 'b']);
  });

  test(
    'the barrier lifts once ORPHAN_SETTLE_MS passes without an answer',
    async () => {
      const { engine, destination, write } = await started(
        makeEngine({ compat }),
      );

      write('a');
      destination.isOpen = false;
      engine.connectionLost();
      await engine.openSettled;
      write('b');

      expect(destination.pendingLines()).toEqual(['a']);

      await tick(ORPHAN_SETTLE_MS + 50);

      if (compat.honorsLateCallbacks === true) {
        // Today's rule: the orphan keeps its callback; newer lines go out past it.
        expect(destination.pendingLines()).toEqual(['a', 'b']);
        destination.succeed(2);
        expect(destination.delivered).toEqual(['a', 'b']);
        expect(engine.getHealth().queueSize).toBe(0);
      } else {
        // The orphan counts as a spent attempt and goes out again, ahead of `b`; its
        // late answer is ignored.
        expect(destination.pendingLines()).toEqual(['a', 'a', 'b']);
        destination.succeed(3);
        expect(destination.delivered).toEqual(['a', 'a', 'b']);
        expect(engine.getHealth().queueSize).toBe(0);
      }
    },
    ORPHAN_SETTLE_MS + 2000,
  );

  test('eviction never takes a line in flight', async () => {
    const { engine, destination, reports, write } = await started(
      makeEngine({ compat, maxQueueSize: 2 }),
    );

    // Backpressure after the first write keeps the rest queued.
    destination.canContinue = false;
    write('a');
    write('b');
    write('c');
    write('d');

    const slots = stateOf(engine).slots;
    const messages = slots.map((slot) => slot.line);

    // `a` is in flight and stays, whatever the cap.
    expect(slots[0]).toMatchObject({ line: 'a', state: 'in_flight' });

    if (compat.countsQueuedOnly === true) {
      // Queued lines alone count against the cap.
      expect(messages).toEqual(['a', 'c', 'd']);
      expect(engine.getHealth().queueSize).toBe(2);
    } else {
      // Every line counts, in flight or not.
      expect(messages).toEqual(['a', 'd']);
      expect(engine.getHealth().queueSize).toBe(2);
    }

    const overflow = reports.filter((failure) => failure.kind === 'queue_full');

    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({
      disposition: 'lost',
      entry: { message: 'b' },
    });
  });

  test('a backpressured destination resumes the queue when it drains', async () => {
    const { destination, write } = await started(makeEngine({ compat }));

    destination.canContinue = false;
    write('a');
    write('b');

    expect(destination.pendingLines()).toEqual(['a']);
    expect(destination.drainWaiters).toHaveLength(1);

    destination.canContinue = true;
    destination.drainWaiters[0]();

    expect(destination.pendingLines()).toEqual(['a', 'b']);
  });

  test('while not connected, an open is in flight or exactly one timer is armed', async () => {
    const destination = new FakeDestination();
    destination.defaultOpen = { status: 'unavailable' };
    const { engine, write } = makeEngine({ compat, destination });

    engine.start();
    expectInvariant(engine);
    await engine.openSettled;
    expectInvariant(engine);

    for (let round = 0; round < 6; round++) {
      write(`line-${String(round)}`);
      expectInvariant(engine);
      await tick(15);
      expectInvariant(engine);
      engine.connectionLost();
      expectInvariant(engine);
    }

    // Kept asking, without traffic, on its own timer.
    expect(destination.opens.length).toBeGreaterThan(2);
    await engine.close();
  });

  test('close drains what the destination takes, then ends it', async () => {
    const { engine, destination, reports, write } = await started(
      makeEngine({ compat }),
    );

    destination.canContinue = false;
    write('a');
    write('b');

    const closing = engine.close();

    expect(engine.getHealth().isHealthy).toBe(false);
    await tick(5);
    destination.canContinue = true;
    destination.succeed();
    destination.drainWaiters[0]();
    destination.succeed();
    await closing;

    expect(destination.delivered).toEqual(['a', 'b']);
    expect(destination.ends).toHaveLength(1);
    expect(reports).toEqual([]);
    expect(engine.getHealth()).toMatchObject({
      isInitialized: false,
      droppedEntries: 0,
    });
  });

  test('close abandons what it cannot send, reported once with the oldest line', async () => {
    const destination = new FakeDestination();
    destination.defaultOpen = { status: 'unavailable' };
    // Room in the grace window for several of its 50 ms polls, so a timer delayed by a
    // busy event loop still leaves time for a second attempt.
    const { engine, reports, write } = await started(
      makeEngine({ compat, destination, closeTimeoutMS: 300 }),
    );

    write('a');
    write('b');
    write('c');
    await engine.close();

    const closeReports = reports.filter((failure) => failure.kind === 'close');

    expect(closeReports).toEqual([
      expect.objectContaining({
        disposition: 'lost',
        entry: expect.objectContaining({ message: 'a' }),
      }),
    ]);
    expect(closeReports[0].error.message).toBe('abandoned 3');
    expect(engine.getHealth().droppedByKind.close).toBe(3);
    // The grace window kept asking, past the backoff.
    expect(
      destination.opens.filter((context) => context.isClosing).length,
    ).toBeGreaterThan(1);
  });

  test('lines refused after close are counted, and reported once', async () => {
    const { engine, reports } = await started(makeEngine({ compat }));

    void engine.close();
    engine.refuseAfterClose(entry('first'));
    engine.refuseAfterClose(entry('second'));

    expect(reports.map((failure) => failure.entry?.message)).toEqual(['first']);
    expect(engine.getHealth().droppedByKind.close).toBe(2);
    await engine.close();
  });

  test('a write in flight when close resolves', async () => {
    const { engine, destination, reports, write } = await started(
      makeEngine({ compat }),
    );

    write('a');
    await engine.close();

    if (compat.honorsLateCallbacks === true) {
      // Left to its callback, which is reported whenever it arrives.
      expect(reports).toEqual([]);
      destination.fail(new Error('late EPIPE'));
      expect(reports).toEqual([
        expect.objectContaining({ kind: 'write', disposition: 'lost' }),
      ]);
      expect(engine.getHealth().droppedByKind.write).toBe(1);
    } else {
      // Settled on the evidence before close resolved: nobody answered for it, so it is
      // reported unknown, uncounted, and its late callback ignored.
      expect(reports).toEqual([
        expect.objectContaining({ kind: 'close', disposition: 'no_entry' }),
      ]);
      expect(reports[0].error.message).toBe('1 in flight, unknown');
      destination.fail(new Error('late EPIPE'));
      expect(reports).toHaveLength(1);
      expect(engine.getHealth().droppedEntries).toBe(0);
    }
  });

  test('writes failed by the destination ending at close', async () => {
    const destination = new FakeDestination();
    destination.doesEndFailPending = true;
    const { engine, reports, write } = await started(
      makeEngine({ compat, destination }),
    );

    write('a');
    write('b');
    await engine.close();

    if (compat.honorsLateCallbacks === true) {
      // Each failed callback is the final word for its own line.
      expect(
        reports.map((failure) => [failure.kind, failure.entry?.message]),
      ).toEqual([
        ['write', 'a'],
        ['write', 'b'],
      ]);
      expect(engine.getHealth().droppedByKind.write).toBe(2);
    } else {
      // One report for the lines the end failed, counted as closing losses.
      expect(reports).toEqual([
        expect.objectContaining({
          kind: 'close',
          disposition: 'lost',
          entry: expect.objectContaining({ message: 'a' }),
        }),
      ]);
      expect(engine.getHealth().droppedByKind.close).toBe(2);
    }
  });

  test('flush resolves once the queue is empty, counting since the last flush', async () => {
    const { engine, destination, write } = await started(
      makeEngine({ compat }),
    );

    write('a');
    write('b');

    const flushing = engine.flush(1000);

    destination.succeed(2);

    expect(await flushing).toEqual({
      success: true,
      entriesWritten: 2,
      entriesFailed: 0,
      timedOut: false,
      entriesQueued: 0,
    });
    expect(await engine.flush(1000)).toMatchObject({ entriesWritten: 0 });
  });

  test('flush during an outage returns after the next attempt fails', async () => {
    const destination = new FakeDestination();
    destination.defaultOpen = { status: 'unavailable' };
    const { engine, write } = await started(
      makeEngine({ compat, destination }),
    );

    write('a');

    const startedAt = Date.now();
    const result = await engine.flush(5000);

    expect(result).toEqual({
      success: false,
      entriesWritten: 0,
      entriesFailed: 0,
      timedOut: false,
      entriesQueued: 1,
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await engine.close();
  });

  test('flush times out on an open that never answers', async () => {
    const destination = new FakeDestination();
    destination.openAnswers = ['pending'];
    const { engine, write } = makeEngine({ compat, destination });

    engine.start();
    write('a');

    expect(await engine.flush(30)).toMatchObject({
      success: false,
      timedOut: true,
      entriesQueued: 1,
    });
  });

  test('reopenNow refuses while the adapter says so, and reports why', async () => {
    const { engine, destination, reports } = await started(
      makeEngine({ compat }),
    );

    destination.refusal = new Error('writes still buffered');

    expect(await engine.reopenNow()).toEqual({
      success: false,
      reason: 'error',
      error: destination.refusal,
    });
    expect(reports).toEqual([
      expect.objectContaining({ kind: 'setup', disposition: 'no_entry' }),
    ]);
    expect(engine.getHealth().isHealthy).toBe(true);
  });

  test('reopenNow waits for an open in flight rather than racing it', async () => {
    const destination = new FakeDestination();
    destination.openAnswers = ['pending'];
    const { engine } = makeEngine({ compat, destination });

    engine.start();

    const reopening = engine.reopenNow();

    expect(await Promise.race([reopening, tick(10)])).toBeUndefined();
    expect(destination.opens).toHaveLength(1);

    destination.answerOpen({ status: 'unavailable' });

    expect(await reopening).toEqual({ success: true });
    expect(destination.opens).toHaveLength(2);
    expect(destination.opens[1].isExplicit).toBe(true);
    expect(await engine.reopenNow()).toEqual({ success: true });
    await engine.close();
    expect(await engine.reopenNow()).toEqual({
      success: false,
      reason: 'closed',
    });
  });
});

describe('DeliveryEngine hostile handlers', () => {
  test.each(MODES)(
    'a handler that closes the sink inside a retrying report leaves the line to close (%s)',
    async (_label, compat) => {
      const harness = makeEngine({
        compat,
        onError: (failure, { engine }) => {
          if (failure.disposition === 'retrying') {
            void engine.close();
          }
        },
      });

      await started(harness);
      harness.write('a');
      harness.destination.fail();
      await harness.engine.close();

      // Closing does not reopen, but its drain still sends the line it was handed.
      expect(harness.destination.delivered).toEqual([]);
      expect(harness.destination.pendingLines()).toEqual(['a']);
    },
  );

  test.each(MODES)(
    'a handler that logs inside a write-failure report does not overtake the failed line (%s)',
    async (_label, compat) => {
      const harness = makeEngine({
        compat,
        onError: (failure, { write }) => {
          if (failure.disposition === 'retrying') {
            write(`report for ${String(failure.entry?.message)}`);
          }
        },
      });
      await started(harness);
      harness.write('a');
      harness.destination.isOpen = false;
      harness.destination.fail();
      harness.engine.connectionLost();
      await until(() => harness.destination.pendingLines().length === 2);

      expect(harness.destination.pendingLines()).toEqual(['a', 'report for a']);
    },
  );

  test.each(MODES)(
    'a handler that reconnects inside the lost-connection report starts one attempt (%s)',
    async (_label, compat) => {
      const harness = await started(makeEngine({ compat }));
      const { engine, destination } = harness;
      const opensBefore = destination.opens.length;
      let reopening: Promise<unknown> | undefined;

      destination.isOpen = false;
      engine.connectionLost({}, () => {
        reopening = engine.reopenNow();
      });
      await reopening;

      expect(destination.opens.length - opensBefore).toBe(1);
      expect(destination.opens.at(-1)?.isExplicit).toBe(true);
      expect(engine.getHealth().isInitialized).toBe(true);
    },
  );

  test('pre-engine behavior: a handler that fills the queue during a retrying report loses the line, said once more', async () => {
    const harness = makeEngine({
      compat: PRE_ENGINE_BEHAVIOR,
      maxQueueSize: 1,
      onError: (failure, { destination, write }) => {
        if (failure.disposition === 'retrying') {
          destination.canContinue = false;
          destination.isOpen = false;
          write('filler');
        }
      },
    });
    await started(harness);
    harness.write('a');
    harness.destination.fail();

    expect(
      harness.reports.map((failure) => [
        failure.entry?.message,
        failure.disposition,
        failure.attempt,
      ]),
    ).toEqual([
      ['a', 'retrying', 1],
      ['a', 'lost', 1],
    ]);
    expect(stateOf(harness.engine).slots.map((slot) => slot.line)).toEqual([
      'filler',
    ]);
    expect(harness.engine.getHealth().droppedByKind.write).toBe(1);
  });

  test('engine rules: a retrying line later evicted gets its own final word', async () => {
    const harness = await started(makeEngine({ maxQueueSize: 2 }));
    const { destination, reports, write } = harness;

    destination.canContinue = false;
    write('a');
    write('b');
    // `a` fails and keeps its place, queued, ahead of `b`.
    destination.fail();
    write('c');
    write('d');

    const finalWords = reports.filter(
      (failure) => failure.disposition === 'lost',
    );

    // The episode's report carried `a`, so `a` is not told twice; `b` was never told
    // anything, so the episode covers it too.
    expect(finalWords.map((failure) => failure.entry?.message)).toEqual(['a']);
    expect(harness.engine.getHealth().droppedByKind.queue_full).toBe(2);
  });

  test('engine rules: a retrying line evicted after the episode was reported is told separately', async () => {
    const harness = await started(makeEngine({ maxQueueSize: 2 }));
    const { destination, reports, write } = harness;

    destination.canContinue = false;
    write('first');
    write('a');
    // The episode is reported here, about `a`.
    write('b');
    // `first` fails and keeps its place, queued and told `'retrying'`, while the
    // destination is still backpressured.
    destination.fail();
    // The next overflow, inside the same episode, evicts it.
    write('c');

    expect(
      reports
        .filter((failure) => failure.kind === 'queue_full')
        .map((failure) => failure.entry?.message),
    ).toEqual(['a', 'first']);
  });

  test('diagnostic lines route their open failures as diagnostics', async () => {
    const destination = new FakeDestination();
    destination.defaultOpen = { status: 'unavailable' };
    const { engine } = await started(makeEngine({ destination }));

    engine.enqueue({
      line: 'diagnostic',
      entry: markDiagnosticEntry(entry('diagnostic')),
      shouldSuppressFailureReport: false,
    });

    expect(engine.openRouting({})).toEqual({
      isDiagnostic: true,
      shouldSuppressFailureReport: false,
    });
    expect(engine.openRouting({ isExplicit: true }).isDiagnostic).toBe(false);

    engine.enqueue({
      line: 'ordinary',
      entry: entry('ordinary'),
      shouldSuppressFailureReport: false,
    });

    expect(engine.openRouting({ isDiagnosticRetry: true })).toEqual({
      isDiagnostic: false,
      shouldSuppressFailureReport: false,
    });
    await engine.close();
  });
});

describe('DeliveryEngine (FileSink pre-engine behavior)', () => {
  /** FileSink's shape: one line at a time, each waiting for its own outcome. */
  const oneAtATime = (): FakeDestination => {
    const destination = new FakeDestination();

    (destination as { maxInFlight: number }).maxInFlight = 1;

    return destination;
  };

  test('a write that failed as setup is reported and counted under setup, and runs onRetry when kept', async () => {
    const destination = oneAtATime();
    const { engine, reports, write } = await started(
      makeEngine({
        compat: FILE_SINK_PRE_ENGINE_BEHAVIOR,
        destination,
        maxRetries: 1,
      }),
    );
    let retries = 0;
    const onRetry = (): void => {
      retries++;
      // Runs before anything sends the line again.
      expect(destination.pendingLines()).toEqual([]);
    };

    write('a');
    destination.fail(new Error('mkdir failed'), true, {
      kind: 'setup',
      onRetry,
    });

    expect(retries).toBe(1);
    expect(destination.pendingLines()).toEqual(['a']);

    destination.fail(new Error('mkdir failed'), true, {
      kind: 'setup',
      onRetry,
    });

    expect(retries).toBe(1);
    expect(
      reports.map((failure) => [
        failure.kind,
        failure.disposition,
        failure.attempt,
      ]),
    ).toEqual([
      ['setup', 'retrying', 1],
      ['setup', 'lost', 2],
    ]);
    expect(engine.getHealth()).toMatchObject({
      consecutiveFailures: 0,
      droppedEntries: 1,
      droppedByKind: { setup: 1, write: 0 },
    });
  });

  test('a handler that fills the queue during a retrying report hears the same failure again as lost', async () => {
    const harness = makeEngine({
      compat: FILE_SINK_PRE_ENGINE_BEHAVIOR,
      destination: oneAtATime(),
      maxQueueSize: 1,
      onError: (failure, { write }) => {
        if (failure.disposition === 'retrying') {
          write('filler');
        }
      },
    });
    const failure = new Error('mkdir failed');

    await started(harness);
    harness.write('a');
    harness.destination.fail(failure, true, { kind: 'setup' });

    expect(
      harness.reports.map((report) => [
        report.kind,
        report.entry?.message,
        report.disposition,
        report.attempt,
      ]),
    ).toEqual([
      ['setup', 'a', 'retrying', 1],
      ['setup', 'a', 'lost', 1],
    ]);
    expect(harness.reports[1].error).toBe(failure);
    // The handler's own line goes out once the failed one has left.
    expect(harness.destination.pendingLines()).toEqual(['filler']);
    expect(harness.engine.getHealth()).toMatchObject({
      consecutiveFailures: 0,
      droppedByKind: { setup: 1, write: 0 },
    });
  });

  test('a write failure is counted once against health, even when said twice', async () => {
    const harness = makeEngine({
      compat: FILE_SINK_PRE_ENGINE_BEHAVIOR,
      destination: oneAtATime(),
      maxQueueSize: 1,
      onError: (failure, { write }) => {
        if (failure.disposition === 'retrying') {
          write('filler');
        }
      },
    });

    await started(harness);
    harness.write('a');
    harness.destination.fail(new Error('EIO'));

    expect(harness.reports.map((report) => report.disposition)).toEqual([
      'retrying',
      'lost',
    ]);
    expect(harness.engine.getHealth()).toMatchObject({
      consecutiveFailures: 1,
      droppedByKind: { write: 1 },
    });
  });

  test('a retry during close goes out at once rather than on the next poll', async () => {
    const destination = oneAtATime();
    const { engine, write } = await started(
      makeEngine({ compat: FILE_SINK_PRE_ENGINE_BEHAVIOR, destination }),
    );

    write('a');

    const closing = engine.close();

    destination.fail();

    expect(destination.pendingLines()).toEqual(['a']);

    destination.succeed();
    await closing;

    expect(destination.delivered).toEqual(['a']);
  });

  test('close waits for a write in flight as it waits for the queue', async () => {
    const destination = oneAtATime();
    const { engine, reports, write } = await started(
      makeEngine({ compat: FILE_SINK_PRE_ENGINE_BEHAVIOR, destination }),
    );
    let isClosed = false;

    write('a');
    void engine.close().then(() => {
      isClosed = true;
    });
    await tick(30);

    expect(isClosed).toBe(false);

    destination.succeed();
    await until(() => isClosed);

    expect(reports).toEqual([]);
    expect(destination.endContexts).toEqual([{ hasReportedInFlight: false }]);
  });

  test('at the deadline, a write never handed over is abandoned with the queue', async () => {
    const destination = oneAtATime();

    destination.commitsOnWrite = false;

    const { engine, reports, write } = await started(
      makeEngine({
        compat: FILE_SINK_PRE_ENGINE_BEHAVIOR,
        destination,
        closeTimeoutMS: 30,
      }),
    );

    write('a');
    write('b');
    await engine.close();

    expect(
      reports.map((failure) => [
        failure.kind,
        failure.disposition,
        failure.entry?.message,
        failure.error.message,
      ]),
    ).toEqual([['close', 'lost', 'a', 'abandoned 2']]);
    expect(destination.endContexts).toEqual([{ hasReportedInFlight: false }]);

    // Its pass resuming into the closed sink says nothing more.
    destination.fail(new Error('closed'), true, { kind: 'close' });

    expect(reports).toHaveLength(1);
    expect(engine.getHealth()).toMatchObject({
      queueSize: 0,
      droppedEntries: 2,
      droppedByKind: { close: 2 },
    });
  });

  test.each(['fails', 'succeeds'] as const)(
    'at the deadline, a write handed over is reported once as unknown, and its late answer %s quietly',
    async (lateAnswer) => {
      const destination = oneAtATime();
      const { engine, reports, write } = await started(
        makeEngine({
          compat: FILE_SINK_PRE_ENGINE_BEHAVIOR,
          destination,
          closeTimeoutMS: 30,
        }),
      );

      write('a');
      write('b');
      await engine.close();

      expect(
        reports.map((failure) => [
          failure.kind,
          failure.disposition,
          failure.entry?.message,
          failure.error.message,
        ]),
      ).toEqual([
        ['close', 'lost', 'b', 'abandoned 1'],
        ['close', 'no_entry', undefined, '1 in flight, unknown'],
      ]);
      expect(destination.endContexts).toEqual([{ hasReportedInFlight: true }]);

      if (lateAnswer === 'fails') {
        destination.fail(new Error('late EIO'));
      } else {
        destination.succeed();
      }

      expect(reports).toHaveLength(2);
      expect(engine.getHealth().lastError?.message).toBe(
        '1 in flight, unknown',
      );
      expect(await engine.flush(100)).toMatchObject({
        entriesWritten: lateAnswer === 'succeeds' ? 1 : 0,
        entriesFailed: 1,
      });
    },
  );

  test('an overflow episode stays open while a line is still in flight', async () => {
    const destination = oneAtATime();
    const { reports, write } = await started(
      makeEngine({
        compat: FILE_SINK_PRE_ENGINE_BEHAVIOR,
        destination,
        maxQueueSize: 1,
      }),
    );

    write('a');
    write('b');
    write('c');
    // `c` goes out; nothing is queued, but the episode is not over until it settles.
    destination.succeed();
    write('d');
    write('e');

    expect(
      reports
        .filter((failure) => failure.kind === 'queue_full')
        .map((failure) => failure.entry?.message),
    ).toEqual(['b']);

    destination.succeed(2);
    write('f');
    write('g');
    write('h');

    expect(
      reports
        .filter((failure) => failure.kind === 'queue_full')
        .map((failure) => failure.entry?.message),
    ).toEqual(['b', 'g']);
  });

  test('the adapter hears close has stopped draining before anything is reported', async () => {
    const destination = oneAtATime();

    destination.commitsOnWrite = false;

    const closedAtReport: number[] = [];
    const harness = makeEngine({
      compat: FILE_SINK_PRE_ENGINE_BEHAVIOR,
      destination,
      closeTimeoutMS: 20,
      onError: () => {
        closedAtReport.push(destination.closedCalls);
      },
    });

    await started(harness);
    harness.write('a');
    await harness.engine.close();

    expect(closedAtReport).toEqual([1]);
  });
});

describe('DeliveryEngine reporting hooks', () => {
  class SinkError extends Error {
    public override readonly name = 'SinkError';
  }

  test("composed reports carry the sink's error class", async () => {
    const harness = await started(
      makeEngine({
        maxQueueSize: 1,
        createError: (message) => new SinkError(message),
      }),
    );

    harness.destination.canContinue = false;
    harness.write('a');
    harness.write('b');
    harness.write('c');

    expect(harness.reports).toHaveLength(1);
    expect(harness.reports[0].error).toBeInstanceOf(SinkError);
    expect(harness.reports[0].error.message).toBe('full at 1');
  });

  test('a report can name its own target, and recordError reports nothing', async () => {
    const { engine, reports } = await started(makeEngine());
    const recorded = new Error('recorded only');

    engine.report('setup', new Error('archive'), { target: '/archive.log' });
    engine.recordError(recorded);

    expect(reports.map((failure) => failure.target)).toEqual(['/archive.log']);
    expect(engine.getHealth().lastError).toBe(recorded);
  });

  test('isDrained covers lines in flight, and flush windows expose their tail', async () => {
    const { engine, destination, write } = await started(makeEngine());
    const before = engine.flushes.settled;

    expect(engine.isDrained).toBe(true);

    write('a');

    expect(engine.isDrained).toBe(false);

    const flushing = engine.flush(1000);

    expect(engine.flushes.settled).not.toBe(before);

    destination.succeed();
    await flushing;

    expect(engine.isDrained).toBe(true);
  });
});
