import { concatChunks } from './concat-chunks';
import {
  fixedUnsharedByteLength,
  readTypedArrayBuffer,
  readTypedArrayByteOffset,
} from '../../internal/binary-view';

/** The size of a block small chunks are copied into. */
const BLOCK_BYTES = 16 * 1024;

/**
 * The smallest chunk kept as it is rather than copied. Below it, the object a kept chunk
 * costs would weigh against its bytes; above it, a chunk is copied once, by the join.
 */
const KEEP_BYTES = 4 * 1024;

/**
 * A response body's bytes, kept as each chunk is read and joined once by
 * {@link concatChunks}. A chunk of {@link KEEP_BYTES} or more that spans at least half
 * the fixed, unshared buffer it is a view over is kept as it is, so its bytes are copied
 * once, by the join. Any other is copied into a block shared with the chunks around it -
 * what is left of it past the block it starts in going into one of its own size - so what
 * is held follows the bytes read, not how finely the server split them nor how much of a
 * larger buffer each piece is a view over: at most about twice the body's size. A body
 * sent in one-byte chunks holds about its own size, not one array per byte, and one handed
 * over as small views over a socket's read buffer does not hold the rest of each buffer.
 * Blocks are added only as bytes arrive, whatever length the body declares. The first is
 * the size of the first chunk copied into it, so a body of one small chunk fills it
 * exactly and is that block, copied once; each after is as large as what has been read so
 * far, up to {@link BLOCK_BYTES}, or as what is left of the chunk being copied, whichever
 * is larger.
 *
 * A chunk kept as it is must not change before the join: the runtime's streams hand over
 * each chunk in memory of its own. Over a source that refills one buffer for each chunk,
 * then, what is read depends on whether each chunk is copied or kept (see above): one
 * copied as it is read holds the bytes it was handed, and one kept as it is reads as the
 * buffer's last fill, as every chunk does through the runtime's own `arrayBuffer()` and a
 * Node stream's consumers. One whose buffer is detached by then fails the join.
 */
export class BodyBytes {
  private readonly parts: Uint8Array[] = [];
  private readonly maxBytes: number;
  private block: Uint8Array | undefined;
  /** Where the block's bytes not yet in `parts` begin. */
  private blockStart = 0;
  private filled = 0;
  private written = 0;

  /** `maxBytes` bounds every block; no more than it may be appended in all. */
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /**
   * Keeps `chunk`'s `byteLength` bytes, read through its internal slots: a `Uint8Array`
   * from any realm, measured already. The caller holds the total to `maxBytes`; a chunk
   * that would pass it throws a `RangeError`, as there is no block left to copy it into.
   */
  public append(chunk: Uint8Array, byteLength: number): void {
    if (byteLength > this.maxBytes - this.written) {
      throw new RangeError('BodyBytes cannot hold more than its maxBytes');
    }

    if (byteLength >= KEEP_BYTES && isKeptAsIs(chunk, byteLength)) {
      this.endPart();
      this.parts.push(chunk);
      this.written += byteLength;
      return;
    }

    let offset = 0;

    while (offset < byteLength) {
      if (this.block === undefined || this.filled === this.block.length) {
        this.startBlock(byteLength - offset);
      }

      const block = this.block as Uint8Array;
      const count = Math.min(byteLength - offset, block.length - this.filled);
      // A part of the chunk, made over its buffer by the intrinsic getters rather than its
      // own `subarray`, which would build it through the chunk's own constructor.
      const part =
        offset === 0 && count === byteLength
          ? chunk
          : new Uint8Array(
              readTypedArrayBuffer(chunk),
              readTypedArrayByteOffset(chunk) + offset,
              count,
            );
      block.set(part, this.filled);
      this.filled += count;
      this.written += count;
      offset += count;
    }
  }

  /**
   * The bytes appended, as a plain `Uint8Array` spanning an `ArrayBuffer` of its own:
   * joined by {@link concatChunks}, which hands back a lone part that already is that.
   */
  public bytes(): Uint8Array {
    this.endPart();
    return concatChunks(this.parts, this.written);
  }

  /** Lets go of every byte kept, for a body that will not be joined. */
  public clear(): void {
    this.parts.length = 0;
    this.block = undefined;
    this.blockStart = 0;
    this.filled = 0;
    this.written = 0;
  }

  /** Adds the block's bytes copied since the last part as a part of their own. */
  private endPart(): void {
    if (this.block !== undefined && this.filled > this.blockStart) {
      this.parts.push(
        new Uint8Array(
          this.block.buffer,
          this.blockStart,
          this.filled - this.blockStart,
        ),
      );
      this.blockStart = this.filled;
    }
  }

  /** Starts a block for `pending` more bytes of a small chunk. */
  private startBlock(pending: number): void {
    const isFirst = this.block === undefined && this.parts.length === 0;
    this.endPart();
    // Never past what the limit leaves: a body over it is refused before it is appended.
    // A later block grows with what has been read, up to a block's size, so its unused
    // end is never more than the body holds already; and what is left of a chunk once the
    // block before fills, past that, gets a block of its own size, so it is copied in one
    // piece rather than many.
    this.block = new Uint8Array(
      Math.min(
        isFirst
          ? pending
          : Math.max(pending, Math.min(BLOCK_BYTES, this.written)),
        this.maxBytes - this.written,
      ),
    );
    this.blockStart = 0;
    this.filled = 0;
  }
}

/**
 * Whether `chunk` may be kept as it is: over a fixed, unshared `ArrayBuffer`, whose
 * `byteLength` bytes are at least half of it, measured through the intrinsic getters, so
 * keeping the chunk holds no more than twice what it counts. A chunk over shared or
 * resizable memory is copied as it is read instead, as another thread could write it, or
 * other code resize it, before the join.
 */
function isKeptAsIs(chunk: Uint8Array, byteLength: number): boolean {
  const bufferBytes = fixedUnsharedByteLength(readTypedArrayBuffer(chunk));

  return bufferBytes !== null && byteLength * 2 >= bufferBytes;
}
