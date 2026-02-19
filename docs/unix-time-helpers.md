# unix-time-helpers

Unix timestamp and high-resolution time utilities.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [unix](#unix)
  - [ms](#ms)
  - [performance](#performance)
  - [convertMSToUnix](#convertmstounix)
  - [convertUnixToMS](#convertunixtoms)

<!-- tocstop -->

## Usage

```typescript
import {
  unix,
  ms,
  performance,
  convertMSToUnix,
  convertUnixToMS,
} from 'lifecycleion/unix-time-helpers';
```

## API

### unix

Returns the current Unix timestamp in seconds.

```typescript
unix(); // e.g. 1593189055
```

### ms

Returns the current Unix timestamp in milliseconds (equivalent to `Date.now()`).

```typescript
ms(); // e.g. 1593189055006
```

### performance

Returns a high-resolution timestamp in milliseconds via `globalThis.performance.now()`. Intended for performance monitoring rather than wall-clock time.

```typescript
performance(); // e.g. 1234.567
```

### convertMSToUnix

Converts a Unix timestamp from milliseconds to seconds.

```typescript
convertMSToUnix(1593189055006); // 1593189055
```

### convertUnixToMS

Converts a Unix timestamp from seconds to milliseconds.

```typescript
convertUnixToMS(1593189055); // 1593189055000
```
