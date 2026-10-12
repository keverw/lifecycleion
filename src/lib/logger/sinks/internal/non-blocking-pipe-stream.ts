import * as fs from 'fs';
import { Writable } from 'stream';

/**
 * A Writable over the probe's non-blocking descriptor.
 *
 * Node's WriteStream assumes a blocking file descriptor. Bun currently mishandles the
 * `EAGAIN` a non-blocking FIFO returns under pressure, so the handoff needs a tiny stream
 * that treats it as backpressure and retries without holding a libuv worker or the event
 * loop open. The Writable high-water mark still bounds its own buffer; NamedPipeSink's
 * queue cap bounds everything not admitted to it.
 */
export class NonBlockingPipeStream extends Writable {
  public readonly fd: number;
  private retryTimer?: NodeJS.Timeout;
  private cancelWrite?: () => void;
  private writeInFlight = false;
  private closeAfterWrite?: () => void;
  private partialWriteFailures = new WeakSet<Error>();

  constructor(descriptor: number) {
    super({ highWaterMark: 16 * 1024, autoDestroy: true, emitClose: true });
    this.fd = descriptor;
  }

  public consumePartialWriteFailure(error: Error): boolean {
    // Writable also passes the same error to buffered, never-started writes.
    // Only the first callback belongs to the partially delivered record.
    return this.partialWriteFailures.delete(error);
  }

  public override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, encoding);
    let offset = 0;
    let isSettled = false;

    const finish = (error?: Error | null): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;
      this.cancelWrite = undefined;

      if (this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
      }

      if (error && offset > 0) {
        const partialError = new Error(
          'Named pipe record was only partially written',
          { cause: error },
        );
        Object.defineProperty(partialError, 'bytesWritten', {
          value: offset,
          enumerable: true,
        });
        this.partialWriteFailures.add(partialError);
        callback(partialError);
      } else {
        callback(error);
      }
    };

    const writeRemaining = (): void => {
      if (this.destroyed) {
        finish(new Error('Named pipe stream was destroyed'));

        return;
      }

      this.writeInFlight = true;
      fs.write(
        this.fd,
        buffer,
        offset,
        buffer.length - offset,
        null,
        (error, written) => {
          this.writeInFlight = false;
          if (this.destroyed) {
            if (error === null) {
              offset += written;
            }
            if (error === null && offset === buffer.length) {
              finish();
            } else {
              this.cancelWrite?.();
            }
            this.closeAfterWrite?.();
            this.closeAfterWrite = undefined;
            return;
          }
          const code = error?.code;

          if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
            this.retryTimer = setTimeout(writeRemaining, 10);
            this.retryTimer.unref?.();

            return;
          }

          if (error !== null) {
            finish(error);

            return;
          }

          offset += written;

          if (offset < buffer.length) {
            writeRemaining();

            return;
          }

          finish();
        },
      );
    };

    this.cancelWrite = () =>
      finish(new Error('Named pipe stream was destroyed'));
    writeRemaining();
  }

  public override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    const close = (): void => {
      this.cancelWrite?.();
      fs.close(this.fd, (closeError) => callback(error ?? closeError));
    };
    // A queued fs.write owns the descriptor until its callback runs.
    if (this.writeInFlight) {
      this.closeAfterWrite = close;
    } else {
      close();
    }
  }
}
