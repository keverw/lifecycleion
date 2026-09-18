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
