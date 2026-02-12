# serialize-error

Simple utilities to convert any `Error` into a plain, JSON-serializable object — and back again if you need to re-throw it.

Useful for IPC, internal RPCs, and storing errors in a database (e.g. logging failed jobs, audit trails, error reports). For external RESTful APIs, don't use these as they can expose sensitive information (like the stack trace) to the client.

## Usage

```ts
import {
  serializeError,
  deserializeError,
  isErrorLike,
} from '@day-mover/serialize-error';

// Serialize any error into a plain object.
const serialized = serializeError(error);
const json = JSON.stringify(serialized); // just works

// On the receiving side, reconstruct a throwable Error if needed.
const restored = deserializeError(JSON.parse(json));
throw restored;
```

### What it captures

- `name`, `message`, `stack` (the non-enumerable ones Error hides)
- All own properties from Error subclasses (`errCode`, `statusCode`, whatever)
- Nested errors are recursively serialized

### `isErrorLike(value)`

Type guard that checks if a value looks like an Error (has `name`, `message`, and `stack`).

## RESTful API Error Guidelines

For RESTful APIs, don't use `serializeError` — it exposes internals like stack traces. Instead, follow these guidelines:

1. Use appropriate HTTP status codes (e.g., 400 for bad requests, 404 for not found, 500 for server errors).
2. Provide a JSON response body with error details. Typical fields include:
   - `code`: An application-specific error code (e.g., "invalid_input", "resource_not_found", "unknown_error")
   - `message`: A message describing the error (e.g., "Validation failed", "Resource not found", "An unknown error occurred")
   - `details`: An array of specific errors, useful for validation errors

### Example RESTful API Error Response

```json
{
  "error:": {
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
