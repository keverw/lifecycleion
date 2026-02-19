# sleep

Pause async execution for a given number of milliseconds.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [sleep](#sleep)

<!-- tocstop -->

## Usage

```typescript
import { sleep } from 'lifecycleion/sleep';
```

## API

### sleep

Pauses execution for the specified number of milliseconds. Returns a `Promise<void>` that resolves after the delay.

```typescript
await sleep(1000); // waits 1 second
```
