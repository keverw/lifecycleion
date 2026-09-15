// Built-in sinks
export { ArraySink } from './array';
export { ConsoleSink, type ConsoleSinkOptions } from './console';
export {
  FileSink,
  type FileSinkOptions,
  type FileSinkHealth,
  type FlushResult,
} from './file';
export {
  NamedPipeSink,
  type NamedPipeSinkOptions,
  type NamedPipeSinkHealth,
  type ReconnectStatus,
} from './named-pipe';
// The one shape every sink reports a failure in, so a consumer can write a single handler
// and hand it to both.
export type {
  DroppedEntryCounts,
  DroppedEntryKind,
  SinkErrorHandler,
  SinkFailure,
  SinkFailureDisposition,
  SinkFailureKind,
} from './internal/sink-failure';
