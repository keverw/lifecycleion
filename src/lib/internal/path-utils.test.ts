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

  test('should ignore unsupported characters instead of throwing', () => {
    expect(getPathParts('users[0].profile-name')).toEqual([
      'users',
      '0',
      'profile',
      'name',
    ]);
  });
});
