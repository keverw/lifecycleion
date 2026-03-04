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

  test('should reject unsupported path syntax', () => {
    expect(getPathParts('users[0].profile-name')).toBeNull();
    expect(getPathParts('users[*].password')).toBeNull();
    expect(getPathParts('user.')).toBeNull();
  });
});
