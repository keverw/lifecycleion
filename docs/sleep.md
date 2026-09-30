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
The delay is required and must be a number other than `NaN`. Invalid values reject
the promise. Zero and negative values (including `-Infinity`) schedule the next timer
turn, never a synchronous continuation. `Infinity` and finite values above
2,147,483,647 ms use that maximum supported timer delay.

```typescript
await sleep(1000); // waits 1 second
```

Computed remaining delays can become negative when a deadline has already passed.
`sleep()` treats those as zero, so the continuation still resumes asynchronously:

```typescript
await sleep(deadline - Date.now());
```
