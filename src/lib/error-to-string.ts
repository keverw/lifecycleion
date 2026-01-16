import type { NestedKeyValueEntry } from './ascii-tables/key-value-ascii-table';
import { KeyValueASCIITable } from './ascii-tables/key-value-ascii-table';

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'object':
      return JSON.stringify(value);
    case 'function':
      return '[Function]';
    case 'symbol':
      return value.toString();
    default:
      // This should never happen, but satisfy the linter
      return String(value as string | number | boolean);
  }
}

export function errorToString(error: unknown, maxRowLength = 80): string {
  const table = errorToASCIITable(error, maxRowLength);

  return table.toString();
}

function errorToASCIITable(
  error: unknown,
  maxRowLength: number,
): KeyValueASCIITable {
  const table = new KeyValueASCIITable({
    tableWidth: maxRowLength,
    autoAdjustWidthWhenPossible: true,
  });

  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    table.addRow('Key', 'Value');

    if (err['message']) {
      table.addRow('Message', safeStringify(err['message']));
    }

    if (err['name']) {
      table.addRow('Name', safeStringify(err['name']));
    }

    if (err['code']) {
      table.addRow('Code', safeStringify(err['code']));
    }

    if (err['errno']) {
      table.addRow('Errno', safeStringify(err['errno']));
    }

    // other conventional that might be used to enhance the error object
    if (err['errPrefix']) {
      table.addRow('Prefix', safeStringify(err['errPrefix']));
    }

    if (err['errType']) {
      table.addRow('errType', safeStringify(err['errType']));
    }

    if (err['errCode']) {
      table.addRow('errCode', safeStringify(err['errCode']));
    }

    if (err['additionalInfo']) {
      const additionalInfo = err['additionalInfo'] as Record<string, unknown>;
      const sensitiveFieldNames =
        (err['sensitiveFieldNames'] as string[]) || [];

      for (const key in additionalInfo) {
        if (sensitiveFieldNames.includes(key)) {
          table.addRow(`AdditionalInfo.${key}`, '***');
        } else {
          const value = additionalInfo[key];

          table.addRow(
            `AdditionalInfo.${key}`,
            stringifyValue(value, table, maxRowLength),
          );
        }
      }
    }

    if (err['stack']) {
      table.addValueOnSeparateRow('Stack', safeStringify(err['stack']));
    }
  }

  return table;
}

function stringifyValue(
  value: unknown,
  table: KeyValueASCIITable,
  maxRowLength: number,
): string | KeyValueASCIITable | NestedKeyValueEntry[] {
  if (typeof value === 'string') {
    return value;
  } else if (Array.isArray(value)) {
    // Handle arrays differently
    return value
      .map((item) => {
        const result = stringifyValue(item, table, maxRowLength);
        // Convert complex types to strings for joining
        if (typeof result === 'string') {
          return result;
        } else if (result instanceof KeyValueASCIITable) {
          return result.toString();
        } else {
          return JSON.stringify(result);
        }
      })
      .join(', ');
  } else if (typeof value === 'object' && value !== null) {
    if (value instanceof Error) {
      return errorToASCIITable(value, maxRowLength - 4);
    } else {
      // Handle objects differently
      const entries: NestedKeyValueEntry[] = Object.entries(value).map(
        ([key, val]) => ({
          key,
          value: stringifyValue(val, table, maxRowLength - 4),
        }),
      );

      return entries;
    }
  } else {
    return String(value);
  }
}
