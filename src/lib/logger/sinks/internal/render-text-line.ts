import type { LogEntry } from '../../types';

/**
 * Keep one text-mode log entry on one physical line.
 *
 * JSON-mode sinks escape these characters through JSON string encoding. Text-mode sinks
 * need the equivalent boundary explicitly so untrusted message text cannot mint a second
 * record. Tabs and other non-line-breaking controls are preserved as message content.
 */
export function renderTextLine(message: string): string {
  return message.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/**
 * The text-mode line both queueing sinks write, without its trailing newline:
 * `[type] [service] [entity] message`, with no prefix for a `raw` entry. The service and
 * entity names are caller-supplied too, so they get the same line-break boundary.
 */
export function renderTextEntry(entry: LogEntry): string {
  let text = '';

  if (entry.type !== 'raw') {
    text = `[${entry.type}] `;

    if (entry.serviceName) {
      text += `[${renderTextLine(entry.serviceName)}] `;
    }

    if (entry.entityName) {
      text += `[${renderTextLine(entry.entityName)}] `;
    }
  }

  return text + renderTextLine(entry.message);
}
