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
  });
});
