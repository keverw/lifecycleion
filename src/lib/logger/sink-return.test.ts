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
      expect(message).not.toContain('also threw');
      expect(message).not.toContain('original failure');
    } finally {
      output.mockRestore();
    }
  });
}
