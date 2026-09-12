import { isString } from '../strings';
import { padRight } from '../padding-utils';
import { MultiColumnASCIITable } from './multi-column-ascii-table';
import { ASCIITableUtils } from './ascii-table-utils';
import stringWidth from 'string-width';
import { clamp } from '../clamp';

/**
 * Width of the widest line in a multi-line value.
 *
 * A counted loop, not `Math.max(...value.split('\n').map(stringWidth))`, for the reason
 * the nested-value renderer below no longer spreads either: spreading passes one argument
 * per line, and an engine's argument limit is a hard cliff well below any sane output size
 * - roughly 125,000 on Node. A value with more lines than that raised
 * `Maximum call stack size exceeded` from inside width calculation, which
 * `errorToString`'s backstop turned into `<error could not be rendered>`, throwing away
 * the error's message, name and stack because one of its values had many lines. A
 * quarter-megabyte of newline-separated text sits well inside the renderer's own length
 * budget, so nothing above here bounded it.
 */
function widestLineWidth(value: string): number {
  const lines = value.split('\n');

  let widest = 0;

  for (const line of lines) {
    const width = stringWidth(line);

    if (width > widest) {
      widest = width;
    }
  }

  return widest;
}

export type TableRowValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | KeyValueASCIITable
  | MultiColumnASCIITable
  | NestedKeyValueEntry[];

type TableRow = TableRowRegular | TableRowOwn;

interface TableRowRegular {
  kind: 'regular';
  key: string;
  value: TableRowValue;
}

interface TableRowOwn {
  kind: 'own';
  key: string;
  value: string | NestedKeyValueEntry[];
}

export interface NestedKeyValueEntry {
  key: string;
  value: string | KeyValueASCIITable | NestedKeyValueEntry[];
}

interface KeyValueASCIITableOptions {
  tableWidth?: number;
  autoAdjustWidthWhenPossible?: boolean;
  emptyMessage?: string;
}

/**
 * The narrowest table that can still be drawn:
 *
 * - 2 characters for the `'| '` at the start
 * - 1 character for the minimum key column width
 * - 3 characters for the `' | '` separating the key and value columns
 * - 1 character for the minimum value column width
 * - 2 characters for the `' |'` at the end
 *
 * Exported because a caller that narrows the width as it nests has to clamp against it:
 * the constructor throws below this, and a renderer that kept subtracting turned a deeply
 * nested payload into a thrown error rather than a narrow table.
 */
export const KEY_VALUE_TABLE_MIN_WIDTH = 9;

export class KeyValueASCIITable {
  public readonly tableWidth: number;
  private emptyMessage: string;
  private autoAdjustWidthWhenPossible: boolean = true;

  private rows: TableRow[] = [];

  constructor(options: KeyValueASCIITableOptions = {}) {
    const minTableWidth = this.getMinimumWidth();

    if (options.tableWidth && options.tableWidth < minTableWidth) {
      throw new Error(
        `Table width must be at least ${minTableWidth} to accommodate the table structure.`,
      );
    }

    this.tableWidth = options.tableWidth || 80;
    this.autoAdjustWidthWhenPossible =
      options.autoAdjustWidthWhenPossible ?? true;
    this.emptyMessage = options.emptyMessage || '';
  }

  public getMinimumWidth(): number {
    return KEY_VALUE_TABLE_MIN_WIDTH;
  }

  /**
   * Adds key and value to the table but placing the value on its own row.
   *
   * @param key
   * @param value
   */

  public addValueOnSeparateRow(key: string, value: string): void {
    const row: TableRow = { kind: 'own', key, value };

    this.rows.push(row);
  }

  /**
   * Adds key and value to the table.
   *
   * If provided value is an instance of ASCIITable or MultiColumnASCIITable, it will be rendered as a nested table on its own row for readability.
   *
   * @param key
   * @param value
   */

  public addRow(key: string, value: TableRowValue): void {
    const row: TableRow = { kind: 'regular', key, value };

    this.rows.push(row);
  }

  public toString(options: KeyValueASCIITableOptions = {}): string {
    const tableWidth = options.tableWidth || this.tableWidth;
    const canAutoAdjustWidthWhenPossible =
      options.autoAdjustWidthWhenPossible ?? this.autoAdjustWidthWhenPossible;

    const emptyMessage = options.emptyMessage || this.emptyMessage;

    if (this.rows.length === 0) {
      const emptyTableWidth = Math.min(tableWidth, 40);

      // `padEnd` rather than `repeat`, as the message padding below already does: both
      // counts come from a caller-supplied `tableWidth`, and a negative one throws a
      // `RangeError` out of a renderer that is only ever reached to describe something
      // else.
      const separator = '+' + padRight('', emptyTableWidth - 2, '-') + '+';
      const emptyMessageLines = ASCIITableUtils.wrapText(
        emptyMessage,
        emptyTableWidth - 4,
      );

      const emptyRows = emptyMessageLines.map((line) => {
        const paddingLeft = padRight(
          '',
          Math.floor((emptyTableWidth - stringWidth(line) - 4) / 2),
          ' ',
        );

        const paddingRight = padRight(
          '',
          Math.ceil((emptyTableWidth - stringWidth(line) - 4) / 2),
          ' ',
        );

        return `| ${paddingLeft}${line}${paddingRight} |`;
      });

      if (emptyRows.length === 0) {
        emptyRows.push(`| ${padRight('', emptyTableWidth - 4)} |`);
      }

      return [separator, ...emptyRows, separator].join('\n');
    }

    const columnWidths = this.calculateColumnWidths(options);

    const headerSeparator = ASCIITableUtils.createSeparator(columnWidths);
    const rowSeparator = ASCIITableUtils.createSeparator(columnWidths, '-');

    let tableString = headerSeparator + '\n';

    for (const [rowIndex, row] of this.rows.entries()) {
      const { kind, key, value } = row;

      if (
        kind === 'own' ||
        value instanceof KeyValueASCIITable ||
        value instanceof MultiColumnASCIITable ||
        Array.isArray(value)
      ) {
        const keyString = ASCIITableUtils.centerText(
          key,
          columnWidths[0] + columnWidths[1] + 3,
        );

        tableString += `| ${keyString} |\n`;
        tableString += rowSeparator + '\n';

        let valueString = '';

        if (value instanceof KeyValueASCIITable) {
          valueString = this.formatValue(
            value,
            tableWidth - 4,
            canAutoAdjustWidthWhenPossible,
            '',
          );
        } else if (value instanceof MultiColumnASCIITable) {
          valueString = this.formatValue(
            value,
            tableWidth - 4,
            canAutoAdjustWidthWhenPossible,
            '',
          );
        } else if (Array.isArray(value)) {
          valueString = this.formatValue(
            value,
            tableWidth - 4,
            canAutoAdjustWidthWhenPossible,
            '',
          );
        } else if (row.kind === 'own') {
          valueString = this.formatTableRowOnOwnRow(
            value as string,
            tableWidth - 4,
            tableWidth,
          );
        }

        const valueLines = valueString.split('\n');
        const paddedValueLines = valueLines.map((line) => {
          const padding = padRight('', tableWidth - stringWidth(line) - 4, ' ');

          return `| ${line}${padding} |`;
        });

        tableString += paddedValueLines.join('\n') + '\n';
        tableString += headerSeparator + '\n';
      } else {
        const keyLines = ASCIITableUtils.wrapText(key, columnWidths[0]);

        const valueLines = ASCIITableUtils.wrapText(
          this.formatValue(
            value,
            columnWidths[1],
            canAutoAdjustWidthWhenPossible,
            '',
          ),
          columnWidths[1],
        );

        const maxLines = Math.max(keyLines.length, valueLines.length);

        for (let i = 0; i < maxLines; i++) {
          const keyLine = keyLines[i] || '';
          const valueLine = valueLines[i] || '';

          // `padRight`, not `' '.repeat()`, because the count can go negative: a line
          // wider than its own column is not impossible here. `splitWord` splits by
          // grapheme, so a column one cell wide cannot hold a two-column grapheme - a CJK
          // character or an emoji - at all, and the chunk it emits overhangs by one.
          // `repeat(-1)` throws a `RangeError`, which `errorToString`'s backstop turns
          // into `<error could not be rendered>`: message, name and stack all thrown away
          // because one value held a wide character. `padEnd` clamps instead, so the row
          // is one cell wide of its border rather than absent.
          const keyPadding = padRight(
            '',
            columnWidths[0] - stringWidth(keyLine),
          );

          const valuePadding = padRight(
            '',
            columnWidths[1] - stringWidth(valueLine),
          );

          tableString += `| ${keyLine}${keyPadding} | ${valueLine}${valuePadding} |\n`;

          if (i === maxLines - 1) {
            if (rowIndex === this.rows.length - 1) {
              tableString += headerSeparator + '\n';
            } else {
              tableString += rowSeparator + '\n';
            }
          }
        }
      }
    }

    return tableString.trim();
  }

  private calculateColumnWidths(
    options: KeyValueASCIITableOptions = {},
  ): number[] {
    const tableWidth = options.tableWidth || this.tableWidth;
    const canAutoAdjustWidthWhenPossible =
      options.autoAdjustWidthWhenPossible ?? this.autoAdjustWidthWhenPossible;

    const columnWidths: number[] = [0, 0];

    for (const row of this.rows) {
      const { key, value } = row;

      const keyWidth = stringWidth(key);
      const maxKeyWidth = Math.floor((tableWidth - 7) / 2);

      if (keyWidth > columnWidths[0]) {
        columnWidths[0] = Math.min(keyWidth, maxKeyWidth);
        columnWidths[1] = Math.max(0, tableWidth - columnWidths[0] - 7);
      }

      if (typeof value === 'string') {
        const valueWidth = widestLineWidth(value);

        if (valueWidth > columnWidths[1]) {
          columnWidths[1] = Math.min(
            valueWidth,
            tableWidth - columnWidths[0] - 7,
          );

          columnWidths[0] = Math.max(0, tableWidth - columnWidths[1] - 7);
        }
      } else if (row.kind === 'own') {
        let valueWidth = 0;

        if (isString(value)) {
          valueWidth = widestLineWidth(value);
        }

        if (valueWidth > columnWidths[1]) {
          columnWidths[1] = Math.min(
            valueWidth,
            tableWidth - columnWidths[0] - 7,
          );

          columnWidths[0] = Math.max(0, tableWidth - columnWidths[1] - 7);
        }
      } else if (value instanceof KeyValueASCIITable) {
        // Update column widths based on the nested table
        let nestedTableColumnWidths: number[] = [];

        if (canAutoAdjustWidthWhenPossible) {
          const minWidth = value.getMinimumWidth();

          const availableWidth = tableWidth - columnWidths[0] - 7;
          const adjustedWidth = clamp(availableWidth, minWidth, availableWidth);

          nestedTableColumnWidths = value.calculateColumnWidths({
            tableWidth: adjustedWidth,
          });
        } else {
          nestedTableColumnWidths = value.calculateColumnWidths();
        }

        const nestedTableWidth =
          nestedTableColumnWidths.reduce((sum, width) => sum + width, 0) +
          nestedTableColumnWidths.length * 3 -
          1;

        const availableWidth = tableWidth - columnWidths[0] - 7;

        if (nestedTableWidth > availableWidth) {
          columnWidths[1] = availableWidth;
        } else {
          columnWidths[1] = Math.max(columnWidths[1], nestedTableWidth);
        }
      } else if (value instanceof MultiColumnASCIITable) {
        // Update column widths based on the nested multi-column table
        let nestedTableColumnWidths: number[] = [];

        if (canAutoAdjustWidthWhenPossible) {
          const minWidth = value.getMinimumWidth();

          const availableWidth = tableWidth - columnWidths[0] - 7;
          const adjustedWidth = clamp(availableWidth, minWidth, availableWidth);

          nestedTableColumnWidths = value.calculateColumnWidths({
            tableWidth: adjustedWidth,
          });
        } else {
          nestedTableColumnWidths = value.calculateColumnWidths();
        }

        const nestedTableWidth =
          nestedTableColumnWidths.reduce((sum, width) => sum + width, 0) +
          nestedTableColumnWidths.length * 3 -
          1;

        const availableWidth = tableWidth - columnWidths[0] - 7;

        if (nestedTableWidth > availableWidth) {
          columnWidths[1] = availableWidth;
        } else {
          columnWidths[1] = Math.max(columnWidths[1], nestedTableWidth);
        }
      } else if (Array.isArray(value)) {
        for (const nestedCell of value) {
          const nestedKeyWidth = stringWidth(nestedCell.key);
          const maxNestedKeyWidth = Math.floor((tableWidth - 7) / 2);

          if (nestedKeyWidth > columnWidths[0]) {
            columnWidths[0] = Math.min(nestedKeyWidth, maxNestedKeyWidth);
            columnWidths[1] = Math.max(0, tableWidth - columnWidths[0] - 7);
          }

          if (typeof nestedCell.value === 'string') {
            const nestedValueWidth = widestLineWidth(nestedCell.value);

            if (nestedValueWidth > columnWidths[1]) {
              columnWidths[1] = Math.min(
                nestedValueWidth,
                tableWidth - columnWidths[0] - 7,
              );
              columnWidths[0] = Math.max(0, tableWidth - columnWidths[1] - 7);
            }
          }
        }
      }
    }

    return columnWidths;
  }

  private formatValue(
    value:
      | string
      | number
      | boolean
      | null
      | undefined
      | KeyValueASCIITable
      | MultiColumnASCIITable
      | NestedKeyValueEntry[],
    cellWidth: number,
    canAutoAdjustWidthWhenPossible: boolean,
    indent = '',
  ): string {
    if (typeof value === 'string') {
      return value;
    } else if (typeof value === 'number') {
      return String(value);
    } else if (typeof value === 'boolean') {
      return String(value);
    } else if (value === null) {
      return 'null';
    } else if (value === undefined) {
      return 'undefined';
    } else if (value instanceof KeyValueASCIITable) {
      let nestedTableLines: string[];

      if (canAutoAdjustWidthWhenPossible) {
        const minWidth = value.getMinimumWidth();

        const adjustedWidth = clamp(cellWidth, minWidth, cellWidth);

        nestedTableLines = value
          .toString({ tableWidth: adjustedWidth })
          .split('\n');
      } else {
        nestedTableLines = value.toString().split('\n');
      }

      const indentedLines = nestedTableLines.map((line) => `${indent}${line}`);

      return indentedLines.join('\n');
    } else if (value instanceof MultiColumnASCIITable) {
      let nestedTableLines: string[];

      if (canAutoAdjustWidthWhenPossible) {
        const minWidth = value.getMinimumWidth();

        const adjustedWidth = clamp(cellWidth, minWidth, cellWidth);
        nestedTableLines = value
          .toString({ tableWidth: adjustedWidth })
          .split('\n');
      } else {
        nestedTableLines = value.toString().split('\n');
      }

      const indentedLines = nestedTableLines.map((line) => `${indent}${line}`);

      return indentedLines.join('\n');
    } else if (Array.isArray(value)) {
      const nestedValueLines: string[] = [];

      for (const { key, value: nestedValue } of value) {
        const formattedKey = `${indent}${key}:`;
        const formattedValue = this.formatValue(
          nestedValue,
          cellWidth - indent.length - stringWidth(key) - 2,
          canAutoAdjustWidthWhenPossible,
          `${indent}`,
        );

        const wrappedSpacer = padRight('', 4, ' ');

        const wrappedValue = formattedValue
          .split('\n')
          .map((line) => `${indent}${wrappedSpacer}${line}`);

        nestedValueLines.push(formattedKey);

        // A loop, not `push(...wrappedValue)`: spreading passes one argument per line, and
        // an engine's argument limit is a hard cliff well below any sane output size. A
        // large nested value therefore raised `Maximum call stack size exceeded` from
        // inside the renderer, which `errorToString`'s backstop turned into
        // `<error could not be rendered>` - throwing away the error's message, name and
        // stack because its payload was big rather than because anything was wrong.
        for (const line of wrappedValue) {
          nestedValueLines.push(line);
        }
        nestedValueLines.push('');
      }

      return nestedValueLines.slice(0, -1).join('\n');
    } else {
      throw new TypeError('Invalid value type provided');
    }
  }

  private formatTableRowOnOwnRow(
    value: string,
    width: number,
    maxRowLength: number,
  ): string {
    const lines = value.split('\n');

    const paddedLines = lines.map((line) => {
      const wrappedLines = ASCIITableUtils.wrapText(line, maxRowLength - 4);

      return wrappedLines
        .map((wrappedLine) => {
          const padding = padRight(
            '',
            width - stringWidth(wrappedLine) - 2,
            ' ',
          );

          return `${wrappedLine}${padding}`;
        })
        .join('\n');
    });

    return paddedLines.join('\n');
  }
}
