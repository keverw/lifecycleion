import { KeyValueASCIITable } from './key-value-ascii-table';
import { describe, expect, it } from 'bun:test';
import { MultiColumnASCIITable } from './multi-column-ascii-table';
import { EOL } from '../constants';

describe('KeyValueASCIITable', () => {
  it('should render a table with word wrapping', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 20,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Name', 'John Doe');
    table.addRow('Age', '30');
    table.addValueOnSeparateRow(
      'Description',
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    );
    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with nested tables', () => {
    const nestedTable = new KeyValueASCIITable({
      tableWidth: 20,
      autoAdjustWidthWhenPossible: false,
    });

    nestedTable.addRow('Nested Key 1', 'Nested Value 1');
    nestedTable.addRow('Nested Key 2', 'Nested Value 2');

    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Name', 'John Doe');
    table.addRow('Nested Table', nestedTable);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with nested values', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Nested values', [
      { key: 'Nested Key 1', value: 'Nested Value 1' },
      { key: 'Nested Key 2', value: 'Nested Value 2' },
    ]);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with deeply nested values', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 60,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Deeply Nested', [
      {
        key: 'Level 1',
        value: [
          { key: 'Level 2', value: 'Value 2' },
          {
            key: 'Level 2 Nested',
            value: [
              { key: 'Level 3', value: 'Value 3' },
              { key: 'Level 3 Nested', value: 'XYZ Value 3 Nested' },
            ],
          },
        ],
      },
    ]);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle long keys and values', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow(
      'Very Long Key That Exceeds Max Length',
      'Even Longer Value That Needs To Be Wrapped',
    );

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle empty tables', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle empty tables with a short custom empty message', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
      emptyMessage: 'No data available',
    });

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('renders an empty message with more lines than a spread could pass', () => {
    // The empty-state lines were assembled with a spread, which hands every line to
    // `Array` as an argument; a message with enough lines exceeded the argument limit
    // where the counted loops elsewhere in this module do not.
    const lines = 200_000;
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
      emptyMessage: 'x\n'.repeat(lines - 1) + 'x',
    });

    // Every message line is rendered; the borders around them are the module's business.
    expect(table.toString().split('\n').length).toBeGreaterThanOrEqual(lines);

    const multi = new MultiColumnASCIITable(['A'], {
      tableWidth: 40,
      emptyMessage: 'x\n'.repeat(lines - 1) + 'x',
    });

    expect(multi.toString().split('\n').length).toBeGreaterThanOrEqual(lines);
  });

  it('should handle empty tables with a very long custom empty message', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
      emptyMessage:
        'This is a very long empty message that will be wrapped to multiple lines',
    });

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with a MultiColumnASCIITable as a value that exceeds the table - headers should stay the same but decided to not wrap and break the table', () => {
    // create the multi-column table
    const multiColumnTable = new MultiColumnASCIITable(
      ['Column 1', 'Column 2', 'Column 3'],
      {
        tableWidth: 60,
        widthMode: 'fixed',
      },
    );

    multiColumnTable.addRow(['Value 1', 'Value 2', 'Value 3']);
    multiColumnTable.addRow([
      'Longer Value 1',
      'Longer Value 2',
      'Longer Value 3',
    ]);

    // create the key value table
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Name', 'John Doe');
    table.addRow('Multi-Column Table', multiColumnTable);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with a MultiColumnASCIITable as a value - smaller table', () => {
    // create the multi-column table
    const multiColumnTable = new MultiColumnASCIITable(
      ['Column 1', 'Column 2', 'Column 3'],
      {
        tableWidth: 30,
      },
    );

    multiColumnTable.addRow(['Value 1', 'Value 2', 'Value 3']);
    multiColumnTable.addRow([
      'Longer Value 1',
      'Longer Value 2',
      'Longer Value 3',
    ]);

    // create the key value table
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Name', 'John Doe');
    table.addRow('Multi-Column Table', multiColumnTable);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with a MultiColumnASCIITable as a value - wider table', () => {
    // create the multi-column table
    const multiColumnTable = new MultiColumnASCIITable(
      ['Column 1', 'Column 2', 'Column 3'],
      {
        tableWidth: 40,
      },
    );

    multiColumnTable.addRow(['Value 1', 'Value 2', 'Value 3']);
    multiColumnTable.addRow([
      'Longer Value 1',
      'Longer Value 2',
      'Longer Value 3',
    ]);

    // create the key value table
    const table = new KeyValueASCIITable({
      tableWidth: 80,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Name', 'John Doe');
    table.addRow('Multi-Column Table', multiColumnTable);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should render a table with a nested KeyValueASCIITable that adjusts its width when autoAdjustWidthWhenPossible is true', () => {
    // create the nested key-value table
    const nestedTable = new KeyValueASCIITable({
      tableWidth: 60,
      autoAdjustWidthWhenPossible: false,
    });

    nestedTable.addRow('Nested Key 1', 'Nested Value 1');
    nestedTable.addRow('Nested Key 2', 'Nested Value 2');
    nestedTable.addRow('Nested Key 3', 'Nested Value 3');

    // create the outer key-value table
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Name', 'John Doe');
    table.addRow('Nested Table', nestedTable);

    expect(EOL + table.toString()).toMatchSnapshot();

    expect(
      EOL +
        table.toString({
          autoAdjustWidthWhenPossible: true,
        }),
    ).toMatchSnapshot();
  });

  it('should render a table with a nested MultiColumnASCIITable that adjusts its width when autoAdjustWidthWhenPossible is true', () => {
    // create the nested multi-column table
    const nestedTable = new MultiColumnASCIITable(
      ['Column 1', 'Column 2', 'Column 3'],
      {
        tableWidth: 60,
        widthMode: 'fixed',
      },
    );

    nestedTable.addRow(['Value 1', 'Value 2', 'Value 3']);
    nestedTable.addRow(['Longer Value 1', 'Longer Value 2', 'Longer Value 3']);

    // create the outer key-value table
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Name', 'John Doe');
    table.addRow('Nested Table', nestedTable);

    expect(EOL + table.toString()).toMatchSnapshot();

    expect(
      EOL +
        table.toString({
          autoAdjustWidthWhenPossible: true,
        }),
    ).toMatchSnapshot();
  });

  it('should throw error when the table width is too small', () => {
    expect(() => {
      new KeyValueASCIITable({
        tableWidth: 5,
      });
    }).toThrow(
      'Table width must be at least 9 to accommodate the table structure.',
    );
  });

  it('should handle emojis in the table', () => {
    const table = new KeyValueASCIITable();

    table.addRow('👨‍💻', '🚀');
    table.addRow('Hello 🌍', '👋 👨‍👩‍👧‍👦');
    table.addValueOnSeparateRow('😃', 'Lorem ipsum dolor sit amet 🎉');

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle emojis in nested tables', () => {
    const nestedTable = new KeyValueASCIITable();

    nestedTable.addRow('Nested 🔑 1', 'Nested 🌟 1');
    nestedTable.addRow('Nested 🔑 2', 'Nested 🌟 2');

    const table = new KeyValueASCIITable();

    table.addRow('Name 👤', 'John Doe');
    table.addRow('Nested 📜', nestedTable);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle emojis in the table with a small width', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 20,
    });

    table.addRow('👨‍💻', '🚀');
    table.addRow('Hello 🌍', '👋 👨‍👩‍👧‍👦');
    table.addValueOnSeparateRow('😃', 'Lorem ipsum dolor sit amet 🎉');

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle emojis in nested tables with a small width', () => {
    const nestedTable = new KeyValueASCIITable({
      tableWidth: 15,
    });

    nestedTable.addRow('Nested 🔑 1', 'Nested 🌟 1');
    nestedTable.addRow('Nested 🔑 2', 'Nested 🌟 2');

    const table = new KeyValueASCIITable({
      tableWidth: 20,
    });

    table.addRow('Name 👤', 'John Doe');
    table.addRow('Nested 📜', nestedTable);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle number values', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 30,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Integer', 42);
    table.addRow('Float', 3.14159);
    table.addRow('Negative', -10);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle boolean values', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 30,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('True Value', true);
    table.addRow('False Value', false);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should handle null and undefined values', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 40,
      autoAdjustWidthWhenPossible: false,
    });

    table.addRow('Null Value', null);

    table.addRow('Undefined Value', undefined);

    expect(EOL + table.toString()).toMatchSnapshot();
  });

  it('should throw an error for unsupported types', () => {
    const table = new KeyValueASCIITable({
      tableWidth: 30,
      autoAdjustWidthWhenPossible: false,
    });

    // @ts-expect-error: For testing purposes
    table.addRow('Unsupported', { key: 'value' } as unknown);

    expect(() => {
      table.toString();
    }).toThrow('Invalid value type provided');
  });
});
