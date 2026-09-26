import { expect, spyOn, test } from 'bun:test';
import { Logger } from './index';
import type { LoggerDiagnostic } from './types';
import { sleep } from '../sleep';

function unreadableReturn(cause: Error): Promise<void> {
  return {
    get then(): never {
      throw cause;
    },
  } as unknown as Promise<void>;
}

for (const context of ['write', 'close'] as const) {
  for (const failureKind of ['throw', 'reject', 'unreadable'] as const) {
    test(`${context} ${failureKind} failures use the configured diagnostic channel`, async () => {
      const output = spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('sink failure');
      const diagnostics: LoggerDiagnostic[] = [];
      const delivered: LoggerDiagnostic[] = [];
      const fail = (): Promise<void> => {
        if (failureKind === 'throw') {
          throw failure;
        }
        return failureKind === 'reject'
          ? Promise.reject(failure)
          : unreadableReturn(failure);
      };
      const sink = {
        write: context === 'write' ? fail : (): void => {},
        close: context === 'close' ? fail : (): void => {},
      };
      const logger = new Logger({
        callProcessExit: false,
        sinks: [sink],
        diagnosticSinks: [
          {
            write: (): void => {},
            writeDiagnostic: (diagnostic: LoggerDiagnostic): void => {
              delivered.push(diagnostic);
            },
          },
        ],
      });
      logger.on('diagnostic', (diagnostic) => {
        diagnostics.push(diagnostic as LoggerDiagnostic);
      });
      try {
        if (context === 'close') {
          await logger.close();
        } else {
          logger.info('entry');
        }
        await sleep(0);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0].kind).toBe('sink');
        expect(diagnostics[0].context).toBe(context);
        expect(diagnostics[0].sink).toBe(sink);
        expect(delivered).toHaveLength(context === 'write' ? 1 : 0);
        expect(output).not.toHaveBeenCalled();
        if (failureKind === 'unreadable') {
          expect(diagnostics[0].error.cause).toBe(failure);
          expect(diagnostics[0].message).toContain('then could not be read');
          expect(diagnostics[0].message).toContain('Log sink #1');
        } else {
          expect(diagnostics[0].error).toBe(failure);
        }
      } finally {
        output.mockRestore();
      }
    });
  }
}

for (const didDeliver of [false, true]) {
  test(`unreadable diagnostic return retains original context (already delivered: ${didDeliver})`, async () => {
    const output = spyOn(console, 'error').mockImplementation(() => {});
    let deliveries = 0;
    const logger = new Logger({
      callProcessExit: false,
      sinks: [
        {
          write: (): never => {
            throw new Error('original failure');
          },
        },
      ],
      diagnosticSinks: [
        {
          write: (): void => {},
          writeDiagnostic: (): Promise<void> => {
            if (didDeliver) {
              deliveries++;
            }
            // Returning does not prove delivery. A lazy destination can wait until
            // then is invoked, which never happens when reading it already fails.
            return unreadableReturn(new Error('diagnostic return'));
          },
        },
      ],
    });
    try {
      logger.info('entry');
      await sleep(0);
      expect(deliveries).toBe(didDeliver ? 1 : 0);
      expect(output).toHaveBeenCalledTimes(1);
      const message = String(output.mock.calls[0]?.[0]);
      // Previously eager-delivery coverage demanded omission of the original.
      // Retaining it is necessary because the lazy case has no other report.
      expect(message).toContain('original failure');
      expect(message).toContain('Diagnostic sink #1 returned a value');
      expect(message).toContain('diagnostic return');
      expect(message).not.toContain('also threw');
    } finally {
      output.mockRestore();
    }
  });
}

test('malformed ordinary returns use one bounded diagnostic fallback', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  let writes = 0;
  let diagnostics = 0;
  const logger = new Logger({
    callProcessExit: false,
    sinks: [
      {
        write: (): Promise<void> => {
          writes++;
          return unreadableReturn(
            new Error(writes === 1 ? 'original return' : 'fallback return'),
          );
        },
      },
    ],
  });
  logger.on('diagnostic', () => {
    diagnostics++;
  });
  try {
    logger.info('entry');
    await sleep(0);
    expect(writes).toBe(2);
    expect(diagnostics).toBe(1);
    expect(output).toHaveBeenCalledTimes(1);
    const message = String(output.mock.calls[0]?.[0]);
    expect(message).toContain('original return');
    expect(message).toContain('fallback return');
  } finally {
    output.mockRestore();
  }
});

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

for (const key of ['sinks', 'diagnosticSinks'] as const) {
  test(`${key} accepts null as absent and rejects non-array input`, () => {
    const options = (value: unknown) =>
      ({ callProcessExit: false, [key]: value }) as ConstructorParameters<
        typeof Logger
      >[0];
    const logger = new Logger(options(null));
    expect(
      key === 'sinks' ? logger.getSinks() : logger.getDiagnosticSinks(),
    ).toEqual([]);
    const sink = { write: (): void => {} };
    for (const invalid of [new Set([sink]), { 0: sink, length: 1 }, false]) {
      expect(() => new Logger(options(invalid))).toThrow(
        'Logger sink lists must be arrays',
      );
    }
  });
}

for (const addMethod of ['addSink', 'addDiagnosticSink'] as const) {
  for (const when of ['during', 'after'] as const) {
    test(`${addMethod} refuses new ownership ${when} close`, async () => {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let ownedCloses = 0;
      let refusedCloses = 0;
      const logger = new Logger({
        callProcessExit: false,
        sinks: [
          {
            write: () => {},
            close: async () => {
              ownedCloses++;
              entered.resolve();
              await gate.promise;
            },
          },
        ],
      });
      const closing = logger.close();
      await entered.promise;
      const refused = {
        write: () => {},
        close: () => {
          refusedCloses++;
        },
      };
      try {
        if (when === 'after') {
          gate.resolve();
          await closing;
        }
        expect(() => logger[addMethod](refused)).toThrow(
          'Cannot add a sink to a closing or closed logger',
        );
        expect(logger.getSinks()).not.toContain(refused);
        expect(logger.getDiagnosticSinks()).not.toContain(refused);
        expect(refusedCloses).toBe(0);
      } finally {
        gate.resolve();
        await closing;
        // A refused sink never becomes logger-owned; its caller disposes it.
        refused.close();
      }
      expect(ownedCloses).toBe(1);
      expect(refusedCloses).toBe(1);
    });
  }
}
