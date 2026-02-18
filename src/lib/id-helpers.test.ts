import {
  IDHelpers,
  emptyID,
  generateID,
  isEmptyID,
  validateID,
} from './id-helpers';
import { describe, expect, it, test } from 'bun:test';
import { ms } from './unix-time-helpers';

describe('Identifier Helpers', () => {
  const timestampMS = ms();
  const identifiersGenerated = {
    objectID: {
      withoutTimeSeed: {
        a: '',
        b: '',
      },
      withTimeSeed: {
        a: '',
        b: '',
      },
    },
    uuid4: {
      a: '',
      b: '',
    },
    uuid7: {
      withoutTimeSeed: {
        a: '',
        b: '',
      },
      withTimeSeed: {
        a: '',
        b: '',
      },
    },
    ulid: {
      withoutTimeSeed: {
        a: '',
        b: '',
      },
      withTimeSeed: {
        a: '',
        b: '',
      },
    },
  };

  test('generateID - objectID without timeSeed', () => {
    identifiersGenerated.objectID.withoutTimeSeed.a = generateID('objectID');
    identifiersGenerated.objectID.withoutTimeSeed.b = generateID('objectID');

    expect(identifiersGenerated.objectID.withoutTimeSeed.a).not.toEqual(
      identifiersGenerated.objectID.withoutTimeSeed.b,
    );
  });

  test('generateID - objectID with timeSeed', () => {
    identifiersGenerated.objectID.withTimeSeed.a = generateID(
      'objectID',
      timestampMS,
    );

    identifiersGenerated.objectID.withTimeSeed.b = generateID(
      'objectID',
      timestampMS,
    );

    expect(identifiersGenerated.objectID.withTimeSeed.a).not.toEqual(
      identifiersGenerated.objectID.withTimeSeed.b,
    );
  });

  test('generateID - uuid4', () => {
    identifiersGenerated.uuid4.a = generateID('uuid4');
    identifiersGenerated.uuid4.b = generateID('uuid4');

    expect(identifiersGenerated.uuid4.a).not.toEqual(
      identifiersGenerated.uuid4.b,
    );
  });

  test('generateID - uuid7 without timeSeed', () => {
    identifiersGenerated.uuid7.withoutTimeSeed.a = generateID('uuid7');
    identifiersGenerated.uuid7.withoutTimeSeed.b = generateID('uuid7');

    expect(identifiersGenerated.uuid7.withoutTimeSeed.a).not.toEqual(
      identifiersGenerated.uuid7.withoutTimeSeed.b,
    );
  });

  test('generateID - uuid7 with timeSeed', () => {
    identifiersGenerated.uuid7.withTimeSeed.a = generateID(
      'uuid7',
      timestampMS,
    );

    identifiersGenerated.uuid7.withTimeSeed.b = generateID(
      'uuid7',
      timestampMS,
    );

    expect(identifiersGenerated.uuid7.withTimeSeed.a).not.toEqual(
      identifiersGenerated.uuid7.withTimeSeed.b,
    );
  });

  test('generateID - ulid without timeSeed', () => {
    identifiersGenerated.ulid.withoutTimeSeed.a = generateID('ulid');
    identifiersGenerated.ulid.withoutTimeSeed.b = generateID('ulid');
    expect(identifiersGenerated.ulid.withoutTimeSeed.a).not.toEqual(
      identifiersGenerated.ulid.withoutTimeSeed.b,
    );
  });

  test('generateID - ulid with timeSeed', () => {
    identifiersGenerated.ulid.withTimeSeed.a = generateID('ulid', timestampMS);

    identifiersGenerated.ulid.withTimeSeed.b = generateID('ulid', timestampMS);

    expect(identifiersGenerated.ulid.withTimeSeed.a).not.toEqual(
      identifiersGenerated.ulid.withTimeSeed.b,
    );
  });

  describe('validate objectID', () => {
    it('should be valid', () => {
      identifiersGenerated.objectID.withoutTimeSeed.a = generateID('objectID');
      identifiersGenerated.objectID.withoutTimeSeed.b = generateID('objectID');

      identifiersGenerated.objectID.withTimeSeed.a = generateID(
        'objectID',
        timestampMS,
      );

      identifiersGenerated.objectID.withTimeSeed.b = generateID(
        'objectID',
        timestampMS,
      );

      expect(
        validateID('objectID', identifiersGenerated.objectID.withoutTimeSeed.a),
      ).toBeTruthy();

      expect(
        validateID('objectID', identifiersGenerated.objectID.withoutTimeSeed.b),
      ).toBeTruthy();

      expect(
        validateID('objectID', identifiersGenerated.objectID.withTimeSeed.a),
      ).toBeTruthy();

      expect(
        validateID('objectID', identifiersGenerated.objectID.withTimeSeed.b),
      ).toBeTruthy();
    });

    it('should be invalid', () => {
      expect(validateID('objectID', 'foo')).toBeFalsy();

      expect(validateID('objectID', identifiersGenerated.uuid4.a)).toBeFalsy();

      expect(
        validateID('objectID', identifiersGenerated.ulid.withoutTimeSeed.a),
      ).toBeFalsy();
    });
  });

  describe('validate uuid4', () => {
    it('should be valid', () => {
      identifiersGenerated.uuid4.a = generateID('uuid4');
      identifiersGenerated.uuid4.b = generateID('uuid4');

      expect(validateID('uuid4', identifiersGenerated.uuid4.a)).toBeTruthy();
      expect(validateID('uuid4', identifiersGenerated.uuid4.b)).toBeTruthy();
    });

    it('should be invalid', () => {
      expect(validateID('uuid4', 'foo')).toBeFalsy();

      expect(
        validateID('uuid4', identifiersGenerated.objectID.withoutTimeSeed.a),
      ).toBeFalsy();

      expect(
        validateID('uuid4', identifiersGenerated.ulid.withoutTimeSeed.a),
      ).toBeFalsy();

      // uuid7 should not validate as uuid4
      expect(
        validateID('uuid4', identifiersGenerated.uuid7.withoutTimeSeed.a),
      ).toBeFalsy();
    });
  });

  describe('validate uuid7', () => {
    it('should be valid', () => {
      identifiersGenerated.uuid7.withoutTimeSeed.a = generateID('uuid7');
      identifiersGenerated.uuid7.withoutTimeSeed.b = generateID('uuid7');

      expect(
        validateID('uuid7', identifiersGenerated.uuid7.withoutTimeSeed.a),
      ).toBeTruthy();
      expect(
        validateID('uuid7', identifiersGenerated.uuid7.withoutTimeSeed.b),
      ).toBeTruthy();

      identifiersGenerated.uuid7.withTimeSeed.a = generateID(
        'uuid7',
        timestampMS,
      );

      identifiersGenerated.uuid7.withTimeSeed.b = generateID(
        'uuid7',
        timestampMS,
      );

      expect(
        validateID('uuid7', identifiersGenerated.uuid7.withTimeSeed.a),
      ).toBeTruthy();

      expect(
        validateID('uuid7', identifiersGenerated.uuid7.withTimeSeed.b),
      ).toBeTruthy();
    });

    it('should be invalid', () => {
      expect(validateID('uuid7', 'foo')).toBeFalsy();

      expect(
        validateID('uuid7', identifiersGenerated.objectID.withoutTimeSeed.a),
      ).toBeFalsy();

      expect(
        validateID('uuid7', identifiersGenerated.ulid.withoutTimeSeed.a),
      ).toBeFalsy();

      // uuid4 should not validate as uuid7
      expect(validateID('uuid7', identifiersGenerated.uuid4.a)).toBeFalsy();
    });
  });

  describe('validate ulid', () => {
    it('should be valid', () => {
      identifiersGenerated.ulid.withoutTimeSeed.a = generateID('ulid');
      identifiersGenerated.ulid.withoutTimeSeed.b = generateID('ulid');

      identifiersGenerated.ulid.withTimeSeed.a = generateID(
        'ulid',
        timestampMS,
      );

      identifiersGenerated.ulid.withTimeSeed.b = generateID(
        'ulid',
        timestampMS,
      );

      expect(
        validateID('ulid', identifiersGenerated.ulid.withoutTimeSeed.a),
      ).toBeTruthy();

      expect(
        validateID('ulid', identifiersGenerated.ulid.withoutTimeSeed.b),
      ).toBeTruthy();

      expect(
        validateID('ulid', identifiersGenerated.ulid.withTimeSeed.a),
      ).toBeTruthy();

      expect(
        validateID('ulid', identifiersGenerated.ulid.withTimeSeed.b),
      ).toBeTruthy();
    });

    it('should be invalid', () => {
      expect(validateID('ulid', 'foo')).toBeFalsy();
      expect(
        validateID('ulid', identifiersGenerated.objectID.withoutTimeSeed.a),
      ).toBeFalsy();

      expect(validateID('ulid', identifiersGenerated.uuid4.a)).toBeFalsy();

      // First character > '7' sets bits 49 or 48 of the timestamp, causing overflow
      expect(validateID('ulid', '8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBeFalsy();
    });
  });

  describe('case handling and canonical output', () => {
    test('validateID accepts mixed/lower/upper case across all types', () => {
      const objectID = generateID('objectID');
      const uuid4 = generateID('uuid4');
      const uuid7 = generateID('uuid7');
      const ulidID = generateID('ulid');

      expect(validateID('objectID', objectID.toUpperCase())).toBeTruthy();
      expect(validateID('uuid4', uuid4.toUpperCase())).toBeTruthy();
      expect(validateID('uuid7', uuid7.toUpperCase())).toBeTruthy();
      expect(validateID('ulid', ulidID.toLowerCase())).toBeTruthy();
    });

    test('generateID returns canonical case by type', () => {
      const objectID = generateID('objectID');
      const uuid4 = generateID('uuid4');
      const uuid7 = generateID('uuid7');
      const ulidID = generateID('ulid');

      expect(objectID).toEqual(objectID.toLowerCase());
      expect(uuid4).toEqual(uuid4.toLowerCase());
      expect(uuid7).toEqual(uuid7.toLowerCase());
      expect(ulidID).toEqual(ulidID.toUpperCase());
    });
  });

  describe('seedTime behavior details', () => {
    test('objectID truncates seedTime to seconds', () => {
      const secondBoundary = 1700000000000;
      const sameSecondA = generateID('objectID', secondBoundary + 100);
      const sameSecondB = generateID('objectID', secondBoundary + 900);
      const nextSecond = generateID('objectID', secondBoundary + 1000);

      expect(sameSecondA.slice(0, 8)).toEqual(sameSecondB.slice(0, 8));
      expect(nextSecond.slice(0, 8)).not.toEqual(sameSecondA.slice(0, 8));
    });
  });

  describe('empty objectID', () => {
    let id: string;

    it('should generate an empty id', () => {
      id = emptyID('objectID');
    });

    it('should be valid', () => {
      expect(validateID('objectID', id)).toBeTruthy();
    });

    it('should be empty', () => {
      expect(isEmptyID('objectID', id)).toBeTruthy();
    });

    it('should not be empty', () => {
      expect(
        isEmptyID('objectID', identifiersGenerated.objectID.withoutTimeSeed.a),
      ).toBeFalsy();
    });
  });

  describe('empty uuid4', () => {
    let id: string;

    it('should generate an empty id', () => {
      id = emptyID('uuid4');
    });

    it('should be valid', () => {
      expect(validateID('uuid4', id)).toBeTruthy();
    });

    it('should be empty', () => {
      expect(isEmptyID('uuid4', id)).toBeTruthy();
    });

    it('should not be empty', () => {
      expect(isEmptyID('uuid4', identifiersGenerated.uuid4.a)).toBeFalsy();
    });
  });

  describe('empty uuid7', () => {
    let id: string;

    it('should generate an empty id', () => {
      id = emptyID('uuid7');
    });

    it('should be valid', () => {
      expect(validateID('uuid7', id)).toBeTruthy();
    });

    it('should be empty', () => {
      expect(isEmptyID('uuid7', id)).toBeTruthy();
    });

    it('should not be empty', () => {
      expect(
        isEmptyID('uuid7', identifiersGenerated.uuid7.withoutTimeSeed.a),
      ).toBeFalsy();
    });
  });

  describe('uuid4/uuid7 shared nil UUID', () => {
    test('empty IDs are interchangeable across uuid4 and uuid7', () => {
      const uuid4Empty = emptyID('uuid4');
      const uuid7Empty = emptyID('uuid7');

      expect(uuid4Empty).toEqual(uuid7Empty);
      expect(isEmptyID('uuid4', uuid7Empty)).toBeTruthy();
      expect(isEmptyID('uuid7', uuid4Empty)).toBeTruthy();
      expect(validateID('uuid4', uuid7Empty)).toBeTruthy();
      expect(validateID('uuid7', uuid4Empty)).toBeTruthy();
    });
  });

  describe('empty ulid', () => {
    let id: string;

    it('should generate an empty id', () => {
      id = emptyID('ulid');
    });

    it('should be valid', () => {
      expect(validateID('ulid', id)).toBeTruthy();
    });

    it('should be empty', () => {
      expect(isEmptyID('ulid', id)).toBeTruthy();
    });

    it('should not be empty', () => {
      expect(
        isEmptyID('ulid', identifiersGenerated.ulid.withoutTimeSeed.a),
      ).toBeFalsy();
    });
  });

  describe('Invalid Type Given', () => {
    test('generateID', () => {
      expect(() => {
        // @ts-expect-error: Unit testing
        generateID('foo');
      }).toThrow(TypeError);

      expect(() => {
        // @ts-expect-error: Unit testing
        generateID('foo');
      }).toThrow(
        'Invalid ID type given: "foo". Expected one of: objectID, uuid4, uuid7, ulid',
      );
    });

    test('validateID', () => {
      expect(() => {
        // @ts-expect-error: Unit testing
        validateID('foo', 'bar');
      }).toThrow(TypeError);

      expect(() => {
        // @ts-expect-error: Unit testing
        validateID('foo', 'bar');
      }).toThrow(
        'Invalid ID type given: "foo". Expected one of: objectID, uuid4, uuid7, ulid',
      );
    });

    test('emptyID', () => {
      expect(() => {
        // @ts-expect-error: Unit testing
        emptyID('foo');
      }).toThrow(TypeError);

      expect(() => {
        // @ts-expect-error: Unit testing
        emptyID('foo');
      }).toThrow(
        'Invalid ID type given: "foo". Expected one of: objectID, uuid4, uuid7, ulid',
      );
    });

    test('isEmptyID', () => {
      expect(() => {
        // @ts-expect-error: Unit testing
        isEmptyID('foo', 'bar');
      }).toThrow(TypeError);

      expect(() => {
        // @ts-expect-error: Unit testing
        isEmptyID('foo', 'bar');
      }).toThrow(
        'Invalid ID type given: "foo". Expected one of: objectID, uuid4, uuid7, ulid',
      );
    });
  });

  describe('Invalid seedTime given', () => {
    const expectedMessage = (value: unknown) =>
      `seedTime must be a non-negative finite number (milliseconds), got: ${String(value)}`;

    test('NaN throws TypeError', () => {
      expect(() => generateID('objectID', NaN)).toThrow(TypeError);
      expect(() => generateID('objectID', NaN)).toThrow(expectedMessage(NaN));
    });

    test('Infinity throws TypeError', () => {
      expect(() => generateID('uuid7', Infinity)).toThrow(TypeError);
      expect(() => generateID('uuid7', Infinity)).toThrow(
        expectedMessage(Infinity),
      );
    });

    test('-Infinity throws TypeError', () => {
      expect(() => generateID('ulid', -Infinity)).toThrow(TypeError);
      expect(() => generateID('ulid', -Infinity)).toThrow(
        expectedMessage(-Infinity),
      );
    });

    test('negative number throws TypeError', () => {
      expect(() => generateID('objectID', -1)).toThrow(TypeError);
      expect(() => generateID('objectID', -1)).toThrow(expectedMessage(-1));
    });

    test('0 is valid (epoch timestamp)', () => {
      expect(() => generateID('uuid7', 0)).not.toThrow();
      expect(() => generateID('ulid', 0)).not.toThrow();
      expect(() => generateID('objectID', 0)).not.toThrow();
    });

    test('uuid4 accepts but ignores valid seedTime', () => {
      const id = generateID('uuid4', Date.now());
      expect(validateID('uuid4', id)).toBeTruthy();
    });

    test('uuid4 ignores seedTime - different seeds still produce random v4 IDs', () => {
      const id1 = generateID('uuid4', 0);
      const id2 = generateID('uuid4', 9999999999999);
      expect(validateID('uuid4', id1)).toBeTruthy();
      expect(validateID('uuid4', id2)).toBeTruthy();
      expect(id1).not.toEqual(id2);
    });

    test('uuid4 still throws on invalid seedTime', () => {
      expect(() => generateID('uuid4', NaN)).toThrow(TypeError);
      expect(() => generateID('uuid4', -1)).toThrow(TypeError);
      expect(() => generateID('uuid4', Infinity)).toThrow(TypeError);
    });
  });

  describe('validateID id input type safety', () => {
    test('non-string id input returns false for every type', () => {
      // @ts-expect-error: Unit testing non-string input
      expect(validateID('objectID', 123)).toBeFalsy();
      // @ts-expect-error: Unit testing non-string input
      expect(validateID('uuid4', 123)).toBeFalsy();
      // @ts-expect-error: Unit testing non-string input
      expect(validateID('uuid7', 123)).toBeFalsy();
      // @ts-expect-error: Unit testing non-string input
      expect(validateID('ulid', 123)).toBeFalsy();
    });
  });

  describe('isEmptyID id input type safety', () => {
    test('non-string id input returns false for every type', () => {
      // @ts-expect-error: Unit testing non-string input
      expect(isEmptyID('objectID', 123)).toBeFalsy();
      // @ts-expect-error: Unit testing non-string input
      expect(isEmptyID('uuid4', 123)).toBeFalsy();
      // @ts-expect-error: Unit testing non-string input
      expect(isEmptyID('uuid7', 123)).toBeFalsy();
      // @ts-expect-error: Unit testing non-string input
      expect(isEmptyID('ulid', 123)).toBeFalsy();
    });
  });

  describe('IDHelpers helper class', () => {
    let classInstance: IDHelpers;
    let id: string;
    let emptyID: string;

    it('should initialize the class', () => {
      classInstance = new IDHelpers('ulid');
      expect(classInstance.type).toEqual('ulid');
    });

    it('should generate an id', () => {
      id = classInstance.generateID();
      expect(classInstance.validateID(id)).toBeTruthy();
      expect(classInstance.isEmptyID(id)).toBeFalsy();
    });

    it('should generate an empty id', () => {
      emptyID = classInstance.emptyID();
      expect(classInstance.validateID(emptyID)).toBeTruthy();
      expect(classInstance.isEmptyID(emptyID)).toBeTruthy();
    });

    it('should throw for invalid type at construction time', () => {
      expect(() => {
        // @ts-expect-error: Unit testing runtime guard
        new IDHelpers('foo');
      }).toThrow(TypeError);

      expect(() => {
        // @ts-expect-error: Unit testing runtime guard
        new IDHelpers('foo');
      }).toThrow(
        'Invalid ID type given: "foo". Expected one of: objectID, uuid4, uuid7, ulid',
      );
    });
  });
});
