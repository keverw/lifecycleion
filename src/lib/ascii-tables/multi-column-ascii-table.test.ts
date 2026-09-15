import { describe, expect, it } from 'bun:test';
import { EOL } from '../constants';
import { MultiColumnASCIITable } from './multi-column-ascii-table';

describe('MultiColumnASCIITable', () => {
  it('should render a table with multiple columns - flex default', () => {
    const table = new MultiColumnASCIITable([
      'Column 1',
      'Column 2',
      'Column 3',
    ]);

    table.addRow(['Value 1', 'Value 2', 'Value 3']);
    table.addRow(['Longer Value 1', 'Longer Value 2', 'Longer Value 3']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with multiple columns - fixed option', () => {
    const table = new MultiColumnASCIITable(
      ['Column 1', 'Column 2', 'Column 3'],
      {
        tableWidth: 60,
        widthMode: 'fixed',
      },
    );

    table.addRow(['Value 1', 'Value 2', 'Value 3']);
    table.addRow(['Longer Value 1', 'Longer Value 2', 'Longer Value 3']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should throw an error when adding a row with mismatched number of values', () => {
    const table = new MultiColumnASCIITable(['Column 1', 'Column 2']);

    expect(() => {
      table.addRow(['Value 1']);
    }).toThrow(
      'Number of values in the row (1) must match the number of headers (2).',
    );
  });

  it('should handle empty tables', () => {
    const table = new MultiColumnASCIITable(['Column 1', 'Column 2']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle empty tables with a short custom empty message', () => {
    const table = new MultiColumnASCIITable(['Column 1', 'Column 2'], {
      tableWidth: 40,
      emptyMessage: 'No data available',
    });

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle empty tables with a very long custom empty message', () => {
    const table = new MultiColumnASCIITable(['Column 1', 'Column 2'], {
      tableWidth: 40,
      emptyMessage:
        'This is a very long empty message that will be wrapped to multiple lines',
    });

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle long cell values with wrapping', () => {
    const table = new MultiColumnASCIITable(['Column 1', 'Column 2'], {
      tableWidth: 30,
    });
    table.addRow(['Short Value', 'A very long value that needs to be wrapped']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle long header values with wrapping', () => {
    const table = new MultiColumnASCIITable(
      ['Column 1', 'A very long header that needs to be wrapped'],
      {
        tableWidth: 50,
      },
    );

    table.addRow(['Short Value', 'Short Value']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with a very small table width should split even words', () => {
    const table = new MultiColumnASCIITable(
      ['Column 1', 'Column 2', 'Column 3'],
      {
        tableWidth: 20,
      },
    );

    table.addRow(['Value 1', 'Value 2', 'Value 3']);
    table.addRow(['Longer Value 1', 'Longer Value 2', 'Longer Value 3']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should throw error when the table width is too small', () => {
    expect(() => {
      new MultiColumnASCIITable(['Column 1', 'Column 2', 'Column 3'], {
        tableWidth: 10,
      });
    }).toThrow('Table width must be at least 13 to accommodate the headers.');
  });

  it('should throw error when adding a row with mismatched number of values', () => {
    const table = new MultiColumnASCIITable(['Column 1', 'Column 2']);

    expect(() => {
      table.addRow(['Value 1', 'Value 2', 'Value 3']);
    }).toThrow(
      'Number of values in the row (3) must match the number of headers (2).',
    );
  });

  it('should handle emojis in the table', () => {
    const table = new MultiColumnASCIITable([
      'Column 1',
      'Column 2',
      'Column 3',
    ]);

    table.addRow(['👨‍💻', '🚀', '🌍']);
    table.addRow(['Hello 🌍', '👋 👨‍👩‍👧‍👦', '😃']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle emojis in the table with a small width', () => {
    const table = new MultiColumnASCIITable(
      ['Column 1', 'Column 2', 'Column 3'],
      {
        tableWidth: 20,
      },
    );

    table.addRow(['👨‍💻', '🚀', '🌍']);
    table.addRow(['Hello 🌍', '👋 👨‍👩‍👧‍👦', '😃']);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('renders an empty table narrower than its message without throwing', () => {
    // The empty-table path still padded with `repeat()`, so a width the message overhangs
    // - one wide grapheme is enough - raised `RangeError: repeat argument must be greater
    // than or equal to 0` out of a renderer whose caller turns any throw into
    // `<error could not be rendered>`, losing everything it was describing.
    const table = new MultiColumnASCIITable(['a'], {
      tableWidth: 5,
      emptyMessage: '漢字',
    });

    expect(() => table.toString()).not.toThrow();
    // Wrapped rather than dropped: each grapheme is wider than the column allows.
    expect(table.toString()).toContain('漢');
    expect(table.toString()).toContain('字');
  });

  it('should distribute remaining width across columns in flex mode', () => {
    const table = new MultiColumnASCIITable(['A', 'B', 'C', 'D'], {
      tableWidth: 20,
    });

    const columnWidths = table.calculateColumnWidths();

    expect(columnWidths).toEqual([2, 2, 1, 1]);
  });
});
