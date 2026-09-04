import { describe, expect, test } from 'bun:test';
import { getPathParts } from './path-utils';

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
    // Wildcards are still not supported, and a malformed path is still rejected.
    expect(getPathParts('users[*].password')).toBeNull();
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
