import { format } from 'date-fns';
import type { LogEntry, LogSink } from '../types';
import { colorize } from '../utils/color';

export interface ConsoleSinkOptions {
  colors?: boolean;
  timestamps?: boolean;
  typeLabels?: boolean;
  muted?: boolean;
}

/**
 * ConsoleSink writes logs to the console with optional colors, timestamps, and type labels
 */
export class ConsoleSink implements LogSink {
  private colors: boolean;
  private timestamps: boolean;
  private typeLabels: boolean;
  private closed = false;
  private muted: boolean;

  constructor(options: ConsoleSinkOptions = {}) {
    this.colors = options.colors ?? true;
    this.timestamps = options.timestamps ?? false;
    this.typeLabels = options.typeLabels ?? false;
    this.muted = options.muted ?? false;
  }

  public write(entry: LogEntry): void {
    if (this.closed || this.muted) {
      return;
    }

    // Raw type - no formatting
    if (entry.type === 'raw') {
      // eslint-disable-next-line no-console
      console.log(entry.message);
      return;
    }

    let formattedMessage = '';

    // Add timestamp if enabled
    if (this.timestamps) {
      const formattedTimestamp = format(entry.timestamp, 'MM-dd-yyyy HH:mm:ss');
      formattedMessage = '[' + formattedTimestamp + '] ';
    }

    // Add type label if enabled
    if (this.typeLabels) {
      formattedMessage += `[${entry.type.toUpperCase()}] `;
    }

    // Add service name if present
    if (entry.serviceName.length > 0) {
      formattedMessage += `[${entry.serviceName}] `;
    }

    // Add the message
    formattedMessage += entry.message;

    // Apply colors if enabled
    if (this.colors) {
      const { coloredText, style } = colorize(entry.type, formattedMessage);

      switch (entry.type) {
        case 'error':
          if (style) {
            // eslint-disable-next-line no-console
            console.error(coloredText, style);
          } else {
            // eslint-disable-next-line no-console
            console.error(coloredText);
          }
          break;
        case 'info':
          if (style) {
            // eslint-disable-next-line no-console
            console.info(coloredText, style);
          } else {
            // eslint-disable-next-line no-console
            console.info(coloredText);
          }
          break;
        case 'warn':
          if (style) {
            // eslint-disable-next-line no-console
            console.warn(coloredText, style);
          } else {
            // eslint-disable-next-line no-console
            console.warn(coloredText);
          }
          break;
        case 'success':
        case 'note':
          if (style) {
            // eslint-disable-next-line no-console
            console.log(coloredText, style);
          } else {
            // eslint-disable-next-line no-console
            console.log(coloredText);
          }
          break;
      }
    } else {
      // No colors
      switch (entry.type) {
        case 'error':
          // eslint-disable-next-line no-console
          console.error(formattedMessage);
          break;
        case 'info':
          // eslint-disable-next-line no-console
          console.info(formattedMessage);
          break;
        case 'warn':
          // eslint-disable-next-line no-console
          console.warn(formattedMessage);
          break;
        case 'success':
        case 'note':
          // eslint-disable-next-line no-console
          console.log(formattedMessage);
          break;
      }
    }
  }

  /**
   * Mute the sink to stop writing logs to console
   */
  public mute(): void {
    this.muted = true;
  }

  /**
   * Unmute the sink to resume writing logs to console
   */
  public unmute(): void {
    this.muted = false;
  }

  /**
   * Check if the sink is currently muted
   */
  public isMuted(): boolean {
    return this.muted;
  }

  /**
   * Close the sink and stop accepting new logs
   */
  public close(): void {
    this.closed = true;
  }
}
