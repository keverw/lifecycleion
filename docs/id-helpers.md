# id-helpers

Unified identifier generation, validation, and empty-ID utilities supporting ObjectID, UUID v4, UUID v7, and ULID.

<!-- toc -->

- [Usage](#usage)
- [Supported Identifier Types](#supported-identifier-types)
- [API](#api)
  - [generateID](#generateid)
  - [validateID](#validateid)
  - [emptyID](#emptyid)
  - [isEmptyID](#isemptyid)
  - [IDHelpers (class)](#idhelpers-class)
- [Constants](#constants)
  - [IDENTIFIER_TYPES](#identifier_types)
- [Types](#types)
  - [IdentifierType](#identifiertype)

<!-- tocstop -->

## Usage

```typescript
import {
  generateID,
  validateID,
  emptyID,
  isEmptyID,
  IDHelpers,
  IDENTIFIER_TYPES,
} from 'lifecycleion/id-helpers';
```

## Supported Identifier Types

| Type       | Format                              | Timestamp-sortable | Example                                  |
| ---------- | ----------------------------------- | ------------------ | ---------------------------------------- |
| `objectID` | 24 hex characters                   | Yes                | `"507f1f77bcf86cd799439011"`             |
| `uuid4`    | 36 chars (`xxxxxxxx-xxxx-4xxx-...`) | No (random)        | `"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"` |
| `uuid7`    | 36 chars (`xxxxxxxx-xxxx-7xxx-...`) | Yes                | `"018e8c6e-4f7e-7000-8000-0123456789ab"` |
| `ulid`     | 26 Crockford base32 characters      | Yes                | `"01ARZ3NDEKTSV4RRFFQ69G5FAV"`           |

**Case handling:** `validateID` accepts upper or lowercase input for all types. Generated output follows canonical case: `objectID`, `uuid4`, and `uuid7` produce lowercase, while `ulid` produces uppercase.

> **Tip — normalize IDs in your application or API layer.** Even though validation is case-insensitive, database queries and equality checks require exact matches. Call `.toLowerCase()` before persisting `objectID` or UUID values, or `.toUpperCase()` for ULIDs.

> **Security tip — avoid timestamp-based IDs for sensitive tokens.** `objectID`, `uuid7`, and `ulid` embed a creation timestamp, which lets anyone holding the ID infer roughly when it was issued. For tokens where that is a privacy or security concern — email verification links, password reset tokens, invitation codes — use `uuid4` instead. Its fully random structure reveals nothing about when it was generated. For email verification and password reset flows, a common pattern is to pair a `uuid4` (used as a record lookup key) with a separate `crypto.randomBytes(32).toString('hex')` nonce (the actual secret, stored hashed in the database) — e.g. `/verify?id=<uuid4>&token=<nonce>`. This way the ID reveals nothing, and the token is what provides the security.

## API

### generateID

Generates a unique identifier of the specified type. Throws `TypeError` if an unrecognized `type` is provided.

```typescript
const objID = generateID('objectID'); // "507f1f77bcf86cd799439011"
const uuid4 = generateID('uuid4'); // "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
const uuid7 = generateID('uuid7'); // "018e8c6e-4f7e-7000-8000-0123456789ab"
const id = generateID('ulid'); // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
```

Pass a `seedTime` (milliseconds) to embed a specific timestamp in the ID. Supported by `objectID`, `uuid7`, and `ulid`. Accepted but ignored by `uuid4` (always random) — however, passing an invalid value still throws. Throws `TypeError` if `seedTime` is provided but is not a non-negative finite number.

> **Note — `objectID` timestamp precision:** ObjectIDs store timestamps at **second-level** granularity. The provided millisecond value is truncated via `Math.floor(ms / 1000)`. Two calls within the same second but with different millisecond values will embed the same timestamp. `uuid7` and `ulid` preserve full millisecond precision.

```typescript
const timestamp = Date.now();
const seededUuid7 = generateID('uuid7', timestamp);
const seededUlid = generateID('ulid', timestamp);
const seededObjID = generateID('objectID', timestamp);
```

### validateID

Validates that a string is a valid identifier of the specified type. Performs strict validation including version checks for UUIDs. Empty IDs (from `emptyID()`) are considered valid. Accepts upper or lowercase for all types. Returns `false` for non-string `id` values. Throws `TypeError` if an unrecognized `type` is provided.

```typescript
validateID('uuid4', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'); // true
validateID('uuid4', '018e8c6e-4f7e-7000-8000-0123456789ab'); // false (this is uuid7)
validateID('objectID', '507f1f77bcf86cd799439011'); // true
validateID('objectID', 'invalid'); // false
```

> **Note — ULID validation:** In addition to checking character set and length, `validateID` enforces the ULID spec overflow constraint: the first character must be `0`–`7` (Crockford base32 digits 0–7). Any higher value in the first position would overflow the 48-bit timestamp field.

### emptyID

Returns an empty/null identifier for the specified type. Useful as default values or placeholders in databases. Empty IDs pass `validateID()`. Throws `TypeError` if an unrecognized `type` is provided.

```typescript
emptyID('objectID'); // "000000000000000000000000"       (24 zeros)
emptyID('uuid4'); // "00000000-0000-0000-0000-000000000000"  (nil UUID)
emptyID('uuid7'); // "00000000-0000-0000-0000-000000000000"  (nil UUID)
emptyID('ulid'); // "00000000000000000000000000"       (26 zeros)
```

> **Note:** `uuid4` and `uuid7` share the same nil UUID (`"00000000-0000-0000-0000-000000000000"`). As a result, `isEmptyID('uuid4', emptyID('uuid7'))` returns `true` and vice versa. If your application needs the empty ID to identify which type a field is, store the type separately.

### isEmptyID

Checks if an identifier matches the empty/null ID for its type. Returns `false` for non-string `id` values. Throws `TypeError` if an unrecognized `type` is provided.

```typescript
const empty = emptyID('uuid4');
const real = generateID('uuid4');

isEmptyID('uuid4', empty); // true
isEmptyID('uuid4', real); // false
```

### IDHelpers (class)

A convenience class that wraps all the standalone functions with a fixed identifier type, so you don't have to pass the type each time.

The constructor throws `TypeError` if an unrecognized `type` is provided.

```typescript
const ids = new IDHelpers('uuid7');

ids.type; // "uuid7"

const id = ids.generateID(); // generates a uuid7
ids.validateID(id); // true
ids.isEmptyID(id); // false

const empty = ids.emptyID();
ids.isEmptyID(empty); // true
```

Accepts an optional `seedTime` on `generateID()`:

```typescript
const ids = new IDHelpers('ulid');
const seeded = ids.generateID(Date.now());
```

`ids.generateID(seedTime)` uses the exact same seed rules as standalone `generateID()`: `seedTime` is supported by `objectID`, `uuid7`, and `ulid`, it is accepted but ignored by `uuid4`, and invalid values throw `TypeError`.

## Constants

### IDENTIFIER_TYPES

Readonly array of all supported identifier type strings:

```typescript
IDENTIFIER_TYPES; // readonly ['objectID', 'uuid4', 'uuid7', 'ulid']
```

## Types

### IdentifierType

Union type of all supported identifier types:

```typescript
type IdentifierType = 'objectID' | 'uuid4' | 'uuid7' | 'ulid';
```
