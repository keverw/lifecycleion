import { describe, expect, test } from 'bun:test';
import { getPathParts, getRedactPathParts } from './path-utils';

describe('getPathParts', () => {
  test('should parse dot-only paths', () => {
    expect(getPathParts('user.profile.name')).toEqual([
      'user',
      'profile',
      'name',
    ]);
  });

  test('should parse array-only paths', () => {
    expect(getPathParts('matrix[0][2]')).toEqual(['matrix', '0', '2']);
  });

  test('should parse mixed object and array paths', () => {
    expect(getPathParts('users[0].roles[1].name')).toEqual([
      'users',
      '0',
      'roles',
      '1',
      'name',
    ]);
  });

  test('should parse quoted bracket keys', () => {
    expect(getPathParts('user["display-name"]')).toEqual([
      'user',
      'display-name',
    ]);

    expect(getPathParts("settings['api-key']")).toEqual([
      'settings',
      'api-key',
    ]);

    expect(getPathParts('users[0]["display-name"]')).toEqual([
      'users',
      '0',
      'display-name',
    ]);
  });

  test('should parse root-level quoted bracket keys', () => {
    expect(getPathParts('["api-key"]')).toEqual(['api-key']);
    expect(getPathParts("['display name']")).toEqual(['display name']);
  });

  test('should parse unquoted segments that are not plain identifiers', () => {
    // Only `.`, `[` and `]` delimit a segment, so an ordinary key name needs no quoting.
    // These used to be rejected, which silently resolved to nothing in every consumer.
    expect(getPathParts('users[0].profile-name')).toEqual([
      'users',
      '0',
      'profile-name',
    ]);
    expect(getPathParts('user.password-hash')).toEqual([
      'user',
      'password-hash',
    ]);
    expect(getPathParts('u.contraseña')).toEqual(['u', 'contraseña']);
    expect(getPathParts('user.@id')).toEqual(['user', '@id']);
  });

  test('should reject unsupported path syntax', () => {
    // A malformed path is still rejected - and so is a wildcard, which this grammar
    // deliberately does not admit: a placeholder renders one value, so there is nothing
    // for `{{users[*].name}}` to print. Redaction has `getRedactPathParts` for that.
    expect(getPathParts('users[*].password')).toBeNull();
    expect(getPathParts('users.*.password')).toBeNull();
    expect(getPathParts('user.')).toBeNull();
    expect(getPathParts('user]name')).toBeNull();
    expect(getPathParts('user[0')).toBeNull();
  });

  test('should still require quoting for a key containing a delimiter', () => {
    // Only quoting can disambiguate a key that really contains `.` or `[`.
    expect(getPathParts('user["a.b"]')).toEqual(['user', 'a.b']);
    expect(getPathParts('["a[0]"]')).toEqual(['a[0]']);
  });

  test('should reject an unquoted segment containing whitespace', () => {
    // Load-bearing: without it almost any brace-wrapped phrase parses as a key name, so
    // `CurlyBrackets` renders its fallback over prose it used to leave alone. A key that
    // really contains a space takes the quoted form.
    expect(getPathParts('Hello world')).toBeNull();
    expect(getPathParts('u.my key')).toBeNull();
    expect(getPathParts("u['my key']")).toEqual(['u', 'my key']);
  });

  test('should reject an unquoted segment containing prose punctuation', () => {
    // Same reason as whitespace, and excluding whitespace alone does not achieve it: a
    // brace-wrapped phrase is made of punctuation too, and every character admitted here
    // is one that turns such a phrase into a silent fallback render. The segment is an
    // allowlist of name characters for exactly this.
    expect(getPathParts('Hello,world')).toBeNull();
    expect(getPathParts('oops!')).toBeNull();
    expect(getPathParts('user.a+b')).toBeNull();
    expect(getPathParts('user.a:b')).toBeNull();
    expect(getPathParts("u['a,b']")).toEqual(['u', 'a,b']);
  });

  test('should accept a non-ASCII name character outside the BMP', () => {
    // The pattern is Unicode-aware, so an astral letter is one character rather than two
    // stray surrogates, and the sticky `lastIndex` still lands on the next delimiter.
    expect(getPathParts('x.𝐀bc')).toEqual(['x', '𝐀bc']);
    expect(getPathParts('user.日本語')).toEqual(['user', '日本語']);
  });
});

describe('getRedactPathParts', () => {
  test('should parse both spellings of a wildcard to the same segment', () => {
    // One rule written two ways, which is how `users.*.password` and `users[*].password`
    // read to anyone writing a `redactedKeys` list.
    expect(getRedactPathParts('users[*].password')).toEqual([
      'users',
      '*',
      'password',
    ]);
    expect(getRedactPathParts('users.*.password')).toEqual([
      'users',
      '*',
      'password',
    ]);
  });

  test('should accept a wildcard anywhere a segment goes', () => {
    expect(getRedactPathParts('*')).toEqual(['*']);
    expect(getRedactPathParts('items[*]')).toEqual(['items', '*']);
    expect(getRedactPathParts('a[*].b[*].c')).toEqual([
      'a',
      '*',
      'b',
      '*',
      'c',
    ]);
  });

  test('should admit the wildcard only as a whole segment', () => {
    // Widening the grammar for redaction must not widen what counts as a name, so a `*`
    // touching anything else is rejected exactly as a stray character always was.
    expect(getRedactPathParts('us*rs')).toBeNull();
    expect(getRedactPathParts('a.*b')).toBeNull();
    expect(getRedactPathParts('a.b*')).toBeNull();
    expect(getRedactPathParts('**')).toBeNull();
    expect(getRedactPathParts('a[*')).toBeNull();
    expect(getRedactPathParts('a[**]')).toBeNull();
  });

  test('should still reject everything the value grammar rejects', () => {
    expect(getRedactPathParts('user.')).toBeNull();
    expect(getRedactPathParts('user]name')).toBeNull();
    expect(getRedactPathParts('user[0')).toBeNull();
    expect(getRedactPathParts('Hello world')).toBeNull();
    expect(getRedactPathParts('oops!')).toBeNull();
  });

  test('should parse a concrete path exactly as the value grammar does', () => {
    for (const path of [
      'user.profile.name',
      'users[0].roles[1].name',
      'users[0]["display-name"]',
      'user.password-hash',
      "u['my key']",
      'x.𝐀bc',
    ]) {
      expect(getRedactPathParts(path)).toEqual(getPathParts(path));
    }
  });

  test('should treat quoting as disambiguation, never as a literal marker', () => {
    // Quoting exists to address a key containing a delimiter; it has never changed what a
    // segment *means*. Numbers are the precedent: all four spellings are one part, and
    // that part addresses an array slot and an object key named `0` alike, because the
    // parser does not distinguish an index from a name - the container does. The wildcard
    // follows the same rule, which is why `["*"]` is not an escape hatch.
    const index = ['users', '0', 'password'];

    expect(getRedactPathParts('users[0].password')).toEqual(index);
    expect(getRedactPathParts('users["0"].password')).toEqual(index);
    expect(getRedactPathParts("users['0'].password")).toEqual(index);
    expect(getRedactPathParts('users.0.password')).toEqual(index);

    const wildcard = ['users', '*', 'password'];

    expect(getRedactPathParts('users[*].password')).toEqual(wildcard);
    expect(getRedactPathParts('users["*"].password')).toEqual(wildcard);
    expect(getRedactPathParts("users['*'].password")).toEqual(wildcard);
    expect(getRedactPathParts('users.*.password')).toEqual(wildcard);
  });

  test('should read the quoted form as the key literally named *', () => {
    // Which is the same part a bare `*` parses to, deliberately: against a plain object
    // there is no set of array slots to expand over, so that key is the only other
    // reading available.
    expect(getRedactPathParts('user["*"]')).toEqual(['user', '*']);
    expect(getRedactPathParts('user.*')).toEqual(['user', '*']);
  });
});
