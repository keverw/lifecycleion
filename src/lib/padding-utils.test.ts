import {
  padCenter,
  padCenterPreferLeft,
  padCenterPreferRight,
  padLeft,
  padRight,
} from './padding-utils';

import { describe, expect, test } from 'bun:test';

describe('string padding helpers', () => {
  test('padLeft', () => {
    expect(padLeft('Hey', 6)).toEqual('   Hey');
    expect(padLeft('Hey', 6, '*')).toEqual('***Hey');
    expect(padLeft('Hello', 6, 'World')).toEqual('WHello');
    expect(padLeft('Hello', 20, 'World')).toEqual('WorldWorldWorldHello');
  });

  test('padRight', () => {
    expect(padRight('Hey', 6)).toEqual('Hey   ');
    expect(padRight('Hey', 6, '*')).toEqual('Hey***');
    expect(padRight('Hello', 6, 'World')).toEqual('HelloW');
    expect(padRight('Hello', 20, 'World')).toEqual('HelloWorldWorldWorld');
  });

  test('padCenter', () => {
    expect(padCenter('', 17)).toEqual('                 ');
    expect(padCenter('', 0)).toEqual('');
  });

  test('padCenterPreferLeft', () => {
    expect(padCenterPreferLeft('Hello World!', 16)).toEqual('  Hello World!  ');
    expect(padCenterPreferLeft('Hello World!', 17)).toEqual(
      '   Hello World!  ',
    );

    expect(padCenterPreferLeft('Hello World!', 16, '*')).toEqual(
      '**Hello World!**',
    );

    expect(padCenterPreferLeft('Hello World!', 17, '*')).toEqual(
      '***Hello World!**',
    );
  });

  test('padCenterPreferRight', () => {
    expect(padCenterPreferRight('Hello World!', 16)).toEqual(
      '  Hello World!  ',
    );
    expect(padCenterPreferRight('Hello World!', 17)).toEqual(
      '  Hello World!   ',
    );

    expect(padCenterPreferRight('Hello World!', 16, '*')).toEqual(
      '**Hello World!**',
    );

    expect(padCenterPreferRight('Hello World!', 17, '*')).toEqual(
      '**Hello World!***',
    );
  });
});
