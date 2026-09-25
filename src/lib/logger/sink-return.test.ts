import { expect, spyOn, test } from 'bun:test';
import { Logger } from './index';
import { sleep } from '../sleep';

for (const isDiagnostic of [false, true]) {
  test(`${isDiagnostic ? 'diagnostic' : 'ordinary'} sink return classification does not claim the sink threw`, async () => {
    const output = spyOn(console, 'error').mockImplementation(() => {});
    let deliveries = 0;
    const delivered = (): Promise<void> => {
      deliveries++;
      // Deliberately violate the sink return contract after successful delivery.
      return {
        get then(): never {
          throw new Error('unreadable return');
        },
      } as unknown as Promise<void>;
    };
    const logger = new Logger({
      callProcessExit: false,
      sinks: [
        {
          write: isDiagnostic
            ? (): never => {
                throw new Error('original failure');
              }
            : delivered,
        },
      ],
      diagnosticSinks: isDiagnostic
        ? [{ write: () => {}, writeDiagnostic: delivered }]
        : [],
    });
    try {
      logger.info('entry');
      await sleep(0);
      expect(deliveries).toBe(1);
      expect(output).toHaveBeenCalledTimes(1);
      const message = String(output.mock.calls[0]?.[0]);
      expect(message).toContain(
        'returned a value whose then could not be read',
      );
      expect(message).toContain('unreadable return');
      expect(message).toContain('sink #1');
      expect(message).not.toContain('also threw');
      expect(message).not.toContain('original failure');
    } finally {
      output.mockRestore();
    }
  });
}

test('close adopts a hostile native promise and reads its method once', async () => {
  let closeReads = 0;
  let ownThenCalls = 0;
  const closed = Promise.resolve();
  void Object.defineProperties(closed, {
    constructor: { value: undefined },
    then: {
      value: (): void => {
        ownThenCalls++;
      },
    },
  });
  const logger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write: () => {},
        get close() {
          closeReads++;
          return (): Promise<void> => closed;
        },
      },
    ],
  });
  let didEmit = false;
  logger.on('logger', (event) => {
    if ((event as { eventType: string }).eventType === 'close') {
      didEmit = true;
    }
  });
  const result = await Promise.race([
    logger.close().then(() => 'closed'),
    sleep(50).then(() => 'timeout'),
  ]);
  expect(result).toBe('closed');
  expect(closeReads).toBe(1);
  expect(ownThenCalls).toBe(0);
  expect(didEmit).toBe(true);
});

test('close identifies unreadable returns without claiming the sink threw', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write: () => {},
        close: () =>
          ({
            get then(): never {
              throw new Error('close return');
            },
          }) as unknown as Promise<void>,
      },
    ],
  });
  try {
    await logger.close();
    expect(output).toHaveBeenCalledTimes(1);
    const message = String(output.mock.calls[0]?.[0]);
    expect(message).toContain('Log sink #1 close returned a value');
    expect(message).toContain('then could not be read');
  } finally {
    output.mockRestore();
  }
});

test('close identifies sinks using their configured list indices', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const makeSink = () => ({
    write: () => {},
    close: () =>
      ({
        get then(): never {
          throw new Error('close return');
        },
      }) as unknown as Promise<void>,
  });
  const a = makeSink();
  const b = makeSink();
  const c = makeSink();
  const logger = new Logger({
    callProcessExit: false,
    sinks: [a, b],
    diagnosticSinks: [c, a],
  });
  try {
    await logger.close();
    const lines = output.mock.calls.map((call) => String(call[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Log sink #1 close');
    expect(lines[1]).toContain('Log sink #2 close');
    expect(lines[2]).toContain('Diagnostic sink #1 close');
  } finally {
    output.mockRestore();
  }
});

test('close preserves sink identity when a close hook removes its own sink', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({ callProcessExit: false, sinks: [] });
  const sink = {
    write: () => {},
    close: (): Promise<void> => {
      logger.removeSink(sink);
      return {
        get then(): never {
          throw new Error('close return');
        },
      } as unknown as Promise<void>;
    },
  };
  logger.addSink(sink);
  try {
    await logger.close();
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]?.[0])).toContain('Log sink #1 close');
  } finally {
    output.mockRestore();
  }
});
