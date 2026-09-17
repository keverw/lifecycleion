# tmp-dir

Create uniquely named temporary directories and clean them up explicitly.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [createTempDir](#createtempdir)
  - [TmpDir](#tmpdir)
    - [path](#path)
    - [initialize](#initialize)
    - [cleanup](#cleanup)
  - [TmpDirOptions](#tmpdiroptions)
  - [Error Classes](#error-classes)

<!-- tocstop -->

## Usage

```typescript
import { createTempDir, TmpDir } from 'lifecycleion/tmp-dir';
```

## API

### createTempDir

Convenience function that creates a `TmpDir` instance, calls `initialize()`, and returns it ready to use.

Use `cleanup()` when done. The utility does not auto-register a process exit handler.

```typescript
const tmpDir = await createTempDir();
try {
  console.log(tmpDir.path); // e.g. /tmp/tmp-12345-A1B2C3D4E5F6
  // ... use the directory ...
} finally {
  await tmpDir.cleanup();
}
```

With options:

```typescript
const tmpDir = await createTempDir({
  mode: 0o750, // optional: allow group read/traverse; private 0o700 by default
  prefix: 'myapp',
  postfix: 'test',
  unsafeCleanup: true,
});
// directory name: myapp-<pid>-<random12chars>-test
```

### TmpDir

Class for managing a temporary directory with explicit `initialize` and `cleanup` lifecycle methods.

```typescript
const tmpDir = new TmpDir({ prefix: 'work' });
await tmpDir.initialize();

// use tmpDir.path ...

await tmpDir.cleanup();
```

#### path

Getter that returns the full absolute path to the temporary directory.

- Throws `ErrTmpDirNotInitialized` if `initialize()` has not been called.
- Throws `ErrTmpDirWasCleanedUp` if `cleanup()` has already run.

```typescript
tmpDir.path; // "/tmp/tmp-12345-A1B2C3D4E5F6"
```

#### initialize

Creates the temporary directory on disk.

- Retries up to `maxTries` times to find a unique name.
- Safe to call more than once. After the first successful call, subsequent calls are no-ops.
- Once cleaned up, the instance remains in that state and will not recreate the directory.

```typescript
await tmpDir.initialize();
```

Throws `ErrTmpDirInitializeMaxTriesExceeded` if a unique directory cannot be created within `maxTries` attempts.

#### cleanup

Removes the temporary directory.

- Safe to call more than once. Calls after successful cleanup are no-ops.
- **`cleanup()` is terminal for the instance, even when it removes nothing.** Calling it
  before `initialize()` touches no filesystem - there is nothing to remove - but the
  instance is finished either way: a later `initialize()` throws `ErrTmpDirWasCleanedUp`
  rather than creating a directory. Construct a new `TmpDir` instead of reusing one past
  its `cleanup()`.
- It first waits for any `initialize()` still in flight, ignoring that create's failure
  (a create that failed left nothing to remove). Refusing a _later_ `initialize()` is what
  closes the rest of the race: a failed create retried alongside a `cleanup()` used to
  begin after cleanup had already returned, and its directory was orphaned.
- With `unsafeCleanup: true`, cleanup uses recursive removal and can delete non-empty directories.
- With `unsafeCleanup: false` (default), cleanup of non-empty directories throws.

```typescript
await tmpDir.cleanup();
```

- Throws `ErrTmpDirCleanupFailedNotEmpty` if the directory is not empty and `unsafeCleanup` is `false`.
- Throws `ErrTmpDirCleanupUnexpectedError` for any other filesystem error. The original error is available on `additionalInfo.originalError`.

### TmpDirOptions

Options object accepted by `new TmpDir(options)` and `createTempDir(options)`.

| Option          | Type      | Default       | Description                                                                                                |
| --------------- | --------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| `unsafeCleanup` | `boolean` | `false`       | Allow deleting a non-empty directory during cleanup                                                        |
| `baseDirectory` | `string`  | `os.tmpdir()` | Absolute path in which to create the temp dir                                                              |
| `mode`          | `number`  | `0o700`       | Integer permission bits from `0o000` through `0o777` for newly created directories                         |
| `maxTries`      | `number`  | `3`           | Maximum attempts to find a unique directory name. Values are floored to an integer and must be at least 1. |
| `prefix`        | `string`  | `'tmp'`       | Prepended to the directory name (separator `-` is added automatically). No `/`, `\`, or control characters |
| `postfix`       | `string`  | `''`          | Appended to the directory name (separator `-` is added automatically). No `/`, `\`, or control characters  |

Directory names follow the pattern: `<prefix>-<pid>-<random12chars>[-<postfix>]`

Notes:

- `baseDirectory` is trimmed before validation and must be an absolute path.
- `random12chars` uses upper/lowercase letters and digits.
- Unknown option keys are ignored. `mode` is strictly validated when supplied; other options ignore values of the wrong type. Invalid `baseDirectory`, `maxTries`, `prefix`, or `postfix` values of the expected type throw a configuration error.
- `mode` is applied to the leaf, subject to the process umask. Newly created parents use `mode | 0o700` so the owner can create and traverse the temporary directory. Existing directories are not chmodded. Permission-bit behavior is platform-dependent on Windows; this option does not configure Windows ACLs.
- `prefix` and `postfix` are refused if they carry a path separator or a control character, so the directory always sits directly inside `baseDirectory`. A `prefix` of `'../escape'` used to create, and with `unsafeCleanup` delete, a directory outside it.

### Error Classes

| Class                                 | When it is thrown                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ErrTmpDirNotInitialized`             | Reading `.path` before `initialize()`                                                             |
| `ErrTmpDirWasCleanedUp`               | Reading `.path` after successful `cleanup()`, or calling `initialize()` after any `cleanup()`     |
| `ErrTmpDirConfigErrorBaseDirectory`   | `baseDirectory` is not an absolute path                                                           |
| `ErrTmpDirConfigErrorMode`            | `mode` is not an integer from `0o000` through `0o777`                                             |
| `ErrTmpDirConfigErrorMaxTries`        | `maxTries` floors to a value that is not a positive integer (e.g. `0`, negative, `Infinity`)      |
| `ErrTmpDirConfigErrorNamePart`        | `prefix` or `postfix` contains a path separator or control character. `option` names which one    |
| `ErrTmpDirInitializeMaxTriesExceeded` | A unique directory could not be created within `maxTries` attempts                                |
| `ErrTmpDirCleanupFailedNotEmpty`      | Cleanup encountered a non-empty directory while `unsafeCleanup` is `false`                        |
| `ErrTmpDirCleanupUnexpectedError`     | Any other cleanup filesystem error. Original error is available on `additionalInfo.originalError` |
