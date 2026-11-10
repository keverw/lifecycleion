# Plan: parse a JSON request body's copy only when something reads it

Status: optional, not scheduled. A saving, not a fix. Do it on its own branch from main, after PR #35 has merged.

## What it is now

`.json()` and `.body()` hand a plain object or array to `copyRequestBody` (`src/lib/http-client/internal/request-body-copy.ts`). It serializes the body with `JSON.stringify` and then `JSON.parse`s the text back, so the client holds its own copy that nothing the caller does can change. The text is recorded against the copy (`jsonTextByCopy`), and the request is sent from that text without serializing again.

So every JSON body is parsed back once, whether or not anything reads the copy, and the copy is a second object graph held for the life of the request.

A review of PR #34 measured a 17.5 MB payload: `.json()` took 112 ms with no interceptors, of which `JSON.stringify` was 24 ms. End to end the branch was still faster than main (about 122 ms against 252 ms), so this is a missed saving, not a regression.

## What reads the parsed copy

More than the interceptors:

- **Initial-phase interceptors**, handed the body (`releaseRequestBody` in `interceptors.ts` forgets its text then, as the interceptor may change it).
- **Observers and error snapshots**, through `buildAttemptBodies` in `http-client.ts`, which builds the observers' own copy of the body from it.
- **Type checks.** `Array.isArray(body) || isPlainRecord(body)` decides that a body is JSON, in the builder, the dispatch path and redirect replays.
- **The `jsonTextByCopy` key.** The copy object itself is the key the text is found by.

## Approach, if done

1. **A stand-in that passes the type checks.** The copy is an empty plain object or array, keyed in a `WeakMap` to its text, and filled from `JSON.parse(text)` the first time anything reads it.
2. **Fill on handoff.** Every place that hands the body to caller code (interceptors, observers, error snapshots) asks for it through one function that fills the stand-in first. Sending stays on the text and never fills it.
3. **Keep identity.** The filled copy is the same object the stand-in was, so `jsonTextByCopy` and any earlier reference still match.
4. **Measure** the 17.5 MB case and a typical small body. Keep the change only if the small case is no slower.

## Why it may not be worth it

- Most bodies are small: a parse costs microseconds there.
- A stand-in that only looks like the copy until it is read adds one more rule every handoff has to follow, and a missed one hands caller code an empty object.

## Tests

- No interceptor or observer: `JSON.parse` is not called (spy on it), and the bytes sent are unchanged.
- An interceptor, an observer and an error snapshot each see the full body.
- A body changed by an interceptor is serialized from the change, as now.
- Redirect replays (307/308) send the same text.
