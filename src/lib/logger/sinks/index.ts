// Built-in sinks
export { ArraySink } from './array';
export { ConsoleSink, type ConsoleSinkOptions } from './console';
export { FileSink, type FileSinkOptions } from './file';
export {
  NamedPipeSink,
  PipeErrorType,
  type NamedPipeSinkOptions,
  type ReconnectStatus,
} from './named-pipe';
