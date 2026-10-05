import { tryReadDependencies } from './dependency-policy';
import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import { Plain } from '../test-helpers';
import { ComponentMetadataReader } from './component-metadata-reader';

function componentWithReads(
  dependencies: () => unknown,
  optional: () => unknown = () => false,
): Plain {
  const component = new Plain(
    new Logger({ sinks: [], callProcessExit: false }),
    'example',
  );
  Object.defineProperties(component, {
    getDependencies: { value: dependencies },
    isOptional: { value: optional },
  });
  return component;
}

function collectReports(run: (reports: Error[]) => void): void {
  const reports: Error[] = [];
  const onError = (event: Event): void => {
    event.preventDefault();
    reports.push((event as ErrorEvent).error as Error);
  };
  globalThis.addEventListener('error', onError);
  try {
    run(reports);
  } finally {
    globalThis.removeEventListener('error', onError);
  }
}

test('every dependency read runs guarded copying, while failure reports retain the first context and name once', () => {
  collectReports((reports) => {
    const calls: string[] = [];
    const invalid = Object.create(null);
    const component = componentWithReads(() => {
      calls.push('dependencies');
      return new Proxy(['first', invalid, 'last'], {
        get: (target, property) => {
          calls.push(String(property));
          if (property === Symbol.iterator || property === 'includes') {
            throw new Error('unsafe iteration');
          }
          return Reflect.get(target, property);
        },
      });
    });
    const reader = new ComponentMetadataReader(() => {
      calls.push('name');
      return 'recorded';
    });
    expect(reader.readDependencies(component, 'ordering')).toEqual([
      'first',
      'last',
    ]);
    expect(reader.readDependencies(component, 'shutdown')).toEqual([
      'first',
      'last',
    ]);
    expect(calls).toEqual([
      'dependencies',
      'length',
      '0',
      '1',
      '2',
      'name',
      'dependencies',
      'length',
      '0',
      '1',
      '2',
      // Already reported: the name is looked up only for the report actually made.
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0].message).toContain(
      'lifecycle-manager ordering dependencies of recorded',
    );
    expect(reports[0].cause).toBeInstanceOf(TypeError);
  });
});

test('unreported reads preserve failures and explicit candidate names bypass name lookup', () => {
  collectReports((reports) => {
    const failure = new Error('dependencies failed');
    const component = componentWithReads(() => {
      throw failure;
    });
    const reader = new ComponentMetadataReader(() => {
      throw new Error('candidate not registered');
    });
    expect(tryReadDependencies(component)).toEqual({ error: failure });
    expect(reports).toHaveLength(0);
    reader.reportDependencyReadFailureOnce(
      component,
      'registration',
      failure,
      'candidate',
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].cause).toBe(failure);
    expect(reports[0].message).toContain(
      'registration dependencies of candidate',
    );
  });
});

test('optional reads accept only true and name only the first thrown failure', () => {
  collectReports((reports) => {
    const failure = new Error('optional failed');
    const answers: unknown[] = [true, 1, 'true', false, failure, failure];
    let names = 0;
    const component = componentWithReads(
      () => [],
      () => {
        const answer = answers.shift();
        if (answer === failure) {
          throw failure;
        }
        return answer;
      },
    );
    const reader = new ComponentMetadataReader(() => {
      names++;
      return 'recorded';
    });
    expect(
      Array.from({ length: 6 }, () => reader.isComponentOptional(component)),
    ).toEqual([true, false, false, false, false, false]);
    expect(names).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0].cause).toBe(failure);
    expect(reports[0].message).toContain('isOptional of recorded');
  });
});

test('an optional read whose name lookup throws answers required, reports unlabelled, and does not silence a later named report', () => {
  collectReports((reports) => {
    const failure = new Error('optional failed');
    const component = componentWithReads(
      () => [],
      () => {
        throw failure;
      },
    );
    let isNameBroken = true;
    const reader = new ComponentMetadataReader(() => {
      if (isNameBroken) {
        throw new Error('name failed');
      }
      return 'recorded';
    });
    // A listener that reads the same component again while the unlabelled report is
    // being made must not report - and recurse - again.
    const reenter = (): void => {
      expect(reader.isComponentOptional(component)).toBe(false);
    };
    globalThis.addEventListener('error', reenter);
    try {
      expect(reader.isComponentOptional(component)).toBe(false);
    } finally {
      globalThis.removeEventListener('error', reenter);
    }
    expect(reports).toHaveLength(1);
    expect(reports[0].cause).toBe(failure);
    expect(reports[0].message).toContain('isOptional of <unnamed component>');
    expect(reader.reportMarks(component).optional).toBe(false);

    isNameBroken = false;
    expect(reader.isComponentOptional(component)).toBe(false);
    expect(reader.isComponentOptional(component)).toBe(false);
    expect(reports).toHaveLength(2);
    expect(reports[1].message).toContain('isOptional of recorded');
    expect(reader.reportMarks(component).optional).toBe(true);
  });
});

test('rollback removes new report marks, preserves prior marks, and never recreates cleared marks', () => {
  collectReports((reports) => {
    const failure = new Error('broken metadata');
    const fail = (): never => {
      throw failure;
    };
    const component = componentWithReads(fail, fail);
    const reader = new ComponentMetadataReader(() => 'recorded');
    const readBoth = (): void => {
      expect(reader.readDependencies(component, 'validation')).toEqual([]);
      expect(reader.isComponentOptional(component)).toBe(false);
    };
    const unmarked = reader.reportMarks(component);
    readBoth();
    const marked = reader.reportMarks(component);
    expect(marked).toEqual({ dependencies: true, optional: true });
    reader.rollBackReports(component, marked);
    readBoth();
    expect(reports).toHaveLength(2);
    reader.rollBackReports(component, unmarked);
    readBoth();
    expect(reports).toHaveLength(4);
    reader.clearReports(component);
    reader.rollBackReports(component, marked);
    expect(reader.reportMarks(component)).toEqual(unmarked);
    readBoth();
    expect(reports).toHaveLength(6);
  });
});

test('report marks are set before synchronous error listeners reenter a metadata read', () => {
  collectReports((reports) => {
    const failure = new Error('broken metadata');
    const fail = (): never => {
      throw failure;
    };
    const component = componentWithReads(fail, fail);
    const reader = new ComponentMetadataReader(() => 'recorded');
    const reenter = (): void => {
      reader.readDependenciesReported(component, 'nested');
    };
    globalThis.addEventListener('error', reenter);
    try {
      reader.readDependenciesReported(component, 'outer');
      expect(reports).toHaveLength(1);
    } finally {
      globalThis.removeEventListener('error', reenter);
    }
  });
});
