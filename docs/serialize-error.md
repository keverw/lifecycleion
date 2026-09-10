# serialize-error

Simple utilities to convert any `Error` into a plain, JSON-serializable object - and back again if you need to re-throw it.

Useful for IPC, internal RPCs, and storing errors in a database (e.g. logging failed jobs, audit trails, error reports). For external RESTful APIs, don't use these as they can expose sensitive information (like the stack trace) to the client.

<!-- toc -->

- [Usage](#usage)
- [What It Captures](#what-it-captures)
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

## When a value cannot be serialized

Serializing degrades rather than failing. A value that refuses to be read becomes
`<unserializable: keys>`, `<unserializable: value>` or `<unserializable: text>` - naming
which half refused - and the rest of the payload survives, which matters here more than anywhere: this runs at an IPC or RPC boundary,
usually while already reporting a failure, so a second failure raised here would replace
the one being reported.

Pass `onRenderError` to receive the cause:

```typescript
const serialized = serializeError(error, {
  onRenderError: (cause, path) => {
    // path:  '<error>.context.token' - structural, never a value
    // cause: the getter's own throw
  },
});
```

It fires at most once per call. With no handler it reports on the standard global `'error'` channel, so a `logger.registerReportErrorListener()` records it, falling back to `console.error` when nothing claims it. The `Logger` and its sinks never use that channel for their own work - they always supply a handler, defaulting to the console, because broadcasting from inside a log call would be logged by the listener, and logging renders.

**The cause never enters the payload.** It comes from the caller's own getter and may
carry the value it was hiding, and this object is about to cross a wire - so the marker
goes in the payload and the cause goes to one handler that asked for it.

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
