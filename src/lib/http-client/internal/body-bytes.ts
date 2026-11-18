import { concatChunks } from './concat-chunks';
import {
  readTypedArrayBuffer,
  readTypedArrayByteOffset,
} from '../../internal/binary-view';

/**
 * The size of a block small chunks are copied into, and the smallest chunk kept as it is
 * rather than copied.
 */
const BLOCK_BYTES = 16 * 1024;

/**
 * A response body's bytes, kept as each chunk is read and joined once by
 * {@link concatChunks}. A chunk of {@link BLOCK_BYTES} or more is kept as it is, so its
 * bytes are copied once, by the join. A smaller one is copied into a block shared with the
 * chunks around it, so what is held follows the bytes read, not how finely the server
 * split them: a body sent in one-byte chunks holds about its own size, not one array per
 * byte. Blocks are added only as bytes arrive, whatever length the body declares.
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
   * from any realm, measured already. The caller holds the total to `maxBytes`.
   */
  public append(chunk: Uint8Array, byteLength: number): void {
    if (byteLength >= BLOCK_BYTES) {
      this.endPart();
      this.parts.push(chunk);
      this.written += byteLength;
      return;
    }

    let offset = 0;

    while (offset < byteLength) {
      if (this.block === undefined || this.filled === this.block.length) {
        this.startBlock();
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

  private startBlock(): void {
    this.endPart();
    // Never past what the limit leaves: a body over it is refused before it is appended.
    this.block = new Uint8Array(
      Math.min(BLOCK_BYTES, this.maxBytes - this.written),
    );
    this.blockStart = 0;
    this.filled = 0;
  }
}
