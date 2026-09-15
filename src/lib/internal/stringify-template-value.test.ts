import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { stringifyTemplateValue } from './stringify-template-value';

describe('stringifyTemplateValue', () => {
  test('should return strings unchanged', () => {
    expect(stringifyTemplateValue('secret123')).toBe('secret123');
  });

  test('should stringify Error values', () => {
    expect(stringifyTemplateValue(new Error('boom'))).toBe('Error: boom');
  });

  test('should stringify arrays', () => {
    expect(stringifyTemplateValue(['a', 'b'])).toBe('["a","b"]');
  });

  test('should stringify plain objects as JSON', () => {
    expect(stringifyTemplateValue({ key: 'value' })).toBe('{"key":"value"}');
  });
});

describe('stringifyTemplateValue - values that resist rendering', () => {
  // This walk renders caller data on paths that must not raise a failure of their own -
  // a log line's params, a rendered error's `additionalInfo` - so every read it makes is
  // guarded. None of that was covered here: the cases below are the ones where a guard
  // going missing changes the output rather than crashing the suite, which is how a
  // whole-object collapse survived in `renderContainer` unnoticed.

  const hostileKeys = (): object =>
    new Proxy(
      { a: 1 },
      {
        ownKeys() {
          throw new Error('ownKeys refused');
        },
      },
    );

  const throwingEntry = (): Record<string, unknown> => {
    const value: Record<string, unknown> = { good: 'kept', other: 2 };

    Object.defineProperty(value, 'bad', {
      get() {
        throw new Error('entry refused');
      },
      enumerable: true,
    });

    return value;
  };

  test('marks one unreadable entry and keeps every sibling', () => {
    // The regression that mattered: read together under one `catch`, a single throwing
    // getter collapsed the whole object and discarded `good` and `other` with it.
    const rendered = stringifyTemplateValue(throwingEntry());

    expect(rendered).toContain('kept');
    expect(rendered).toContain('"other":2');
    expect(rendered).toContain('[unrenderable: value]');
  });

  test('marks one unreadable element and keeps every sibling', () => {
    // Three slots, with the middle one replaced by a throwing accessor, so the siblings
    // asserted below sit on both sides of it.
    const value: unknown[] = ['first', 'second', 'third'];

    Object.defineProperty(value, '1', {
      get() {
        throw new Error('element refused');
      },
      enumerable: true,
    });

    expect(stringifyTemplateValue(value)).toBe(
      '["first","[unrenderable: value]","third"]',
    );
  });

  test('degrades a container whose keys cannot be enumerated', () => {
    // The marker is emitted as a JSON string, so at the top level it arrives with its
    // quotes - this walk's leaves are always quoted and the container it stood in for
    // never got the chance to render its own braces.
    expect(stringifyTemplateValue(hostileKeys())).toBe(
      '"[unrenderable: keys]"',
    );
    expect(stringifyTemplateValue({ inner: hostileKeys() })).toBe(
      '{"inner":"[unrenderable: keys]"}',
    );
  });

  test('keeps a sibling of an unreadable container', () => {
    const rendered = stringifyTemplateValue({
      inner: hostileKeys(),
      keep: 'visible',
    });

    expect(rendered).toContain('visible');
    expect(rendered).toContain('[unrenderable: keys]');
  });

  test('cuts a cycle where it closes rather than collapsing everything above it', () => {
    const value: Record<string, unknown> = { name: 'root' };

    value['self'] = value;

    const rendered = stringifyTemplateValue(value);

    expect(rendered).toContain('root');
    expect(rendered).toContain('[circular]');
  });

  test('renders a value referenced twice side by side in full both times', () => {
    // `seen` is released on the way out deliberately, so a shared subtree is not a cycle.
    const shared = { id: 7 };

    expect(stringifyTemplateValue({ l: shared, r: shared })).toBe(
      '{"l":{"id":7},"r":{"id":7}}',
    );
  });

  test('marks where a walk past the depth cap stopped', () => {
    let deep: Record<string, unknown> = { bottom: true };

    for (let index = 0; index < 150; index++) {
      deep = { next: deep };
    }

    expect(stringifyTemplateValue(deep)).toContain('[max depth exceeded]');
  });

  test('stops and says so rather than emitting without bound', () => {
    // Empty containers cost nothing per entry, so the delimiters have to be charged for
    // the cap to hold at all - this is the payload that ran past it when they were not.
    const wide: unknown[] = [];

    for (let index = 0; index < 500_000; index++) {
      wide.push({});
    }

    const rendered = stringifyTemplateValue(wide);

    expect(rendered).toContain('[max length exceeded]');
    expect(rendered.length).toBeLessThan(2_000_000);
  });

  test('names a value whose own toString throws', () => {
    // A class instance, not an object literal: a literal carrying a `toString` key is a
    // plain container, so it is walked as structure and that function is rendered as one
    // of its entries rather than ever being called.
    class Hostile {
      public toString(): string {
        throw new Error('toString refused');
      }
    }

    expect(stringifyTemplateValue(new Hostile())).toBe('[unrenderable: text]');
    expect(stringifyTemplateValue({ v: new Hostile() })).toBe(
      '{"v":"[unrenderable: text]"}',
    );
  });

  test('caps a bare value whose own toString is enormous', () => {
    // Bounded wherever it sits. Nested, this instance goes through `quoteWithinBudget` and
    // is cut; bare, it returned `String(value)` whole, so the cap depended only on whether
    // the value happened to have a container around it.
    class Huge {
      public toString(): string {
        return 'x'.repeat(10_000_000);
      }
    }

    const bare = stringifyTemplateValue(new Huge());

    expect(bare).toContain('[max length exceeded]');
    expect(bare.length).toBeLessThan(2_000_000);

    const nested = stringifyTemplateValue({ v: new Huge() });

    expect(nested).toContain('[max length exceeded]');
    expect(nested.length).toBeLessThan(2_000_000);
  });

  test('renders a bigint as text rather than throwing on it', () => {
    // `JSON.stringify` throws on a bigint anywhere inside a value, which used to collapse
    // the entire render to `[object]`.
    expect(stringifyTemplateValue({ big: 10n })).toBe('{"big":"10"}');
  });

  test('distinguishes undefined from the string "undefined"', () => {
    expect(stringifyTemplateValue({ a: undefined, b: 'undefined' })).toBe(
      '{"a":"[undefined]","b":"undefined"}',
    );
  });

  test('renders non-finite numbers as null, having no JSON form', () => {
    expect(stringifyTemplateValue({ n: NaN, i: Infinity })).toBe(
      '{"n":null,"i":null}',
    );
  });

  test('names a function rather than emitting its source', () => {
    // `String(fn)` returns the whole body, which can carry a literal key or a comment the
    // author wrote inside it straight into a log line.
    function namedHelper(): void {
      // Intentionally empty.
    }

    expect(stringifyTemplateValue({ fn: namedHelper })).toBe(
      '{"fn":"[Function: namedHelper]"}',
    );
  });

  test('names a class instance rather than dumping its fields', () => {
    class Session {
      public token = 'hunter2secret';
    }

    expect(stringifyTemplateValue(new Session())).toBe('[Session]');
    expect(stringifyTemplateValue({ s: new Session() })).toBe(
      '{"s":"[Session]"}',
    );
  });

  test('renders a Date as its ISO form at any depth', () => {
    const when = new Date('2020-01-02T03:04:05.000Z');

    expect(stringifyTemplateValue(when)).toBe('2020-01-02T03:04:05.000Z');
    expect(stringifyTemplateValue({ when })).toBe(
      '{"when":"2020-01-02T03:04:05.000Z"}',
    );
  });

  test('never throws on a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});

    revoke();

    expect(() => stringifyTemplateValue(proxy)).not.toThrow();
    expect(() => stringifyTemplateValue({ p: proxy })).not.toThrow();
  });
});

describe('stringifyTemplateValue on binary views', () => {
  // The rule here is deliberately not `serializeError`'s. That function marks every view,
  // because an IPC payload has no business carrying one JSON key per byte. This is the
  // human-readable path behind logger templates, where `String(Buffer.from('hello'))` is
  // `hello` and a reader wants to see it. What is closed is only the case where decoding
  // could not have helped: `String(buffer)` materializes every byte before anything can cut
  // the result, so a large view cost a second and its own size in memory to produce a
  // couple of hundred characters.
  test('a small view still renders as its decoded text', () => {
    expect(stringifyTemplateValue(Buffer.from('hello'))).toBe('hello');
  });

  test('a view larger than the allowance renders as a marker instead of decoding', () => {
    const big = Buffer.alloc(8_000_000, 0x41);

    const started = Date.now();
    const rendered = stringifyTemplateValue(big);
    const elapsed = Date.now() - started;

    expect(rendered).toBe('<binary: Buffer, 8000000 bytes>');
    // The point is the work avoided, not only the text: decoding this took about 200ms and
    // eight megabytes before the marker, and the result was cut to nothing anyway.
    expect(elapsed).toBeLessThan(200);
  });

  test('a view that fits the allowance is decoded as before', () => {
    const small = Buffer.alloc(2_000, 0x41);

    expect(stringifyTemplateValue(small)).toBe('A'.repeat(2_000));
  });

  test('a subclass that under-reports its size is measured honestly', () => {
    // `byteLength` is an accessor, so the value can claim any size it likes - and a size
    // the value supplies is worth nothing to a check that exists to decide whether that
    // value is too big. Read through the intrinsic `%TypedArray%.prototype.byteLength`
    // getter, which reads the internal slot and cannot be overridden, a subclass claiming
    // `0` over twenty megabytes still takes the marker.
    class Lying extends Uint8Array {
      public override get byteLength(): number {
        return 0;
      }
    }

    const lying = new Lying(20_000_000);

    const started = Date.now();
    const rendered = stringifyTemplateValue(lying);

    expect(Date.now() - started).toBeLessThan(200);
    expect(rendered).toBe('<binary: Lying, 20000000 bytes>');
  });

  test('a subclass whose size accessor throws is still measured, not refused', () => {
    // The intrinsic getter never consults the overridden one, so a throwing accessor is
    // not a refusal here: the view is small, and it decodes like any other.
    class Throwing extends Uint8Array {
      public override get byteLength(): number {
        throw new Error('byteLength refused');
      }
    }

    const view = new Throwing(3);

    expect(stringifyTemplateValue(view)).toBe('0,0,0');
  });

  test('a bare ArrayBuffer names itself and its size', () => {
    // `ArrayBuffer.isView` is deliberately false for the backing store, so it used to fall
    // through to the generic constructor naming and render `[ArrayBuffer]` - correct and
    // cheap, and silent about the one thing worth knowing. There is no decode to avoid, so
    // no allowance is consulted: this is only about two bytes and forty megabytes not
    // reading the same.
    expect(stringifyTemplateValue(new ArrayBuffer(2))).toBe(
      '<binary: ArrayBuffer, 2 bytes>',
    );
    expect(stringifyTemplateValue(new ArrayBuffer(40_000_000))).toBe(
      '<binary: ArrayBuffer, 40000000 bytes>',
    );
  });

  test('a buffer from another realm is recognized, where instanceof is not', () => {
    // The brand check is the intrinsic getter throwing or not, never `instanceof`, which is
    // realm-bound: a buffer from an iframe or a `vm` context fails that operator while
    // being exactly the thing worth naming.
    const foreign = runInNewContext('new ArrayBuffer(77)') as object;

    expect(foreign instanceof ArrayBuffer).toBe(false);
    expect(stringifyTemplateValue(foreign)).toBe(
      '<binary: ArrayBuffer, 77 bytes>',
    );
  });

  test('an ordinary object is not mistaken for a buffer', () => {
    // The getters throw on a receiver without the internal slot, so nothing that merely
    // looks buffer-shaped is claimed - including one that reports a `byteLength`.
    expect(stringifyTemplateValue({ byteLength: 40_000_000 })).toBe(
      '{"byteLength":40000000}',
    );
    expect(stringifyTemplateValue({})).toBe('{}');
  });

  test('a DataView is measured through its own intrinsic getter', () => {
    const view = new DataView(new ArrayBuffer(4_000_000));

    expect(stringifyTemplateValue(view)).toBe(
      '<binary: DataView, 4000000 bytes>',
    );
  });
});
