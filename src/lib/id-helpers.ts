import ObjectID from 'bson-objectid';
import {
  v4 as UUIDv4,
  v7 as UUIDv7,
  validate as uuidValidate,
  version as uuidVersion,
} from 'uuid';
import { ulid } from 'ulid';
import { convertMSToUnix } from './unix-time-helpers';

/**
 * Supported identifier types:
 *
 * - **`objectID`**: MongoDB-style ObjectID
 *   - Format: 24 hexadecimal characters
 *   - Timestamp-based: Yes (sortable by creation time)
 *   - Case-sensitive: No (accepts both uppercase and lowercase)
 *   - Example: `"507f1f77bcf86cd799439011"`
 *
 * - **`uuid4`**: UUID version 4
 *   - Format: 36 characters (32 hex + 4 dashes): `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
 *   - Timestamp-based: No (random)
 *   - Case-sensitive: No (accepts both uppercase and lowercase)
 *   - Example: `"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"`
 *
 * - **`uuid7`**: UUID version 7
 *   - Format: 36 characters (32 hex + 4 dashes): `xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`
 *   - Timestamp-based: Yes (sortable by creation time)
 *   - Case-sensitive: No (accepts both uppercase and lowercase)
 *   - Example: `"018e8c6e-4f7e-7000-8000-0123456789ab"`
 *
 * - **`ulid`**: Universally Unique Lexicographically Sortable Identifier
 *   - Format: 26 characters using Crockford's base32 alphabet
 *   - Timestamp-based: Yes (sortable by creation time)
 *   - Case-sensitive: No (canonical form is uppercase, but accepts lowercase)
 *   - Example: `"01ARZ3NDEKTSV4RRFFQ69G5FAV"`
 */
export type IdentifierType = 'objectID' | 'uuid4' | 'uuid7' | 'ulid';

/**
 * Array of all supported identifier types.
 */
export const IDENTIFIER_TYPES = ['objectID', 'uuid4', 'uuid7', 'ulid'] as const;

function assertIdentifierType(type: unknown): asserts type is IdentifierType {
  if (!IDENTIFIER_TYPES.includes(type as IdentifierType)) {
    throw new TypeError(
      `Invalid ID type given: "${type as string}". Expected one of: ${IDENTIFIER_TYPES.join(', ')}`,
    );
  }
}

/**
 * Generates a unique identifier of the specified type.
 *
 * @param type - The type of identifier to generate:
 *   - `objectID`: MongoDB ObjectID (24 hex chars, timestamp-based)
 *   - `uuid4`: UUID v4 (random, not sortable)
 *   - `uuid7`: UUID v7 (timestamp-based, sortable)
 *   - `ulid`: ULID (timestamp-based, sortable, case-insensitive)
 * @param seedTime - Optional timestamp in milliseconds to seed the ID with.
 *   - Supported by: `objectID`, `uuid7`, `ulid`
 *   - Ignored by: `uuid4` (always random)
 *   - Use this for testing or when you need IDs to have a specific timestamp
 * @returns A unique identifier string
 * @throws {TypeError} If an invalid type is provided
 * @throws {TypeError} If `seedTime` is provided but is not a non-negative finite number
 *
 * @example
 * ```typescript
 * // Generate random IDs
 * const objId = generateID('objectID');  // "507f1f77bcf86cd799439011"
 * const uuid4 = generateID('uuid4');     // "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
 * const uuid7 = generateID('uuid7');     // "018e8c6e-4f7e-7000-8000-0123456789ab"
 * const ulid = generateID('ulid');       // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
 *
 * // Generate IDs with a specific timestamp
 * const timestamp = Date.now();
 * const seededId = generateID('uuid7', timestamp);
 * ```
 */
export function generateID(type: IdentifierType, seedTime?: number): string {
  assertIdentifierType(type);

  if (seedTime !== undefined && (!Number.isFinite(seedTime) || seedTime < 0)) {
    throw new TypeError(
      `seedTime must be a non-negative finite number (milliseconds), got: ${seedTime}`,
    );
  }

  if (type === 'objectID') {
    if (seedTime !== undefined) {
      // expects as unix time
      const unixTime = convertMSToUnix(seedTime);

      return new ObjectID(unixTime).toHexString();
    } else {
      return new ObjectID().toHexString();
    }
  } else if (type === 'uuid4') {
    return UUIDv4();
  } else if (type === 'uuid7') {
    if (seedTime !== undefined) {
      // expect in milliseconds
      return UUIDv7({ msecs: seedTime });
    } else {
      return UUIDv7();
    }
  } else if (type === 'ulid') {
    if (seedTime !== undefined) {
      // expect in milliseconds
      return ulid(seedTime);
    } else {
      return ulid();
    }
  } else {
    throw new TypeError(`Unhandled identifier type: "${type as string}"`);
  }
}

/**
 * Validates that a string is a valid identifier of the specified type.
 *
 * Performs strict validation:
 * - `objectID`: Must be 24 hexadecimal characters
 * - `uuid4`: Must be a valid UUID with version 4
 * - `uuid7`: Must be a valid UUID with version 7
 * - `ulid`: Must be 26 characters from the ULID character set
 *
 * Empty IDs (from `emptyID()`) are considered valid.
 * Non-string `id` values return `false`.
 *
 * @param type - The expected identifier type
 * @param id - The identifier string to validate
 * @returns `true` if the ID is valid for the specified type, `false` otherwise
 * @throws {TypeError} If an invalid type is provided
 *
 * @example
 * ```typescript
 * validateID('uuid4', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d');  // true
 * validateID('uuid4', '018e8c6e-4f7e-7000-8000-0123456789ab');  // false (this is uuid7)
 * validateID('objectID', '507f1f77bcf86cd799439011');           // true
 * validateID('objectID', 'invalid');                            // false
 * ```
 */
export function validateID(type: IdentifierType, id: string): boolean {
  assertIdentifierType(type);

  if (typeof id !== 'string') {
    return false;
  }

  if (type === 'objectID') {
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      return true;
    } else {
      return false;
    }
  } else if (type === 'uuid4' || type === 'uuid7') {
    // Check if it's the empty ID first
    if (isEmptyID(type, id)) {
      return true;
    }

    const isValid = uuidValidate(id);
    if (!isValid) {
      return false;
    }

    // Check the specific UUID version
    const version = uuidVersion(id);
    if (type === 'uuid4' && version === 4) {
      return true;
    } else if (type === 'uuid7' && version === 7) {
      return true;
    } else {
      return false;
    }
  } else if (type === 'ulid') {
    if (id.match(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i)) {
      return true;
    } else {
      return false;
    }
  } else {
    throw new TypeError(`Unhandled identifier type: "${type as string}"`);
  }
}

/**
 * Returns an empty/null identifier for the specified type.
 *
 * Empty IDs are valid IDs (pass `validateID()`) but represent a null/empty state.
 * Useful as default values or placeholders in databases.
 *
 * Empty ID formats:
 * - `objectID`: `"000000000000000000000000"` (24 zeros)
 * - `uuid4`: `"00000000-0000-0000-0000-000000000000"` (nil UUID)
 * - `uuid7`: `"00000000-0000-0000-0000-000000000000"` (nil UUID)
 * - `ulid`: `"00000000000000000000000000"` (26 zeros)
 *
 * @param type - The type of empty identifier to generate
 * @returns An empty identifier string
 * @throws {TypeError} If an invalid type is provided
 *
 * @example
 * ```typescript
 * const emptyUuid = emptyID('uuid4');  // "00000000-0000-0000-0000-000000000000"
 * validateID('uuid4', emptyUuid);      // true
 * isEmptyID('uuid4', emptyUuid);       // true
 * ```
 */
export function emptyID(type: IdentifierType): string {
  assertIdentifierType(type);

  if (type === 'objectID') {
    return '0'.repeat(24);
  } else if (type === 'uuid4' || type === 'uuid7') {
    return '00000000-0000-0000-0000-000000000000';
  } else if (type === 'ulid') {
    return '0'.repeat(26);
  } else {
    throw new TypeError(`Unhandled identifier type: "${type as string}"`);
  }
}

/**
 * Checks if an identifier is an empty/null ID.
 *
 * Compares the provided ID against the empty ID for the specified type.
 * This is useful for checking if an ID represents a null/empty state.
 *
 * @param type - The identifier type to check against
 * @param id - The identifier string to check
 * @returns `true` if the ID is empty for the specified type, `false` otherwise.
 * Non-string `id` values return `false`.
 * @throws {TypeError} If an invalid type is provided
 *
 * @example
 * ```typescript
 * const emptyUuid = emptyID('uuid4');
 * const realUuid = generateID('uuid4');
 *
 * isEmptyID('uuid4', emptyUuid);  // true
 * isEmptyID('uuid4', realUuid);   // false
 * ```
 */
export function isEmptyID(type: IdentifierType, id: string): boolean {
  assertIdentifierType(type);

  if (typeof id !== 'string') {
    return false;
  }

  return emptyID(type) === id;
}

/**
 * Helper class for working with identifiers of a specific type.
 *
 * This class provides a convenient way to work with IDs without repeatedly
 * specifying the type parameter. Initialize it with your preferred ID type,
 * then use its methods without passing the type each time.
 *
 * @example
 * ```typescript
 * // Create a helper for UUID v7 identifiers
 * const idHelper = new IDHelpers('uuid7');
 *
 * // Generate IDs without specifying type each time
 * const id1 = idHelper.generateID();
 * const id2 = idHelper.generateID(Date.now());
 *
 * // Validate IDs
 * if (idHelper.validateID(someId)) {
 *   console.log('Valid uuid7');
 * }
 *
 * // Check for empty IDs
 * const empty = idHelper.emptyID();
 * console.log(idHelper.isEmptyID(empty));  // true
 * ```
 */
export class IDHelpers {
  private _type: IdentifierType;

  /**
   * Gets the identifier type this helper is configured for.
   */
  public get type(): IdentifierType {
    return this._type;
  }

  /**
   * Creates a new ID helper for the specified type.
   * @param type - The identifier type to use for all operations
   * @throws {TypeError} If an invalid type is provided
   */
  constructor(type: IdentifierType) {
    assertIdentifierType(type);
    this._type = type;
  }

  /**
   * Generates a new identifier using the configured type.
   * @param seedTime - Optional timestamp in milliseconds to seed the ID with
   * @returns A unique identifier string
   */
  public generateID(seedTime?: number): string {
    return generateID(this._type, seedTime);
  }

  /**
   * Validates an identifier against the configured type.
   * @param id - The identifier string to validate
   * @returns `true` if valid, `false` otherwise
   */
  public validateID(id: string): boolean {
    return validateID(this._type, id);
  }

  /**
   * Returns an empty identifier for the configured type.
   * @returns An empty identifier string
   */
  public emptyID(): string {
    return emptyID(this._type);
  }

  /**
   * Checks if an identifier is empty for the configured type.
   * @param id - The identifier string to check
   * @returns `true` if empty, `false` otherwise
   */
  public isEmptyID(id: string): boolean {
    return isEmptyID(this._type, id);
  }
}
