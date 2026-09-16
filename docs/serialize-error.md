# serialize-error

Simple utilities to convert any `Error` into a plain, JSON-serializable object - and back again if you need to re-throw it.

Useful for IPC, internal RPCs, and storing errors in a database (e.g. logging failed jobs, audit trails, error reports). For external RESTful APIs, don't use these as they can expose sensitive information (like the stack trace) to the client.

<!-- toc -->

- [Usage](#usage)
- [What It Captures](#what-it-captures)
- [When a Value Cannot Be Serialized](#when-a-value-cannot-be-serialized)
- [Values JSON Cannot Carry](#values-json-cannot-carry)
- [Bounds on the Walk](#bounds-on-the-walk)
- [API](#api)
  - [isErrorLike](#iserrorlike)
- [RESTful API Error Guidelines](#restful-api-error-guidelines)
  - [Example RESTful API Error Response](#example-restful-api-error-response)
- [Security Note](#security-note)

<!-- tocstop -->

## Usage

```typescript
import {
  serializeError,
  deserializeError,
  isErrorLike,
} from 'lifecycleion/serialize-error';

// Serialize any error into a plain object.
const serialized = serializeError(error);
const json = JSON.stringify(serialized); // just works

// On the receiving side, reconstruct a throwable Error if needed.
const restored = deserializeError(JSON.parse(json));
throw restored;
```

## What It Captures

- `name`, `message`, `stack` (the non-enumerable ones Error hides)
- All own properties from Error subclasses (`errCode`, `statusCode`, whatever)
- Nested errors are recursively serialized

## When a Value Cannot Be Serialized

Serializing degrades rather than failing. A value that refuses to be read becomes
`<unserializable: keys>`, `<unserializable: value>` or `<unserializable: text>` - naming
which half refused - and the rest of the payload survives, which matters here more than anywhere: this runs at an IPC or RPC boundary,
usually while already reporting a failure, so a second failure raised here would replace
the one being reported.

Pass `onFormatError` to receive the cause:

```typescript
const serialized = serializeError(error, {
  onFormatError: (cause, kind, path) => {
    // kind:  'render' - serializeError never redacts, so it raises no other kind
    // path:  '<error>.context.token' - structural, never a value
    // cause: the getter's own throw
  },
});
```

The options object itself is read once, up front, and a member whose getter throws counts
as absent - so passing a hostile or exotic bag cannot make the one function documented never
to throw throw while describing somebody else's failure.

It fires at most once per call. With no handler it first dispatches a cancelable global
`'error'` event, so a `logger.registerReportErrorListener()` can record it. If event
dispatch is unavailable it uses `globalThis.reportError()` when present; an unclaimed
dispatch, unavailable reporting function, or reporting failure ends at guarded
`console.error`. A custom sink that calls this function should pass a handler that
terminates locally. If a supplied handler throws or rejects, the failure goes directly to
guarded `console.error`, without broadcasting again. Nested host reports also terminate
there to prevent recursion. See the [shared routing summary](./safe-handle-callback.md#the-reporting-pattern)
for how this differs from logger-owned diagnostics and sink-owned callbacks.

**The cause never enters the payload.** It comes from the caller's own getter and may
carry the value it was hiding, and this object is about to cross a wire - so the marker
goes in the payload and the cause goes to one handler that asked for it.

## Values JSON Cannot Carry

The output is JSON-serializable, which takes more than avoiding cycles - three leaf types would otherwise break `JSON.stringify` on the payload itself:

| Leaf on the error | In the payload          | Left alone, `JSON.stringify` would                                                                        |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `bigint`          | its decimal digits      | throw a `TypeError`                                                                                       |
| `function`        | `<function>`            | drop the key silently - and **call** an own `toJSON`, so a hostile one threw from inside your `stringify` |
| `symbol`          | `<symbol: Symbol(...)>` | drop the key silently                                                                                     |

The two markers use the same angle brackets as `<unserializable: value>` on purpose: this payload is parsed by a receiver who cannot ask what a value means, so a marker has to read as the library talking rather than as something a caller might have stored. It is recognizable, not provable - a property whose real value is the text `<function>` is indistinguishable, exactly as it already is for the `<unserializable: …>` markers.

A `bigint` gets its digits rather than a marker, because the digits are the _value_ and the receiver can parse them back. What does not survive is its type: a `bigint` and a string of the same digits arrive identical.

`NaN` and the infinities are deliberately untouched: `JSON.stringify` writes `null` for them rather than throwing, which is the conventional stand-in, and a marker would only disagree with what the receiving side ends up reading. `undefined` is likewise left as-is, and `JSON.stringify` drops the key - the same way an absent `message` is represented.

## Bounds on the Walk

`serializeError` never throws and always terminates, which is what lets it run at a boundary where a second failure would replace the one being reported. `JSON.stringify` makes the opposite trade - it raises a `TypeError` on a cycle - so the walk here is bounded instead, and a payload that reaches a bound is cut rather than refused.

Three things stop the walk, all marked `[max depth exceeded]` in the payload:

| Bound          | Limit      | Reached by                                                           |
| -------------- | ---------- | -------------------------------------------------------------------- |
| Nesting depth  | 100 levels | a payload nested past the cap, with or without a cycle               |
| A cycle        | -          | `error.self = error`, or a request object pointing back at its error |
| Values visited | 100,000    | a shared subtree reached once per reference, or an error bag of keys |

The last one is the least obvious: a value referenced twice side by side is serialized in full both times, so an object graph that is neither deep nor circular can still be large. The node count is the only bound that catches that.

Both the depth and cycle bounds mark where they stopped rather than dropping the entry, so a receiving side always sees _that_ something was cut and where. The marker text is shared with the other renderers in this library and reads `[max depth exceeded]` for all three causes, so it names the most common one and not necessarily the one that fired.

**String values are passed through unchanged.** There is no length cap on `message`, `stack`, or any own property - a bound there would silently hand the receiver a wrong message rather than a truncated render, and it is the receiver, not the marker, that parses this payload. A transport with a frame limit should enforce its own, where it can fail loudly.

## API

### isErrorLike

Type guard that checks if a value looks like an Error (has `name`, `message`, and `stack`).

```typescript
isErrorLike(value); // true | false
```

## RESTful API Error Guidelines

For RESTful APIs, don't use `serializeError` - it exposes internals like stack traces. Instead, follow these guidelines:

1. Use appropriate HTTP status codes (e.g., 400 for bad requests, 404 for not found, 500 for server errors).
2. Provide a JSON response body with error details. Typical fields include:
   - `code`: An application-specific error code (e.g., "invalid_input", "resource_not_found", "unknown_error")
   - `message`: A message describing the error (e.g., "Validation failed", "Resource not found", "An unknown error occurred")
   - `details`: An array of specific errors, useful for validation errors

### Example RESTful API Error Response

```json
{
  "error": {
    "code": "invalid_input",
    "message": "The request parameters did not pass validation",
    "details": [
      {
        "field": "email",
        "type": "invalid_email",
        "message": "Must be a valid email address"
      },
      {
        "field": "password",
        "type": "invalid_length",
        "message": "Must be at least 8 characters long"
      }
    ]
  }
}
```

## Security Note

For security, avoid exposing internal error details or stack traces in public APIs. Log detailed error information server-side for debugging purposes.

`deserializeError` copies at most 100,000 extra properties, omitting any surplus without reading their values. This bounds property copying, but key enumeration still allocates the input key list; callers accepting untrusted IPC should also limit the incoming message size.
