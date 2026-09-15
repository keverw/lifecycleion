import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { isNumber } from './is-number';
import { isString } from './strings';
import { isBoolean } from './is-boolean';
import { isPlainObject } from './is-plain-object';

// Helper functions
function randomString(length: number): string {
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  const alphabetLength = alphabet.length;
  const randomValues = new Uint32Array(length);

  // Generate random values
  crypto.getRandomValues(randomValues);

  // Use the random values to select characters from the alphabet
  for (let i = 0; i < length; i++) {
    result += alphabet[randomValues[i] % alphabetLength];
  }

  return result;
}

// Error classes
export class ErrTmpDirNotInitialized extends Error {
  constructor() {
    super('The temporary directory has not been initialized yet.');
    this.name = 'ErrTmpDirNotInitialized';
  }
}

export class ErrTmpDirWasCleanedUp extends Error {
  constructor() {
    super('The temporary directory was already cleaned up.');
    this.name = 'ErrTmpDirWasCleanedUp';
  }
}

export class ErrTmpDirConfigErrorBaseDirectory extends Error {
  constructor() {
    super(
      'An error occurred with the configuration. `baseDirectory` must be an absolute path.',
    );
    this.name = 'ErrTmpDirConfigErrorBaseDirectory';
  }
}

export class ErrTmpDirConfigErrorMaxTries extends Error {
  constructor() {
    super(
      'An error occurred with the configuration. `maxTries` must be a positive integer.',
    );
    this.name = 'ErrTmpDirConfigErrorMaxTries';
  }
}

export class ErrTmpDirConfigErrorNamePart extends Error {
  constructor(public readonly option: 'prefix' | 'postfix') {
    super(
      `An error occurred with the configuration. \`${option}\` must not contain path separators or control characters.`,
    );
    this.name = 'ErrTmpDirConfigErrorNamePart';
  }
}

export class ErrTmpDirInitializeMaxTriesExceeded extends Error {
  constructor() {
    super('Could not create a unique temporary directory, maxTries exceeded.');
    this.name = 'ErrTmpDirInitializeMaxTriesExceeded';
  }
}

export class ErrTmpDirCleanupFailedNotEmpty extends Error {
  constructor() {
    super(
      'Cleanup failed. The temporary directory is not empty and `unsafeCleanup` is false.',
    );
    this.name = 'ErrTmpDirCleanupFailedNotEmpty';
  }
}

export class ErrTmpDirCleanupUnexpectedError extends Error {
  public additionalInfo: { originalError: Error };

  constructor(additionalInfo: { originalError: Error }) {
    super('Cleanup failed due to an unexpected error.');
    this.name = 'ErrTmpDirCleanupUnexpectedError';
    this.additionalInfo = additionalInfo;
  }
}

interface TmpDirOptions {
  unsafeCleanup?: boolean; // allow cleaning up a directory that is not empty, default: false
  baseDirectory?: string; // the directory in which the temporary directory should be created, default: os.tmpdir()
  maxTries?: number; // max number of attempts to create a unique directory, default: 3
  prefix?: string; // prefix of the created directory, default: 'tmp'
  postfix?: string; // postfix of the created directory, default: ''
}

/**
 * Inspired by tmp-promise and tmp-promise with a limited subset of features
 * Was getting an error with the newer versions of `tmp-promise`,
 *
 * TypeError: removeFunction is not a function. (In 'removeFunction(fileOrDirName, next || function() {
 * })', 'removeFunction' is an instance of Object)
 * at _cleanupCallback
 *  at fn (node:util:119:27)
 *
 * so decided to create a simpler version with only the features I need and native to typescript and async/await
 * as was not even using everything included and was a wrapper around another library anyways.
 */

export class TmpDir {
  // internal properties
  private isInitialized = false;
  private wasCleanedUp = false;
  private fullTempDirPath = '';
  /**
   * The `initialize()` in flight, shared by every caller that arrives while it runs.
   *
   * The exclusive create closes the race between two *processes*. Two calls on one
   * instance raced each other instead: both read `isInitialized` as false, both created a
   * leaf of their own, and the loser's path was overwritten and never cleaned up - an
   * orphan a safe-mode `cleanup()` could not have removed even had it known about it.
   */
  private initializing: Promise<void> | null = null;

  /**
   * Set the moment `cleanup()` is entered, and never cleared.
   *
   * `wasCleanedUp` cannot do this job: it is only set once a directory has actually been
   * removed, so a `cleanup()` that found nothing to remove left the object looking
   * untouched. That is precisely the window a failed-then-retried create lands in -
   * `initialize().catch(() => initialize())` racing a `cleanup()` - and the retry's
   * directory was then created *after* the only call that would ever have removed it had
   * returned. Waiting for the in-flight create cannot close that on its own, because the
   * retry has not started yet when the wait ends; refusing the retry can.
   */
  private cleanupRequested = false;

  // configuration properties
  private allowUnsafeCleanup = false;
  private baseDirectory = '';
  private maxTries = 3;
  private prefix = 'tmp';
  private postfix = '';

  public get path(): string {
    if (this.wasCleanedUp) {
      throw new ErrTmpDirWasCleanedUp();
    } else if (this.isInitialized) {
      return this.fullTempDirPath;
    } else {
      throw new ErrTmpDirNotInitialized();
    }
  }

  constructor(options?: TmpDirOptions) {
    if (isPlainObject(options)) {
      if (isBoolean(options.unsafeCleanup)) {
        this.allowUnsafeCleanup = options.unsafeCleanup;
      }

      if (isString(options.baseDirectory)) {
        // trim the baseDirectory just in case
        const baseDirectory = options.baseDirectory.trim();

        // check if the baseDirectory is an absolute path
        if (path.isAbsolute(baseDirectory)) {
          this.baseDirectory = baseDirectory;
        } else {
          throw new ErrTmpDirConfigErrorBaseDirectory();
        }
      }

      if (isNumber(options.maxTries)) {
        const floored = Math.floor(options.maxTries);

        if (isFinite(floored) && floored > 0) {
          this.maxTries = floored;
        } else {
          throw new ErrTmpDirConfigErrorMaxTries();
        }
      }

      // Refused at construction, as `baseDirectory` is. Both are joined into the leaf
      // name, and `path.join` normalizes, so `prefix: '../escape'` created and later
      // cleaned up a directory *outside* `baseDirectory` - with `unsafeCleanup`, a
      // recursive delete outside the one directory this class promises to stay in. A
      // `NUL` is refused with the separators because `fs` refuses it later, from
      // `initialize()`, after the constructor that checks configuration has returned.
      if (isString(options.prefix)) {
        if (!isValidNamePart(options.prefix)) {
          throw new ErrTmpDirConfigErrorNamePart('prefix');
        }

        this.prefix = options.prefix;
      }

      if (isString(options.postfix)) {
        if (!isValidNamePart(options.postfix)) {
          throw new ErrTmpDirConfigErrorNamePart('postfix');
        }

        this.postfix = options.postfix;
      }
    }

    // if the baseDirectory is not set, use the system temp directory
    if (this.baseDirectory.length === 0) {
      this.baseDirectory = os.tmpdir();
    }
  }

  public async initialize(): Promise<void> {
    // `cleanup()` is terminal for the instance - `path` already throws after one - so a
    // create started afterwards could only ever produce a directory nothing can name and
    // nothing will remove. Refused loudly rather than leaked quietly.
    if (this.cleanupRequested) {
      throw new ErrTmpDirWasCleanedUp();
    }

    if (this.isInitialized) {
      return;
    }

    if (this.initializing === null) {
      this.initializing = this.createTempDir().finally(() => {
        this.initializing = null;
      });
    }

    await this.initializing;

    // `cleanup()` may have joined the create while it was in flight. The directory is
    // removed by that cleanup, so the initializer must not report that it successfully
    // produced a usable path after the instance became terminal.
    if (this.cleanupRequested) {
      throw new ErrTmpDirWasCleanedUp();
    }
  }

  public async cleanup(): Promise<void> {
    this.cleanupRequested = true;

    // An `initialize()` still in flight is waited for first, and its failure ignored.
    //
    // `isInitialized` is set at the *end* of `createTempDir`, so for the whole of that
    // call both flags below are false and `cleanup()` was a no-op that removed nothing -
    // and then the directory appeared, with nothing left to remove it. `cleanup()` before
    // `await initialize()`, or `Promise.all([initialize(), cleanup()])`, leaked a temp
    // directory every time; with `unsafeCleanup` that is a recursive-delete target the
    // object believes it has already dealt with.
    //
    // The failure is swallowed rather than rethrown because it is `initialize()`'s to
    // report to whoever called it: a create that failed leaves nothing to clean up, which
    // is the state `cleanup()` was asked to reach.
    // A loop rather than a single `await`, because the slot is cleared by `initialize()`'s
    // own `.finally` *before* control returns here. A create that fails and is retried -
    // `initialize().catch(() => initialize())` racing a `cleanup()` - resolved this await
    // with `initializing` back to `null` and `isInitialized` still `false`, so the check
    // below saw a fresh jar in flight as nothing to do and no-opped; the retry then
    // succeeded and left a directory behind that this object believed it had handled.
    // Re-reading the slot each time round is what makes "wait for initialization" mean the
    // last one rather than the first.
    while (this.initializing !== null) {
      try {
        await this.initializing;
      } catch {
        // Nothing was created, so there is nothing to remove.
      }
    }

    if (this.isInitialized && !this.wasCleanedUp) {
      try {
        if (this.allowUnsafeCleanup) {
          await fs.rm(this.fullTempDirPath, { recursive: true, force: true });
        } else {
          // `rmdir`, not `rm`. `fs.rm` without `recursive` refuses a directory outright
          // and reports `ERR_FS_EISDIR` whether or not it is empty, so it can never
          // complete a safe cleanup and cannot tell "not empty" from "removed fine".
          // `rmdir` is the call that means what this wants: remove it if it is empty,
          // and report `ENOTEMPTY` if it is not.
          await fs.rmdir(this.fullTempDirPath);
        }

        this.wasCleanedUp = true;
      } catch (error) {
        // Gone already is the state this was asked to reach, so it counts as done rather
        // than as a failure: an OS tmp reaper, a parent removed with `unsafeCleanup`, or a
        // second `cleanup()` after a first threw all leave nothing to remove. Reported as
        // `ErrTmpDirCleanupUnexpectedError`, it also never set `wasCleanedUp`, so every
        // later `cleanup()` threw again and the object could not reach a terminal state.
        if (
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
          this.wasCleanedUp = true;

          return;
        }

        // Different runtimes report a non-empty directory differently:
        // - ENOTEMPTY: the standard code, from `rmdir` on Node and Bun
        // - EEXIST: some platforms use this for the same condition
        // - EFAULT: older Bun, from the `fs.rm` path this no longer takes
        // - ERR_FS_EISDIR: `fs.rm` refusing a directory, kept in case a runtime routes
        //   `rmdir` through the same error
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code === 'ENOTEMPTY' ||
            code === 'EEXIST' ||
            code === 'EFAULT' ||
            code === 'ERR_FS_EISDIR'
          ) {
            throw new ErrTmpDirCleanupFailedNotEmpty();
          }
        }

        throw new ErrTmpDirCleanupUnexpectedError({
          originalError: error as Error,
        });
      }
    }
  }

  private async createTempDir(): Promise<void> {
    if (!this.isInitialized) {
      // The parent once, so each attempt below can be an *exclusive* create of the leaf.
      // `mkdir` with `recursive: true` succeeds on a directory that already exists, which
      // is why the old stat-then-mkdir could not be made exclusive by itself.
      await fs.mkdir(this.baseDirectory, { recursive: true });

      let attemptsMade = 0;

      // attempt this while the attemptsMade is less than the maxTries
      while (attemptsMade < this.maxTries) {
        attemptsMade++; // increment the attempts made

        // generate a temporary directory name
        const name = this.generateTempDirName();
        const fullPath = path.join(this.baseDirectory, name);

        // Created, not checked and then created. A `stat` that found nothing followed by
        // a `mkdir` left a window in which another process - or another instance in this
        // one, given the same random name - could create the same path first, and the
        // `recursive` create then adopted their directory as this one's. A plain `mkdir`
        // fails with `EEXIST` on a path that is already there, which is the answer the
        // check was trying to get, only without the window.
        try {
          await fs.mkdir(fullPath);
        } catch (error) {
          if (
            error instanceof Error &&
            (error as NodeJS.ErrnoException).code === 'EEXIST'
          ) {
            continue;
          }

          throw error;
        }

        // set isInitialized to true and return
        this.fullTempDirPath = fullPath;
        this.isInitialized = true;

        return;
      }

      // if the loop completes without finding a unique directory, throw an error
      throw new ErrTmpDirInitializeMaxTriesExceeded();
    }
  }

  private generateTempDirName(): string {
    return [
      this.prefix.length > 0 ? this.prefix + '-' : '',
      process.pid,
      '-',
      randomString(12),
      this.postfix.length > 0 ? '-' + this.postfix : '',
    ].join('');
  }
}

/**
 * Whether a `prefix` or `postfix` stays inside one path segment.
 *
 * Separators are what let it leave `baseDirectory`; control characters are refused with
 * them because `fs` refuses a `NUL` and nothing lists a name holding a newline cleanly.
 * `..` on its own is fine: it is only ever joined with `-` and the pid, never a segment.
 */
function isValidNamePart(part: string): boolean {
  for (const character of part) {
    const code = character.codePointAt(0) ?? 0;

    if (
      character === '/' ||
      character === '\\' ||
      code < 0x20 ||
      code === 0x7f
    ) {
      return false;
    }
  }

  return true;
}

export async function createTempDir(options?: TmpDirOptions): Promise<TmpDir> {
  const tmpDir = new TmpDir(options);

  await tmpDir.initialize();

  return tmpDir;
}
