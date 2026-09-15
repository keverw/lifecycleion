import { stringifyValue } from '../../../stringify-value';
import type { LogEntry } from '../../types';

/**
 * One log entry as one line of JSON, for the `jsonFormat` of `FileSink` and
 * `NamedPipeSink`.
 *
 * The envelope - timestamp, type, names, message - goes through `JSON.stringify`, which
 * cannot fail on the primitives a `LogEntry` carries there. The params do not. A plain
 * `JSON.stringify` over the bag was a second, unguarded serializer beside the one the
 * logger already renders templates with, and it threw on exactly the values that one
 * handles: a `BigInt`, a cycle, a getter that throws. The whole line was then lost and
 * reported as a `'format'` failure, for a bag the message had already rendered fine.
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
  const envelope = JSON.stringify({
    timestamp: entry.timestamp,
    type: entry.type,
    serviceName: entry.serviceName,
    entityName: entry.entityName,
    message: entry.message,
  });

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
  const params = rendered.startsWith('{')
    ? rendered.slice(1)
    : `"params":${JSON.stringify(rendered)}}`;

  return `${envelope.slice(0, -1)},${params}`;
}
