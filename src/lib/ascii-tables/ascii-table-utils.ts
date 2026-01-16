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
          lines.push(...subWords.slice(0, -1));
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
        subWords.push(currentSubWord);
        currentSubWord = grapheme;
      }
    }

    if (currentSubWord) {
      subWords.push(currentSubWord);
    }

    return subWords;
  }
}
