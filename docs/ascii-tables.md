# ascii-tables

Render key-value and multi-column ASCII tables with automatic word wrapping, nested table support, and emoji-safe column width calculations.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [KeyValueASCIITable](#keyvalueasciitable)
    - [Constructor Options](#constructor-options)
    - [tableWidth](#tablewidth)
    - [getMinimumWidth](#getminimumwidth)
    - [addRow](#addrow)
    - [addValueOnSeparateRow](#addvalueonseparaterow)
    - [toString](#tostring)
  - [MultiColumnASCIITable](#multicolumnasciitable)
    - [Constructor](#constructor)
    - [getMinimumWidth](#getminimumwidth-1)
    - [addRow](#addrow-1)
    - [calculateColumnWidths](#calculatecolumnwidths)
    - [toString](#tostring-1)
  - [ASCIITableUtils](#asciitableutils)
    - [centerText](#centertext)
    - [createSeparator](#createseparator)
    - [wrapText](#wraptext)
    - [splitWord](#splitword)
- [Types](#types)
  - [TableRowValue](#tablerowvalue)
  - [NestedKeyValueEntry](#nestedkeyvalueentry)

<!-- tocstop -->

## Usage

```typescript
import {
  KeyValueASCIITable,
  MultiColumnASCIITable,
  ASCIITableUtils,
} from 'lifecycleion/ascii-tables';
```

## API

### KeyValueASCIITable

A two-column table that displays key-value pairs with automatic word wrapping and support for nested tables.

#### Constructor Options

```typescript
const table = new KeyValueASCIITable({
  tableWidth: 80, // Total character width (default: 80, minimum: 9)
  autoAdjustWidthWhenPossible: true, // Auto-adjust nested table widths (default: true)
  emptyMessage: 'No data', // Message shown when table has no rows
});
```

#### tableWidth

Public readonly property exposing the configured table width.

```typescript
const table = new KeyValueASCIITable({ tableWidth: 60 });
table.tableWidth; // 60
```

#### getMinimumWidth

Returns the minimum allowed `tableWidth` (always `9`).

```typescript
new KeyValueASCIITable().getMinimumWidth(); // 9
```

#### addRow

Adds a key-value pair to the table. Values can be strings, numbers, booleans, `null`, `undefined`, nested `KeyValueASCIITable` or `MultiColumnASCIITable` instances, or `NestedKeyValueEntry[]` arrays.

```typescript
const table = new KeyValueASCIITable({ tableWidth: 40 });

table.addRow('Name', 'John Doe');
table.addRow('Age', 30);
table.addRow('Active', true);
table.addRow('Notes', null);

console.log(table.toString());
// +======================================+
// | Name   | John Doe                    |
// +--------------------------------------+
// | Age    | 30                          |
// +--------------------------------------+
// | Active | true                        |
// +--------------------------------------+
// | Notes  | null                        |
// +======================================+
```

#### addValueOnSeparateRow

Adds a key with its value displayed on its own row beneath the centered key header — useful for longer text content.

```typescript
const table = new KeyValueASCIITable({ tableWidth: 30 });

table.addValueOnSeparateRow(
  'Description',
  'A longer value that gets its own row.',
);

console.log(table.toString());
```

#### toString

Renders the table to a string. You can pass options to override the constructor defaults for a single render.

```typescript
table.toString(); // uses constructor defaults
table.toString({ tableWidth: 60 }); // override width for this render
table.toString({ autoAdjustWidthWhenPossible: false });
```

**Nested tables example:**

```typescript
const nested = new KeyValueASCIITable({ tableWidth: 30 });
nested.addRow('Sub Key', 'Sub Value');

const table = new KeyValueASCIITable({ tableWidth: 50 });
table.addRow('Name', 'John Doe');
table.addRow('Details', nested);

console.log(table.toString());
```

**Nested key-value entries example:**

```typescript
const table = new KeyValueASCIITable({ tableWidth: 40 });

table.addRow('Config', [
  { key: 'Host', value: 'localhost' },
  { key: 'Port', value: '3000' },
]);

console.log(table.toString());
```

### MultiColumnASCIITable

A table with a fixed set of named columns, automatic word wrapping, and support for both `flex` and `fixed` width modes.

#### Constructor

```typescript
const table = new MultiColumnASCIITable(
  ['Name', 'Role', 'Status'], // header names
  {
    tableWidth: 60, // Total character width (default: 80)
    emptyMessage: 'No records', // Message shown when table has no rows
    widthMode: 'flex', // 'flex' (default) or 'fixed'
  },
);
```

- **`flex`** mode distributes extra width proportionally based on header lengths.
- **`fixed`** mode divides available width equally across all columns.

#### getMinimumWidth

Returns the minimum allowed `tableWidth` based on the number of headers (`headers.length * 4 + 1`).

```typescript
new MultiColumnASCIITable(['A', 'B', 'C']).getMinimumWidth(); // 13
```

#### addRow

Adds a row of values. The number of values must match the number of headers.

```typescript
const table = new MultiColumnASCIITable(['Name', 'Role', 'Status']);

table.addRow(['Alice', 'Engineer', 'Active']);
table.addRow(['Bob', 'Designer', 'On Leave']);

console.log(table.toString());
// +============================================================================+
// | Name   | Role       | Status                                               |
// +----------------------------------------------------------------------------+
// | Alice  | Engineer   | Active                                               |
// +----------------------------------------------------------------------------+
// | Bob    | Designer   | On Leave                                             |
// +============================================================================+
```

#### calculateColumnWidths

Returns the computed column width array for the current headers and options. Useful for advanced layout scenarios.

```typescript
const table = new MultiColumnASCIITable(['Name', 'Status'], { tableWidth: 30 });
table.calculateColumnWidths(); // e.g. [10, 12]
```

#### toString

Renders the table to a string. Options can override constructor defaults for a single render.

```typescript
table.toString(); // uses constructor defaults
table.toString({ tableWidth: 40 }); // override width
table.toString({ widthMode: 'fixed' }); // override width mode
```

### ASCIITableUtils

Static utility methods used internally by both table classes, also available for direct use.

#### centerText

Centers text within a given width using space padding.

```typescript
ASCIITableUtils.centerText('hello', 11); // '   hello   '
```

#### createSeparator

Creates a horizontal separator line for the given column widths.

```typescript
ASCIITableUtils.createSeparator([10, 20]); // '+================================+'
ASCIITableUtils.createSeparator([10, 20], '-'); // '+--------------------------------+'
```

#### wrapText

Wraps text to fit within a maximum line length, splitting on spaces.

```typescript
ASCIITableUtils.wrapText('hello world foo bar', 10);
// ['hello', 'world foo', 'bar']
```

#### splitWord

Splits a single word into chunks that fit within a maximum length. Handles multi-byte characters and emoji correctly.

```typescript
ASCIITableUtils.splitWord('abcdefghij', 4);
// ['abcd', 'efgh', 'ij']
```

## Types

### TableRowValue

The allowed value types for `KeyValueASCIITable.addRow`:

```typescript
type TableRowValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | KeyValueASCIITable
  | MultiColumnASCIITable
  | NestedKeyValueEntry[];
```

### NestedKeyValueEntry

Structure for nested key-value entries:

```typescript
interface NestedKeyValueEntry {
  key: string;
  value: string | KeyValueASCIITable | NestedKeyValueEntry[];
}
```
