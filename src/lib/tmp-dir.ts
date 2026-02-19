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
export class FSUtilsErrTmpDirNotInitialized extends Error {
  constructor() {
    super('The temporary directory has not been initialized yet.');
    this.name = 'FSUtilsErrTmpDirNotInitialized';
  }
}

export class FSUtilsErrTmpDirWasCleanedUp extends Error {
  constructor() {
    super('The temporary directory was already cleaned up.');
    this.name = 'FSUtilsErrTmpDirWasCleanedUp';
  }
}

export class FSUtilsErrTmpDirConfigErrorBaseDirectory extends Error {
  constructor() {
    super(
      'An error occurred with the configuration. `baseDirectory` must be an absolute path.',
    );
    this.name = 'FSUtilsErrTmpDirConfigErrorBaseDirectory';
  }
}

export class FSUtilsErrTmpDirConfigErrorMaxTries extends Error {
  constructor() {
    super(
      'An error occurred with the configuration. `maxTries` must be a positive number.',
    );
    this.name = 'FSUtilsErrTmpDirConfigErrorMaxTries';
  }
}

export class FSUtilsErrTmpDirInitializeMaxTriesExceeded extends Error {
  constructor() {
    super('Could not create a unique temporary directory, maxTries exceeded.');
    this.name = 'FSUtilsErrTmpDirInitializeMaxTriesExceeded';
  }
}

export class FSUtilsErrTmpDirCleanupFailedNotEmpty extends Error {
  constructor() {
    super(
      'Cleanup failed. The temporary directory is not empty and `unsafeCleanup` is false.',
    );
    this.name = 'FSUtilsErrTmpDirCleanupFailedNotEmpty';
  }
}

export class FSUtilsErrTmpDirCleanupUnexpectedError extends Error {
  public additionalInfo: { originalError: Error };

  constructor(additionalInfo: { originalError: Error }) {
    super('Cleanup failed due to an unexpected error.');
    this.name = 'FSUtilsErrTmpDirCleanupUnexpectedError';
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

  // configuration properties
  private allowUnsafeCleanup = false;
  private baseDirectory = '';
  private maxTries = 3;
  private prefix = 'tmp';
  private postfix = '';

  public get path(): string {
    if (this.wasCleanedUp) {
      throw new FSUtilsErrTmpDirWasCleanedUp();
    } else if (this.isInitialized) {
      return this.fullTempDirPath;
    } else {
      throw new FSUtilsErrTmpDirNotInitialized();
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
          throw new FSUtilsErrTmpDirConfigErrorBaseDirectory();
        }
      }

      if (isNumber(options.maxTries)) {
        const isAllowedNumber =
          isFinite(options.maxTries) && options.maxTries > 0;

        if (isAllowedNumber) {
          this.maxTries = options.maxTries;
        } else {
          throw new FSUtilsErrTmpDirConfigErrorMaxTries();
        }
      }

      if (isString(options.prefix)) {
        this.prefix = options.prefix;
      }

      if (isString(options.postfix)) {
        this.postfix = options.postfix;
      }
    }

    // if the baseDirectory is not set, use the system temp directory
    if (this.baseDirectory.length === 0) {
      this.baseDirectory = os.tmpdir();
    }
  }

  public async initialize(): Promise<void> {
    if (!this.isInitialized) {
      let attemptsMade = 0;

      // attempt this while the attemptsMade is less than the maxTries
      while (attemptsMade < this.maxTries) {
        attemptsMade++; // increment the attempts made

        // generate a temporary directory name
        const name = this.generateTempDirName();

        // check if the path exists
        const fullPath = path.join(this.baseDirectory, name);

        let doesPathExist = false;
        try {
          await fs.stat(fullPath);
          doesPathExist = true;
        } catch {
          // Path doesn't exist, which is what we want
          doesPathExist = false;
        }

        // only proceed if path doesn't exist
        if (!doesPathExist) {
          // create the directory
          await fs.mkdir(fullPath, { recursive: true });

          // set isInitialized to true and return
          this.fullTempDirPath = fullPath;
          this.isInitialized = true;

          return;
        }
      }

      // if the loop completes without finding a unique directory, throw an error
      throw new FSUtilsErrTmpDirInitializeMaxTriesExceeded();
    }
  }

  public async cleanup(): Promise<void> {
    if (this.isInitialized && !this.wasCleanedUp) {
      try {
        await fs.rm(this.fullTempDirPath, {
          recursive: this.allowUnsafeCleanup,
          force: this.allowUnsafeCleanup,
        });

        this.wasCleanedUp = true;
      } catch (error) {
        // Check if directory is not empty
        // Different runtimes may return different error codes:
        // - ENOTEMPTY: directory not empty (Node.js)
        // - EFAULT: bad address (Bun when trying to delete non-empty dir without recursive)
        // - ENOENT: doesn't exist (already cleaned up, this shouldn't happen but handle it)
        if (error instanceof Error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOTEMPTY' || code === 'EFAULT') {
            throw new FSUtilsErrTmpDirCleanupFailedNotEmpty();
          }
        }

        throw new FSUtilsErrTmpDirCleanupUnexpectedError({
          originalError: error as Error,
        });
      }
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

export async function createTempDir(options?: TmpDirOptions): Promise<TmpDir> {
  const tmpDir = new TmpDir(options);

  await tmpDir.initialize();

  return tmpDir;
}
