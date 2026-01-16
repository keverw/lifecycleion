import { ASCIITableUtils } from './ascii-table-utils';
import stringWidth from 'string-width';

interface MultiColumnASCIITableOptions {
  tableWidth?: number;
  emptyMessage?: string;
  widthMode?: 'flex' | 'fixed';
}

export class MultiColumnASCIITable {
  private headers: string[];
  private rows: string[][];
  private tableWidth: number;
  private emptyMessage: string;
  private widthMode: 'flex' | 'fixed';

  constructor(headers: string[], options: MultiColumnASCIITableOptions = {}) {
    this.headers = headers;
    this.rows = [];
    this.tableWidth = options.tableWidth || 80;
    this.emptyMessage = options.emptyMessage || '';
    this.widthMode = options.widthMode || 'flex';

    const minTableWidth = this.getMinimumWidth();

    if (this.tableWidth < minTableWidth) {
      throw new Error(
        `Table width must be at least ${minTableWidth} to accommodate the headers.`,
      );
    }
  }

  public getMinimumWidth(): number {
    return this.headers.length * 4 + 1;
  }

  public addRow(row: string[]): void {
    if (row.length !== this.headers.length) {
      throw new Error(
        `Number of values in the row (${row.length}) must match the number of headers (${this.headers.length}).`,
      );
    }

    this.rows.push(row);
  }

  public toString(options: MultiColumnASCIITableOptions = {}): string {
    const tableWidth = options.tableWidth || this.tableWidth;
    const emptyMessage = options.emptyMessage || this.emptyMessage;

    if (this.rows.length === 0) {
      const emptyTableWidth = Math.min(tableWidth, 40);

      const separator = '+' + '-'.repeat(emptyTableWidth - 2) + '+';
      const emptyMessageLines = ASCIITableUtils.wrapText(
        emptyMessage,
        emptyTableWidth - 4,
      );

      const emptyRows = emptyMessageLines.map((line) => {
        const paddingLeft = ' '.repeat(
          Math.floor((emptyTableWidth - stringWidth(line) - 4) / 2),
        );

        const paddingRight = ' '.repeat(
          Math.ceil((emptyTableWidth - stringWidth(line) - 4) / 2),
        );

        return `| ${paddingLeft}${line}${paddingRight} |`;
      });

      if (emptyRows.length === 0) {
        emptyRows.push(`| ${' '.repeat(emptyTableWidth - 4)} |`);
      }

      return [separator, ...emptyRows, separator].join('\n');
    }

    const columnWidths = this.calculateColumnWidths(options);

    const headerSeparator = ASCIITableUtils.createSeparator(columnWidths);
    const rowSeparator = ASCIITableUtils.createSeparator(columnWidths, '-');
    let tableString = headerSeparator + '\n';

    const header = this.renderRow(this.headers, columnWidths);
    tableString += header + '\n' + rowSeparator + '\n';

    const rows = this.rows.map((row) => {
      return this.renderRow(row, columnWidths);
    });

    tableString += rows.join('\n' + rowSeparator + '\n');
    tableString += '\n' + headerSeparator;

    return tableString;
  }

  public calculateColumnWidths(
    options: MultiColumnASCIITableOptions = {},
  ): number[] {
    const tableWidth = options.tableWidth || this.tableWidth;
    const widthMode = options.widthMode || this.widthMode;

    const numColumns = this.headers.length;

    if (widthMode === 'fixed') {
      const availableWidth = tableWidth - (numColumns + 1) * 3 + 1;
      const columnWidth = Math.floor(availableWidth / numColumns);
      const extraWidth = availableWidth % numColumns;
      const columnWidths = new Array(numColumns).fill(columnWidth);

      // if there is any remaining width (extraWidth), we distribute it evenly among the columns starting from the first column.
      for (let i = 0; i < extraWidth; i++) {
        columnWidths[i] += 1;
      }

      return columnWidths as number[];
    }

    const availableWidth = tableWidth - (numColumns + 1) * 3 + 1;
    const maxColumnWidth = Math.floor(availableWidth / numColumns);
    const totalContentWidth = this.headers.reduce(
      (sum, header) => sum + stringWidth(header),
      0,
    );

    if (availableWidth >= totalContentWidth) {
      const remainingWidth = availableWidth - totalContentWidth;
      const extraCharWidth = Math.floor(remainingWidth / numColumns);
      const extraCharRemainder = remainingWidth % numColumns;

      const columnWidths = this.headers.map((header, index) => {
        const extraWidth = index < extraCharRemainder ? 1 : 0;
        return stringWidth(header) + extraCharWidth + extraWidth;
      });

      return columnWidths;
    } else {
      const columnWidths = this.headers.map(() => maxColumnWidth);

      return columnWidths;
    }
  }

  private renderRow(row: string[], columnWidths: number[]): string {
    const wrappedCells = row.map((value, index) => {
      const wrappedLines = ASCIITableUtils.wrapText(value, columnWidths[index]);

      return wrappedLines
        .map((line) => line.padEnd(columnWidths[index]))
        .join('\n');
    });

    const maxLines = Math.max(
      ...wrappedCells.map((cell) => cell.split('\n').length),
    );

    const paddedRows = [];

    for (let i = 0; i < maxLines; i++) {
      const rowLine = wrappedCells.map((cell, index) => {
        const cellLines = cell.split('\n');
        const cellLine = cellLines[i] || '';
        const padding = ' '.repeat(columnWidths[index] - stringWidth(cellLine));

        return ' ' + cellLine + padding + ' ';
      });

      paddedRows.push('|' + rowLine.join('|') + '|');
    }

    return paddedRows.join('\n');
  }
}
