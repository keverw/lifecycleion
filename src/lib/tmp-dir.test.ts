import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  TmpDir,
  createTempDir,
  FSUtilsErrTmpDirCleanupFailedNotEmpty,
  FSUtilsErrTmpDirConfigErrorBaseDirectory,
  FSUtilsErrTmpDirConfigErrorMaxTries,
  FSUtilsErrTmpDirInitializeMaxTriesExceeded,
  FSUtilsErrTmpDirNotInitialized,
  FSUtilsErrTmpDirWasCleanedUp,
} from './tmp-dir';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

// Helper function for tests
function removeBaseDir(baseDir: string, fullPath: string): string {
  return fullPath.replace(baseDir, '');
}

describe('TmpDir', () => {
  let tempDir: TmpDir;

  beforeAll(async () => {
    tempDir = await createTempDir({
      unsafeCleanup: true,
    });
  });

  afterAll(async () => {
    await tempDir.cleanup();
  });

  test('should create a temporary directory with the defaults (other than unsafeCleanup)', () => {
    const display = removeBaseDir(os.tmpdir(), tempDir.path);

    const parts = display.slice(1).split('-');

    expect(parts[0]).toBe('tmp');
    expect(parts[1]).toBe(process.pid.toString());
    expect(parts[2].length).toBe(12);
  });

  test('should create a temporary directory with the specified prefix and postfix', async () => {
    const prefix = 'test.prefix';
    const postfix = 'test.postfix';

    const anotherTempDir = await createTempDir({
      unsafeCleanup: true,
      baseDirectory: tempDir.path,
      prefix,
      postfix,
    });

    const display = removeBaseDir(tempDir.path, anotherTempDir.path);

    const parts = display.slice(1).split('-');

    expect(parts[0]).toBe(prefix);
    expect(parts[1]).toBe(process.pid.toString());
    expect(parts[2].length).toBe(12);
    expect(parts[3]).toBe(postfix);
  });

  test('unsafeCleanup with a non-empty directory with default unsafeCleanup as false', async () => {
    const anotherTempDir = await createTempDir({
      baseDirectory: tempDir.path,
    });

    const filePath = path.join(anotherTempDir.path, 'foo.txt');

    await Bun.write(filePath, 'bar');

    // Verify file exists
    const stats = await fs.stat(filePath);
    expect(stats.isFile()).toBe(true);

    let err: unknown;

    try {
      await anotherTempDir.cleanup();
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(FSUtilsErrTmpDirCleanupFailedNotEmpty);
  });

  test('unsafeCleanup with a non-empty directory with unsafeCleanup set true', async () => {
    const anotherTempDir = await createTempDir({
      unsafeCleanup: true,
      baseDirectory: tempDir.path,
    });

    const filePath = path.join(anotherTempDir.path, 'foo.txt');

    await Bun.write(filePath, 'bar');

    // Verify file exists
    const statsBefore = await fs.stat(filePath);
    expect(statsBefore.isFile()).toBe(true);

    await anotherTempDir.cleanup();

    // Verify file no longer exists
    let doesFileExist = false;
    try {
      await fs.stat(filePath);
      doesFileExist = true;
    } catch {
      doesFileExist = false;
    }
    expect(doesFileExist).toBe(false);
  });

  test('maxTries should error when exceeded', async () => {
    const anotherTempDir = await createTempDir({
      baseDirectory: tempDir.path,
    });

    const randomAlready = removeBaseDir(
      tempDir.path,
      anotherTempDir.path,
    ).split('-')[2];

    const TamperedTempDir = new TmpDir({
      baseDirectory: tempDir.path,
    });

    // @ts-expect-error: tampering random generation for testing purposes
    TamperedTempDir.generateTempDirName = (): string => {
      return [
        // @ts-expect-error: tampering random generation for testing purposes
        tempDir.prefix.length > 0 ? tempDir.prefix + '-' : '',
        process.pid,
        '-',
        randomAlready,
        // @ts-expect-error: tampering random generation for testing purposes
        tempDir.postfix.length > 0 ? '-' + tempDir.postfix : '',
      ].join('');
    };

    let err: unknown;

    try {
      await TamperedTempDir.initialize();

      console.log(TamperedTempDir.path);
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(FSUtilsErrTmpDirInitializeMaxTriesExceeded);
  });

  test('should error when accessing .path before initialization', () => {
    const tempDir = new TmpDir();

    let err: unknown;
    let pathStr: string | undefined;

    try {
      pathStr = tempDir.path;
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(FSUtilsErrTmpDirNotInitialized);
    expect(pathStr).toBeUndefined();
  });

  test('should error when accessing .path after cleanup', async () => {
    const tempDir = await createTempDir({
      unsafeCleanup: true,
    });

    await tempDir.cleanup();

    let err: unknown;
    let pathStr: string | undefined;

    try {
      pathStr = tempDir.path;
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(FSUtilsErrTmpDirWasCleanedUp);
    expect(pathStr).toBeUndefined();
  });

  test('should error if baseDirectory is not an absolute path', async () => {
    let err: unknown;

    try {
      await createTempDir({
        baseDirectory: './relative/path',
      });
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(FSUtilsErrTmpDirConfigErrorBaseDirectory);
  });

  test('should error if maxTries is not a positive number', async () => {
    let err: unknown;

    try {
      await createTempDir({
        maxTries: -1,
      });
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(FSUtilsErrTmpDirConfigErrorMaxTries);
  });
});
