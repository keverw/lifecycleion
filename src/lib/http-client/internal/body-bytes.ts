import { concatChunks } from './concat-chunks';
import {
  readTypedArrayBuffer,
  readTypedArrayByteOffset,
} from '../../internal/binary-view';

/** The first block a body is copied into. */
const FIRST_BLOCK_BYTES = 16 * 1024;

/** The largest block a body is copied into: each one after the first is twice the last. */
const MAX_BLOCK_BYTES = 1024 * 1024;

/**
 * A response body's bytes, copied in as each chunk is read - as the Fetch standard's body
 * read copies them, so a source that hands over the same buffer again with the next
 * chunk's bytes is kept as it was read - into blocks of their own rather than one buffer
 * per chunk, so what is held follows the bytes read, not how finely the server split
 * them. Blocks are added only as bytes arrive, whatever length the body declares, and
 * joined once it is read, by {@link concatChunks}.
 */
export class BodyBytes {
  private readonly blocks: Uint8Array[] = [];
  private readonly maxBytes: number;
  private block: Uint8Array;
  private filled = 0;
  private nextBlockBytes = FIRST_BLOCK_BYTES * 2;
  private written = 0;

  /** `maxBytes` bounds every block; no more than it may be appended in all. */
  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
    this.block = new Uint8Array(Math.min(FIRST_BLOCK_BYTES, maxBytes));
  }

  /**
   * Copies `chunk`'s `byteLength` bytes in, read through its internal slots: a
   * `Uint8Array` from any realm, measured already. The caller holds the total to
   * `maxBytes`.
   */
  public append(chunk: Uint8Array, byteLength: number): void {
    let offset = 0;

    while (offset < byteLength) {
      if (this.filled === this.block.length) {
        this.startBlock();
      }

      const count = Math.min(
        byteLength - offset,
        this.block.length - this.filled,
      );
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
      this.block.set(part, this.filled);
      this.filled += count;
      this.written += count;
      offset += count;
    }
  }

  /**
   * The bytes appended, as a plain `Uint8Array` spanning an `ArrayBuffer` of its own: the
   * one block itself where the body filled it exactly, joined otherwise.
   */
  public bytes(): Uint8Array {
    if (this.blocks.length === 0 && this.filled === this.block.length) {
      return this.block;
    }

    const parts =
      this.filled === 0
        ? this.blocks
        : [...this.blocks, new Uint8Array(this.block.buffer, 0, this.filled)];

    return concatChunks(parts, this.written);
  }

  private startBlock(): void {
    if (this.filled > 0) {
      this.blocks.push(this.block);
    }

    // Never past what the limit leaves: a body over it is refused before it is appended.
    this.block = new Uint8Array(
      Math.min(this.nextBlockBytes, this.maxBytes - this.written),
    );
    this.nextBlockBytes = Math.min(this.nextBlockBytes * 2, MAX_BLOCK_BYTES);
    this.filled = 0;
  }
}
