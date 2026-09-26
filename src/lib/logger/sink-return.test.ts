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

test('a sink thenable is adopted from one accessor read without a false sink failure', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  let reads = 0;
  let calls = 0;
  const logger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write: () =>
          ({
            get then() {
              if (++reads > 1) {
                throw new Error('second read');
              }
              return (resolve: () => void): void => {
                calls++;
                resolve();
              };
            },
          }) as unknown as Promise<void>,
      },
    ],
  });
  try {
    logger.info('entry');
    await sleep(0);
    expect(reads).toBe(1);
    expect(calls).toBe(1);
    expect(output).not.toHaveBeenCalled();
  } finally {
    output.mockRestore();
  }
});

test('diagnostic fallback identifies the original log sink list', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  const logger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write: () => {
          throw new Error('write failed');
        },
        writeDiagnostic: () =>
          ({
            get then(): never {
              throw new Error('return failed');
            },
          }) as unknown as Promise<void>,
      },
    ],
  });
  try {
    logger.info('entry');
    await sleep(0);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]?.[0])).toContain('Log sink #1');
    expect(String(output.mock.calls[0]?.[0])).not.toContain('Diagnostic sink');
  } finally {
    output.mockRestore();
  }
});

test('a write uses its initial sink snapshot when sinks remove and add destinations', () => {
  const deliveries: string[] = [];
  const configuredSinks: { write: () => void }[] = [];
  // Numeric membership, not a caller-overridden iterator, defines destinations.
  Object.defineProperty(configuredSinks, Symbol.iterator, {
    value: () => [].values(),
  });
  const logger = new Logger({ callProcessExit: false, sinks: configuredSinks });
  const added = {
    write: () => {
      deliveries.push('added');
    },
  };
  const first = {
    write: () => {
      deliveries.push('first');
      logger.removeSink(first);
      logger.addSink(added);
    },
  };
  const second = {
    write: () => {
      deliveries.push('second');
    },
  };
  logger.addSink(first);
  logger.addSink(second);
  logger.info('initial');
  expect(deliveries).toEqual(['first', 'second']);
  deliveries.length = 0;
  logger.info('next');
  expect(deliveries).toEqual(['second', 'added']);
});

test('logger owns both sink lists and mutations do not edit the caller arrays', async () => {
  const deliveries: string[] = [];
  const sink = {
    write: (): void => {
      deliveries.push('log');
    },
  };
  const diagnostic = {
    write: (): void => {
      deliveries.push('diagnostic');
    },
  };
  const sinks = [sink];
  const diagnostics = [diagnostic];
  const logger = new Logger({
    callProcessExit: false,
    sinks,
    diagnosticSinks: diagnostics,
  });
  sinks.length = 0;
  diagnostics.length = 0;
  logger.info('entry');
  expect(deliveries).toEqual(['log']);
  expect(logger.getDiagnosticSinks()).toEqual([diagnostic]);
  const extra = { write: (): void => {} };
  logger.addSink(extra);
  logger.addDiagnosticSink(extra);
  expect(sinks).toEqual([]);
  expect(diagnostics).toEqual([]);
  expect(logger.removeSink(extra)).toBe(true);
  expect(logger.removeDiagnosticSink(extra)).toBe(true);
  expect(logger.getSinks()).toEqual([sink]);
  expect(logger.getDiagnosticSinks()).toEqual([diagnostic]);
  await logger.close();
});
