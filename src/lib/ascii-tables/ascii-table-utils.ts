import { padCenterPreferRight, padRight } from '../padding-utils';
import stringWidth from 'string-width';
import { splitGraphemes } from '../strings';

export class ASCIITableUtils {
  public static centerText(text: string, width: number): string {
    return padCenterPreferRight(text, width, ' ');
  }

  public static createSeparator(
    columnWidths: number[],
    character: string = '=',
  ): string {
    const totalWidth =
      columnWidths.reduce((sum, width) => sum + width + 3, 0) - 1;

    return `+${padRight('', totalWidth, character)}+`;
  }

  public static wrapText(text: string, maxLength: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (stringWidth(currentLine) + stringWidth(word) + 1 <= maxLength) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }

        if (stringWidth(word) <= maxLength) {
          currentLine = word;
        } else {
          const subWords = ASCIITableUtils.splitWord(word, maxLength);

          // A loop, not `push(...subWords.slice(0, -1))`: `splitWord` returns one entry
          // per `maxLength` graphemes, and `maxLength` bottoms out at 1 at
          // `KEY_VALUE_TABLE_MIN_WIDTH` - which a cause chain reaches, since each level
          // narrows the table by four. Spreading passes one argument per entry, so a long
          // word in a narrow column raised `Maximum call stack size exceeded` from inside
          // the renderer, and `errorToString`'s backstop turned that into
          // `<error could not be rendered>` - the error's message, name and stack thrown
          // away because its column was narrow. Same reasoning as
          // `KeyValueASCIITable`'s nested-value loop.
          for (const subWord of subWords.slice(0, -1)) {
            lines.push(subWord);
          }

          currentLine = subWords[subWords.length - 1];
        }
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }

  public static splitWord(word: string, maxLength: number): string[] {
    const graphemes = splitGraphemes(word);
    const subWords: string[] = [];
    let currentSubWord = '';

    for (const grapheme of graphemes) {
      if (stringWidth(currentSubWord + grapheme) <= maxLength) {
        currentSubWord += grapheme;
      } else {
        // Only what has actually accumulated. A grapheme wider than the column - any
        // full-width character at `KEY_VALUE_TABLE_MIN_WIDTH`, where `maxLength` bottoms
        // out at 1 - fails the test on the *first* pass, with nothing collected yet:
        // `splitWord('漢字', 1)` returned `['', '漢', '字']`, and `wrapText` emitted that
        // leading empty chunk as a blank line above the value. The grapheme still overflows
        // the column, which nothing can help, but it no longer costs a row as well.
        if (currentSubWord) {
          subWords.push(currentSubWord);
        }

        currentSubWord = grapheme;
      }
    }

    if (currentSubWord) {
      subWords.push(currentSubWord);
    }

    return subWords;
  }
}
