# Plan: build NodeAdapter's decoded response body on a real `Readable`

Status: optional, not scheduled. Worth doing only if `DecodedResponseBody` needs more fixes; see "When to do it". Do it on its own branch from main, after PR #35 has merged.

## What it is now

`DecodedResponseBody` (`src/lib/http-client/internal/response-decoding.ts`) is what NodeAdapter reads a compressed response through. It extends a bare `EventEmitter` and rebuilds part of what a stream does by hand:

- a paused state with `pause()` / `resume()`;
- two queues of held events (`held`, `heldWhilePaused`);
- its own `close`, which waits for decoding to finish;
- microtask and `nextTick` ordering, so events land in the order a paused `IncomingMessage` would give them.

That is about 500 lines with eleven state flags. Review rounds 113 to 115 fixed ordering and hold-queue edge cases in it.

## Why consider it

- **Less hand-written stream logic.** A `PassThrough` (or the last decoder itself) already buffers data while no one reads, waits to emit `'end'` until the data is consumed, and applies backpressure. Those parts of the hold queues and pause flags would go away.
- **Fewer places for ordering bugs.** Most of the fixes to this class were about when an event is delivered relative to another. Node's stream machinery has that ordering already worked out.
- **Easier to read.** A reviewer could reason about it as "a stream, plus these few rules" rather than a custom event protocol.

## Why it may not be worth it

Several behaviours have to stay custom whatever the base is, because a plain `Readable` does not have them:

- **Decoders built on the first byte.** An empty body is not decoded at all (a strict decoder reads empty input as truncated), and `deflate`'s zlib-or-raw choice needs the first two bytes. So `stream.pipeline(res, ...decoders)` cannot be set up front.
- **Held errors.** A `Readable` emits `'error'` as soon as it happens. Here an error found before the `streamResponse` factory has its sink is held for the reader (`heldError`, `onFailure`), or it would be lost or unhandled.
- **`aborted`**, which comes from the raw response and is not a `Readable` event.
- **`close` after decoding**, when all of the raw body arrived.
- **Decode-failure tagging** (`markDecodeError`), the trailing-byte and truncation checks, and `didDestroyUnfinishedResponse`, which NodeAdapter reads to tell its own teardown from a network failure.

So the saving is the pause and data-holding half, perhaps 150-250 lines, not the whole class. Against that, every NodeAdapter response with a `Content-Encoding` goes through it: buffered bodies, `streamResponse`, early-answered uploads, cancels and timeouts. The current code is covered by a large set of tests, and a rewrite risks subtle ordering changes those tests may not all pin.

## When to do it

- Another bug turns up in the pause or hold-queue logic, or
- the class needs a new feature (for example, exposing the decoded body as a real stream to callers), or
- a Node or Bun release changes stream timing and the hand-written ordering breaks.

Otherwise, leave it.

## Approach, if done

1. **Pin behaviour first.** Before changing anything, add tests for each event-ordering guarantee in the class's doc comment, if not already covered: `end` / `close` / `error` / `aborted` held until a reader attaches, `close` waiting for decoding, `destroy` stopping inflation, a paused body applying backpressure to the raw response.
2. **Swap the base.** Make the last stage a `PassThrough` that the decoders pipe into once they are built on the first byte. Let it do the buffering, pausing and `'end'`.
3. **Keep a thin wrapper** for what a `Readable` lacks: held errors and `onFailure`, `aborted`, `close` after decoding, `didDestroyUnfinishedResponse`.
4. **Keep `ResponseBodySource` as it is**, so NodeAdapter does not change.
5. **Run the NodeAdapter, request-normalization and late-error integration tests on Node and Bun.** Both, since their stream timing differs.

## Tests

The existing NodeAdapter and `request-normalization.test.ts` decoding tests are the safety net. Add the ordering tests from step 1 before the rewrite, so they prove the old and new code behave the same.
