import { stringifyValue } from '../../../stringify-value';
import { MAX_RENDER_LENGTH } from '../../../internal/render-budget';
import type { LogEntry } from '../../types';

/**
 * One log entry as one line of JSON, for the `jsonFormat` of `FileSink` and
 * `NamedPipeSink`.
 *
 * The fixed envelope fields go through `JSON.stringify`, which cannot fail on the
 * primitives a `LogEntry` carries there. The message is encoded directly when it fits and
 * goes through the bounded renderer when its encoded string would exceed the render cap.
 * The params need the guarded renderer too. A plain `JSON.stringify` over the bag was a
 * second, unguarded serializer beside the one the logger already renders templates with,
 * and it threw on exactly the values that one handles: a `BigInt`, a cycle, a getter that
 * throws. The whole line was then lost and reported as a `'format'` failure, for a bag the
 * message had already rendered fine.
 * `stringifyValue` renders every leaf and never throws - a `BigInt` becomes its digits, a
 * cycle `"[circular]"`, a broken getter `"[unrenderable: value]"` - and its output for a
 * container is JSON, so the line stays one parseable object with a marker where the
 * value was.
 *
 * Rendered one level down, as `{ params: bag }`, rather than as the bag itself.
 * `stringifyValue`'s top level is template text rather than JSON - a bag that cannot be
 * rendered at all, a revoked `Proxy` say, comes back as bare `[object Object]` - while
 * a value *inside* a container it owns is always a JSON fragment or a quoted marker. The
 * wrapper is a fresh plain object, so its render is always `{"params":...}`, and the
 * line is JSON however hostile the bag.
 *
 * `onFormatError` hears the first value that would not render, as the sink's
 * `'format'`/`'fallback'` report: the line was written, with a marker in it.
 */
export function renderJSONLine(
  entry: LogEntry,
  onFormatError: (error: Error) => void,
): string {
  const envelopeBase = JSON.stringify({
    timestamp: entry.timestamp,
    type: entry.type,
    serviceName: entry.serviceName,
    entityName: entry.entityName,
  });
  // Keep the ordinary JSON.stringify behavior (including a hostile runtime value
  // throwing) while bounding the encoded form of a real string. Check the encoded length
  // without first allocating that full encoding: one control-heavy megabyte can otherwise
  // allocate roughly six megabytes merely to discover that it needs truncation. JavaScript
  // callers and custom transformers can still violate LogEntry's string type at runtime.
  // JSON.stringify returns undefined for undefined, functions and symbols; render those
  // through the guarded formatter instead of interpolating the invalid JSON token.
  let renderedMessage: string;

  if (
    typeof entry.message === 'string' &&
    exceedsJSONEncodedStringLength(entry.message, MAX_RENDER_LENGTH)
  ) {
    renderedMessage = stringifyValue(
      { message: entry.message },
      { onFormatError },
    );
  } else {
    const encodedMessage = JSON.stringify(entry.message);

    renderedMessage =
      encodedMessage === undefined
        ? stringifyValue({ message: entry.message }, { onFormatError })
        : `{"message":${encodedMessage}}`;
  }
  const envelope = spliceRenderedObject(
    envelopeBase,
    renderedMessage,
    'message',
  );

  // `redactedParams ?? params`, the rule `LogEntry` states: `redactedParams` is present
  // only when redaction is configured, so reading it alone dropped the whole bag from
  // every line of an unredacted logger - silently, with no `'format'` report and nothing
  // counted as dropped.
  const params = entry.redactedParams ?? entry.params;

  if (params === undefined) {
    return envelope;
  }

  const rendered = stringifyValue(
    { params },
    {
      onFormatError: (error) => {
        onFormatError(error);
      },
    },
  );

  return spliceRenderedParams(envelope, rendered);
}

/** Whether JSON.stringify's string literal would exceed `maxLength`, without building it. */
export function exceedsJSONEncodedStringLength(
  text: string,
  maxLength: number,
): boolean {
  let encodedLength = 2; // Opening and closing quotes.

  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);

    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      encodedLength += 2; // Quote and reverse solidus.
    } else if (codeUnit <= 0x1f) {
      // Backspace, tab, LF, form-feed, and CR use a two-character short escape. The
      // remaining C0 controls use `\u00xx`.
      encodedLength +=
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
          ? 2
          : 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        // A valid surrogate pair is emitted as the original two UTF-16 code units.
        encodedLength += 2;
        index++;
      } else {
        // Well-formed JSON.stringify escapes a lone surrogate as `\udxxx`.
        encodedLength += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      encodedLength += 6;
    } else {
      encodedLength++;
    }

    if (encodedLength > maxLength) {
      return true;
    }
  }

  return encodedLength > maxLength;
}

/**
 * `{"params":...}` onto the end of the envelope: drop the envelope's closing brace and
 * the wrapper's opening one.
 *
 * The splice assumes the wrapper rendered as an object, which it does on every path but
 * one: `stringifyValue`'s own catch - an unexpected throw from inside the walk - answers
 * the bare marker `[unrenderable]`, and spliced in it made `...,unrenderable]`, the one
 * line this module could emit that is not JSON. Anything that does not open as an object
 * is quoted instead, so the marker lands where the params would have and the line still
 * parses. Exported for the test, since no input the walk guards reaches that catch.
 */
export function spliceRenderedParams(
  envelope: string,
  rendered: string,
): string {
  return spliceRenderedObject(envelope, rendered, 'params');
}

function spliceRenderedObject(
  envelope: string,
  rendered: string,
  fallbackKey: string,
): string {
  const params = rendered.startsWith('{')
    ? rendered.slice(1)
    : `${JSON.stringify(fallbackKey)}:${JSON.stringify(rendered)}}`;

  return `${envelope.slice(0, -1)},${params}`;
}
