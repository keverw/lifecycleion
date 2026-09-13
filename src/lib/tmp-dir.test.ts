import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  TmpDir,
  createTempDir,
  ErrTmpDirCleanupFailedNotEmpty,
  ErrTmpDirConfigErrorBaseDirectory,
  ErrTmpDirConfigErrorMaxTries,
  ErrTmpDirConfigErrorNamePart,
  ErrTmpDirInitializeMaxTriesExceeded,
  ErrTmpDirNotInitialized,
  ErrTmpDirWasCleanedUp,
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

  test('refuses a prefix or postfix that could leave baseDirectory', () => {
    // `path.join(baseDirectory, '../escape-<pid>-<random>')` normalizes to a sibling of
    // `baseDirectory`, and `initialize()` created it there - with `unsafeCleanup`, the
    // later cleanup was a recursive delete outside the one directory this class promises
    // to stay in. Refused at construction, as `baseDirectory` is.
    for (const part of ['../escape', 'a/b', 'a\\b', 'a\0b', 'a\nb']) {
      expect(() => new TmpDir({ prefix: part })).toThrow(
        ErrTmpDirConfigErrorNamePart,
      );
      expect(() => new TmpDir({ postfix: part })).toThrow(
        ErrTmpDirConfigErrorNamePart,
      );
    }

    // `..` alone is only ever joined with `-` and the pid, never a segment of its own.
    expect(() => new TmpDir({ prefix: '..', postfix: '..' })).not.toThrow();

    try {
      new TmpDir({ postfix: 'a/b' });
    } catch (error) {
      expect((error as ErrTmpDirConfigErrorNamePart).option).toBe('postfix');
    }
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

    expect(err).toBeInstanceOf(ErrTmpDirCleanupFailedNotEmpty);
  });

  test('safe cleanup removes an empty directory', async () => {
    // `fs.rm` without `recursive` refuses a directory outright with `ERR_FS_EISDIR`, empty
    // or not, so the safe path could never complete: every `cleanup()` on the default
    // configuration reported an unexpected error for a directory with nothing in it.
    const anotherTempDir = await createTempDir({
      baseDirectory: tempDir.path,
    });

    const dirPath = anotherTempDir.path;

    expect((await fs.stat(dirPath)).isDirectory()).toBe(true);

    await anotherTempDir.cleanup();

    let doesDirExist = true;

    try {
      await fs.stat(dirPath);
    } catch {
      doesDirExist = false;
    }

    expect(doesDirExist).toBe(false);
    expect(() => anotherTempDir.path).toThrow(ErrTmpDirWasCleanedUp);
  });

  test('cleanup of a directory already gone counts as done', async () => {
    // Gone already is the state cleanup was asked to reach. Reported as an unexpected
    // error, it also never marked the object cleaned up, so every later `cleanup()` threw
    // again and it could not reach a terminal state.
    const anotherTempDir = await createTempDir({
      baseDirectory: tempDir.path,
    });

    const dirPath = anotherTempDir.path;

    await fs.rm(dirPath, { recursive: true, force: true });

    await anotherTempDir.cleanup();

    expect(() => anotherTempDir.path).toThrow(ErrTmpDirWasCleanedUp);

    // Terminal: a second cleanup has nothing to do and nothing to complain about.
    await anotherTempDir.cleanup();
  });

  test('unsafe cleanup of a directory already gone counts as done too', async () => {
    const anotherTempDir = await createTempDir({
      unsafeCleanup: true,
      baseDirectory: tempDir.path,
    });

    const dirPath = anotherTempDir.path;

    await fs.rm(dirPath, { recursive: true, force: true });

    await anotherTempDir.cleanup();

    expect(() => anotherTempDir.path).toThrow(ErrTmpDirWasCleanedUp);
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

  test('a name that already exists is skipped rather than adopted', async () => {
    // Stat-then-mkdir with `recursive: true` adopted a directory another process created
    // between the two calls. An exclusive create refuses it and tries the next name.
    const first = await createTempDir({ baseDirectory: tempDir.path });

    const firstName = path.basename(first.path);
    let calls = 0;

    const second = new TmpDir({ baseDirectory: tempDir.path });
    const tampered = second as unknown as { generateTempDirName: () => string };
    const original = tampered.generateTempDirName.bind(second);

    tampered.generateTempDirName = (): string => {
      calls++;

      return calls === 1 ? firstName : original();
    };

    await second.initialize();

    expect(calls).toBe(2);
    expect(second.path).not.toBe(first.path);
    expect((await fs.stat(second.path)).isDirectory()).toBe(true);

    await second.cleanup();
    await first.cleanup();
  });

  test('two initialize() calls on one instance create one directory', async () => {
    // The exclusive create closes the race between processes; two calls on one instance
    // raced each other instead, each creating a leaf, with the loser's path overwritten
    // and orphaned. The second call now joins the first.
    const dir = new TmpDir({ baseDirectory: tempDir.path });
    const spied = dir as unknown as { generateTempDirName: () => string };
    const original = spied.generateTempDirName.bind(dir);
    let names = 0;

    spied.generateTempDirName = (): string => {
      names++;

      return original();
    };

    await Promise.all([dir.initialize(), dir.initialize(), dir.initialize()]);

    expect(names).toBe(1);
    expect((await fs.stat(dir.path)).isDirectory()).toBe(true);

    await dir.cleanup();
  });

  test('creates a base directory that is not there yet', async () => {
    const base = path.join(tempDir.path, 'nested', 'base');
    const dir = await createTempDir({ baseDirectory: base });

    expect(dir.path.startsWith(base)).toBe(true);

    await dir.cleanup();
  });

  test('maxTries should error when exceeded', async () => {
    const anotherTempDir = await createTempDir({
      baseDirectory: tempDir.path,
    });

    const randomAlready = removeBaseDir(
      tempDir.path,
      anotherTempDir.path,
    ).split('-')[2];

    const tamperedTempDir = new TmpDir({
      baseDirectory: tempDir.path,
    });

    // @ts-expect-error: tampering random generation for testing purposes
    tamperedTempDir.generateTempDirName = (): string => {
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
      await tamperedTempDir.initialize();

      console.log(tamperedTempDir.path);
    } catch (error) {
      err = error;
    }

    expect(err).toBeInstanceOf(ErrTmpDirInitializeMaxTriesExceeded);
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

    expect(err).toBeInstanceOf(ErrTmpDirNotInitialized);
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

    expect(err).toBeInstanceOf(ErrTmpDirWasCleanedUp);
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

    expect(err).toBeInstanceOf(ErrTmpDirConfigErrorBaseDirectory);
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

    expect(err).toBeInstanceOf(ErrTmpDirConfigErrorMaxTries);
  });
});
