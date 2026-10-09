# LifecycleManager

A comprehensive lifecycle orchestration system that manages startup, shutdown, and runtime control of application components. The LifecycleManager coordinates complex applications with multiple components, handles graceful shutdowns, manages dependencies, and integrates with process signals for production-ready applications.

<!-- toc -->

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [1. Create Your Components](#1-create-your-components)
  - [2. Create and Configure LifecycleManager](#2-create-and-configure-lifecyclemanager)
  - [3. Graceful Shutdown](#3-graceful-shutdown)
- [Core Concepts](#core-concepts)
  - [Component Lifecycle States](#component-lifecycle-states)
  - [Abort Signals at a Glance](#abort-signals-at-a-glance)
  - [Startup Abort Signal](#startup-abort-signal)
  - [Late-Start Cleanup](#late-start-cleanup)
  - [Dependency Management](#dependency-management)
  - [Optional Components](#optional-components)
  - [Multi-Phase Shutdown](#multi-phase-shutdown)
  - [Stop Abort Signals](#stop-abort-signals)
- [API Reference](#api-reference)
  - [LifecycleManager Constructor](#lifecyclemanager-constructor)
  - [Component Registration](#component-registration)
    - [`registerComponent(component, options?)`](#registercomponentcomponent-options)
    - [`insertComponentAt(component, position, targetComponentName?, options?)`](#insertcomponentatcomponent-position-targetcomponentname-options)
    - [`unregisterComponent(name, options?)`](#unregistercomponentname-options)
  - [Lifecycle Operations](#lifecycle-operations)
    - [`startAllComponents(options?)`](#startallcomponentsoptions)
    - [`stopAllComponents(options?)`](#stopallcomponentsoptions)
    - [`restartAllComponents(options?)`](#restartallcomponentsoptions)
    - [Individual Component Operations](#individual-component-operations)
  - [Component Messaging](#component-messaging)
    - [`sendMessageToComponent(componentName, payload, options?)`](#sendmessagetocomponentcomponentname-payload-options)
    - [`broadcastMessage(payload, options?)`](#broadcastmessagepayload-options)
  - [Health Monitoring](#health-monitoring)
    - [`checkComponentHealth(name)`](#checkcomponenthealthname)
    - [`checkAllHealth()`](#checkallhealth)
  - [Value Sharing](#value-sharing)
  - [Signal Integration](#signal-integration)
    - [`attachSignals()`](#attachsignals)
    - [`detachSignals()`](#detachsignals)
    - [`getSignalStatus()`](#getsignalstatus)
    - [`getShutdownEscalationStatus()`](#getshutdownescalationstatus)
    - [Manual Signal Triggers](#manual-signal-triggers)
    - [Custom Signal Handlers](#custom-signal-handlers)
    - [Repeated Shutdown Request Policy](#repeated-shutdown-request-policy)
  - [Logger Integration](#logger-integration)
    - [`enableLoggerExitHook()`](#enableloggerexithook)
    - [Process Exit Design & Rationale](#process-exit-design--rationale)
    - [Logger Requirements](#logger-requirements)
  - [Status and Query Methods](#status-and-query-methods)
    - [Component Existence and State](#component-existence-and-state)
    - [Lists and Counts](#lists-and-counts)
    - [System State](#system-state)
    - [Dependencies](#dependencies)
- [BaseComponent API](#basecomponent-api)
  - [Constructor](#constructor)
  - [Lifecycle Methods](#lifecycle-methods)
  - [Signal Handlers](#signal-handlers)
  - [Messaging](#messaging)
  - [Health Checks](#health-checks)
  - [Value Sharing](#value-sharing-1)
  - [Reporting Unexpected Stops](#reporting-unexpected-stops)
  - [Component Properties](#component-properties)
- [Events](#events)
  - [Subscribing to Events](#subscribing-to-events)
  - [Event Categories](#event-categories)
  - [Event Handler Best Practices](#event-handler-best-practices)
- [Error Handling](#error-handling)
  - [Result Objects vs Exceptions](#result-objects-vs-exceptions)
    - [Operations Return Result Objects](#operations-return-result-objects)
    - [Promises Never Reject](#promises-never-reject)
    - [Running Operations in the Background](#running-operations-in-the-background)
    - [Exceptions (Programmer Errors)](#exceptions-programmer-errors)
  - [Failure Codes](#failure-codes)
- [Advanced Usage](#advanced-usage)
  - [Dynamic Component Management](#dynamic-component-management)
  - [Dependency Validation](#dependency-validation)
  - [Stalled Component Recovery](#stalled-component-recovery)
- [Best Practices](#best-practices)
  - [1. Design Components for Graceful Shutdown](#1-design-components-for-graceful-shutdown)
  - [2. Use Appropriate Timeouts](#2-use-appropriate-timeouts)
  - [3. Handle Optional Dependencies](#3-handle-optional-dependencies)
  - [4. Leverage Events for Monitoring](#4-leverage-events-for-monitoring)
  - [5. Validate Before Production](#5-validate-before-production)
  - [6. Use Single LifecycleManager Instance](#6-use-single-lifecyclemanager-instance)
  - [7. Make Component Startup Idempotent and Coordinate With Shutdown](#7-make-component-startup-idempotent-and-coordinate-with-shutdown)
  - [8. Safe Resource Sharing via Dynamic Wrappers](#8-safe-resource-sharing-via-dynamic-wrappers)
    - [Step 1: The Resource Component](#step-1-the-resource-component)
    - [Step 2: The Consumer Wrapper Helper](#step-2-the-consumer-wrapper-helper)
- [Known Limitations](#known-limitations)
  - [1. Timeouts Do Not Force-Cancel Work](#1-timeouts-do-not-force-cancel-work)
  - [2. Stalled Promises Can Retain Memory](#2-stalled-promises-can-retain-memory)
  - [3. No Atomic Restart](#3-no-atomic-restart)
  - [Logger contract](#logger-contract)

<!-- tocstop -->

## Features

- 🚀 **Dependency-ordered startup** - Components start in dependency order (topological sort)
- 🛑 **Multi-phase shutdown** - Global warning → per-component graceful → force phases
- 📦 **Component lifecycle** - Unified interface for start, stop, restart operations
- 🔗 **Dependency management** - Automatic dependency resolution with cycle detection
- 📡 **Process signal integration** - Built-in handling for SIGINT, SIGTERM, SIGHUP, etc.
- 🪵 **Logger integration** - Graceful shutdown on `logger.exit()` with configurable timeout
- 💬 **Component messaging** - Send messages, broadcast to running components, and read values from other components
- 🏥 **Health monitoring** - Built-in health check system with timeouts
- 🔄 **Hot reload support** - Broadcast reload signals to components
- 📊 **Event-driven** - Rich event system for monitoring and observability
- 🎯 **Optional components** - Components that can fail without breaking startup

## Installation

```bash
npm install lifecycleion
# or
bun add lifecycleion
```

**Note on Logger:** The LifecycleManager requires a `Logger` from `lifecycleion/logger`. The logger provides sinks, service scoping, and lifecycle integration.

## Quick Start

### 1. Create Your Components

Components extend `BaseComponent` and implement lifecycle methods.

**Production Note:** For simple or stateless components, implementing standard `start()` and `stop()` methods is sufficient. For production servers and long-running services, you should implement the **idempotency pattern** (using a `startPromise`, a `stopPromise`, and explicit start/stop coordination) to prevent race conditions. See [Best Practice #7](#7-make-component-startup-idempotent-and-coordinate-with-shutdown) for details.

```typescript
import { BaseComponent } from 'lifecycleion/lifecycle-manager';
import type { Logger } from 'lifecycleion/logger';

class DatabaseComponent extends BaseComponent {
  private pool!: Pool;

  constructor(logger: Logger) {
    super(logger, {
      name: 'database',
    });
  }

  // `signal` is aborted if the manager gives up on this start (it timed out)
  async start(signal: AbortSignal) {
    this.logger.info('Connecting to database...');

    this.pool = await createPool(config, { signal });

    await this.pool.connect();
    this.logger.success('Database connected');
  }

  async stop() {
    this.logger.info('Closing database connection...');
    await this.pool.drain();
    this.logger.success('Database closed');
  }

  async healthCheck() {
    const stats = await this.pool.stats();
    return {
      healthy: stats.idle > 0,
      message: stats.idle > 0 ? 'Pool healthy' : 'No idle connections',
      details: { active: stats.active, idle: stats.idle },
    };
  }
}

class WebServerComponent extends BaseComponent {
  private server!: Server;

  constructor(logger: Logger) {
    super(logger, {
      name: 'web-server',
      dependencies: ['database'], // Start after database
    });
  }

  async start() {
    this.logger.info('Starting web server...');
    this.server = createServer();
    await this.server.listen(3000);
    this.logger.success('Web server listening on port 3000');
  }

  async stop() {
    this.logger.info('Stopping web server...');
    await this.server.close();
    this.logger.success('Web server stopped');
  }

  async onReload() {
    this.logger.info('Reloading web server configuration...');
    await this.reloadConfig();
  }
}
```

### 2. Create and Configure LifecycleManager

```typescript
import { LifecycleManager } from 'lifecycleion/lifecycle-manager';

const lifecycle = new LifecycleManager({
  name: 'my-app',
  logger,
  shutdownOptions: { timeoutMS: 30000 }, // 30 second shutdown timeout
});

// Register components
lifecycle.registerComponent(new DatabaseComponent(logger));
lifecycle.registerComponent(new WebServerComponent(logger));

// Start all components (respects dependencies)
const result = await lifecycle.startAllComponents();

if (!result.success) {
  logger.error('Failed to start application', {
    params: { errors: result.errors },
  });

  process.exit(1);
}

// Manually Attach signal handlers for graceful shutdown
lifecycle.attachSignals();

logger.success('Application started successfully');
```

### 3. Graceful Shutdown

When SIGINT (Ctrl+C) or SIGTERM is received, the LifecycleManager automatically:

1. Emits `lifecycle-manager:shutdown-initiated` event
2. Runs global shutdown warning phase (calls `onShutdownWarning()` on all components)
3. Stops components in reverse dependency order
4. Handles timeouts and stalled components
5. Emits `lifecycle-manager:shutdown-completed` event

## Core Concepts

### Component Lifecycle States

Components transition through these states:

```
registered → starting → running → stopping → stopped
                  ↓                   ↓
                  ↓ (timeout)         stalled (if shutdown fails)
                  ↓
            starting-timed-out (required component timeout)
                  ↓
            failed (optional component timeout/error)
```

**Note:** Required components that timeout enter `starting-timed-out` and trigger rollback. Optional components that fail enter `failed` state and startup continues.

Once a required startup failure begins rollback, the bulk startup timer is cleared.
Rollback uses the component shutdown timeouts, and startup returns the original failure
after cleanup finishes. A concurrent shutdown also cancels the remaining bulk starts,
even if shutdown finishes before startup resumes. Shutdown owns cleanup in this case, so
startup does not launch a second rollback that could bypass `haltOnStall`. The aborted
startup result lists components from that startup pass that are still running when it
returns. Consult the shutdown result for stalls and incomplete stops.

**Starting-Timed-Out State Definition:**
A component enters "starting-timed-out" when:

1. `start()` exceeds `startupTimeoutMS`
2. The manager marks the component `starting-timed-out` and treats it as not running

After an individual component timeout, this state behaves like `registered`: the component can be started again, unregistered normally, and will not be stopped during shutdown because it is not running. The state is cleared automatically on a successful start. Bulk startup deadlines follow the same recovery rules described below.

After a bulk startup deadline, restart and unregistration are allowed even if the
abandoned `start()` never settles. A late successful start is stopped automatically
only if its attempt still owns the registered component. A retry or replacement makes
the old completion stale, so it cannot stop the new run. Once the manager observes a
late fulfillment that it owns cleanup for, unregistration is blocked through recovery's
ownership check and until that cleanup finishes. An individual
restart may claim the cleanup's stop before it begins and then start a new run;
once the stop is in flight, restart is refused as an already stopping component.
These cleanup protections also apply to individual component timeouts.

Use `getStartTimedOutComponentNames()` to inspect components currently in this state.
For accounting purposes, `getStoppedComponentNames()` and `getStoppedComponentCount()` include
components in this state so that `running + stopped + stalled = total`.

When a component `start()` exceeds its `startupTimeoutMS`, the manager:

1. Aborts the `AbortSignal` it passed to that `start()` call, with the
   `ComponentStartTimeoutError` the start's result carries as `signal.reason`
2. Marks the component state as `starting-timed-out` (for observability)
3. Treats the component as not running

The signal is the cancellation cue: pass it to cancellable work, or check
`signal.aborted` between steps, and let `start()` settle once it aborts. Each start
attempt gets a fresh signal, so a retry is never handed an already-aborted one. See
[Startup Abort Signal](#startup-abort-signal) for exactly when it is aborted.

If that delayed `start()` later completes successfully anyway, the manager
automatically calls `stop()` to clean it up and then returns the state to
`starting-timed-out` for observability - unless the component sets
`ownsLateStartCleanup: true` (see [Late-Start Cleanup](#late-start-cleanup)). Until that cleanup
settles, `stopComponent()` and `startComponent()` on the component are both
refused with `component_already_stopping` - the manager owns that teardown - and
`startAllComponents()` is refused with `partial_state`.

Any in-flight startup work may continue in the background, so components should
either keep startup side effects idempotent or honor the start signal (the manager
cannot cancel work that ignores it).

**Failed State Definition:**

A component enters "failed" when:

1. It's marked as `optional: true`, AND
2. Its `start()` method throws an error or exceeds `startupTimeoutMS`

When an optional component fails:

- The component state becomes `failed`
- It's recorded in `StartupResult.failedOptionalComponents`
- Startup **continues** with remaining components (dependents still attempt to start)
- The component can be restarted later with `startComponent(name)`

```typescript
class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // Failure enters 'failed' state, doesn't stop startup
    });
  }
}

const result = await lifecycle.startAllComponents();
if (result.failedOptionalComponents.length > 0) {
  logger.warn(
    'Some optional components failed:',
    result.failedOptionalComponents.map((c) => c.name),
  );
  // Application continues running in degraded mode
}
```

**Stalled State Definition:**
A component becomes "stalled" when:

1. The graceful `stop()` method exceeds `shutdownGracefulTimeoutMS` or throws an error, AND
2. Either `onShutdownForce()` is not implemented, OR `onShutdownForce()` also fails by timing out or throwing an error

Or when a `forceImmediate` stop - or a force retry - finds `onShutdownForce()` failing
the same way. A `forceImmediate` stop of a component without `onShutdownForce()` stalls
at once, with `phase: 'force'`, `reason: 'error'`, and an error saying the component has
no force handler: no graceful phase ran, so none failed.

Once stalled, a component remains registered but:

- `startAllComponents()` will fail unless you pass `ignoreStalledComponents: true` (which skips stalled components during bulk startup)
- `startComponent(name)` will fail unless you pass `forceStalled: true` (which calls `start()` regardless of stalled state)

To recover: unregister the component, retry via `stopAllComponents({ retryStalled: true })` (this escalates to the force phase and does not re-run `stop()`), start non-stalled components via `startAllComponents({ ignoreStalledComponents: true })`, or force start an individual stalled component via `startComponent(name, { forceStalled: true })`. Force starting is only appropriate for components whose `start()` implementation rejects or otherwise protects against any still-running shutdown work from the previous run.

A successful forced start retires the old stall: it emits `component:stalled-resolved`
with `reason: 'forced-start'`, then `component:started`. If shutdown begins while the
forced start is pending and startup then succeeds before its startup timeout, it
retires the stall the same way (`component:stalled-resolved` with
`reason: 'forced-start'`) and emits `component:started`, then goes straight into
cleanup, which emits `component:stopped` when it succeeds. Like
`'late-start-cleanup'`, this reason means the old stop was superseded, not that it
finished. If instead the old stop finishes while the forced start is still pending,
its stall ends then: `component:stalled-resolved` without a `reason`, and no
`component:stopped`, since the forced start owns the component's state.

A timed-out forced start preserves the old stall while its startup remains unresolved.
If that startup later succeeds first, it takes the late-start cleanup path instead,
even when shutdown began while startup was unresolved: if the old stall record
remains, automatic cleanup retires it and emits `component:stalled-resolved` with
`reason: 'late-start-cleanup'` before stopping the new run. This reason means the old stop was superseded, not that it
finished. As with any forced start, the component must tolerate overlapping old
shutdown work. A timed-out forced start still in `stalled` state is listed by the
stalled APIs, not `getStartTimedOutComponentNames()`, which lists only components
currently in `starting-timed-out` state.

The final status reflects completed lifecycle work, not a permanent record of the
last start attempt. If the old stop finishes before late startup, it clears the
error and moves to `stopped`; successful automatic cleanup preserves that state.
If late startup retires the still-live stall first, successful cleanup preserves
`starting-timed-out` and the startup timeout error. In both orders, the original
start result and `component:start-timeout` event report the timeout.

**Automatic late resolution:** If `stop()` eventually completes after the graceful timeout (e.g., a server waiting on keep-alive connections), the manager automatically clears the stall and emits `component:stalled-resolved`. No manual retry is needed. The same applies to `onShutdownForce()`: if it eventually resolves after its own timeout, the stall is cleared automatically. A stalled component's force retry (`stopAllComponents({ retryStalled: true })`) continues the same stop, so the original `stop()` or `onShutdownForce()` - or an earlier retry's - finishing late still clears the stall, whether the retry is still running (it then ends as stopped) or has stalled again. If none ever completes, the stall persists until you intervene.

### Abort Signals at a Glance

`start()`, `stop()` and `onShutdownForce()` each receive an `AbortSignal`. A signal
fires when the manager stops needing that call's work, or wants it wrapped up
sooner. JavaScript cannot cancel a running promise, so the signal is how the manager
asks your code to wind down - and the only timeout notification a component gets.

| Call                      | Its signal fires when...                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `start(signal)`           | `startupTimeoutMS` (or a bulk startup deadline) passes, or a shutdown with `abortPendingStarts: true` begins          |
| `stop(signal)`            | `shutdownGracefulTimeoutMS` (or a `stopComponent()` `timeout`) passes - then `onShutdownForce()` runs, if implemented |
| `onShutdownForce(signal)` | `shutdownForceTimeoutMS` passes, or the earlier `stop()` finishes after all, so the component is already down         |

It never fires because the call itself resolved, rejected or threw. Each attempt gets a
fresh signal.

`signal.reason` says why. Every reason is an exported `Error` subclass with an
`errCode` (also listed in `lifecycleManagerErrCodes`), so it can be checked with
`instanceof` or by code:

| Signal                    | Reason class                        | `errCode`                | Fired by                                                                    |
| ------------------------- | ----------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `start(signal)`           | `ComponentStartTimeoutError`        | `StartTimeout`           | `startupTimeoutMS` or a bulk startup deadline (the start result's `error`)  |
| `start(signal)`           | `StartupInterruptedByShutdownError` | `StartupInterrupted`     | a shutdown pass with `abortPendingStarts: true` beginning                   |
| `start(signal)`           | `ComponentStartObservationError`    | `StartObservationFailed` | a `start()` promise the manager cannot observe (its error is the `cause`)   |
| `stop(signal)`            | `ComponentStopTimeoutError`         | `StopTimeout`            | `shutdownGracefulTimeoutMS` or a `stopComponent()` `timeout`                |
| `onShutdownForce(signal)` | `ComponentForceTimeoutError`        | `ForceTimeout`           | `shutdownForceTimeoutMS` (the stalled result's `error`)                     |
| `onShutdownForce(signal)` | `ForceShutdownSupersededError`      | `ForceSuperseded`        | the earlier `stop()` completing late - the component is down; not a failure |

```typescript
import { lifecycleManagerErrCodes } from 'lifecycleion/lifecycle-manager';

class QueueComponent extends BaseComponent {
  async onShutdownForce(signal: AbortSignal) {
    signal.addEventListener('abort', () => {
      switch (signal.reason?.errCode) {
        case lifecycleManagerErrCodes.ForceTimeout:
          this.logger.warn('Force cleanup ran out of time; dropping the queue');
          this.queue.drop();
          break;
        case lifecycleManagerErrCodes.ForceSuperseded:
          // stop() finished after all - nothing left to force.
          break;
      }
    });
    await this.queue.flush({ signal });
  }
}
```

A stop that escalates, end to end - one stop operation, holding the component's lock
throughout:

```text
t=0     stop(signalA) called
t=5s    shutdownGracefulTimeoutMS passes
          -> signalA aborts (reason: ComponentStopTimeoutError)
          -> onShutdownForce(signalB) called; stop() may still be running
t=6s    the original stop() finishes after all - the component is down
          -> the stop succeeds, signalB aborts (reason: ForceShutdownSupersededError)
```

All a component needs to do: pass the signal to its async work (`fetch`, `listen`,
a pool connect, `setTimeout` from `node:timers/promises`) or check `signal.aborted`
between steps, and stop when it fires. For work the signal cannot reach directly -
flags, instance-level cleanup - add an `'abort'` listener:
`signal.addEventListener('abort', () => this.closeAll())`.

### Startup Abort Signal

`start(signal)` receives a fresh `AbortSignal` for each start attempt. Every signal
the manager hands a hook - this one, and the [stop and force
signals](#stop-abort-signals) - follows one rule: it aborts when the manager no longer
needs that still-pending call's work - see [Abort Signals at a
Glance](#abort-signals-at-a-glance) - and never because the call itself settled. For
`start()`, that is exactly when the manager stops waiting on a call that is still
pending, or is told to stop wanting it:

- the component's own `startupTimeoutMS` passes;
- a `startAllComponents()` / `restartAllComponents()` deadline bounds the start and
  passes first (a bulk deadline bounds an in-flight start through the same timer);
- either of those passes for an attempt that a newer attempt has already superseded
  (for example, the component reported an unexpected stop from inside `start()` and a
  listener started it again). That old attempt's signal is still aborted; the newer
  run's is its own, and is not;
- a shutdown pass using `abortPendingStarts` begins while the start is pending (see
  [Multi-Phase Shutdown](#multi-phase-shutdown)). That abort is only a cue, with a
  `StartupInterruptedByShutdownError` as `signal.reason`: nothing is marked timed
  out. Only a failure linked to it is answered
  `shutdown_in_progress`; an unrelated one is still `error`;
- the promise `start()` returned cannot be observed (see [Late-Start
  Cleanup](#late-start-cleanup)): the start fails at once, so its signal aborts with a
  `ComponentStartObservationError` carrying that failure as `cause`, and a shutdown
  pass with `abortPendingStarts` does not abort it again.

It is never aborted because `start()` resolved, rejected or threw. Without
`abortPendingStarts`, a shutdown pass does not abort it either - including one using
`allowStopWithPendingStarts`, or one whose budget runs out while it waits on the
start: the start attempt is still waiting on `start()`, and sends the component
through the stop pipeline once it settles. Each signal aborts at most once: a start
whose signal a shutdown already aborted keeps that reason if its own timeout passes
later (the start is still recorded as timed out then), and a start whose signal its
timeout already aborted is not aborted again by a shutdown.
`stopComponent()` and `unregisterComponent()` are refused while a start is pending
(`component_not_running` / `component_starting`), so they never abandon one. A
start that resolved but lost to a bulk deadline in the same moment is handed to
late-start cleanup without an abort; there is no pending work left to cancel. With
startup timeouts disabled (`0`) and no bulk deadline, the signal never aborts.

For a timeout, `signal.reason` is the same `ComponentStartTimeoutError` instance the result reports
as `error`. The abort happens after the manager has finished its own bookkeeping for
the timeout (late-start cleanup is already arranged). The result itself, with state
`starting-timed-out`, is built after it.

Abort listeners run synchronously inside the manager's timer: keep them fast. On an ordinary `AbortSignal`, a listener that throws is reported by the
runtime as an uncaught exception (`process` `'uncaughtException'` in Node and Bun),
which terminates a process that has no handler. The signal handed to `start()` guards
against that: an error thrown by an `'abort'` listener added with
`signal.addEventListener()` (a function, or an object's `handleEvent`) or by
`signal.onabort` - or a rejection from an async one - is reported on the global
`'error'` channel like any other callback failure (see
[safe-handle-callback](./safe-handle-callback.md)), as
`Error in a callback lifecycle-manager start abort listener for <name>` with the
thrown value as `cause`. The listeners after it still run, and the manager's timeout
result and late-start cleanup are unaffected.

The guard is the signal's own `addEventListener`, `removeEventListener` and `onabort`,
defined on that instance and backed by the `EventTarget` methods. They otherwise
behave as natively: a duplicate
listener with the same capture flag is still ignored, `removeEventListener()` with the
original listener removes it, `once`, `passive` and `signal` options apply, a `null`
listener is ignored, `onabort` runs at the position where it was first set, and other
event types are not wrapped. Native consumers such as `fetch(url, { signal })` and
`AbortSignal.any([signal])` follow it as usual. Two gaps remain the runtime's:

- Listeners on a signal **derived** from it - `AbortSignal.any([signal, ...])`, for
  instance - belong to that signal and are not guarded.
- Calling `EventTarget.prototype.addEventListener.call(signal, ...)` (or the
  prototype's `onabort` setter) registers the raw listener, deliberately bypassing
  the guard.

Catch inside listeners in those two cases.

After an abort, prefer rejecting (for example with `signal.throwIfAborted()`) to
resolving: a timed-out `start()` that resolves is a late success, which the manager
stops again with `stop()` (see [Late-Start Cleanup](#late-start-cleanup)). Declaring
`start()` without the parameter is valid: the component simply never sees the signal,
and its startup timeout and late-start cleanup apply as described here. A component
that defines one of the unsupported timeout hooks (`onStartupAborted()`,
`onGracefulStopTimeout()`, `onShutdownForceAborted()`) is refused at registration
with `invalid_options` (see [`registerComponent()`](#registercomponentcomponent-options)).

### Late-Start Cleanup

A `start()` that passes its `startupTimeoutMS` keeps running - the manager can only
abort its signal. If it then completes successfully anyway, the component holds
whatever it brought up while the manager considers it not running. By default the
manager cleans that up: it calls `stop()` on the late start, and once that succeeds
the component is back in `starting-timed-out` with the timeout error - the status
the cleanup's `component:stopped` event carries (or wherever the timed-out start
had left it, such as `stopped` after an unexpected stop it reported). Until that
cleanup settles, it refuses `startComponent()` / `stopComponent()` on the component
with `component_already_stopping`.

If the manager cannot observe the promise returned by `start()` because its
constructor or species throws, the start operation returns that error and aborts
the start signal immediately, with a `ComponentStartObservationError` whose `cause`
is that error. The manager retains ownership of the unfinished
start and attempts to observe it again for automatic late cleanup. Unregistration
is refused while that work remains unresolved, and a successful cleanup retains
the original observation error. A promise whose constructor persistently prevents
observation cannot be monitored without modifying it; its unfinished start stays
protected rather than being treated as a settled rejection of `start()`.

A component that would rather undo a late start itself sets
`ownsLateStartCleanup: true` (default `false`) in its constructor options. The manager
then leaves a late success of its own timed-out start alone. It is readable as the
`ownsLateStartCleanup` property and must be a boolean: the constructor throws a
`TypeError` for anything else, and a start, `restartComponent()` or
`restartAllComponents()` that finds a non-boolean there (an overridden property, say)
is refused with `invalid_options` before it starts or stops anything. A start that a
`startAllComponents()` / `restartAllComponents()` deadline abandons is cleaned up by
the manager regardless.

```typescript
class ConnectionComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'connection',
      startupTimeoutMS: 5000,
      ownsLateStartCleanup: true,
    });
  }

  async start(signal: AbortSignal) {
    this.socket = await openSocket(); // ignores the signal
    if (signal.aborted) {
      // Timed out while connecting: the manager has given up on this start.
      await this.teardown();
    }
  }

  async stop() {
    await this.teardown();
  }
}
```

### Dependency Management

Components declare dependencies in their constructor options:

```typescript
class ApiComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database', 'cache'], // Required dependencies
      optional: false, // If true, startup continues even if it fails; dependents still attempt to start
    });
  }
}
```

**Dependency Resolution:**

- Components start in **topological order** (dependencies first)
- Components stop in **reverse topological order** (dependents first)
- Cycle detection prevents invalid dependency graphs
- Missing dependencies are reported before startup

### Optional Components

Optional components can fail during startup without breaking the entire application:

**Important:** When you mark a component as `optional: true`, it's the **component itself** that's optional (can fail without triggering rollback), NOT the dependency relationship. Other components that list it as a dependency will still attempt to start even if it fails, so those dependents must handle the missing component gracefully.

```typescript
class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // App works without cache, just slower
    });
  }
}

const result = await lifecycle.startAllComponents();

if (result.failedOptionalComponents.length > 0) {
  logger.warn('Running in degraded mode:', result.failedOptionalComponents);
}
```

Dependents still attempt to start if an optional component fails, is stalled, or isn't running, so they should handle missing optional dependencies gracefully. Optional dependencies are primarily for ordering and visibility, not hard requirements.

**Handling Optional Dependencies:**

Dependents of optional components should gracefully handle the missing dependency:

```typescript
class ApiComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database', 'cache'], // cache is optional, database is required
    });
  }

  async start() {
    // Database is required - assume it's available
    this.db = await getComponentValue('database', 'connection');

    // Cache is optional - check if available
    const cacheResult = lifecycle.getValue('cache', 'instance');
    this.cache = cacheResult.found ? cacheResult.value : null;

    if (!this.cache) {
      this.logger.warn('Cache unavailable, using fallback');
    }
  }
}

class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // Mark as optional so API can still start
    });
  }
}
```

When `cache` fails to start:

- It's recorded in `failedOptionalComponents`
- The `api` component still attempts to start
- The `api` component handles the missing cache gracefully

### Multi-Phase Shutdown

A shutdown encountering an ordinary in-flight start waits for that attempt and its
automatic stop cleanup before stopping its dependencies, within the shutdown's
`timeoutMS` budget. If that deadline expires, dependencies remain available and the
result reports `shutdown_timeout`. Unrelated components are stopped before these
startup joins, keeping reverse dependency order within each group.

If the start had already timed out before this shutdown pass and remains unresolved,
shutdown skips that wait and reports `success: false` with `code: 'cleanup_incomplete'`
without consuming another budget on that start. Its dependencies remain available; unrelated components can
still stop. Dependencies already known to be protected are excluded from shutdown
warnings, so their hooks are not asked to drain while they must remain available.
This also applies when nothing is running: unresolved work is reported
as incomplete, not as a clean shutdown. If late-start cleanup is already underway,
shutdown still waits for it within its remaining budget, or without a deadline when `timeoutMS: 0`. A pass that skipped a pending start may
need another shutdown call after cleanup settles. Failed or unconfirmed cleanup
continues to protect dependencies. An aborted start signal does not by itself prove
that raw startup settled: unresolved work retains protection across later passes,
while a settled start that owns its late cleanup (`ownsLateStartCleanup: true`) is not
reported as incomplete merely because its state remains `starting-timed-out`.

For an explicit escape hatch, use `allowStopWithPendingStarts: true` on a shutdown
call. That pass does not wait for unresolved `start()` calls, leaving its budget
available to stop their dependencies. This can shut down resources those calls
are still using; it does **not** cancel them or abort their start signals. Cleanup already underway, stalled
components, and other stop failures retain their normal protection. If cleanup
begins between dependency stops, the pass preserves its remaining dependencies.
That protection lasts for the rest of this pass; after cleanup finishes, call
shutdown again to stop those dependencies. The pass does not revisit earlier skips.
Any remaining startup work still makes the result unsuccessful (`cleanup_incomplete`, or
`shutdown_timeout` if the pass exhausts its budget). Late-start cleanup works as it does
on any other pass, including the component's cleanup responsibility when it sets
`ownsLateStartCleanup: true`.

```typescript
const result = await lifecycle.stopAllComponents();
if (
  result.code === 'cleanup_incomplete' ||
  result.code === 'shutdown_timeout'
) {
  // Only when the application accepts interrupting resources used by pending starts.
  const forced = await lifecycle.stopAllComponents({
    timeoutMS: 5000,
    allowStopWithPendingStarts: true,
  });
  // Inspect forced.success/code: pending starts can still be unfinished.
}
```

The default is `false`. Like other stop options, it can be configured in
`shutdownOptions` for shutdown hooks; a per-call `false` restores safe waiting.
Prefer the per-call override when this is an operator decision: a global `true`
also lets SIGTERM or logger-triggered shutdown stop dependencies under an ordinary
slow start, even if it would have finished shortly. `restartAllComponents()` always
keeps this override disabled; an incomplete stop prevents restart's startup phase,
so dropping dependency protection would not help it finish the restart.

Restart skips its startup phase when shutdown reports `cleanup_incomplete`. A start
that had already timed out with its `start()` still unresolved when the restart is
called would always end the stop phase that way, so restart refuses up front instead,
before stopping anything: `shutdownResult` is `cleanup_incomplete` with no stopped
components (no shutdown pass runs), and `startupResult` is `partial_state`. Otherwise
the stop phase would stop every component that start does not depend on and then
leave them down. The reason's 'still in progress' names include dependencies deliberately left running;
it does not mean a background shutdown pass will stop them. Individual stops also
refuse to stop dependencies while this late recovery is pending, unless
`allowStopWithRunningDependents` is explicitly enabled.

Unregistering a timed-out component explicitly abandons the manager's ownership of
that attempt and removes its protection from future shutdown passes. It does not
cancel the underlying start or prove its resources are cleaned up; only use this
escape hatch when the application can handle that abandoned work safely.

With `timeoutMS: 0`, the global shutdown deadline is disabled. Shutdown waits for
ordinary in-flight starts and their automatic cleanup before stopping dependencies.
If an unresolved start times out during that wait - with a finite budget or without
one - shutdown stops waiting on it exactly as it would for a start that had already
timed out when the pass began: it returns `cleanup_incomplete`, releases its shutdown
latch, and preserves the dependencies, rather than spend the rest of its budget on a
`start()` that may never settle. A later shutdown can finish after the start settles;
cleanup already underway is still joined.

To wait for such a start instead, pass `waitForAbandonedStarts: true` (default:
`false`; it can also be set in `shutdownOptions`). The pass then waits for a start that
timed out before it began or while it ran, the same way in both cases, until its
`start()` settles and its late cleanup stops it, and then stops its dependencies. For a
component with `ownsLateStartCleanup: true` there is no late cleanup to wait for, but
the pass still waits for its `start()` to settle. The wait is still bounded by
`timeoutMS` (`shutdown_timeout` when it runs out); with `timeoutMS: 0` it lasts until
`start()` settles. Use it when one shutdown call should
leave as little running as possible, such as a process that exits right after it, and
a slow start may still finish within the budget. `allowStopWithPendingStarts` takes
precedence: with it enabled, starts are not waited for at all.
`restartAllComponents()` always keeps it disabled, as it does `allowStopWithPendingStarts`:
a restart refuses up front for a start that already timed out, and one that times out
during its stop phase ends that phase `cleanup_incomplete`. Waiting would only trade
that for `shutdown_timeout` after stopping more components, with startup skipped either way.

```typescript
const result = await lifecycle.stopAllComponents({
  timeoutMS: 10000,
  waitForAbandonedStarts: true,
});
```

To tell starts still in flight to give up, pass `abortPendingStarts: true` (default:
`false`; it can also be set in `shutdownOptions`, and a per-call value overrides it).
As the pass begins - once it is accepted, before its warning phase and before it waits
on anything - it aborts the [start signal](#startup-abort-signal) of each start in
flight at that moment, with a `StartupInterruptedByShutdownError` (exported;
`additionalInfo: { componentName, method }`) as `signal.reason`. The sooner a start
learns of the shutdown, the sooner it can settle and release what the pass keeps up
for it. It is a cue, not the pass giving up on those starts: nothing is marked
`starting-timed-out`, and the pass still waits for them
within its budget and keeps their dependencies up until they settle, exactly as it
would without the option. Two starts are left alone:

- one whose own timeout already aborted its signal (a signal aborts at most once, so
  its `ComponentStartTimeoutError` reason stays), and one whose `start()` has settled;
- one that requested this shutdown itself - synchronously from `start()`, or through
  its `this.lifecycle` handle. It already knows, the pass does not join it, and it may
  be awaiting the pass's result. A start still unfinished when the pass ends - one
  awaiting that result cannot settle sooner - keeps its dependencies up and leaves the
  pass `cleanup_incomplete`, as any start the pass could not wait for does; once that
  start settles (it stops itself, having found the shutdown), another shutdown stops
  them.

A start that honors the cue by rejecting or throwing with a failure linked to the
abort is answered by `startComponent()` with `code: 'shutdown_in_progress'` (the thrown
value as `error`, the reason prefixed `Shutdown interrupted component startup: `, and a
warning log), as a start that resolved after a shutdown began already is, rather than
`error`. Linked means the thrown value is `signal.reason` itself, is an `AbortError`
(by `name` - the `DOMException` `fetch` and timers reject with, or a library's own), or
carries either on its `cause` chain - a library wrapping the reason, say
`new Error('connect aborted', { cause: signal.reason })`. The chain is followed for at
most 16 links and stops at a cycle, and `name` and `cause` are read defensively: a
getter that throws, or a `Proxy` that refuses, reads as not linked. Any other failure -
a connection refused just after the abort, say - is reported exactly as it would be
without the option: `code: 'error'`, the same reason text, and an error log, so the
option never relabels a real startup failure as an interruption. Either way the start
still emits `component:start-failed` and returns to the state it had before the
attempt, which releases its dependencies to the pass. A start that ignores the cue and
resolves is stopped by the pass, as it is without the option. `startAllComponents()`
already answers `shutdown_in_progress` for any startup a shutdown interrupts. With
`allowStopWithPendingStarts`, pending starts are aborted too - the pass is about to
stop the dependencies they use - but not waited for. With `waitForAbandonedStarts`
there is nothing to reconcile: the starts it waits for timed out, and their signals are
already aborted. `restartAllComponents()` always keeps `abortPendingStarts` disabled,
as it does the two options above: its stop phase is not a request to stay down, and the
starts it would interrupt are ones the restart waits for and then starts again -
cancelling them would only turn a slow start into a failed one ahead of the same
start, and a global `true` meant for signal or logger shutdowns must not reach a
restart.

```typescript
const lifecycle = new LifecycleManager({
  logger,
  // SIGTERM / logger.exit(): tell pending starts to give up, then wait for them.
  shutdownOptions: { timeoutMS: 10000, abortPendingStarts: true },
});
```

A shutdown requested synchronously from `start()` also skips joining that requesting
start and preserves its dependencies, so the hook can await the result. It first
yields one timer turn so an immediately rejected start can settle and release its
dependencies before the pass decides what to protect.
A request made through the component's own handle, `this.lifecycle.stopAllComponents()`
or `this.lifecycle.restartAllComponents()`, is treated the same way even after the hook
has already yielded (for example, after an earlier `await`), so `start()` can await it at
any point.
A request made through the manager itself after the hook has yielded cannot be
identified as re-entry across all supported runtimes. Awaiting that shutdown can
consume its finite budget, or wait indefinitely when both startup and shutdown
deadlines are disabled. Use `this.lifecycle` inside `start()`, or request shutdown
without awaiting it (`void manager.stopAllComponents()`) and let `start()` finish so
shutdown can clean it up.

Startup rollback likewise preserves dependencies of independent work and pending late startup recovery, including a required start that timed out. Rollback is best-effort: `startedComponents` reports components left running, and a later shutdown is needed after recovery settles.
Individual stop/restart and unregister-with-stop refuse running or starting
dependents unless their explicit override is enabled.

The shutdown process has three phases:

1. **Global Warning Phase** (manager-level timeout)
   - Calls `onShutdownWarning()` on all running components
   - Best for quick, non-blocking prep (stop accepting new work)
   - Avoid long-running persistence here, treat it as best-effort and minimal
   - Non-blocking - components continue running and there is no cancellation signal

2. **Graceful Phase** (per-component timeout)
   - Calls `stop(signal)` on each component in reverse dependency order
   - Components shut down cleanly
   - At `shutdownGracefulTimeoutMS` the signal is aborted (see [Stop Abort Signals](#stop-abort-signals))
   - Timeout or error triggers force phase for that component

3. **Force Phase** (per-component)
   - Calls `onShutdownForce(signal)` with a fresh signal, aborted at `shutdownForceTimeoutMS`, or earlier if a late graceful completion ends the force phase first
   - Called if graceful `stop()` times out or throws
   - Also called (skipping graceful) when retrying a previously stalled component via `retryStalled: true`
   - Component is marked as `stalled` if force phase is not implemented, times out, or throws
   - Manager stops after the first stop failure or refusal by default (set `haltOnStall: false` to continue independent cleanup). A component already being stopped or started by another operation does not halt it

```typescript
class WorkerComponent extends BaseComponent {
  private activeJobs = new Set<Job>();

  async onShutdownWarning() {
    // Global warning - stop accepting new work
    this.acceptingWork = false;
    this.logger.info('Shutdown warning received, stopping new work');
  }

  async stop() {
    // Graceful phase - wait for active jobs to complete
    this.logger.info('Waiting for active jobs to complete...');
    await this.waitForJobs(this.activeJobs);
    this.logger.success('All jobs completed');
  }
}
```

### Stop Abort Signals

`stop(signal)` and `onShutdownForce(signal)` each receive an `AbortSignal`, the same
way `start(signal)` does (see [Startup Abort Signal](#startup-abort-signal)), under the
same rule: a signal aborts when the manager no longer needs that still-pending call's
work - at the call's deadline, or, for `onShutdownForce()`, when the `stop()` it
escalated from finishes first within the same stop - and never because the call itself
resolved, rejected or threw. `signal.reason` tells the two force aborts apart (see the
[reasons table](#abort-signals-at-a-glance)).

- **`stop(signal)`** gets a fresh signal for each graceful stop attempt. It is aborted
  when the component's `shutdownGracefulTimeoutMS` (or a `stopComponent()` `timeout`)
  passes while `stop()` is still pending, with that timeout's
  `ComponentStopTimeoutError` as `signal.reason` - the error the
  `component:stop-timeout` event carries, and the stop result's `error` when there is
  no force handler to escalate to.
- **`onShutdownForce(signal)`** gets its own fresh signal for each force attempt -
  escalation after a failed graceful phase, a `forceImmediate` stop, and a stalled
  component's retry (`stopAllComponents({ retryStalled: true })`) alike - never the
  graceful phase's. It is aborted when `shutdownForceTimeoutMS` passes while the call
  is still pending, with a `ComponentForceTimeoutError` (`errCode: 'ForceTimeout'`,
  message `Force shutdown timed out`) - the error the stalled result carries as
  `error` - as `signal.reason`. It is also aborted when the graceful `stop()` it
  escalated from - still running, since a promise cannot be cancelled - completes late
  and ends the force phase before its deadline while the call is still pending - or,
  for a stalled component's retry, when an earlier attempt of the stop it retries
  completes late. All of those calls belong to the one stop of the component; no other
  operation can trigger this. The component did stop, so
  the stop answers success, the call's work is no longer needed, and the signal says
  so with a `ForceShutdownSupersededError` (`errCode: 'ForceSuperseded'`, message
  `Force shutdown superseded: component already stopped`) as `signal.reason`. That abort
  happens with timeouts disabled too. It is not a failure: the force deadline did not
  pass. A call that settled itself in the same moment is not aborted.

Neither signal is aborted because its call resolved, rejected or threw, nor at a
deadline with timeouts disabled (`0`). A `stopAllComponents()` /
`restartAllComponents()` `timeoutMS` does not abort them either: it halts the pass's
further stops, while the stop in progress keeps its own per-component deadlines, which
abort as usual. Every path that stops a component runs these same phases, so the
signals behave identically for `stopComponent()`, `stopAllComponents()`,
`restartComponent()` / `restartAllComponents()`, `unregisterComponent()` with
`stopIfRunning`, startup rollback, and late-start cleanup.

A graceful phase whose `stop()` settles promptly once its signal aborts still wins the
race as the success it is - the timeout's rejection waits one macrotask after the
abort - so a component that honors the
signal can finish its stop without entering the force phase:

```typescript
class ServerComponent extends BaseComponent {
  async stop(signal: AbortSignal) {
    // Graceful: wait for keep-alive connections to drain...
    const closed = new Promise<void>((resolve) =>
      this.server.close(() => resolve()),
    );
    // ...until the manager gives up on the graceful phase.
    signal.addEventListener('abort', () => this.server.closeAllConnections());
    await closed;
  }

  async onShutdownForce(signal: AbortSignal) {
    await this.flushQueue({ signal });
  }
}
```

A call that honors its signal by rejecting instead - say
`await setTimeout(5000, undefined, { signal })` from `node:timers/promises`, which
rejects with an `AbortError` - is answered as the timeout it was told of, even when its
rejection reaches the race before the deferred deadline does: `code:
'component_shutdown_timeout'`, the `component:stop-timeout` (or
`component:shutdown-force-timeout`) event, and the stall reason a timeout leaves, with
the timeout error - `signal.reason` - as the result's `error`. Its own rejection is
logged as a stop that failed after its deadline fired. Linked follows the start
signal's rule (see [Startup Abort Signal](#startup-abort-signal)): the thrown value is
`signal.reason` itself, an `AbortError`, or carries either on its `cause` chain. Any
other rejection is the call's own failure (`code: 'error'`), as it is before the
deadline. Likewise, an `onShutdownForce()` that rejects linked to a
`ForceShutdownSupersededError` abort is not reported; any other rejection after that
abort is logged as a warning, `Force shutdown failed after graceful stop completed`.

Abort listeners run synchronously inside the manager's timer: keep them fast. As with
the start signal, an `'abort'` listener added through the signal's own
`addEventListener()` or `onabort` that throws (or rejects) is reported on the global
`'error'` channel - as `lifecycle-manager stop abort listener for <name>` or
`lifecycle-manager force abort listener for <name>` - instead of becoming an uncaught
exception, and the listeners after it and the timeout handling still run.
Listeners on a derived signal, or added through `EventTarget.prototype` directly, are
not guarded. Declaring `stop()` or `onShutdownForce()` without the parameter is
valid: the component never sees the signal, and its stop timeouts, escalation and
late-completion handling apply as described here.

## API Reference

### LifecycleManager Constructor

```typescript
new LifecycleManager(options: LifecycleManagerOptions)
```

**Options:**

```typescript
interface LifecycleManagerOptions {
  name?: string; // Manager name for logging (default: 'lifecycle-manager')
  logger: Logger; // Logger instance (required)
  startupTimeoutMS?: number | null; // Global timeout for startup in ms (default: 60000, 0 = disabled)
  shutdownOptions?: StopAllOptions; // Default stopAll options for shutdown hooks (defaults: timeoutMS=30000, retryStalled=true, haltOnStall=true)
  shutdownWarningTimeoutMS?: number | null; // Global warning phase timeout in ms (default: 500, 0 = fire-and-forget, <0 = skip)
  messageTimeoutMS?: number | null; // Default message timeout in ms (default: 5000, 0 = disabled)
  attachSignalsBeforeStartup?: boolean; // Auto-attach signals before startAllComponents()/startComponent() begins work, even if startup later fails (default: false)
  attachSignalsOnStart?: boolean; // Auto-attach signals when the first component comes up (no other component is up) and none are attached (default: false)
  detachSignalsOnStop?: boolean; // Auto-detach signals when last component stops (default: false)
  enableLoggerExitHook?: boolean; // Auto-enable logger exit hook integration (default: false)

  // Custom signal handlers (optional)
  onReloadRequested?: (
    broadcastReload: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
  onInfoRequested?: (
    broadcastInfo: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
  onDebugRequested?: (
    broadcastDebug: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
}
```

### Component Registration

#### `registerComponent(component, options?)`

Register a component with the manager.

```typescript
registerComponent(
  component: BaseComponent,
  options?: RegisterOptions
): Promise<RegisterComponentResult>
```

**Options:**

```typescript
interface RegisterOptions {
  autoStart?: boolean; // Auto-start component if possible (default: false)
}
```

**Returns:**

```typescript
interface RegisterComponentResult {
  action: 'register';
  success: boolean;
  registered: boolean;
  componentName: string;
  reason?: string;
  code?: RegistrationFailureCode;
  error?: Error;
  registrationIndexBefore: number | null;
  registrationIndexAfter: number | null;
  startupOrder: string[]; // empty on a refusal made before every dependency list was read, or an unexpected failure
  duringStartup?: boolean; // true if registered during bulk startup
  autoStartAttempted?: boolean; // includes an auto-start refused before start() is called
  autoStartDeferred?: boolean; // true if left to the upcoming restart startup or a bulk startup batch
  autoStartSucceeded?: boolean; // true if auto-start succeeded
  startResult?: ComponentOperationResult; // result of auto-start (if attempted)
}
```

**Registration Constraints:**

- **Single Manager Binding**: A component instance can only be registered with one `LifecycleManager` at a time. Attempting to register a component instance that is already registered (either with the same manager under a different name, or with a different manager instance) will fail with `code: 'duplicate_instance'`.
- **Unique Name Constraint**: The component name must be unique within a manager instance. Registering a component with a name that is already taken will fail with `code: 'duplicate_name'`. That holds even when a component's own code registers the name while the registration is in progress, for example from `getDependencies()`: registration checks again right before it commits.
- **Unsupported Timeout Hooks**: A component that defines `onStartupAborted()`, `onGracefulStopTimeout()` or `onShutdownForceAborted()` - as its own property or an inherited one, with any value other than `undefined`, including through a getter that returns one or throws - is refused with `code: 'invalid_options'` and a reason naming each such hook and the abort signal to use instead (see [Abort Signals at a Glance](#abort-signals-at-a-glance)); a component that cleans up its own late start sets [`ownsLateStartCleanup: true`](#late-start-cleanup). It is checked by both `registerComponent()` and `insertComponentAt()`, before any component's dependency list is read, so the refusal reports an empty `startupOrder`.
- **Bulk Operation Guard**: Registration/insertion is blocked while the manager is shutting down (`isShuttingDown = true`), failing with `code: 'shutdown_in_progress'`. During startup (`isStarting = true`), registration/insertion is only blocked when the new component is a required dependency of an already-registered component, failing with `code: 'startup_in_progress'`.

**Example:**

```typescript
const result = await lifecycle.registerComponent(new DatabaseComponent(logger));

if (!result.success) {
  console.error('Registration failed:', result.reason);
}
```

#### `insertComponentAt(component, position, targetComponentName?, options?)`

Insert a component at a specific position.

```typescript
insertComponentAt(
  component: BaseComponent,
  position: 'start' | 'end' | 'before' | 'after',
  targetComponentName?: string,
  options?: RegisterOptions
): Promise<InsertComponentAtResult>
```

**Example:**

```typescript
// Insert cache before database
await lifecycle.insertComponentAt(
  new CacheComponent(logger),
  'before',
  'database',
);
```

**Returns:**

```typescript
interface InsertComponentAtResult {
  success: boolean;
  reason?: string;
  code?: RegistrationFailureCode;
  error?: Error;
  registered: boolean;
  action: 'insert';
  requestedPosition: {
    position: InsertPosition | (string & {});
    targetComponentName?: string;
  };
  actualPosition?: {
    index: number; // The actual registry index where the component was inserted
    description?: string; // Human-readable position description (e.g., "after database, before api")
  };
  manualPositionRespected?: boolean; // True/false when order is known; undefined when unavailable
  targetFound?: boolean; // Whether 'before'/'after' reference component was found (always `undefined` for 'start'/'end')
}
```

**Position Debugging Fields:**

- `requestedPosition` - What you asked for (position type and optional target component)
- `actualPosition` - Where it actually ended up after dependency resolution, read when the call returns. Present when the component is still registered then - not when a listener removed it again during its auto-start
  - `index` - The registry array index (0-based)
  - `description` - Human-readable position like `"at start"`, `"at end"`, `"after database, before api"`, or `"only component"`
- `manualPositionRespected` - `true` if the explicit position was honored, `false` if dependency ordering forced a different position, and `undefined` when startup order is unavailable or insertion was refused
- `targetFound` - For 'before'/'after' positions, indicates if the reference component was found (always `undefined` for 'start'/'end')

**Example:**

```typescript
const result = await lifecycle.insertComponentAt(
  new CacheComponent(logger),
  'before',
  'database',
);

console.log(result.actualPosition);
// { index: 2, description: "after config, before database" }
```

#### `unregisterComponent(name, options?)`

Unregister a component (stops it if running).

```typescript
unregisterComponent(
  name: string,
  options?: UnregisterOptions
): Promise<UnregisterComponentResult>
```

**Options:**

```typescript
interface UnregisterOptions {
  stopIfRunning?: boolean; // Stop the component first if it's running (default: true)
  forceStop?: boolean; // Allow stopping even if running dependents exist (default: false)
}
```

**Notes:**

- `forceStop` only applies when `stopIfRunning` is true (passes through to `stopComponent` as `allowStopWithRunningDependents`).
- A stop that refuses before it runs `stop()` is answered with the unregister's own code for that refusal rather than `stop_failed`: running dependents without `forceStop` give `component_running`, a start or stop that owns the component `component_starting` / `component_stopping`, a bulk startup or shutdown `bulk_operation_in_progress`, and an invalid timeout `invalid_options`. The component stays registered, in the state it was in.
- If a component is stalled and `stopIfRunning` is true, unregister is blocked.
- While a start or stop is in flight, unregister is refused with `component_starting` / `component_stopping`: the operation writes its outcome when it settles, so the component has to be left registered until then. This is checked again after unregister's own stop, since a `component:stopped` listener may have started the component again; one that is already back up is refused with `component_running`.
- The registration itself is rechecked immediately before anything is removed, on every path. Reading `stopIfRunning` and `forceStop` off the options object runs caller code, so a getter can unregister the component and register a replacement under the same name before the removal begins. The call then reports `component_not_found`, and the replacement keeps the name and its state. If the getter instead started a bulk startup or shutdown without replacing the component, the usual refusals are checked first, in this order: a start or stop in flight (`component_starting` / `component_stopping`), a stalled component with `stopIfRunning` true (`stop_failed`), and a running component with `stopIfRunning: false` (`component_running`). Otherwise the call reports `bulk_operation_in_progress` before stopping or removing anything.
- Successfully unregistering a component automatically clears its `lifecycle` reference (setting it to `undefined`) and marks it as unregistered, which allows the same component instance to be registered again (either with the same manager or with a different one).

**Returns:**

```typescript
interface UnregisterComponentResult {
  success: boolean;
  componentName: string;
  reason?: string;
  code?: UnregisterFailureCode;
  error?: Error;
  stopFailureReason?: UnregisterStopFailureReason;
  wasStopped: boolean;
  wasRegistered: boolean;
}
```

**Failure codes:** See the centralized list in [Failure Codes](#failure-codes).

**Stop failure reasons:**

- `'stalled'` - Component was already stalled from an earlier stop, so no stop was attempted. A stop this unregister runs that ends in a stall is reported by how it failed (`'timeout'`, `'error'` or `'operation_crashed'`), with the component left `stalled`
- `'timeout'` - Component stop timed out
- `'error'` - Component stop threw an error
- `'operation_crashed'` - The stop itself crashed; the component may be left stalled or still running

### Lifecycle Operations

#### `startAllComponents(options?)`

Start all registered components in dependency order.

```typescript
startAllComponents(options?: StartupOptions): Promise<StartupResult>
```

**Options:**

```typescript
interface StartupOptions {
  ignoreStalledComponents?: boolean; // Allow bulk startup to proceed by skipping stalled components
  timeoutMS?: number | null; // Startup time budget, excluding failure rollback (default: constructor's startupTimeoutMS)
}
```

**Returns:**

```typescript
interface StartupResult {
  success: boolean;
  startedComponents: string[];
  failedOptionalComponents: Array<{ name: string; error: Error }>;
  skippedDueToDependency: string[];
  skippedDueToStall?: string[]; // Actually skipped with ignoreStalledComponents, on any outcome
  blockedByStalledComponents?: string[]; // Present when stalled components blocked startup
  durationMS?: number; // Total startup duration in milliseconds
  timedOut?: boolean; // True if startup timed out
  reason?: string; // Reason for failure (when success is false)
  code?:
    | 'already_in_progress'
    | 'component_unexpected_stop' // A required component reported an unexpected stop before startup completed
    | 'shutdown_in_progress'
    | 'dependency_cycle'
    | 'no_components_registered'
    | 'stalled_components_exist'
    | 'partial_state' // Components already running or independently starting/stopping
    | 'required_component_failed' // Required component failed to start
    | 'shutdown_requested_during_restart' // restartAllComponents() skipped its startup phase
    | 'signal_attach_failed' // attachSignalsBeforeStartup / attachSignalsOnStart could not attach process signals
    | 'startup_timeout'
    | 'invalid_options'
    | 'operation_crashed'; // The startup itself threw - see "Promises Never Reject"
  error?: Error; // Error object (when success is false due to dependency cycle or a crash)
}
```

An individual start still in flight makes bulk startup return `partial_state`,
with already-running components retained in `startedComponents` and pending
starts excluded. A refusal for components still stopping likewise retains running
siblings, excluding components in graceful or force teardown. If
an independently owned start or stop is encountered mid-pass, the bulk pass stops without
rolling back its already-started components or taking ownership of the pending
operation. The pending component is not counted as successfully started. Preflight
snapshots are taken after their log callbacks and exclude teardown. Even the
all-running shortcut returns `partial_state` if those callbacks change availability.
Startup interrupted by shutdown also excludes components already in teardown from
its `startedComponents` snapshot. Rollback failure reports likewise list the
components still up after the rollback - the ones it could not stop - and exclude any
still in teardown; a component the rollback left stalled is reported by the stalled
APIs (`getStalledComponentNames()`), not as started.
An independent operation includes late cleanup owned by an earlier timed-out start;
a subsequent bulk pass encountering it returns `partial_state` without taking over
that cleanup or rolling back components it may still depend on. If cleanup is already
stopping when preflight runs, the reason is `Components are still stopping: <names>`,
and the pass does not start any components. If the startup loop encounters the cleanup
after preflight, the reason is
`Component "<name>": Timed-out startup is still awaiting completion or cleanup`.
A preflight refusal stays refused even if its log callback changes the state. When
counts or bulk-operation latches change, its reason distinguishes the original
running fraction from the current snapshot and identifies a newly active shutdown
or startup. Otherwise, the concise refusal reason is unchanged.

`skippedDueToStall` lists stalled components the pass actually skipped, including
on timeout and failure results. It is absent when no stalled components were
skipped; it is separate from dependency skips and from components that blocked
startup outright. A component that depends on a stalled one skipped this way is
itself skipped (listed in `skippedDueToDependency`) only when the stalled one is
required; an optional stalled dependency does not block it, as an optional one that
failed or was skipped does not.

**Timeout Behavior:**

Timeouts operate at **two independent levels** - they don't compete, they're layered:

Lifecycle timer delays are capped at 2,147,483,647 ms, including positive `Infinity`.
Optional timeout settings use their defaults for `null` or `undefined`. `NaN`, other
non-number values, and unsupported negative durations are configuration errors. Constructors throw a
`TypeError` for invalid numeric input or `RangeError` for a negative duration. Public
manager operations preserve their never-reject contract: an invalid override or
component timeout returns `code: 'invalid_options'` with an error naming the option.
Expected validation refusals do not emit a global callback-error report. Health and
signal broadcasts identify `invalid_options` in their per-component results while
retaining their aggregate error codes. An invalid shared message-broadcast timeout
returns an empty array before dispatching any recipient.

Restart validates and snapshots startup timeouts for existing registrations before
stopping components. Invalid configuration leaves healthy components running so you
can correct it and retry. Graceful stop also validates its force timeout before calling
`stop()`.

Individual restart returns pre-stop refusals directly, including `component_not_found`,
`component_not_running`, `component_stalled`, `component_already_starting`,
`component_already_stopping`, `has_running_dependents`, and `invalid_options`.
`restart_stop_failed` applies only once the restart has claimed a stop attempt, so
callers need to handle these refusal codes alongside it. As with `stopComponent()`, a
component with active dependents answers `has_running_dependents` (unless
`stopOptions.allowStopWithRunningDependents` is set) before the component's timeouts are
read or any timeout is validated.

Each operation reads its options once, every field in a fixed order, at its start - after
the refusals that need no options - so an option getter runs at most once per call and
later changes to the object do not reach a call already under way.

Availability refusals take precedence over options that would never be used: an active
bulk startup returns `already_in_progress` without reading new options, and messages
to missing, unavailable, or handlerless components retain `not_found`, `stopped`,
`stalled`, or `no_handler`. `restartComponent()` is the exception: it reads its
`stopOptions` and `startOptions` before its `component_not_found`,
`component_not_running` and `has_running_dependents` refusals (after only the refusal
for a bulk operation in progress), so a throwing option getter answers
`operation_crashed` even for a component that is missing or not running. Broadcast validates its shared budget before dispatching
any recipients. A message that can be dispatched validates its budget before emitting
`message-sent` or invoking the handler.

Zero means disabled wherever an option documents it. BaseComponent graceful and force
timeouts enforce their 1,000ms and 500ms minimums after validation.
The warning phase is the exception for negatives: any negative duration skips
the warning phase entirely. HTTP request timeouts have their own documented
disable sentinels; logger/sink zero budgets expire immediately. All modules share the
same numeric validation; these per-option meanings apply on top of it.

Validate environment-derived values before passing them in, or omit an unset option:
`Number(undefined)` is `NaN`, which is rejected as a configuration error.

**1. Global Timeout (Bulk Operation)**

- `startAllComponents({ timeoutMS })` sets a time budget for starting components. Failure rollback uses its own shutdown timeouts
- If exceeded: manager stops initiating new components and promptly returns a snapshot of partial results with `timedOut: true` and `code: 'startup_timeout'`. Unexpected stops reported by timeout logging, including further stops reported by reconciliation getters or logs, are drained first: a required stop returns `component_unexpected_stop` after rollback, while an optional stop is recorded in `failedOptionalComponents`. Shutdown begun by the final timeout warning or reconciliation callbacks returns `shutdown_in_progress`; shutdown owns teardown, so startup does not begin a competing rollback.
- The remaining bulk budget also bounds the current component start, even when its own timeout is disabled. Previously started components remain running unless rollback had already begun for a separate failure.
- A start still in flight has its start signal aborted. Restart and unregistration are allowed while the abandoned start remains pending. If it later resolves and still owns the component, automatic cleanup stops it, even for a component with `ownsLateStartCleanup: true`. Recovery is blocked only while that cleanup runs. A stale completion cannot stop a retry or replacement.
- Once a required failure starts rollback, the startup timer is cleared. Startup waits for rollback and returns the original failure. Another bulk startup is blocked until rollback finishes.
- Timeouts cannot preempt synchronous JavaScript that blocks the event loop.
- Constructor option sets the default: `new LifecycleManager({ startupTimeoutMS: 60000 })`
- Method parameter overrides: `await lifecycle.startAllComponents({ timeoutMS: 30000 })`

**2. Per-Component Timeout (Individual Component)**

- Each component's `startupTimeoutMS` (default 30s) controls only that component's `start()` method
- If exceeded on **required component** (default): enters `starting-timed-out` state and triggers **rollback**
- If exceeded on **optional component**: enters `failed` state and startup **continues**

**Example:**

```typescript
// Global: 60s for entire startup operation
await lifecycle.startAllComponents({ timeoutMS: 60000 });

// Required component with 5s timeout (default behavior)
class ComponentA extends BaseComponent {
  constructor() {
    super(logger, { name: 'A', startupTimeoutMS: 5000 });
  }
}

// Optional component with 5s timeout
class ComponentB extends BaseComponent {
  constructor() {
    super(logger, { name: 'B', startupTimeoutMS: 5000, optional: true });
  }
}

// If required Component A's start() takes 6 seconds:
// - Component A enters 'starting-timed-out' state (exceeded its 5s timeout)
// - Startup STOPS and rolls back all started components
// - Returns { success: false, code: 'required_component_failed', reason: '...', error: ... }
//
// If optional Component B's start() takes 6 seconds:
// - Component B enters 'failed' state (exceeded its 5s timeout)
// - Startup CONTINUES with Component C (global 60s timer still has 54s left)
// - Returns { success: true, failedOptionalComponents: [{ name: 'B', ... }] }
//
// If global 60s expires while Component C is starting:
// - Manager stops initiating new starts after timeout; current start may still run
//   until its per-component timeout (if any) elapses
// - Returns { success: false, timedOut: true, code: 'startup_timeout', startedComponents: [...], ... }
```

**More Examples:**

```typescript
// Use constructor's default timeout (60s)
await lifecycle.startAllComponents();

// Override with custom timeout (30s)
await lifecycle.startAllComponents({ timeoutMS: 30000 });

// Disable global timeout (wait indefinitely)
await lifecycle.startAllComponents({ timeoutMS: 0 });
```

#### `stopAllComponents(options?)`

Stop all running components in reverse dependency order.

```typescript
stopAllComponents(options?: StopAllOptions): Promise<ShutdownResult>
```

**Parameters:**

- `options` (optional) - `StopAllOptions` object. If omitted, uses the constructor's `shutdownOptions.timeoutMS` value (default: 30000ms).

**StopAllOptions:**

```typescript
interface StopAllOptions {
  timeoutMS?: number | null; // Global shutdown timeout (default: 30000, 0 = disabled)
  retryStalled?: boolean; // Retry components that were previously stalled (default: true)
  haltOnStall?: boolean; // Stop processing after a stop failure or refusal (default: true)
  allowStopWithPendingStarts?: boolean; // Release pending starts' dependency protection (default: false)
  waitForAbandonedStarts?: boolean; // Wait, within timeoutMS, for starts already past startupTimeoutMS (default: false)
  abortPendingStarts?: boolean; // Abort in-flight starts' signals as the pass begins; still waits for them (default: false)
}
```

**Option Details:**

- `retryStalled`: If `true`, attempts to stop components that are currently in the `stalled` state from previous shutdown attempts. If `false`, skips components already marked as stalled (under `haltOnStall: true` their dependencies stay up, as below). **Note:** retry goes directly to the force phase (`onShutdownForce`), not the graceful phase. `stop()` is not called again. The assumption is that graceful already had its chance, and the retry is an escalation. A retry keeps the original stall's start time: a component without `onShutdownForce` attempts nothing new, so it stays stalled under its original record and answers with that stop's result without emitting `component:shutdown-force` or `component:stalled`. A retry that runs `onShutdownForce` emits `component:shutdown-force` describing only that attempt (`gracefulPhaseRan: false`, `gracefulTimedOut: false`). If it succeeds it emits `component:stalled-resolved`; if it fails again it records a fresh force-phase stall: `reason: 'timeout'` when `onShutdownForce` times out again, otherwise `'both'` when the original graceful phase timed out and `'error'` when it did not. Its `component:stalled` carries the new record, which replaces the earlier one rather than ending it: the stall never cleared, so no `component:stalled-resolved` comes between the two, and the one that ends the stall carries the latest record.
- `haltOnStall`: If `true`, stops processing remaining components after a stop failure or refusal, including invalid configuration. If `false`, continues independent cleanup. Either way, a component another operation is already stopping or starting does not halt the pass: its dependencies are skipped while that work is in flight, and the pass goes back to them once if it has settled by the end of the loop. The pass does not wait for that work. Nor does a stall the pass leaves as it found it - one skipped with `retryStalled: false`, or a retry that attempts nothing because the component has no `onShutdownForce` - halt it: that is no new failure, so the component stays stalled and is reported under `Stalled:`, and the pass goes on to the components after it. Under `haltOnStall: true` that stall's dependencies stay up while it remains stalled - its stalled stop may still be using them - and are reported under `Not attempted:`; unrelated components are stopped. Under `haltOnStall: false` they are stopped like any other. If a concurrent stop stalls before the pass reaches its next component, `haltOnStall: true` halts the remaining stops, including when `retryStalled` is false. Dependencies of any component still running after a failed stop remain protected, including when a getter throws before cleanup starts. The aggregate result stays unsuccessful; validation refusals retain `invalid_options`, also for a component still starting as the pass began, whose stop runs once its `start()` settles. Its `reason` names components the pass never tried to stop under `Not attempted:` - those a `haltOnStall` break never reached, and dependencies left running because a component still up after a failed stop, or a stall the pass left as it was, needs them - apart from the ones whose stop actually failed (`Failed to stop:`).

**Timeout Behavior:**

Timeouts operate at **two independent levels** - they don't compete, they're layered:

**1. Global Timeout (Bulk Operation)**

- `stopAllComponents({ timeoutMS })` sets a total time budget for the entire shutdown operation
- If exceeded: the public call promptly returns partial results and releases the bulk shutdown latch. A stop already in flight continues under its component timeouts. The timed-out shutdown pass initiates no further stops and joins no further pending starts. Deferred logger exits can proceed, so components are not guaranteed to finish before process exit.
- Components not yet processed are left in their current state. A later shutdown attempt will not overlap an unfinished stop or stop its dependencies while that stop remains in flight.
- Constructor option sets the default: `new LifecycleManager({ shutdownOptions: { timeoutMS: 30000 } })`. An explicit invalid duration is refused at construction or returned as a failed shutdown request; `null` or `undefined` selects the default.
- Method parameter overrides: `await lifecycle.stopAllComponents({ timeoutMS: 5000 })`

**2. Per-Component Timeouts (Individual Component)**

- Each component's `shutdownGracefulTimeoutMS` (default 5s) and `shutdownForceTimeoutMS` (default 2s) control its individual shutdown phases
- If the graceful phase exceeds its timeout or throws, and the force phase is unavailable or also fails, that component becomes stalled. With the default `haltOnStall: true` the pass stops there; with `haltOnStall: false` it continues with the next component

**Example:**

```typescript
// Global: 30s for entire shutdown operation
await lifecycle.stopAllComponents({ timeoutMS: 30000 });

// Component A has 3s graceful timeout and no onShutdownForce()
class ComponentA extends BaseComponent {
  constructor() {
    super(logger, { name: 'A', shutdownGracefulTimeoutMS: 3000 });
  }
}

// If Component A's stop() never settles:
// - At 3s its graceful phase times out; with no force phase, Component A becomes stalled
// - With the default haltOnStall: true, the pass stops there: Component B and the rest
//   are not attempted (listed under `Not attempted:` in the result's `reason`)
// - With haltOnStall: false, the pass continues with Component B (global 30s timer
//   still has 27s left)
// A stop() that resolves after its timeout - at 4s, say - clears the stall and records
// Component A stopped, but the pass has already treated it as stalled.
//
// With haltOnStall: false, if global 30s expires while Component C is stopping:
// - Manager stops initiating new stops after timeout; current stop may still run
//   until its per-component timeout (if any) elapses
// - Returns { success: false, timedOut: true, stoppedComponents: ['B'], stalledComponents: [...] }
```

**More Examples:**

```typescript
// Use constructor's default timeout (30s)
await lifecycle.stopAllComponents();

// Override with custom timeout (5s)
await lifecycle.stopAllComponents({ timeoutMS: 5000 });

// Disable global timeout (wait indefinitely)
await lifecycle.stopAllComponents({ timeoutMS: 0 });

// Retry stalled components in this shutdown pass
await lifecycle.stopAllComponents({ retryStalled: true });

// Stop processing after the first stall
await lifecycle.stopAllComponents({ haltOnStall: true });

// Continue shutdown even if a component stalls
await lifecycle.stopAllComponents({ haltOnStall: false });

// Skip retrying previously stalled components
await lifecycle.stopAllComponents({ retryStalled: false });
```

**Returns:**

```typescript
interface ShutdownResult {
  success: boolean;
  stoppedComponents: string[];
  stalledComponents: ComponentStallInfo[];
  durationMS: number;
  timedOut?: boolean;
  reason?: string;
  code?:
    | 'already_in_progress'
    | 'shutdown_timeout'
    | 'cleanup_incomplete'
    | 'partial_state' // Preparation refused, or shutdown left stalled/running components
    | 'invalid_options'
    | 'operation_crashed';
  error?: Error; // operation_crashed: the thrown value. invalid_options: the option validation error - the call's own, or that of a component stop the pass refused, leaving its component up (kept here under cleanup_incomplete too)
}
```

**Note:** If `timedOut` is `true`, `success` will be `false` even if no components stalled.

A pass that throws outright - a bug in the manager, or a component getter that throws - resolves with `code: 'operation_crashed'` and the thrown value on `error`, rather than rejecting. It still emits `lifecycle-manager:shutdown-completed` with the same result and updates `getLastShutdownResult()`, lists the components it had already stopped, and arms the escalation window like any other failed pass.

**From inside shutdown listeners:** `lifecycle-manager:shutdown-completed` and `shutdown-escalation-armed` run while the pass still holds its latch, so a call made from one returns `already_in_progress`. Defer it (`setImmediate`, `queueMicrotask`) or `await` this method's promise instead.

**Background use:** the promise never rejects, so a caller that cannot block - an HTTP handler, an event listener - can start a shutdown without awaiting it and read the outcome later. See [Running Operations in the Background](#running-operations-in-the-background). A call made while a shutdown is already running resolves at once with `already_in_progress`.

**Escalation:** calls made while a shutdown is running **never** count toward [`repeatedShutdownRequestPolicy`](#repeated-shutdown-request-policy), whatever `countManualRetriesTowardEscalation` says. Escalation represents an operator pressing Ctrl+C again; overlapping programmatic callers are not expressing that, so a burst of them can never force-kill the process. The flag only covers a deliberate retry after a failed pass: with it enabled, a call made while escalation is still armed counts once and can reach `forceAfterCount`, and the retry pass still starts. A manual call does not emit `signal:shutdown`, which describes a real OS signal; observe `lifecycle-manager:shutdown-initiated` instead.

#### `restartAllComponents(options?)`

Stop all components, then start them again.

```typescript
restartAllComponents(options?: RestartAllOptions): Promise<RestartResult>

interface RestartAllOptions {
  startupOptions?: StartupOptions;     // Options for the start phase
  shutdownTimeoutMS?: number | null;         // Timeout for the shutdown phase
  // Note: retryStalled and haltOnStall are hardcoded to true during restart shutdown
}
```

**Returns:**

```typescript
interface RestartResult {
  shutdownResult: ShutdownResult;
  startupResult: StartupResult;
  startupSkippedByShutdownRequest?: boolean; // Present and true when a shutdown request canceled the startup phase
  success: boolean; // True only if both phases succeeded
}
```

**Important:** `restartAllComponents` hardcodes `retryStalled: true` and `haltOnStall: true` for the shutdown phase to ensure clean restart. Only `shutdownTimeoutMS` can be customized.

A restart that meets a bulk startup in progress - called during one, or one begun by
its own option getters or log sinks while it prepares - is refused before stopping
anything, with `startupResult.code` `already_in_progress` and `shutdownResult.code`
`partial_state`: its stop phase would interrupt that startup, and its own startup phase
would then be refused while the interrupted one unwound. One that meets an active
shutdown is refused with `startupResult.code` `shutdown_in_progress`.

Restart checks existing components' startup timeout settings before stopping them.
It saves those settings for registrations that remain unchanged. It also checks the
stop budgets its stop phase will use - `shutdownGracefulTimeoutMS` of each running
component, and `shutdownForceTimeoutMS` of each running or stalled component that
implements `onShutdownForce()` - so an invalid one refuses the restart with
`invalid_options` before any component is stopped, rather than halting the stop phase
partway with some components already down. That includes a component the check had
already passed while it was idle, started by caller code that runs during it - another
component's getter, or a sink of the `Restarting all components` log. If the registry
changes during this
initial check, restart logs a warning and refuses both phases with `partial_state`,
before stopping anything. A start that already timed out with its `start()` still
unresolved is refused the same way, with `shutdownResult.code` `cleanup_incomplete`
(see [Multi-Phase Shutdown](#multi-phase-shutdown)).

Restart skips its startup phase, logs a warning, and answers `partial_state` for
`startupResult` when the stop phase timed out, left cleanup incomplete, or ended with
components still running - a `haltOnStall` break, a stop that failed and left its
component up, or the dependencies of a stall its retry had nothing to run for. Starting on top of those would only be refused, and would report the
components the stop phase never restarted as started.

**Components included in startup.** The startup phase builds an initial dependency-ordered
list before calling components' `start()` methods. After each batch, it checks for
new `autoStart: true` registrations and starts them in another dependency-ordered
batch. This repeats until no queued auto-starts remain. Components already attempted
by a batch are not retried by that check. This applies to both `startAllComponents()` and restart.
Whether a new component joins depends on when registration happens:

| When registration is attempted                                                         | What happens                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| While shutdown is active, including inside a synchronous `shutdown-completed` listener | Registration is refused with `shutdown_in_progress`.                                                                                                                                                                                                          |
| After shutdown finishes, before bulk startup begins                                    | The new or replacement component is available to the upcoming startup. `autoStart: true` waits for that startup too: registration returns `autoStartDeferred: true` without starting it independently. Components removed before startup begins are left out. |
| During startup, while its order is still being built                                   | Successfully registered components are included in that order. `autoStart: true` is deferred to the bulk startup rather than starting them twice.                                                                                                             |
| After startup has fixed its order and begun starting components                        | By default a new component stays registered without being started by this pass. `autoStart: true` queues it for a follow-up batch and returns `autoStartDeferred: true` immediately; the startup result reports its outcome.                                  |

A deferred registration returns immediately with `autoStartAttempted: false` and
without `startResult`; await the bulk startup or restart result to learn whether
startup succeeded. This lets a component's `start()` await registration without
waiting on its own startup batch. Follow-up batches share the original overall
startup deadline, required-component rollback, and optional-component failure
reporting. They do not get a fresh timeout budget. A deferred auto-start is not an
independent start: if a required one fails - its own `start()`, or a check such as
`dependency_not_running` because its dependency was registered without `autoStart` -
the whole startup rolls back with `required_component_failed`, including the components
the original batch already started. Give the component `optional: true` (a component
option) to have its failure reported in `failedOptionalComponents` instead. If startup exits before reaching a deferred
component, a warning identifies that abandoned auto-start and the exit reason,
including deferred components included in the initial order or left in an
already-fixed follow-up batch. Unattempted components
remain registered; they are not reported as successful or failed starts. Components added from final
completion logs or the `lifecycle-manager:started` notification belong to work after
the completed pass; their auto-start runs independently instead of extending its result.
Success is committed before these notifications. A component that reports an unexpected
stop from either notification still emits its normal stopped event and changes state,
but does not reopen startup rollback. The startup result remains successful and its
`startedComponents` snapshot excludes components no longer running after the callbacks.
The completion event describes the completed pass; use component events/status for
subsequent availability changes. A shutdown begun from either notification is the
exception: `getSystemState()` already answers `shutting-down`, so the result reports
`code: 'shutdown_in_progress'` (reason `Shutdown triggered as startup completed`)
rather than success, while the `lifecycle-manager:started` event stands.
That completion boundary comes after failure reconciliation. Registrations made
while a failed pass is being reconciled cannot escape its rollback by starting
independently. If reconciliation succeeds, its deferred registrations run in
another startup batch under the same deadline and rollback rules. Startup repeats
batch processing and reconciliation until no deferred work remains, or timeout,
shutdown, or failure ends the pass. Follow-up dependency cycles return `dependency_cycle` after rollback,
matching initial-order cycle classification.

An auto-start whose own registration logging (a log sink, say) begins a
`startAllComponents()` or `restartAllComponents()` is left to that operation the same
way, with `autoStartDeferred: true`, rather than refused alongside it.

If restart is canceled or fails before startup takes ownership,
the component remains registered without being started, and a warning identifies
the abandoned auto-start. An explicit `startAllComponents()` that takes the startup
latch first can also take responsibility for these deferred registrations.

During active startup, unregister is refused, so an earlier component's `start()`
cannot replace a later component under the same name. Once startup's order is fixed,
registration is refused if the new component is a required dependency of an
already-registered component, except one queued for a future batch. After a
registration returns `autoStartDeferred: true`, its missing dependencies may be
registered before that batch is ordered. Register those dependencies with
`autoStart: true` to include them in the follow-up batch, or explicitly start them
before the dependent is attempted. `autoStart: false` (or omitting the option)
registers the dependency without starting it; dependency checks still require it
to be running. A required dependent failure can therefore roll back startup.
Earlier registration hooks and log
callbacks run before the auto-start request has been queued, so they do not get
that exception. Once the batch is fixed, the dependency guard applies again.

**Failures from new components.** A required component included in startup can make
restart fail if its startup checks or `start()` fail. That failure can roll back the
new startup; the old components have already stopped. Optional component failures
normally appear in `failedOptionalComponents` while startup continues.
For example, replacing required `db` after shutdown with a component that has an
invalid startup timeout can fail restart; the initial check could not validate a
replacement that did not yet exist. Unchanged registrations still use their saved
timeout settings. Restart does not restore the old registry or running application
on failure.

For predictable restarts, register and configure the intended components before
calling `restartAllComponents()`. If your application changes registrations during
restart, inspect both the registration result and the restart result; successful
registration alone does not mean the component started successfully.

**A shutdown request during the shutdown phase wins.** A `SIGINT`/`SIGTERM`, a `logger.exit()` under [`enableLoggerExitHook()`](#enableloggerexithook), or a direct `stopAllComponents()` call made while the restart is stopping asks the process to stay down, so the restart skips its startup phase instead of bringing every component back up. The result then carries `startupSkippedByShutdownRequest: true`, `startupResult.code` is `shutdown_requested_during_restart`, and `success` is `false` - the restart did not complete. This is checked before the shutdown phase's own outcome, so a stalled or failed stop phase paired with a request still reports the request. `getLastShutdownResult()` is left in place, so the shutdown phase's outcome is still readable afterwards. It is cleared by the next bulk startup - including a restart's startup phase - once that startup has claimed the startup latch and passed its signal-attach and shutdown checks, whatever that startup's outcome. Skipping startup does not stop anything the shutdown phase could not: if `shutdownResult.success` is `false` - a stall or a timeout - some components may still be running, exactly as after any failed shutdown.

**A shutdown phase that throws outright** resolves the restart rather than rejecting it: `shutdownResult` carries the pass's `operation_crashed` result, and the startup phase is skipped - with `startupResult.code` also `operation_crashed` - since nothing can be said about the state the components were left in.

Only the restart that actually runs the shutdown phase can be cancelled this way. A `restartAllComponents()` call made while a shutdown is already running - including one started by another restart - logs a warning and has its own shutdown phase refused with `already_in_progress` and startup refused with `shutdown_in_progress`, before reading unused options or component startup getters. The same early refusal applies if a logger sink starts shutdown from the restart info log; neither restart phase runs. It never reports `startupSkippedByShutdownRequest`, and it does not disturb the restart whose shutdown phase is running. The reverse holds too: every restart that does run a shutdown phase is cancellable on its own terms, including one that starts in the moment between a previous pass finishing and the restart that owned it resuming.

```typescript
const result = await lifecycle.restartAllComponents();

if (result.startupSkippedByShutdownRequest) {
  // Something asked us to shut down mid-restart, so nothing was started again.
  if (!result.shutdownResult.success) {
    // The shutdown phase stalled or timed out: some components may still be running.
    console.warn('Restart cancelled with components still running');
  }

  return;
}
```

A request that arrives during the restart's _startup_ phase aborts that startup instead: the request starts a real shutdown pass, and `startupResult.code` is `shutdown_in_progress`.

#### Individual Component Operations

Registration becomes visible only after the component's registration hooks succeed.
Until then, public lookups and operations treat it as absent, while its name and
instance remain reserved to prevent duplicate registration. Hooks may register other
components; insertion next to a component requires that target to be fully registered.
Failed registration rolls back only the affected entry and keeps its reservation until
cleanup finishes. A hook that starts shutdown prevents registration from completing.

Registration results and events describe the committed registry, including registrations
added by hooks. If startup ordering cannot be determined, `startupOrder` is empty and
`manualPositionRespected` is `undefined`; registration itself can still succeed. During
bulk startup, a registration that would invalidate dependencies already in use is
refused with `startup_in_progress`.

Start, stop, restart, and unregister recheck the component after reading options or
calling listeners. If it was replaced or another operation took ownership, the operation
returns the applicable refusal code without acting on the replacement. Individual
stops also protect dependents that are still starting.

**Restarts go through the public methods.** `restartComponent()` stops and starts the
component through `stopComponent()` and `startComponent()`, and `restartAllComponents()`
runs its startup phase through `startAllComponents()` - each looked up on the manager
when the restart calls it, so a subclass override or an instance patch of one runs for
restarts too. The stop phase of `restartAllComponents()` is its own shutdown pass, not a
`stopAllComponents()` call. The options a restart hands these methods are a frozen copy
of its own, with every field present, and they carry the restart's context: the options
it already read and validated, the registration it approved before stopping, and whether
its stop took the component. An override that passes that same object on - to `super`,
or to the method it patched - keeps the restart's behavior. One that passes any other
object, a spread copy included, gets a plain start or stop of the name: the start acts
on whatever is registered under the name by then rather than only the registration the
restart approved, a startup timeout is read again rather than taken from the restart's
check, the startup phase validates every registration as `startAllComponents()` does,
and any failed stop is answered `restart_stop_failed`. The object carries the context
only into its own manager and only until that call settles: passed to another manager,
or kept and passed again later, it is a plain call too. A shutdown request made while an
override awaits before passing the object on still skips the restart's start, answered
`shutdown_requested_during_restart` as one made during the stop is. An override that
throws or rejects is a crash of the restart, answered `operation_crashed`.

```typescript
class AuditedManager extends LifecycleManager {
  public override startComponent(
    name: string,
    options?: StartComponentOptions,
  ) {
    audit.record('start', name); // runs for restartComponent() too
    return super.startComponent(name, options); // pass `options` on unchanged
  }
}
```

```typescript
// Start a single component
startComponent(name: string, options?: StartComponentOptions): Promise<ComponentOperationResult>

// Stop a single component
stopComponent(name: string, options?: StopComponentOptions): Promise<ComponentOperationResult>

// Restart a single component
restartComponent(name: string, options?: RestartComponentOptions): Promise<ComponentOperationResult>
```

**Options:**

```typescript
interface StartComponentOptions {
  allowNonRunningDependencies?: boolean; // Allow start with non-running registered deps (missing deps still fail)
  forceStalled?: boolean; // Force starting a stalled component
  allowDuringBulkStartup?: boolean; // Allow starting during startAllComponents() (default: false)
  // Normally blocked to prevent race conditions with dependency ordering.
  // Only needed for dynamic mid-startup registration. Most users never need this option.
}
// A dependency counts as running only while it is up: one that is stopping or
// force-stopping is not, and a start on it fails with 'dependency_not_running' unless
// the dependency is optional or allowNonRunningDependencies is set. A dependency that
// goes down while the start reads the component's own getters is held to required.

interface StopComponentOptions {
  forceImmediate?: boolean; // Skip graceful phase, go straight to force
  timeout?: number | null; // Override default timeout
  allowStopWithRunningDependents?: boolean; // Allow stopping despite running dependents (default: false)
}

// Note: restartComponent() skips its start, returning 'shutdown_requested_during_restart',
// when a request to stay down arrives while it stops the component: a shutdown accepted
// meanwhile, or one refused by a concurrent restartAllComponents() stop phase.

// Note: Individual component stops skip the global warning phase. Only bulk shutdown operations
// include the onShutdownWarning() callback.

interface RestartComponentOptions {
  stopOptions?: StopComponentOptions; // Options for stop phase
  startOptions?: StartComponentOptions; // Options for start phase
}
```

**Returns:**

```typescript
interface ComponentOperationResult {
  success: boolean;
  componentName: string;
  reason?: string;
  code?: ComponentOperationFailureCode;
  error?: Error;
  status?: ComponentStatus;
}
```

**Failure codes:** See the centralized list in [Failure Codes](#failure-codes).

**Overlapping operations:** `startComponent()` refuses to run alongside the same component's other lifecycle work. A start already underway returns `component_already_starting`; a stop still in flight returns `component_already_stopping`. This holds even after a global shutdown timeout has already returned: `stopAllComponents()` settles at its deadline while a component's `stop()` or `onShutdownForce()` may still be running, and per-component state keeps the overlap blocked until that work finishes.

Both codes are an immediate refusal: the call returns `success: false` without waiting for the in-flight operation to settle, and it does not start the component once that work finishes. To wait for a component to become startable again, poll `getComponentStatus(name).state` until it leaves `stopping` / `force-stopping`, then start it. `component:stopped` and `component:stalled` (recoverable with `forceStalled: true`) are useful prompts to re-check, but confirm with the state rather than relying on either event arriving. To make concurrent callers of your own `start()` / `stop()` implementations share a single in-flight promise, see [Best Practice #7](#7-make-component-startup-idempotent-and-coordinate-with-shutdown). The manager only guards its own invocations, so that pattern is still required for the force phase, where `onShutdownForce()` runs concurrently with an unfinished `stop()` by design.

### Component Messaging

Value providers are read once, then the captured registration and availability are
checked again before invocation. A provider getter that starts teardown, removes,
or replaces its component cannot cause the captured provider to run; the
`value-requested` event still receives its `value-returned` counterpart.

Message, health, and value result code `stopped` means unavailable and not stalled. A stalled component answers `stalled` whenever it is refused, including while a `retryStalled` force retry has it in `force-stopping`. The label follows the stall, not availability, so messages, values, broadcasts, and health checks agree. `stopped` does not identify the exact lifecycle state. Use `getComponentStatus(name).state` to distinguish registered, starting, failed, and stopped components. `includeStopped` permits handlers on inactive components, but never during active startup, a timed-out startup, or teardown. A component whose timed-out start completed late and is being cleaned up is marked running only so it can be stopped: messages, values, health checks, and signal broadcasts treat it as unavailable (`stopped`, and no signal row), even with `includeStopped`. Operations that select their own targets leave it out, as they leave out components that are not running: an unfiltered `broadcastMessage()` and `checkAllHealth()` have no row for it, so it does not turn the health report `degraded`. Asked about by name, it answers `stopped`.

A handler or `healthCheck` property getter that stops or unregisters its own component answers with that refusal - `stopped` or `not_found` - rather than `no_handler`, a healthy result, or `operation_crashed`: the getter ran, but the component it was read from is no longer available.

#### `sendMessageToComponent(componentName, payload, options?)`

Send a message to a specific component.
By default, only running components receive messages, so use `includeStopped`/`includeStalled` to override. During bulk shutdown, components still running can receive messages until their own teardown begins. Messages remain blocked during `starting`, `starting-timed-out`, `stopping`, and `force-stopping`, even with these overrides or after the bulk shutdown timeout. Messages refused during teardown return `code: 'stopped'` and `error: null`, or `code: 'stalled'` for a stalled component (such as one in a `retryStalled` force retry). Missing targets return `not_found`.

```typescript
sendMessageToComponent<T = unknown>(
  componentName: string,
  payload: T,
  options?: SendMessageOptions
): Promise<MessageResult>
```

**Options:**

```typescript
interface SendMessageOptions {
  timeout?: number | null; // Response timeout in milliseconds (default: manager messageTimeoutMS, 0 = disabled)
  includeStopped?: boolean; // Allow stopped components (default: false)
  includeStalled?: boolean; // Allow stalled components (default: false)
}
```

A `message-failed` event can carry an explanatory error for an unavailable target
while the result uses `code: 'stopped'` or `'not_found'` and `error: null`: no handler
threw. Check `sent` and `code` for delivery, not `error` alone.
`handlerImplemented` records whether the captured target's handler was found; it
can be true even when a later listener removes the target before invocation.
`componentFound` and `componentRunning` describe the target as of the last check
before its handler was called: a handler that stops or unregisters its own component
still answers `componentFound: true` and `componentRunning: true`. The same holds for
a broadcast row's `running` and for `getValue()`.

**Returns:**

```typescript
interface MessageResult {
  sent: boolean;
  componentFound: boolean;
  componentRunning: boolean;
  handlerImplemented: boolean;
  data: unknown;
  error: Error | null;
  timedOut: boolean;
  code:
    | 'sent'
    | 'not_found'
    | 'stopped'
    | 'stalled'
    | 'no_handler'
    | 'timeout'
    | 'invalid_options' // The per-call timeout was invalid; the handler was not called
    | 'error' // The component's handler threw or rejected
    | 'operation_crashed'; // A handler getter threw, or the call itself crashed - a bug to report
}
```

**Example:**

```typescript
import { isPlainObject } from 'lifecycleion/is-plain-object';

// Component with message handler
class CacheComponent extends BaseComponent {
  async onMessage<TData = unknown>(
    payload: unknown,
    from: string | null,
  ): Promise<TData> {
    // Validate payload is a plain object (not null, not array)
    if (!isPlainObject(payload)) {
      return { success: false, error: 'Expected object' } as TData;
    }

    const data = payload as { action: string; key?: string };

    switch (data.action) {
      case 'clear':
        await this.cache.clear();
        return { success: true } as TData;
      case 'get':
        if (!data.key) {
          return { success: false, error: 'Missing key' } as TData;
        }

        return { success: true, value: this.cache.get(data.key) } as TData;
      default:
        return { success: false, error: 'Unknown action' } as TData;
    }
  }
}

// Send message
const result = await lifecycle.sendMessageToComponent('cache', {
  action: 'clear',
});

if (result.sent) {
  console.log('Cache cleared:', result.data);
}
```

**Note:** Payloads support any type (strings, numbers, objects). Validate as needed using type checks, type guards, or validation libraries

#### `broadcastMessage(payload, options?)`

Broadcast a message to multiple components.
By default, only running components receive messages, so use `includeStopped`/`includeStalled` to override. During bulk shutdown, components still running can receive messages until their own teardown begins. Messages remain blocked during `starting`, `starting-timed-out`, `stopping`, and `force-stopping`, even with these overrides or after the bulk shutdown timeout. Messages refused during teardown return `code: 'stopped'` and `error: null`, or `code: 'stalled'` for a stalled component (such as one in a `retryStalled` force retry). A target unregistered mid-broadcast also returns `stopped`, as does one replaced by another component under the same name mid-broadcast: the replacement is not sent the message.
A non-empty `componentNames` array limits the targets; `null`, omitted, or empty arrays use all eligible components. Stopped/stalled explicit targets are reported but not sent unless explicitly included. Non-array filters - and an array whose `length` is not a whole number from 0 to 100,000 - refuse the whole broadcast before delivery and return `[]`, logging the `TypeError` as a warning, as an invalid broadcast `timeout` is, rather than reporting it on the global error channel. A component's `getDependencies()` list has the same kind of bound, 10,000 entries; see [Promises Never Reject](#promises-never-reject).

An invalid shared timeout also refuses the whole broadcast before delivery, returning `[]` with a warning; no recipient row is ever `invalid_options`. The array alone cannot distinguish these refusals from no recipients; use the diagnostics for that distinction.

```typescript
broadcastMessage<T = unknown>(
  payload: T,
  options?: BroadcastOptions
): Promise<BroadcastResult[]>
```

**Options:**

```typescript
interface BroadcastOptions {
  timeout?: number | null; // Response timeout in milliseconds (default: manager messageTimeoutMS, 0 = disabled)
  includeStopped?: boolean; // Include stopped components (default: false)
  includeStalled?: boolean; // Include stalled components (default: false)
  componentNames?: string[] | null; // Filter by specific components; null uses the default
}
```

**Returns:**

```typescript
interface BroadcastResult {
  name: string;
  sent: boolean;
  running: boolean;
  data: unknown;
  error: Error | null;
  timedOut: boolean;
  code:
    | 'sent'
    | 'stopped' // Also a target unregistered while the broadcast was running
    | 'stalled'
    | 'no_handler'
    | 'timeout'
    | 'error' // The component's handler threw or rejected
    | 'operation_crashed'; // A handler getter threw, or the call itself crashed - a bug to report
}
```

### Health Monitoring

#### `checkComponentHealth(name)`

Health hooks are skipped during `stopping` and `force-stopping`, and the result is unhealthy, including after a bulk shutdown timeout. They are also skipped for a running component while a `start()` of it is still pending, or while a timed-out start's late cleanup is pending - the same entry rule messaging and signal broadcasts use.

Check the health of a specific component.

```typescript
checkComponentHealth(name: string): Promise<HealthCheckResult>
```

**Example:**

```typescript
const health = await lifecycle.checkComponentHealth('database');

if (!health.healthy) {
  console.error('Database unhealthy:', health.message);
}
```

#### `checkAllHealth()`

Check health of all running components. A running component that is stopping is still checked and answers `stopped`; one being cleaned up after a late-completed timed-out start is left out of the report (see [Component Messaging](#component-messaging)).

```typescript
checkAllHealth(): Promise<HealthReport>
```

**Returns:**

```typescript
interface HealthCheckResult {
  name: string;
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
  checkedAt: number;
  durationMS: number;
  error: Error | null;
  timedOut: boolean;
  code:
    | 'ok'
    | 'not_found'
    | 'stopped'
    | 'stalled'
    | 'no_handler'
    | 'timeout'
    | 'invalid_options' // The component's health-check timeout was invalid; the check did not run
    | 'error' // The component's handler threw or rejected
    | 'operation_crashed'; // A handler getter threw, or the call itself crashed - a bug to report
}

interface HealthReport {
  healthy: boolean; // true only if ALL components healthy
  components: HealthCheckResult[];
  checkedAt: number;
  durationMS: number;
  timedOut: boolean;
  code:
    | 'ok'
    | 'degraded'
    | 'timeout'
    | 'error' // Also when any component's entry is invalid_options
    | 'operation_crashed';
  error?: Error; // Set when the check itself failed unexpectedly (operation_crashed)
}
```

### Value Sharing

Components can share values with each other. **By default, only running components can provide values.** Use the `includeStopped` or `includeStalled` options to retrieve values from components in other states. Value requests remain blocked during `starting`, `starting-timed-out`, `stopping`, and `force-stopping`, even with these overrides or after the bulk shutdown timeout. Refused requests return `code: 'stopped'`, or `code: 'stalled'` for a stalled component.

```typescript
class ConfigComponent extends BaseComponent {
  getValue(key: string, from: string | null): ComponentValueResult {
    if (key === 'database-url') {
      return { found: true, value: this.config.databaseUrl };
    }

    return { found: false, value: undefined }; // Key not found
  }
}

// Request value from another component
const result = lifecycle.getValue('config', 'database-url');
if (result.found) {
  console.log('Database URL:', result.value);
}

// Request from a stopped or stalled component (explicitly)
const fallback = lifecycle.getValue('config', 'database-url', {
  includeStopped: true,
  includeStalled: true,
});
```

**Options:**

```typescript
interface GetValueOptions {
  includeStopped?: boolean; // Allow stopped components (default: false)
  includeStalled?: boolean; // Allow stalled components (default: false)
}
```

`getValue()` is synchronous and never throws. A component's own `getValue()` handler that throws returns `code: 'error'`. `componentFound` and `componentRunning` describe the component as of the last check before its handler was called, as for messages. An unexpected failure in the lookup itself returns `code: 'operation_crashed'`, carries the thrown value on `error`, and is reported on the global `'error'` channel.

### Signal Integration

#### `attachSignals()`

Attach process signal handlers manually.

```typescript
attachSignals(): void
```

**Signals:**

- **SIGINT, SIGTERM, SIGTRAP** - Trigger `stopAllComponents()`
- **SIGHUP, R key** - Trigger reload (calls `onReload()` on components or custom callback)
- **SIGUSR1, I key** - Trigger info (calls `onInfo()` on running components or custom callback)
- **SIGUSR2, D key** - Trigger debug (calls `onDebug()` on running components or custom callback)

If `attachSignalsBeforeStartup` is enabled, handlers are auto-attached before
`startAllComponents()` or `startComponent()` begins work, so the startup window
is covered even if startup fails. If attaching fails, the start is refused with
`code: 'signal_attach_failed'` before any work begins.

If `attachSignalsOnStart` is enabled, handlers are auto-attached when the
first component comes up (no other component is up) and none are attached. If attaching fails, its start
returns `code: 'signal_attach_failed'` and the manager attempts to stop it.
`startAllComponents()` fails with the same code and attempts rollback, even for an
optional component. Cleanup can fail or time out; inspect the result and current
component status rather than assuming all resources were released.

If `detachSignalsOnStop` is enabled, currently attached handlers are detached
when the last running component stops, whether they were attached manually or
automatically. If startup fails before anything is running, handlers attached
via `attachSignalsBeforeStartup` are detached during startup cleanup. Handlers
stay attached while any component is stalled - a stalled component is not
counted as running, but Ctrl+C is how the operator retries or forces it - and
come off once the last stall clears: by a later stop, by the original `stop()`
or `onShutdownForce()` finishing late, or by unregistering it. They also stay
while anything is still in flight - a startup or shutdown, a component starting
or stopping, or a timed-out `start()` still pending whose late completion the
manager will stop - and come off once it ends, if nothing is left. An
`attachSignals()` call made in the meantime cancels that pending detach. A clean
`stopAllComponents()` that stopped the last component detaches them before it
emits `lifecycle-manager:shutdown-completed` (one that stopped nothing leaves
them alone); a failed one keeps them, so the next Ctrl+C still reaches
escalation.

#### `detachSignals()`

Detach all signal handlers.

```typescript
detachSignals(): void
```

#### `getSignalStatus()`

Get detailed status information about signal handling configuration.

```typescript
getSignalStatus(): LifecycleSignalStatus
```

**Returns:**

```typescript
interface LifecycleSignalStatus {
  isAttached: boolean;
  handlers: {
    shutdown: boolean;
    reload: boolean;
    info: boolean;
    debug: boolean;
  };
  listeningFor: {
    shutdownSignals: boolean;
    reloadSignal: boolean;
    infoSignal: boolean;
    debugSignal: boolean;
    keypresses: boolean;
  };
  shutdownMethod: ShutdownMethod | null;
}
```

**Example:**

```typescript
const status = lifecycle.getSignalStatus();

if (status.isAttached) {
  console.log('Signal handlers attached');
  console.log(
    'Listening for shutdown signals:',
    status.listeningFor.shutdownSignals,
  );
  console.log('Listening for reload signal:', status.listeningFor.reloadSignal);
}
```

#### `getShutdownEscalationStatus()`

```typescript
getShutdownEscalationStatus(): ShutdownEscalationStatus
```

Returns a read-only snapshot of repeated shutdown escalation configuration and runtime state.

```typescript
type ShutdownEscalationStatus =
  | {
      configured: false;
      isShuttingDown: boolean;
      isArmed: false;
      forceAfterCount: null;
      withinMS: null;
      armedAfterFailureMS: null;
      armedAfterFailureMSSource: null;
      requestCount: 0;
      firstMethod: null;
      latestMethod: null;
      firstRequestAt: null;
      latestRequestAt: null;
      repeatedWindowStartedAt: null;
      armedUntil: null;
      hasTriggeredForceShutdown: false;
    }
  | {
      configured: true;
      isShuttingDown: boolean;
      isArmed: boolean;
      forceAfterCount: number;
      withinMS: number;
      armedAfterFailureMS: number;
      armedAfterFailureMSSource: 'explicit' | 'derived';
      countManualRetriesTowardEscalation: boolean;
      requestCount: number;
      firstMethod: ShutdownMethod | null;
      latestMethod: ShutdownMethod | null;
      firstRequestAt: number | null;
      latestRequestAt: number | null;
      repeatedWindowStartedAt: number | null;
      armedUntil: number | null;
      hasTriggeredForceShutdown: boolean;
    };
```

When consuming this in TypeScript, check `configured` first so the union narrows cleanly before reading enabled-only fields such as `forceAfterCount` or `countManualRetriesTowardEscalation`.

**Example:**

```typescript
const escalation = lifecycle.getShutdownEscalationStatus();

if (escalation.configured && escalation.isArmed) {
  console.log('Shutdown escalation is armed until:', escalation.armedUntil);
  console.log('Current escalation count:', escalation.requestCount);
}
```

#### Manual Signal Triggers

Reload/info/debug broadcasts check that each component is still running immediately before invoking its handler. Components that begin teardown during an earlier callback are skipped, as are running components whose `start()` is still pending or whose late-start cleanup is pending. A target that its own handler or `signalTimeoutMS` getter, or a synchronous signal-started listener, makes unavailable produces a per-component `unavailable` result, a signal-started event, and a matching signal-failed event; its handler is not called. When the getter is what made it unavailable, the started and failed events are emitted back to back after the read, and the result is `unavailable` even if the getter also threw. A handler or `signalTimeoutMS` read that fails - a getter that throws (`operation_crashed`) or an invalid timeout (`invalid_options`) - does not call the handler, but still emits signal-started then signal-failed, as a health check whose configuration read fails does, so a listener counting signals in flight stays paired. Unavailable targets count toward the aggregate `error` or `partial_error` code. A handler timeout also emits signal-failed, while retaining the `timeout` result code; late settlement does not emit a second terminal event. An already-running signal handler is not cancelled by teardown. A timeout event carries an explanatory Error, while its result retains `error: null` and `timedOut: true`; the timeout is not a handler exception. Inspect `code` and `timedOut` as well as `error`.

```typescript
triggerReload(): Promise<SignalBroadcastResult>
triggerInfo(): Promise<SignalBroadcastResult>
triggerDebug(): Promise<SignalBroadcastResult>
```

**Note:** For programmatic shutdown, use [`stopAllComponents()`](#stopallcomponentsoptions). It returns a `ShutdownResult`, and it is safe to start without awaiting - see [Running Operations in the Background](#running-operations-in-the-background).

#### Custom Signal Handlers

```typescript
const lifecycle = new LifecycleManager({
  logger,

  // Custom reload handler
  onReloadRequested: async (broadcastReload) => {
    console.log('Reloading global configuration...');
    await reloadGlobalConfig();
    await broadcastReload(); // Also reload components
  },

  // Custom info handler
  onInfoRequested: async () => {
    console.log('=== App Info ===');
    console.log('Uptime:', process.uptime());
    console.log('Components:', lifecycle.getRunningComponentNames());
  },

  // Custom debug handler
  onDebugRequested: async () => {
    console.log('Debug mode toggled');
  },
});
```

#### Repeated Shutdown Request Policy

Use `repeatedShutdownRequestPolicy` when you want repeated shutdown requests
during an already-running shutdown to escalate into application-defined behavior.

Terminology used below:

- **Escalation state** is the logical repeated-shutdown context for one shutdown cycle
- **Armed window** is the short post-failure period after an unsuccessful shutdown returns, before the next retry starts
- During an active retry, the escalation state is still preserved, but the armed window is not active because shutdown is running again
- A `restartAllComponents()` stop phase does not start an escalation cycle of its own, and one started while an earlier failed shutdown's window is still armed ends that cycle rather than carrying its count. The first shutdown signal during it is the operator's initial request: it cancels the restart and starts the cycle (`firstMethod` is that signal) without being counted. Signals after it count as presses, as they would against any running shutdown. A restart whose stop phase fails with no signal leaves nothing armed

This applies to shutdown requests from:

- OS signals
- Keyboard shortcuts such as `Escape` and `Ctrl+C`
- Programmatic signal-style shutdown requests such as `ProcessSignalManager.triggerShutdown()`

```typescript
const lifecycle = new LifecycleManager({
  logger,
  repeatedShutdownRequestPolicy: {
    forceAfterCount: 3, // default
    withinMS: 2000, // default
    armedAfterFailureMS: 6000, // optional override; default is withinMS * forceAfterCount
    countManualRetriesTowardEscalation: false, // default
    onForceShutdown: ({
      requestCount,
      firstMethod,
      latestMethod,
      isShuttingDown,
      wasArmedAfterFailure,
    }) => {
      logger.warn('Force shutdown requested', {
        params: {
          requestCount,
          firstMethod,
          latestMethod,
          isShuttingDown,
          wasArmedAfterFailure,
        },
      });

      process.exit(1);
    },
  },
});
```

**How counting works:**

- The first shutdown request starts graceful shutdown but does not count toward the force threshold
- That first request still arms the escalation state with an effective escalation count of `0`
- Additional shutdown requests received while shutdown is still in progress are treated as escalation requests
- By default, only signal-style shutdown requests count toward escalation
- Manual `stopAllComponents()` retries start a fresh escalation cycle unless `countManualRetriesTowardEscalation` is enabled
- A shutdown request made from inside `onForceShutdown()` or a `lifecycle-manager:shutdown-escalation-forced` listener is treated as a continuation of the request that fired it, not as a new one, so it is never counted again
- Escalation requests are counted inside a `withinMS` window
- If a new escalation request arrives more than `withinMS` after the first escalation request in the current window, a new escalation window starts
- `onForceShutdown()` fires once per escalation state when the count reaches `forceAfterCount`
- Finite `forceAfterCount` values are clamped to at least `1`. Non-finite or non-number values use the default `3`; fractions are accepted, with force firing when the integer request count reaches the threshold

**Important reset behavior:**

- The repeated-request counter belongs to one active escalation state
- If shutdown completes successfully, the repeated-request state resets immediately
- If shutdown completes unsuccessfully, times out, or leaves stalled components behind, escalation stays armed briefly so follow-up shutdown requests can continue the same force count
- That post-failure armed period defaults to `withinMS * forceAfterCount` (with the default 2000 ms window when `withinMS` is `0`, so a zero-width window does not disable arming), or uses `armedAfterFailureMS` when explicitly configured. The effective duration is capped at 2,147,483,647 ms to match the timer limit
- A shutdown request received during that armed period continues the same escalation state and starts a fresh shutdown attempt
- While that retry is running, the armed timer is no longer active because shutdown is in progress again
- If the retry also finishes unsuccessfully, the manager re-arms the post-failure window so follow-up requests can continue the same escalation state
- It also resets on a fresh `startAllComponents()`. One started from a log sink while a request is being counted leaves that request counted on the old state, so it does not invoke `onForceShutdown()`; the fresh state counts from the next request
- A later `stopAllComponents()` attempt only continues the same escalation state when `countManualRetriesTowardEscalation` is `true`
- Once the armed period expires, or shutdown/startup later succeeds, the next escalation state starts fresh
- The request that finds the armed period already expired is the first of that fresh state: it starts it, as the first request of any shutdown does, rather than being dropped. This holds for a signal landing on a running shutdown too, so the next press counts toward `forceAfterCount`

**Stalled shutdown behavior:**

- The policy can still escalate while shutdown is stalled or still waiting on component timeouts
- This is intentional: repeated shutdown requests are meant to express stronger operator intent during a hanging shutdown
- If `stopAllComponents()` returns unsuccessfully, the escalation state remains armed briefly so quick follow-up signal presses still count
- Manual retry attempts only keep counting during that armed period when `countManualRetriesTowardEscalation` is enabled
- A follow-up signal during that armed period retries shutdown immediately instead of being treated as telemetry-only
- Once that armed period expires, or a later shutdown/startup succeeds, the old escalation state is cleared

**Example timeline (`forceAfterCount: 3`, `withinMS: 2000`):**

- `t=0ms`: first shutdown request arrives, graceful shutdown starts
- `t=5000ms`: second shutdown request arrives, escalation count = `1`
- `t=6500ms`: third shutdown request arrives within 2000ms of the previous escalation window start, escalation count = `2`
- `t=7000ms`: fourth shutdown request arrives within that same window, escalation count = `3`, `onForceShutdown()` fires

If instead the fourth request arrived at `t=8000ms`, the escalation window would reset there and the escalation count would start over from `1`.

**Post-failure retry example (`forceAfterCount: 3`, `withinMS: 2000`):**

- `t=0ms`: first shutdown request arrives, graceful shutdown starts
- `t=3000ms`: shutdown returns unsuccessfully, so the post-failure armed window opens briefly
- `t=3500ms`: another shutdown signal arrives during that armed window
- That signal increments the same escalation state and immediately starts a new shutdown attempt
- While that retry is running, the armed window itself is no longer active
- If the retry also returns unsuccessfully, the manager opens a new armed window so later requests can continue the same escalation state

**Design note:**

- `onForceShutdown()` is application-defined on purpose
- The LifecycleManager detects repeated requests, but your app decides what "force" means
- Common choices include final logging, telemetry flush, `logger.exit()`, or `process.exit()`
- `isShuttingDown` in the callback context is `true` when force escalation fires during an active shutdown (the normal path: operator pressed the shutdown signal multiple times while `stopAllComponents()` was running). It is `false` when escalation fires from the post-failure armed window (a previous shutdown returned unsuccessfully and the manager kept escalation armed briefly, and no shutdown is actively running when the callback fires)
- `wasArmedAfterFailure` is `true` in the post-failure case above and `false` during an active shutdown. Use this flag to distinguish the two paths if your handler needs to know whether it must start a new shutdown or assume one is already underway

**Escalation events:**

- `lifecycle-manager:shutdown-escalation-armed` means a failed/timed-out shutdown left a short-lived escalation window open
- `lifecycle-manager:shutdown-escalation-expired` means that armed window elapsed and the old escalation state was cleared
- `lifecycle-manager:shutdown-escalation-forced` means the repeated-request threshold was crossed and the manager invoked `onForceShutdown()`
- The `forced` event does **not** guarantee that the process exited. It only means the force callback was dispatched

### Logger Integration

The LifecycleManager can integrate with the Logger's exit mechanism to trigger graceful component shutdown when `logger.exit()` is called.

#### `enableLoggerExitHook()`

Enable Logger exit hook integration to trigger graceful component shutdown before process exit.

```typescript
enableLoggerExitHook(): void
```

**What it does:**

- Sets up the logger's `beforeExit` callback to call `stopAllComponents(shutdownOptions)`
- When `logger.exit(code)` is called, components shut down gracefully first
- When `logger.error('message', { exitCode: 1 })` is called, components shut down before exit
- Uses the constructor's `shutdownOptions.timeoutMS` (default: 30000ms) to prevent hanging - unless it is `0`, which disables the deadline (see Timeout Behavior below)
- Overwrites any existing `beforeExit` callback on the logger
- An exit that lands while a shutdown is already running waits for it rather than starting a second pass - and if that shutdown is a [`restartAllComponents()`](#restartallcomponentsoptions) stop phase, it cancels the restart's startup phase, so nothing is started again behind the exit
- **Exit behavior depends on logger configuration:** `logger.exit()` only calls `process.exit()` when the logger is created with `callProcessExit: true` (default). Test-optimized and frontend-optimized loggers disable process exit.

**Constructor Options:**

```typescript
const lifecycle = new LifecycleManager({
  logger,
  enableLoggerExitHook: true, // Auto-enable on construction
  shutdownOptions: { timeoutMS: 30000 }, // Max time for shutdown (default: 30s)
});
```

**Manual Usage:**

```typescript
const lifecycle = new LifecycleManager({ logger });

// Enable later
lifecycle.enableLoggerExitHook();

// Now logger.exit() triggers graceful shutdown
logger.exit(0);
// Components stop gracefully (up to shutdown timeout) before process exits
```

**Example with Error Exit:**

```typescript
const lifecycle = new LifecycleManager({
  logger,
  enableLoggerExitHook: true,
});

await lifecycle.registerComponent(database);
await lifecycle.registerComponent(apiServer);
await lifecycle.startAllComponents();

// Fatal error triggers graceful shutdown
logger.error('Database connection lost', { exitCode: 1 });
// Output:
// Logger exit triggered, stopping components...
// Stopping component: api-server...
// Stopping component: database...
// [Process exits with code 1]
```

**Timeout Behavior:**

If component shutdown exceeds `shutdownOptions.timeoutMS`, the process will exit anyway:

```typescript
const lifecycle = new LifecycleManager({
  logger,
  enableLoggerExitHook: true,
  shutdownOptions: { timeoutMS: 5000 }, // Only wait 5 seconds
});

// If shutdown takes longer than 5s, warning is logged and exit proceeds
logger.exit(0);
// The shutdown-completed payload has timedOut: true, then exit proceeds.
```

With `shutdownOptions.timeoutMS: 0` there is no deadline, and the exit waits for the
shutdown however long it takes. Each component's stop is still bounded by its own
`shutdownGracefulTimeoutMS` and `shutdownForceTimeoutMS` (a stop that exceeds both
stalls, and the exit proceeds once the pass ends), but the pass also waits for any
in-flight `start()`, and one without a startup timeout (`startupTimeoutMS: 0`) can hold
the exit indefinitely. Keep a non-zero `timeoutMS` when an exit must never hang.

**Important Notes:**

- This method is idempotent (can be called multiple times safely)
- Overwrites any existing `beforeExit` callback on the logger
- If you need custom exit logic, set it up manually with `logger.setBeforeExitCallback()`
- If `logger.exit()` is called while shutdown is already in progress, that exit call returns `{ action: 'wait' }` instead of exiting immediately.
- The first such `logger.exit()` call is kept pending and allowed to proceed when the in-flight shutdown completes or reaches its global timeout.
- Later duplicate `logger.exit()` calls made while an earlier exit is still being handled - including one a log sink makes synchronously before that exit's shutdown has started - also return `{ action: 'wait' }`, so they cannot exit early or start a second shutdown. Their codes still count: the logger applies [last non-zero wins](logger.md#exit-behavior) to the pending exit, so a component that fails while stopping and logs `exitCode: 1` during a shutdown started by `SIGTERM` and `logger.exit(0)` makes the process exit 1 rather than 0. A later `exit(0)` never downgrades a pending failure. A simulated exit (`callProcessExit: false`) settles its code the same way, so a test of that shutdown sees `logger.exitCode` and the `exit-process` code as 1 too.
- With a logger that does not end the process (`callProcessExit: false`), an exit made after an earlier one has finished is handled like a first exit: it stops the components again, and settles its own exit code rather than inheriting the earlier one's. The earlier exit counts as finished from the moment the shutdown pass it depends on ends, so an exit made right after - from a microtask a `shutdown-completed` listener queued, for instance - also stops anything started again in between.
- Once an exit that ends the process is allowed to proceed, every later start is refused, from the moment the shutdown pass it depends on ends. `startAllComponents()`, `startComponent()`, and `restartAllComponents()`'s startup phase answer `code: 'shutdown_in_progress'` with the reason `Process is exiting after a logger exit`; `restartComponent()` answers `restart_start_failed` (or `component_not_running`, since the exit's shutdown already stopped everything); an `autoStart` registration reports `autoStartSucceeded: false`. A `startAllComponents()` refused this way part-way, with no shutdown pass running, rolls back the components it had already started before it answers. The logger still closes its sinks before calling `process.exit()`, and a component started in that window would be killed without a graceful stop. The refusal is permanent for that manager: if `process.exit()` is patched not to exit, starts stay refused. A simulated exit (`callProcessExit: false`) leaves the process running, so starts are refused the same way only until its sink cleanup settles - the logger's [`exit-completed`](logger.md#exit-event-phases) event - and are allowed again after that. The refusal during sink cleanup reads the logger's own [`isFinishingExit`](logger.md#exit-event-phases), true from `exit-process` until `exit-completed` for any of its exits, so it applies whether or not `enableLoggerExitHook` is on, and to every manager that shares that logger; the hook only makes it begin earlier, when it tells the exit to proceed.
- After that commit, any further `logger.exit()` returns `{ action: 'wait' }`: it runs no second shutdown. Whether its code counts is the logger's rule: a failure still replaces the pending code until the logger publishes it in `exit-process`, and is ignored after that - as one a sink makes from its own `close()` is, since sinks close after `exit-process`.

#### Process Exit Design & Rationale

By default, `LifecycleManager` does **not** call `process.exit()` during signal-triggered shutdowns (such as `SIGINT` or `SIGTERM`). Instead, it relies on the Node.js event loop naturally emptying once all components have stopped.

This design choice has two primary benefits:

- **Resource Leak Detection**: If a component's `stop()` method fails to clean up properly (e.g., leaves a database connection pool open, fails to close an HTTP server, or leaves an active interval running), the process will hang. This surfaces resource leaks during development and testing that would otherwise be masked by a forced exit.
- **Multi-App Integration Testing**: In testing environments where multiple simulated application instances run in a single process, calling `process.exit()` in one manager would terminate the entire test runner. Leaving process termination to the host allows clean multi-lifecycle execution.

If you want the process to exit automatically:

- **Via signals**: Handle the exit explicitly in the application entrypoint by listening to the `lifecycle-manager:shutdown-completed` event (e.g., calling `logger.exit(0)` or `process.exit(0)`).
- **Via logger hooks**: Enable logger exit hook integration (`enableLoggerExitHook: true`). When enabled, calling `logger.exit()` or logging a fatal error with `exitCode` will trigger `LifecycleManager` to stop all components first, and then delegate back to the logger to proceed with its configured exit behavior (respecting any overrides like `callProcessExit: false`). See [Exit Behavior in docs/logger.md](logger.md#exit-behavior) for details on configuring simulated exits.
- **Via repeated signals (Ctrl+C escalation)**: Configure `repeatedShutdownRequestPolicy.onForceShutdown` to call `logger.exit(1)` or `process.exit(1)` when the threshold (like multiple Ctrl+C presses) is crossed. With `enableLoggerExitHook`, a `logger.exit()` made synchronously from `onForceShutdown` - before any `await` - proceeds at once instead of waiting for the running shutdown; one made later is deferred like any exit during a shutdown.

#### Logger Requirements

The LifecycleManager requires a Logger instance that implements the Lifecycleion logger interface. This Logger provides:

- **Structured logging** with message templates and parameters
- **Service scoping** via `logger.service(name)` for component-specific logs
- **Entity scoping** for logging with entity context
- **Process exit integration** via `logger.exit()` and `beforeExit` callbacks
- **Multiple log levels**: error, warn, info, success, notice, debug, raw

**Creating a Logger:**

The Logger class is part of the Lifecycleion package. Basic usage:

```typescript
import { Logger } from 'lifecycleion/logger';

const logger = new Logger({
  // Logger configuration options
});

// Create LifecycleManager with the logger
const lifecycle = new LifecycleManager({
  logger,
  name: 'my-app',
});
```

**Logger Interface Used by Components:**

Components receive a scoped logger service via `logger.service(componentName)` which provides:

- `logger.info(message, options?)` - Informational messages
- `logger.error(message, options?)` - Error messages
- `logger.warn(message, options?)` - Warning messages
- `logger.success(message, options?)` - Success messages
- `logger.debug(message, options?)` - Debug messages
- `logger.entity(name)` - Create entity-scoped logger

**Message Templates:**

Log messages support `{{key}}` template syntax for embedding param values inline. This is useful in component `start()`/`stop()` implementations so errors are visible in any log output without needing a structured sink:

```typescript
async start() {
  try {
    await this.db.connect();
  } catch (error) {
    const err = toError(error);

    this.logger.error('Failed to connect: {{error.message}}', {
      params: { error: err },
    });
    // → "Failed to connect: Connection refused"
  }
}
```

Normalizing the caught value with [`toError`](./to-error.md) ensures `{{error.message}}` always resolves to a string - without it, a thrown string or plain object would produce `(null)` in the output. Libraries and native APIs occasionally throw non-`Error` values.

Use `toError` rather than hand-rolling `error instanceof Error ? error : new Error(String(error))`: both halves of that idiom can throw. `instanceof` walks a prototype chain, which a revoked `Proxy` refuses, and `String()` invokes `toString`/`Symbol.toPrimitive` - on a value created with `Object.create(null)` it raises a `TypeError` of its own, from the line that was only trying to normalize an error. `toError` guards both and keeps the original on `cause`.

The normalized `err` is also captured in `params` for structured sinks that need the full error object or stack trace. Because the pattern only wraps non-`Error` values, original `Error` stack traces are preserved when the thrown value was already an `Error`.

**Note:** The LifecycleManager itself logs `error.message` inline when component lifecycle methods fail (e.g., `start()` throwing, shutdown errors). Avoid including sensitive details like connection strings or credentials in error messages thrown from lifecycle methods, as they will appear in plain log output.

**A logger that fails cannot fail a lifecycle operation.**

The logger is yours, so every line the manager writes runs code it does not own - inside OS signal handlers, timer callbacks, floating promise chains, and the middle of a startup or shutdown pass. The manager wraps its own service logger once, at construction, so this holds for every operation, not just for a particular path:

- **A log method that throws, or that returns a rejecting promise, cannot fail or derail the operation that was logging.** Startup, shutdown, restart, and every per-component operation carry on and return their normal result: a throw inside the shutdown stop loop does not reject the pass, leave the components it has not reached running, or keep `lifecycle-manager:shutdown-completed` listeners waiting on a pass that is already over. The guard keeps a logger failure off the pass's failure path in the first place, so it is not reported as a failed shutdown either.
- **Only built-in entity children are cached.** A custom `entity()` factory runs on each call, allowing it to refresh context when a component name is reused. The cache keeps a child for every registered component plus up to 256 other names, least recently used first out, so a pass that logs every component reuses their children however many are registered, while names that come and go - per-job or per-tenant components - stay bounded.
- **`logger.entity(name)` is covered too.** If `entity()` itself throws, the chain still gets something callable back - the line lands under the service name, without the entity scope.
- **Failures are reported on the global `'error'` channel**, never back through the logger that just failed. See [safe-handle-callback](./safe-handle-callback.md). The report names the logger method (for example `lifecycle-manager logger.warn`) and carries the original failure on `cause`. Listen with `globalThis.addEventListener('error', handler)` and call `event.preventDefault()` to claim it.
- **Your logger object is never wrapped or modified.** `rootLogger` stays the exact instance you passed in: `enableLoggerExitHook()`, `logger.exit()`, and the scoped logger every component builds all go through your object unchanged. Only the manager's own internal logging is guarded.

This is a containment guarantee, not a repair: a logger that throws still loses those lines. It is worth fixing the logger.

### Status and Query Methods

#### Component Existence and State

**`hasComponent(name: string): boolean`**

Check if a component is registered.

```typescript
if (lifecycle.hasComponent('database')) {
  console.log('Database component is registered');
}
```

**`isComponentRunning(name: string): boolean`**

Check if a component is currently running.

```typescript
if (lifecycle.isComponentRunning('cache')) {
  // Use cache
} else {
  // Fallback behavior
}
```

**`getComponentStatus(name: string): ComponentStatus | undefined`**

Get detailed status for a specific component. Returns `undefined` if component not found.

The manager reads the `status` on its results and events, and each entry of `getAllComponentStatuses()`, through this method, so a subclass override is the one used. If an override throws, the throw is reported on the global `'error'` channel and the result or event leaves `status` out (`getAllComponentStatuses()` leaves that entry out); the operation itself is not affected.

```typescript
const status = lifecycle.getComponentStatus('web-server');
if (status) {
  console.log('State:', status.state); // 'running', 'stopped', etc.
  console.log('Started at:', status.startedAt);
  console.log('Stopped at:', status.stoppedAt);
  console.log('Last error:', status.lastError);
  console.log('Stall info:', status.stallInfo);
}
```

**`getComponentInstance(name: string): BaseComponent | undefined`**

Get the raw component instance. Returns `undefined` if component not found.

```typescript
const dbComponent = lifecycle.getComponentInstance('database');

if (dbComponent) {
  // Access component metadata
  console.log('Component name:', dbComponent.getName());
  console.log('Dependencies:', dbComponent.getDependencies());
  console.log('Is optional:', dbComponent.isOptional());
}
```

**Warning:** Direct access to component instances should be used carefully. Prefer using the manager's API methods for lifecycle operations (start, stop, messaging, etc.) to maintain proper state management. This method is primarily useful for reading component metadata (name, dependencies, optional flag).

#### Lists and Counts

**`getComponentNames(): string[]`**

Get names of all registered components.

**`getRunningComponentNames(): string[]`**

Get names of all currently running components (excludes stalled).

**`getComponentCount(): number`**

Get total number of registered components.

**`getRunningComponentCount(): number`**

Get number of currently running components (excludes stalled).

**`getStalledComponentCount(): number`**

Get number of stalled components (failed to stop during shutdown).

**`getStoppedComponentCount(): number`**

Get number of stopped components. Includes components in `starting-timed-out` state for accounting purposes (since they're not running).

**`getStartTimedOutComponentCount(): number`**

Get number of components in `starting-timed-out` state (exceeded startup timeout).

**`getAllComponentStatuses(): ComponentStatus[]`**

Get detailed status for all registered components, each read through `getComponentStatus()`. An entry an override answers `undefined` for, or throws for, is left out.

```typescript
const statuses = lifecycle.getAllComponentStatuses();
for (const status of statuses) {
  console.log(`${status.name}: ${status.state}`);

  if (status.lastError) {
    console.error(`  Error: ${status.lastError.message}`);
  }
}
```

#### System State

**`getSystemState(): SystemState`**

Get the current system state (see SystemState Values below).

**`getStatus(): LifecycleManagerStatus`**

Get comprehensive manager status including counts and component lists (see LifecycleManagerStatus below).

```typescript
const status = lifecycle.getStatus();
console.log('System state:', status.systemState);
console.log('Running:', status.counts.running);
console.log('Stalled:', status.counts.stalled);
```

**SystemState Values:**

`getSystemState()` returns one of the following states:

- `'no-components'` - No components registered
- `'ready'` - Components registered, none running
- `'starting'` - `startAllComponents()` in progress
- `'running'` - Components are running (all or some)
- `'stalled'` - Some components failed to stop (stuck running)
- `'shutting-down'` - `stopAllComponents()` in progress

**Note:** The `'running'` state is returned whenever any components are running, regardless of whether all components are running. Use `getRunningComponentCount()` and `getComponentCount()` to determine if all components are running.

`getRunningComponentCount()` excludes stalled components. Use `getStalledComponents()` if you need to include stalled ones.

**LifecycleManagerStatus:**

```typescript
interface LifecycleManagerStatus {
  systemState: SystemState;
  isStarted: boolean; // Any component is running (or stalled)
  isStarting: boolean;
  isShuttingDown: boolean;
  counts: {
    total: number;
    running: number;
    stopped: number;
    stalled: number;
    startTimedOut: number;
  };
  components: {
    registered: string[];
    running: string[];
    stopped: string[];
    stalled: string[];
    startTimedOut: string[];
  };
}
```

**Note:** `counts.stopped` and `components.stopped` include `startTimedOut` components.

**Note:** `components.running` excludes stalled components. `components.stopped` excludes both running and stalled (use `components.stalled` or `getStalledComponents()` for those).

**Definition:** `stopped` = registered − running − stalled.

**`getStalledComponents(): ComponentStallInfo[]`**

Get detailed information about stalled components.

```typescript
const stalled = lifecycle.getStalledComponents();
for (const info of stalled) {
  console.error(`Stalled: ${info.name}`);
  console.error(`  Reason: ${info.reason}`);
  console.error(`  At: ${new Date(info.stalledAt)}`);
}
```

**`getStalledComponentNames(): string[]`**

Get names of stalled components.

**`getStoppedComponentNames(): string[]`**

Get names of stopped components (includes `starting-timed-out` state).

**`getStartTimedOutComponentNames(): string[]`**

Get names of components in `starting-timed-out` state.

**`getLastShutdownResult(): ShutdownResult | null`**

Get the result of the last `stopAllComponents()` call. Returns `null` if no shutdown has occurred yet, or once a later bulk startup (`startAllComponents()`, or the startup phase of `restartAllComponents()`) has begun: it is cleared when that startup claims the startup latch and passes its signal-attach and shutdown checks, whether or not the startup then succeeds. A startup refused before that point leaves it in place.

```typescript
const lastShutdown = lifecycle.getLastShutdownResult();
if (lastShutdown && lastShutdown.stalledComponents.length > 0) {
  console.error('Previous shutdown had stalled components:');
  for (const stalled of lastShutdown.stalledComponents) {
    console.error(`  - ${stalled.name}: ${stalled.reason}`);
  }
}
```

**Use cases:**

- Debugging shutdown issues
- Tracking stalled components across restarts
- Collecting shutdown metrics
- Recovery decision-making

#### Dependencies

**`getStartupOrder(): StartupOrderResult`**

Get the computed startup order based on dependencies.

Like `validateDependencies()` and a bulk startup, it reads every component's
`getDependencies()` until the reads stop changing the registry, then orders the
registry as it stands: a component a read registers is included, and one a read
unregisters is not. A registry that keeps changing past 16 rounds of reads answers
`operation_crashed`.

```typescript
interface StartupOrderResult {
  success: boolean;
  startupOrder: string[]; // Resolved dependency order (empty array if !success)
  reason?: string; // Human-readable explanation when !success
  code?: StartupOrderFailureCode; // 'dependency_cycle' | 'operation_crashed'
  error?: Error; // Error object (present for dependency_cycle and operation_crashed)
}
```

**Example:**

```typescript
const order = lifecycle.getStartupOrder();

if (order.success) {
  console.log('Startup order:', order.startupOrder);
} else {
  console.error('Cannot compute order:', order.reason);

  if (order.code === 'dependency_cycle') {
    console.error('Cycle detected:', order.error);
  }
}
```

**`validateDependencies(): DependencyValidationResult`**

Validate the dependency graph for missing dependencies and circular cycles

**DependencyValidationResult:**

```typescript
interface DependencyValidationResult {
  valid: boolean;
  missingDependencies: Array<{
    componentName: string;
    componentIsOptional: boolean;
    missingDependency: string;
  }>;
  circularCycles: string[][];
  invalidDependencyLists: Array<{ componentName: string; error: Error }>; // getDependencies() threw or returned a non-array, an array longer than 10,000, or a non-string entry (a throwing isOptional() is read as required, not listed)
  cycleCheckError?: Error; // Set only if cycle detection itself failed unexpectedly; valid is then false
  summary: {
    totalMissingDependencies: number; // Total number of missing dependencies across all components
    requiredMissingDependencies: number; // Missing dependencies on required components (blocks startup)
    optionalMissingDependencies: number; // Missing dependencies on optional components (degrades functionality)
    totalCircularCycles: number; // Number of circular dependency cycles detected
    totalInvalidDependencyLists: number; // Number of invalidDependencyLists entries
  };
}
```

**Summary Fields Explained:**

- `totalMissingDependencies`: Count of all missing dependency declarations (sum of required + optional)
- `requiredMissingDependencies`: Missing dependencies that will prevent startup (required components depending on non-existent components)
- `optionalMissingDependencies`: Missing dependencies that won't block startup but indicate configuration issues
- `totalCircularCycles`: Number of representative dependency cycles detected (each cycle prevents startup), not the total number of all possible cycles. The DFS visits each node once, so overlapping cycles can be omitted even in small graphs. Reporting also stops once the listed cycles hold 10,000 component names in total; each listed cycle is complete, and a cyclic graph always lists at least one

**Example:**

```typescript
const validation = lifecycle.validateDependencies();

console.log(`Valid: ${validation.valid}`);
console.log(`Missing: ${validation.summary.totalMissingDependencies} total`);
console.log(
  `  - ${validation.summary.requiredMissingDependencies} blocking startup`,
);
console.log(
  `  - ${validation.summary.optionalMissingDependencies} non-blocking`,
);
console.log(`Circular cycles: ${validation.summary.totalCircularCycles}`);

if (!validation.valid) {
  // Detailed breakdown available in missingDependencies and circularCycles arrays
}
```

## BaseComponent API

Components extend `BaseComponent` and can implement these methods:

### Constructor

```typescript
constructor(logger: Logger, options?: ComponentOptions)
```

**Options:**

```typescript
interface ComponentOptions {
  name: string; // Component name (kebab-case)
  dependencies?: string[]; // Component dependencies
  optional?: boolean | null; // If true, failure doesn't stop startup (default: false); must be a boolean
  startupTimeoutMS?: number | null; // Start timeout in milliseconds (default: 30000, 0 = disabled)
  shutdownGracefulTimeoutMS?: number | null; // Graceful shutdown timeout in ms (default: 5000, minimum: 1000)
  // Values below 1000ms are silently raised to 1000ms to ensure reasonable cleanup time
  shutdownForceTimeoutMS?: number | null; // Force shutdown timeout in ms (default: 2000, minimum: 500)
  // Values below 500ms are silently raised to 500ms to prevent abrupt termination
  healthCheckTimeoutMS?: number | null; // Health check timeout in milliseconds (default: 5000, 0 = disabled)
  signalTimeoutMS?: number | null; // Signal handler timeout in milliseconds (default: 5000, 0 = disabled)
  ownsLateStartCleanup?: boolean | null; // The component undoes its own late start (default: false); see Late-Start Cleanup
}
```

`optional` and `ownsLateStartCleanup` must be booleans: `null` or omitted selects the
default (`false`), and anything else - `'yes'`, `1` - makes the constructor throw a
`TypeError` (`optional must be a boolean`, `ownsLateStartCleanup must be a boolean`)
rather than read it as truthy or falsy.

### Lifecycle Methods

```typescript
// Required: Start the component. `signal` is aborted if the manager stops waiting
// on this start (a startup timeout or bulk deadline), or as a cue by a shutdown using
// abortPendingStarts; see Startup Abort Signal.
// Declaring start() without the parameter is fine.
abstract start(signal: AbortSignal): Promise<void> | void;

// Required: Stop the component. `signal` is aborted if shutdownGracefulTimeoutMS
// passes while stop() is pending; see Stop Abort Signals. The parameter is optional.
abstract stop(signal: AbortSignal): Promise<void> | void;

// Optional: Called during global shutdown warning
onShutdownWarning?(): Promise<void> | void;

// Optional: Called for force shutdown if graceful shutdown times out or throws.
// `signal` is fresh per force attempt, aborted if shutdownForceTimeoutMS passes, or if
// a late graceful completion stops the component first; see Stop Abort Signals.
onShutdownForce?(signal: AbortSignal): Promise<void> | void;
```

The signals are the only timeout notifications: there are no separate timeout hooks
(see [Abort Signals at a Glance](#abort-signals-at-a-glance)). A component that defines
`onStartupAborted()`, `onGracefulStopTimeout()` or `onShutdownForceAborted()` is refused
at registration with `code: 'invalid_options'` (see
[`registerComponent()`](#registercomponentcomponent-options)).

**Shutdown contract:** `stop()` should always eventually settle (resolve or reject) on every path. If you implement `onShutdownForce()`, it should also eventually settle. In many components, `onShutdownForce()` should not start a completely separate shutdown flow. Instead, it should help the in-flight `stop()` finish or await the same underlying stop work.

**Important:** `onShutdownWarning()` is only fired during bulk shutdowns via `stopAllComponents()` or `restartAllComponents()`. Individual `stopComponent()` calls do NOT trigger the warning phase. The `onShutdownWarning` property is read only for a component the phase will warn - running or stalled, and not owned by a start, a stop, or late-start cleanup - so a getter on it does not run, and its failure is not reported, for one that is skipped. There is no built-in "warning cleared" event, so if shutdown is canceled or stalls, reset any warning state on the next successful `start()` or via an app-specific signal.

### Signal Handlers

```typescript
// Optional: Handle reload signal
onReload?(): Promise<void> | void;

// Optional: Handle info signal
onInfo?(): Promise<void> | void;

// Optional: Handle debug signal
onDebug?(): Promise<void> | void;
```

### Messaging

```typescript
// Optional: Handle messages from other components or external callers
onMessage?<TData = unknown>(payload: unknown, from: string | null): TData | Promise<TData>;
// from: component name when sent from another component, null when sent from manager/external

// Send message to another component
sendMessage<T>(to: string, payload: T): Promise<MessageResult>;

// Broadcast message to all components
broadcastMessage<T>(payload: T, options?: BroadcastOptions): Promise<BroadcastResult[]>;
```

### Health Checks

```typescript
// Optional: Report component health
healthCheck?(): Promise<ComponentHealthResult | boolean> | ComponentHealthResult | boolean;
```

**Return types:**

```typescript
// Rich result
return {
  healthy: true,
  message: 'All systems operational',
  details: { connections: 10, queueSize: 5 },
};

// Simple boolean (automatically wrapped by manager)
return true; // Automatically wrapped to { healthy: true, message: undefined, details: undefined }
return false; // Wrapped to { healthy: false, message: undefined, details: undefined }
```

**Note:** Boolean returns are automatically normalized to `ComponentHealthResult` format by the manager. Return result rich objects directly for more detailed health information.

Health handlers and their timeout configuration are read before invocation. A throwing
`healthCheckTimeoutMS` getter returns `code: 'operation_crashed'` with "Health check timeout could
not be read"; it does not call the handler. Failed configuration reads still emit the
paired health-check started/failed notifications used to count completed checks.

A health check must return a boolean or an object whose `healthy` field is a boolean.
Callable objects with that shape are accepted too; the result itself is not invoked.
Null `message` and `details` are normalized to absent (`undefined`). Otherwise,
optional `message` must be a string, and optional `details` must be a non-null,
non-array object. This is a shallow metadata check, not a plain-prototype or JSON
serialization guarantee: class instances are not rejected solely for their prototype.
Use string-keyed records when the consumer expects JSON fields; convert Map/Date values
explicitly if their default JSON representation is unsuitable.
Invalid metadata is reported as a return-contract error
before any completed event is emitted.
Nullish values, other primitives, and objects with missing or non-boolean `healthy`
fields are malformed results. The manager returns
`code: 'error'`, `healthy: false`, and a message explaining the return contract, and
emits `component:health-check-failed`. It does not describe that completed invocation
as a handler that threw. The manager reads `healthy`, `message`, and `details` once,
before emitting completion, and uses that snapshot for both the event and the returned
result. If reading one of those fields throws, the check reports an invalid returned
result with the getter failure preserved as `error.cause`, rather than labeling the
completed handler invocation as a throw.

### Value Sharing

```typescript
// Optional: Provide values to other components
getValue?<T>(key: string, from: string | null): ComponentValueResult<T>;
```

### Reporting Unexpected Stops

If a component stops on its own, such as a crashed server, a lost database connection, or a worker thread that exited, call `reportUnexpectedStop()` so the manager can update its state, emit `component:unexpected-stop`, and then emit the canonical `component:stopped` event for the resulting stopped state:

```typescript
class ServerComponent extends BaseComponent {
  private server?: http.Server;
  private stopping = false;
  private serverError?: Error;

  async start() {
    const reportUnexpectedStop = this.getUnexpectedStopReporter();
    this.stopping = false;
    this.serverError = undefined;
    this.server = http.createServer(this.handler);
    this.server.listen(8080);

    this.server.on('error', (err) => {
      // 'error' isn't always fatal (e.g. a transient socket error may leave the
      // server still listening). Store it so 'close' can report it with context.
      this.serverError = err;
    });

    this.server.on('close', () => {
      // 'close' is the definitive "server stopped" signal. Guard with the
      // stopping flag so it only fires when the manager didn't ask us to stop.
      if (!this.stopping) {
        reportUnexpectedStop(
          this.serverError ?? new Error('Server closed unexpectedly'),
        );
      }
    });
  }

  async stop() {
    this.stopping = true;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
```

The `component:unexpected-stop` event gives callers a single place to decide what to do, such as restart, escalate, or shut everything down. `component:stopped` follows immediately afterward so generic "component is now stopped" listeners still work for this path. If you call `stopAllComponents()` in response, the already-stopped component is skipped naturally (it's no longer running), and the rest of the shutdown proceeds in normal dependency order. The error passed to `reportUnexpectedStop()` is stored as `lastError` on the component's status and remains visible after shutdown. For async listeners registered in `start()`, prefer `getUnexpectedStopReporter()` as shown above so callbacks from an older run become a no-op after restart. `reportUnexpectedStop()` remains useful for immediate or synchronous detection paths. Both return `true` if the manager accepted the signal for the current run, otherwise `false`.

A stalled component started again with `startComponent(name, { forceStalled: true })` that reports an unexpected stop before that start completes goes back to `stalled`, not `stopped`: the stop that stalled is still unfinished, and its stall record stands. It emits `component:unexpected-stop` (with the state already `stalled`) but no `component:stopped`; the stall still ends with `component:stalled-resolved`, as any stall does. The start answers `component_unexpected_stop`.

If a component reports an unexpected stop while `startAllComponents()` is still in progress, the startup attempt is reconciled before completion: a required component causes bulk startup to fail with `code: 'component_unexpected_stop'` and triggers rollback of any later-started components, while a stopped optional component is recorded in `failedOptionalComponents` and startup continues. A component that a listener has already started again by the time the report is reconciled (with `allowDuringBulkStartup: true`) - including one that reported the stop from inside its own `start()` - is still reported this way, and still counts as started: a required failure's rollback stops it as well. An optional one is then listed in both `failedOptionalComponents` (its failed run) and `startedComponents` (its current one).

### Component Properties

```typescript
// Access component metadata
getName(): string
getDependencies(): string[]
isOptional(): boolean

// Configuration, as resolved by the constructor
readonly startupTimeoutMS: number
readonly shutdownGracefulTimeoutMS: number
readonly shutdownForceTimeoutMS: number
readonly healthCheckTimeoutMS: number
readonly signalTimeoutMS: number
readonly ownsLateStartCleanup: boolean // see Late-Start Cleanup

// Get this component's own status from the manager (no need to pass name)
// Returns undefined if the component is not registered
// Check status?.state === 'running' to test if currently running
protected getSelfStatus(): ComponentStatus | undefined

// Capture a run-scoped callback for async listeners created during start()
// The returned function becomes a no-op after stop, unregister, or restart
// Returns true if the signal was accepted for the current run
protected getUnexpectedStopReporter(): (error?: Error) => boolean

// Report an unexpected stop directly for immediate or synchronous detection paths
// Returns true if the signal was accepted for the current run
protected reportUnexpectedStop(error?: Error): boolean

// Logger (pre-configured with component name)
protected logger: LoggerService

// Lifecycle manager reference (for advanced usage)
protected lifecycle: ComponentLifecycleRef
```

**Component Lifecycle Reference:**

Components have access to a `lifecycle` property that provides a restricted view of the LifecycleManager. This allows components to interact with other components at runtime:

```typescript
class ApiComponent extends BaseComponent {
  async start() {
    // Check if optional dependency is running
    if (this.lifecycle.isComponentRunning('cache')) {
      // Get value from cache component
      const result = this.lifecycle.getValue('cache', 'instance');

      if (result.found) {
        this.cache = result.value;
      }
    }

    // Send message to another component
    await this.lifecycle.sendMessageToComponent('metrics', {
      event: 'api-started',
      timestamp: Date.now(),
    });
  }
}
```

**Available methods through `lifecycle`:**

- **Event listeners**: `on()`, `once()`, `hasListener()`, `hasListeners()`, `listenerCount()`
- **Component queries**: `hasComponent()`, `isComponentRunning()`, `getComponentStatus()`, `getComponentNames()`, `getRunningComponentNames()`, `getComponentCount()`, `getRunningComponentCount()`, `getStalledComponentCount()`, `getStoppedComponentCount()`, and `getAllComponentStatuses()`. Use `getSelfStatus()` (on `BaseComponent` directly) to query your own state without passing the name
- **System state**: `getSystemState()`, `getStatus()`
- **Stalled/stopped components**: `getStalledComponents()`, `getStalledComponentNames()`, `getStoppedComponentNames()`
- **Dependency validation**: `validateDependencies()`, `getStartupOrder()`
- **Lifecycle control**: `startAllComponents()`, `stopAllComponents()`, `restartAllComponents()`, `startComponent()`, `stopComponent()`, `restartComponent()`
- **Messaging**: `sendMessageToComponent()`, `broadcastMessage()`
- **Value sharing**: `getValue()`
- **Health checks**: `checkComponentHealth()`, `checkAllHealth()`
- **Signal management**: `attachSignals()`, `detachSignals()`, `getSignalStatus()`, `triggerReload()`, `triggerInfo()`, `triggerDebug()`

**Note:** While lifecycle control methods are available through the lifecycle reference, use them with caution. For startup/shutdown ordering, prefer declaring dependencies in your component's configuration rather than manually controlling other components' lifecycles.

## Events

The LifecycleManager emits events for monitoring and observability. All events are typed via `LifecycleManagerEvents`.

Manager-generated **state notifications** run after synchronous state transitions
finish. They retain FIFO order across listener re-entry: notifications raised by a
listener wait behind those already queued and the current event's remaining listeners.
Listener promises are not awaited. Payloads describe the originating snapshot; use
status getters for current state, which earlier listeners may have changed.

Four **synchronous control events** can overtake queued notifications:

- `lifecycle-manager:signals-attached` lets listeners intervene before startup proceeds
  when `attachSignalsBeforeStartup` is enabled.
- `lifecycle-manager:shutdown-initiated` runs after acquiring the shutdown latch and
  before dependency getters or pending-start abort listeners run.
- `signal:shutdown` runs before the request can invoke `onForceShutdown()`.
- `lifecycle-manager:shutdown-escalation-forced` runs after `onForceShutdown()` returns.
  A synchronous `logger.exit()` from this listener can proceed without waiting for a
  blocked shutdown pass. The event cannot run if the force callback exits the process.

**Timing:** state notification listeners see completed bookkeeping, not the
intermediate state of a transition still in progress. There is no global FIFO across
state notifications and control events, and synchronous control guards do not extend
past an async listener's `await`.

### Subscribing to Events

```typescript
import type { LifecycleManagerEventMap } from 'lifecycleion/lifecycle-manager';

// Type-safe event subscription
lifecycle.on('component:started', (data) => {
  console.log(`Component ${data.name} started`);
});

lifecycle.on('lifecycle-manager:shutdown-completed', (data) => {
  console.log(`Shutdown completed in ${data.durationMS}ms`);

  if (!data.success) {
    console.error('Shutdown issues:', data);
  }

  process.exit(data.success ? 0 : 1);
});
```

### Event Categories

**Lifecycle Events:**

- `lifecycle-manager:started` - All components started successfully
- `lifecycle-manager:shutdown-initiated` - Shutdown process started
- `lifecycle-manager:shutdown-warning` - Global warning phase started
- `lifecycle-manager:shutdown-warning-completed` - Warning phase completed
- `lifecycle-manager:shutdown-warning-timeout` - Warning phase timed out; `pending` lists the components reported by `component:shutdown-warning-timeout`, so it leaves out those whose hook already completed, failed, or was skipped
- `lifecycle-manager:shutdown-completed` - Shutdown attempt completed, includes the `ShutdownResult` fields at the top level plus `method` / `duringStartup`. This is the best single event for centralized logging or follow-up policy when shutdown times out or leaves stalled components. If the global shutdown timeout was hit, the payload reflects the result at the moment the public call stopped waiting. A component stop already in flight is not cancelled: its per-component state continues to reject an overlapping start or stop, while the process-wide shutdown latch is released so exit handling and later shutdown/escalation attempts can proceed. It always pairs with `lifecycle-manager:shutdown-initiated`: a pass that throws outright still emits it with `success: false`, `code: 'operation_crashed'` and a `reason` naming the cause - the same result `stopAllComponents()` resolves with - so a caller waiting on it is never left hanging. Listeners run while the pass still holds its shutdown latch: `getSystemState()` says `shutting-down` there, and any operation started from inside one - `stopAllComponents()`, `startAllComponents()`, a per-component start or stop - is refused (`already_in_progress` / `shutdown_in_progress`). To act on the result, defer out of the listener (`setImmediate`, `queueMicrotask`), or `await` the promise `stopAllComponents()` returned instead of listening.

**Component Registration:**

- `component:registered` - Component registered
- `component:unregistered` - Component unregistered

**Component Lifecycle:**

- `component:starting` - Component start initiated
- `component:started` - Component started successfully. Also emitted for a `start()` that finishes after a shutdown began, immediately followed by that component's stop (its `startComponent()` result is still `shutdown_in_progress`)
- `component:start-failed` - Component start failed
- `component:shutdown-warning` - Component selected for a shutdown warning
- `component:shutdown-warning-completed` - The invoked warning hook completed. Not emitted for a component already reported by `component:shutdown-warning-timeout`: a hook that settles after the warning phase timed out does not also report completion
- `component:shutdown-warning-failed` - The invoked warning hook threw synchronously or rejected; includes `name` and `error`. Like completion, not emitted for a component already reported by `component:shutdown-warning-timeout`: a hook that fails after the warning phase timed out is only logged
- `component:shutdown-warning-skipped` - A selected warning hook was not invoked because its registration or state changed, or a lifecycle phase took it; includes `name`, `reason` (`component_not_found`, `component_changed`, or `component_not_available`), and the name's current `state` when one is registered
- `component:stopping` - Component stop initiated
- `component:stopped` - Component is now stopped. Emitted after normal manager-driven stop flows, after late stall resolution, and after `reportUnexpectedStop()` transitions a running component into the stopped state. Its `status` is read through `getComponentStatus()`; if an override of it throws, the throw is reported on the global `'error'` channel and the event is still emitted, without `status`
- `component:stop-failed` - Component stop failed
- `component:stalled` - Component failed to stop after graceful/force handling timed out or errored. A failed `retryStalled` retry emits it again with a new record that replaces the earlier one; the stall continues, and a single `component:stalled-resolved` ends it
- `component:stalled-resolved` - A stall was cleared after its stop completed (late, or through a successful `retryStalled` force retry), or retired by a forced start: `reason: 'forced-start'` when the forced start itself brings the component up (or, with shutdown begun meanwhile, straight into cleanup), and `reason: 'late-start-cleanup'` when a timed-out forced start succeeds late and its cleanup retires the stall. Either reason means the old stop was superseded, not that it finished.
- `component:unexpected-stop` - Component reported stopping on its own via `reportUnexpectedStop()`. Payload includes `name` and an optional `error`. This event fires before the follow-up `component:stopped` event so listeners can react to the abnormal cause separately from the generic stopped-state transition. A forced start of a stalled component that reports one before it completes goes back to `stalled` and gets no `component:stopped` (see [Reporting Unexpected Stops](#reporting-unexpected-stops))

**Signal Events:**

- `signal:shutdown` - Shutdown request received, includes `method` and whether shutdown was already in progress via `isAlreadyShuttingDown`
- `signal:reload` - Reload signal received
- `signal:info` - Info signal received
- `signal:debug` - Debug signal received
- `lifecycle-manager:shutdown-escalation-armed` - Failed/timed-out shutdown left escalation armed briefly for follow-up force presses. Like `shutdown-completed`, it fires while the failed pass still holds its shutdown latch, so defer any follow-up operation out of the listener.
- `lifecycle-manager:shutdown-escalation-expired` - Armed escalation window expired and was cleared
- `lifecycle-manager:shutdown-escalation-forced` - Repeated shutdown requests crossed the force threshold and `onForceShutdown()` was invoked. The payload includes `wasArmedAfterFailure` to indicate whether the threshold was crossed during an active shutdown or from the post-failure armed window

**Component Signal Events:**

- `component:reload-started` - Component reload started
- `component:reload-completed` - Component reload completed
- `component:reload-failed` - Component reload failed
- `component:info-started` - Component info started
- `component:info-completed` - Component info completed
- `component:info-failed` - Component info failed
- `component:debug-started` - Component debug started
- `component:debug-completed` - Component debug completed
- `component:debug-failed` - Component debug failed

Each `*-started` event precedes that component's final availability check, which follows the event's listeners even for a broadcast made from inside another listener. A listener that begins teardown synchronously prevents the handler from running; the component then reports `*-failed` and `code: 'unavailable'`. A handler or `signalTimeoutMS` getter that makes its own component unavailable is reported the same way, with its `*-started` and `*-failed` emitted back to back. Every `*-started` is followed by exactly one `*-completed` or `*-failed`, including for a component whose handler or `signalTimeoutMS` could not be read: its `*-started` and `*-failed` are emitted back to back, and the handler is not called.

**Messaging Events:**

- `component:message-sent` - A message dispatch is about to be attempted. This event precedes the final availability check and handler invocation; a listener can prevent dispatch by beginning teardown synchronously. The check waits one microtask after the event, so this holds for a send made from inside another manager event listener too, where the event is queued rather than delivered at once. Such a refusal emits `component:message-failed` and returns `sent: false`. Use the returned `MessageResult` to count dispatched messages, not this event.
- `component:message-failed` - Message send failed
- `component:broadcast-started` - Broadcast started
- `component:broadcast-completed` - Broadcast completed

**Health Events:**

- `component:health-check-started` - Health check started. As with `component:message-sent`, the final availability check follows this event's listeners, even for a check made from inside another listener: one that begins teardown synchronously prevents the hook from running, and the check reports `component:health-check-failed`.
- `component:health-check-completed` - Health check completed
- `component:health-check-failed` - Health check failed

**Value Events:**

- `component:value-requested` - Value requested. `getValue()` answers synchronously, so it cannot wait for this event's listeners: called from inside another manager event listener, both value events are delivered after the call has returned, and a `value-requested` listener cannot prevent the read.
- `component:value-returned` - Value returned

### Event Handler Best Practices

Event handlers are **fire-and-forget** - they do not block lifecycle operations.

**Event Handler Error Handling:** The LifecycleManager automatically catches errors thrown by event handlers via `safeHandleCallback`, preventing them from breaking lifecycle operations. Errors are dispatched as `ErrorEvent` objects on the standard global `'error'` event channel:

```typescript
// Listen for event handler errors
globalThis.addEventListener('error', (event) => {
  if (event instanceof ErrorEvent) {
    // Claim the report, so it is not written to the console as well
    event.preventDefault();

    console.error('Event handler error:', event.error.message);
    // error.message names the callback: "Error in a callback event handler for component:started"
    // The error the handler actually threw is on `event.error.cause`, so you can render it
    // with your own settings - or use `errorToString(event.error)`, which renders both.
  }
});
```

Available in Node.js 25+, Bun, Deno, and modern browsers. **Note:** Errors are NOT logged to the LifecycleManager's logger - use an `'error'` listener, or `logger.registerReportErrorListener()`, for custom logging/monitoring.

However, it's still best practice to handle errors explicitly in your handlers for better control over error logging and recovery.

```typescript
// ✅ Best - handle errors explicitly for better control
lifecycle.on('component:started', async (data) => {
  try {
    await logToDatabase(data);
  } catch (error) {
    logger.errorObject('Failed to log component start', error);
    // Can add custom recovery logic here
  }
});

// ✅ Safe but less control - manager catches and logs errors
lifecycle.on('component:started', async (data) => {
  await logToDatabase(data); // Errors are caught by manager
});

// ❌ Bad - blocking or long-running work
lifecycle.on('component:started', async (data) => {
  // Don't perform expensive operations here - events are for notifications only
  await performExpensiveMigration(); // This blocks the event loop
});
```

## Error Handling

### Result Objects vs Exceptions

The LifecycleManager uses **result objects** for expected failures and reserves **exceptions** for programmer errors or invalid construction.

#### Operations Return Result Objects

All lifecycle operations return result objects, for example:

```typescript
const result = await lifecycle.startComponent('database');

if (!result.success) {
  console.error('Start failed:', result.reason);
  console.error('Error code:', result.code);

  // Handle specific failures
  if (result.code === 'missing_dependency') {
    console.error('Missing dependencies');
  }
}

// Access component state immediately
if (result.success && result.status) {
  console.log('Started at:', result.status.startedAt);
}
```

#### Promises Never Reject

Every async method answers with a result object, including when something goes wrong that the manager did not plan for - a bug in the manager, or a component that breaks its contract with a getter (`getName()`, `getDependencies()`, `isOptional()`, or a `start` / `stop` accessor) that throws. The promise resolves with a failed result and the original error is reported on the global `'error'` channel (see [safe-handle-callback](./safe-handle-callback.md)):

| Method                                                                   | Unexpected failure resolves with                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `registerComponent()`, `insertComponentAt()`                             | `code: 'operation_crashed'`, `registered`: whether this call added it |
| `unregisterComponent()`                                                  | `code: 'operation_crashed'`                                           |
| `startAllComponents()`, `stopAllComponents()`, `restartAllComponents()`  | `code: 'operation_crashed'` with `error`                              |
| `startComponent()`, `stopComponent()`, `restartComponent()`              | `code: 'operation_crashed'` with `error`                              |
| `getStartupOrder()` (synchronous)                                        | `code: 'operation_crashed'` with `error`                              |
| `sendMessageToComponent()`, `checkComponentHealth()`, `checkAllHealth()` | `code: 'operation_crashed'`                                           |
| `getValue()` (synchronous)                                               | `code: 'operation_crashed'` with `error`                              |
| `triggerReload()`, `triggerInfo()`, `triggerDebug()`                     | `code: 'operation_crashed'` with `error`                              |
| `broadcastMessage()`                                                     | an empty array                                                        |

Invalid timeout values, and a non-array (or invalid-length) `broadcastMessage()` `componentNames`, are
expected refusals (`invalid_options`) and do not use the global callback-error channel;
inspect their `error` for the named option. The array-only `broadcastMessage()` result
has no aggregate error field, so its refusal is logged as a warning instead. The table
above describes unexpected failures, including ordinary exceptions thrown by getters.

Branch on `code` as usual; `operation_crashed` is never an expected outcome, so treat it as a bug to report rather than a condition to retry around. Every call uses the same pair of codes. `error` means a method you wrote ran and failed: a component's `start()`, `stop()`, `onShutdownForce()`, `healthCheck()`, `onMessage()` or `getValue()` threw, rejected, or (for `healthCheck()`) returned a malformed result, or a custom `onReloadRequested` / `onInfoRequested` / `onDebugRequested` callback threw or rejected. That is an ordinary failure of that code, not of the manager. `operation_crashed` means something that should never throw did: the manager itself, or a property getter on a component - a handler such as `onMessage`, a timeout such as `healthCheckTimeoutMS`, or `getName()`. A `getDependencies()` that throws refuses its registration with `operation_crashed`, but once registered it fails only that component's own start, with `missing_dependency`. An array whose `length` is not a whole number from 0 to 10,000 is treated the same way, before any entry is read - the dependency-list counterpart of `broadcastMessage()`'s 100,000-name `componentNames` bound - and `validateDependencies()` lists it under `invalidDependencyLists`.

A stop that crashes still records the component as stalled, so it can be retried or unregistered. Its result carries `status`, whose `stallInfo` describes that stall, and its `reason` says so when the graceful phase had already timed out first. Its `component:stalled` event uses `component_shutdown_timeout` when it crashed while still in the graceful phase after that phase timed out, and `operation_crashed` otherwise - including a crash in the force phase after a graceful timeout (`reason: 'both'`).

Automatic signal handling follows the configuration. A start that is configured to attach process signals (`attachSignalsBeforeStartup`, `attachSignalsOnStart`) fails with `code: 'signal_attach_failed'` when attaching throws, rather than bringing the process up without them - see [`attachSignals()`](#attachsignals). A detach that throws once the last component stops (`detachSignalsOnStop`) does not fail the stop or unregister it follows: the operation carries on and the failure is logged and reported. An explicit `attachSignals()` / `detachSignals()` call still throws to its caller.

#### Running Operations in the Background

There is no `wait: false` option; there doesn't need to be. Because no promise rejects, you can start any operation without awaiting it and still read its result later from the same promise:

```typescript
// Inside an HTTP handler that must respond now
const pending = lifecycle.stopAllComponents();

res.status(202).send('shutting down');

pending.then((result) => {
  if (!result.success) {
    console.error('Shutdown did not complete cleanly:', result.reason);
  }
});
```

If you don't need the result, `void lifecycle.stopAllComponents()` is safe too - there is no rejection to go unhandled. Events and state getters still report the outcome: `lifecycle-manager:shutdown-completed`, `getLastShutdownResult()`, and `getSystemState()`.

A call that is refused - `already_in_progress`, `shutdown_in_progress`, and so on - resolves almost immediately, so you still find out quickly whether what you asked for was accepted.

#### Exceptions (Programmer Errors)

Exceptions are limited to invalid construction and explicit synchronous calls such as `attachSignals()`. The async public API never rejects - see [Promises Never Reject](#promises-never-reject).

Explicit exceptions you may see:

- `BaseComponent` constructor validation:

```typescript
// ❌ Throws InvalidComponentNameError
new MyComponent(logger, { name: 'Invalid Name' }); // Must be kebab-case

// ✅ Valid name
new MyComponent(logger, { name: 'my-component' });
```

- `LifecycleManager` constructor requires a root logger:

```typescript
// ❌ Throws Error
new LifecycleManager({} as any);
```

Dependency cycle detection throws `DependencyCycleError` internally, but public methods catch it and return a result with `code: 'dependency_cycle'`.

### Failure Codes

Result objects include machine-readable failure codes.

**Timeout Code Naming Convention:**

- Bulk operations (e.g., `startAllComponents()`, `stopAllComponents()`) use `startup_timeout` / `shutdown_timeout`
- Individual component operations (e.g., `startComponent()`, `stopComponent()`) use `component_startup_timeout` / `component_shutdown_timeout`

This distinction makes it clear whether the timeout occurred at the bulk operation level or the individual component level.

```typescript
// Component operation failure codes
type ComponentOperationFailureCode =
  | 'invalid_options'
  | 'component_not_found'
  | 'component_already_running'
  | 'component_already_starting'
  | 'component_already_stopping'
  | 'component_not_running'
  | 'component_stalled'
  | 'missing_dependency'
  | 'dependency_not_running'
  | 'has_running_dependents'
  | 'startup_in_progress'
  | 'shutdown_in_progress'
  | 'component_unexpected_stop' // The component reported an unexpected stop during its start
  | 'component_startup_timeout'
  | 'component_shutdown_timeout'
  | 'restart_stop_failed'
  | 'restart_start_failed'
  | 'shutdown_requested_during_restart' // restartComponent() skipped its start for a request to stay down
  | 'startup_rolled_back' // auto-start refused because bulk startup is rolling back
  | 'signal_attach_failed'
  | 'error' // The component's own start(), stop(), or onShutdownForce() failed
  | 'operation_crashed'; // The operation itself threw - a bug to report

// Registration failure codes
type RegistrationFailureCode =
  | 'duplicate_name'
  | 'duplicate_instance'
  | 'shutdown_in_progress'
  | 'startup_in_progress'
  | 'target_not_found'
  | 'invalid_position'
  | 'dependency_cycle'
  | 'invalid_options' // The component defines onStartupAborted(), onGracefulStopTimeout() or onShutdownForceAborted(), which are not supported; use the abort signals
  | 'operation_crashed';

// Unregister failure codes
type UnregisterFailureCode =
  | 'component_not_found'
  | 'component_running'
  | 'component_starting' // A start is in flight; wait for it to settle
  | 'component_stopping' // A stop is in flight; wait for it to settle
  | 'stop_failed'
  | 'bulk_operation_in_progress'
  | 'invalid_options' // An invalid timeout refused before the operation ran
  | 'operation_crashed';

// Startup order failure codes
type StartupOrderFailureCode = 'dependency_cycle' | 'operation_crashed';
```

## Advanced Usage

### Dynamic Component Management

Add and remove components at runtime:

```typescript
// Add component during runtime with autoStart
const result = await lifecycle.registerComponent(
  new CacheComponent(logger),
  { autoStart: true }, // Automatically starts when possible
);

// Remove component (stops it first if running)
await lifecycle.unregisterComponent('cache');
```

### Dependency Validation

Validate dependencies before startup:

```typescript
const validation = lifecycle.validateDependencies();

if (!validation.valid) {
  console.error('Dependency issues found:');

  for (const issue of validation.missingDependencies) {
    console.error(
      `${issue.componentName} missing dependency: ${issue.missingDependency}`,
    );
  }

  for (const cycle of validation.circularCycles) {
    console.error(`Dependency cycle: ${cycle.join(' → ')}`);
  }

  console.error('Summary:', validation.summary);
}
```

### Stalled Component Recovery

Handle components that fail to stop:

`lifecycle-manager:shutdown-completed` is the usual global hook for deciding what to do next when `success` is false, including `cleanup_incomplete`, timeouts, and stalled components. Use repeated shutdown escalation separately when you want follow-up shutdown requests to trigger another shutdown pass or invoke force behavior.

```typescript
const shutdownResult = await lifecycle.stopAllComponents();

if (shutdownResult.stalledComponents.length > 0) {
  console.error('Stalled components:', shutdownResult.stalledComponents);

  // Option 0: Retry via force phase (escalation - does NOT re-run stop())
  // If the component implements onShutdownForce(), that is called.
  // If not, the component stalls again immediately.
  await lifecycle.stopAllComponents({ retryStalled: true });

  // Option 1: Unregister stalled components
  for (const stalled of shutdownResult.stalledComponents) {
    await lifecycle.unregisterComponent(stalled.name);
  }

  // Option 2: Start non-stalled components while skipping stalled ones
  await lifecycle.startAllComponents({ ignoreStalledComponents: true });

  // Option 3: Force restart an individual stalled component (risky - the
  // component's start() must protect against any still-running shutdown work
  // from the previous run)
  await lifecycle.startComponent('server', { forceStalled: true });
}
```

`ignoreStalledComponents` does not force-start stalled components during bulk startup. It lets startup continue for non-stalled components and skips stalled entries. Stalled components then count neither as running nor as left to start: when every other component is already running, the call answers as an all-running startup does - success, with those components as `startedComponents` and the stalled ones in `skippedDueToStall` - while some running and some not is still refused as `partial_state`. Forced starts use `startComponent(name, { forceStalled: true })` and are only safe when the component's `start()` implementation does not report success while its own previous `stop()` work is still active. For server-like components, reject `start()` while a `stopPromise` exists so the manager does not mark the component running while the old shutdown can still close its resources.

**If `onShutdownForce()` should join the already-running `stop()`**, deduplicate the promise in `stop()` so that calling it again, or calling it from `onShutdownForce()`, simply awaits the same in-flight operation. Note: This example uses a simplified, idealized `this.server.close()` abstraction. For a complete, production-ready component that also coordinates startup and rejects start attempts while stopping, see [Best Practice #7](#7-make-component-startup-idempotent-and-coordinate-with-shutdown):

```typescript
class ServerComponent extends BaseComponent {
  // Stored so concurrent callers (e.g. onShutdownForce) join the same
  // in-flight promise rather than starting a second concurrent close.
  private stopPromise: Promise<void> | null = null;

  async stop() {
    // Return the same promise if stop is already running, so concurrent callers
    // (including onShutdownForce) join the in-flight operation
    // instead of starting a second concurrent close.
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = (async () => {
      try {
        await this.server.close(); // waits for keep-alive connections to drain
      } finally {
        // Runs on both success and error. Without this, a thrown error would leave
        // stopPromise pointing at a rejected promise forever. Since there's no catch,
        // errors still propagate normally to any caller awaiting this promise.
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  async onShutdownForce() {
    // Force-close open connections so server.close() in the in-flight stop()
    // can finish draining and resolve. Both ?. guards are needed: the outer one
    // handles server not yet assigned (e.g. start() failed), the inner one
    // handles runtimes that don't expose closeAllConnections. (Note: If coordinating
    // with an active start(), you would also check/await that promise here.)
    this.server?.closeAllConnections?.();
    // Wait for the stop() promise to resolve
    await this.stop();
  }
}
```

Alternatively, unblock `stop()` directly when its graceful timeout is reached: listen for the abort of the signal passed to `stop(signal)` (see [Stop Abort Signals](#stop-abort-signals)). When the graceful timeout is reached, the manager aborts the signal and then proceeds with timeout handling, which may enter the force phase or mark the component stalled. A listener that unblocks `stop()` lets it finish as the success it is; if it settles later, the manager's late-resolution handling clears the stall automatically:

```typescript
class ServerComponent extends BaseComponent {
  async stop(signal: AbortSignal) {
    signal.addEventListener('abort', () => {
      // Runs while stop() is still running but has exceeded shutdownGracefulTimeoutMS.
      // Force-closing connections unblocks server.close(), which lets stop() resolve.
      // Both ?. guards are needed: the outer one handles server not yet assigned,
      // the inner one handles runtimes that don't expose closeAllConnections. (Note: If
      // coordinating with an active start(), you would ensure startup settled first.)
      this.server?.closeAllConnections?.();
    });
    await this.server.close(); // waits for keep-alive connections to drain
  }
}
```

If `stop()` (or `onShutdownForce()`) just needs more time and will eventually complete on its own, the automatic late-resolution behavior handles it: the manager clears the stall and emits `component:stalled-resolved` when the promise resolves, with no manual retry needed.

The key requirement is still that the promise eventually settles: late resolution is supported, but never-settling shutdown work will remain stalled until you intervene or the process exits.

## Best Practices

### 1. Design Components for Graceful Shutdown

Implement cooperative cancellation:

```typescript
class WorkerComponent extends BaseComponent {
  async start(signal: AbortSignal) {
    // Check the signal between steps of long operations
    for (const task of tasks) {
      signal.throwIfAborted();
      await processTask(task);
    }

    // Pass it to APIs that support signals
    await fetch(url, { signal });
  }

  async stop(signal: AbortSignal) {
    // Graceful shutdown - wait for current work, until the graceful timeout aborts
    // the signal and the work should be abandoned
    await this.waitForCurrentWork({ signal });
  }
}
```

### 2. Use Appropriate Timeouts

Configure timeouts based on your component's needs:

```typescript
const lifecycle = new LifecycleManager({
  logger,
  startupTimeoutMS: 60000, // Long-running migrations (global timeout for all components)
  shutdownOptions: { timeoutMS: 10000 }, // Most components stop quickly (global timeout)
  shutdownWarningTimeoutMS: 5000, // Time to flush buffers
});
```

### 3. Handle Optional Dependencies

Mark non-critical components as optional:

```typescript
class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // App works without cache
    });
  }
}

// Check for degraded mode
const result = await lifecycle.startAllComponents();

if (result.failedOptionalComponents.some((item) => item.name === 'cache')) {
  logger.warn('Running without cache - performance may be degraded');
}
```

### 4. Leverage Events for Monitoring

Use events for observability, not control flow:

```typescript
// ✅ Good - monitoring and observability
lifecycle.on('component:started', ({ name }) => {
  metrics.increment('component.started', { component: name });
});

// ❌ Bad - don't use events for control flow
lifecycle.on('component:started', async ({ name }) => {
  // Don't start other components here - use dependencies instead
  await lifecycle.startComponent('other-component');
});
```

### 5. Validate Before Production

Always validate dependencies before production:

```typescript
// Validate dependency graph
const validation = lifecycle.validateDependencies();

if (!validation.valid) {
  throw new Error(
    'Invalid dependencies: ' +
      JSON.stringify({
        missingDependencies: validation.missingDependencies,
        circularCycles: validation.circularCycles,
      }),
  );
}
```

### 6. Use Single LifecycleManager Instance

Only create one instance per application:

```typescript
// ✅ Good - single instance
const lifecycle = new LifecycleManager({ logger });
lifecycle.attachSignals();

// ❌ Bad - multiple instances cause signal conflicts
const lifecycle1 = new LifecycleManager({ logger });
const lifecycle2 = new LifecycleManager({ logger });
lifecycle1.attachSignals(); // Conflicts with lifecycle2
```

### 7. Make Component Startup Idempotent and Coordinate With Shutdown

For servers and long-running services, make `start()` idempotent by tracking an in-flight `startPromise`, and make `stop()` idempotent by tracking an in-flight `stopPromise`. Additionally, reject `start()` while `stop()` is in progress, and coordinate `stop()` so that it awaits any active `startPromise` before shutting down.

This prevents race conditions such as a shutdown request arriving mid-boot, multiple callers starting the same server concurrently, or a force restart trying to reuse a server that is still shutting down. Starting while stopping should be treated as an error: the existing runtime is being torn down, so a new start attempt must wait until shutdown settles and can create a fresh runtime.

If the component is already ready, `start()` can return successfully without creating another resource. If initialization is still pending, return its existing promise or reject the duplicate call explicitly. Do not return successfully before the component is ready, because the manager treats a fulfilled startup promise as readiness. The example below keeps the successful startup promise until shutdown, so subsequent calls reuse it.

A startup timeout does not automatically retry `start()`. If your application requests another start after a timeout, the original work may still be running. The manager uses attempt tokens to prevent an old late-completion handler from changing the newer run's state or stopping it. Those tokens do not prevent your original `start()` from assigning to component fields or creating resources. Reuse the pending promise, or cancel and settle the old work before creating a replacement. If overlapping attempts are intentional, the component needs its own attempt checks before publishing resources and must dispose of resources created by superseded attempts.

```typescript
class ServerComponent extends BaseComponent {
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    // Starting while shutdown is active is not a safe no-op: the manager could
    // mark the component running while the old stop() is still draining.
    if (this.stopPromise) {
      throw new Error('Cannot start server while shutdown is in progress');
    }

    // Return the same promise if start is already running, so concurrent callers
    // join the in-flight operation instead of starting a second concurrent startup.
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      try {
        this.server = createServer();
        await this.server.listen(3000);

        this.logger.success('Server started');
      } catch (error) {
        // Reset startup state on failure so startup can be retried.
        this.server = null;
        this.startPromise = null;
        throw error;
      }
    })();

    return this.startPromise;
  }

  async stop(signal?: AbortSignal): Promise<void> {
    // The manager aborts its signal at the graceful timeout: force-closing active
    // connections then unblocks the in-flight close below. (Absent when
    // onShutdownForce() joins this stop.)
    signal?.addEventListener('abort', () => {
      this.server?.closeAllConnections?.();
    });

    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      try {
        // Await active startup to settle before stopping, preventing orphaned
        // listening sockets if shutdown is initiated mid-boot.
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Ignore startup errors since we are stopping anyway
          }
        }

        // Keep a local reference so this stop attempt closes the same runtime
        // even if component state changes while shutdown is in progress.
        const server = this.server;
        if (server) {
          await server.close();
        }

        // Only clear the server reference after a successful stop. If stop()
        // rejects, force shutdown still needs this.server to close connections.
        this.server = null;
        this.startPromise = null;
      } finally {
        // Runs on both success and error. Without this, a thrown error would leave
        // stopPromise pointing at a rejected promise forever. Since there's no catch,
        // errors still propagate normally to any caller awaiting this promise.
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  async onShutdownForce(): Promise<void> {
    // If graceful close failed or timed out, keep using the same server handle and
    // join the in-flight stop() promise instead of starting a second close.
    this.server?.closeAllConnections?.();
    await this.stop();
  }
}
```

**Cooperative Cancellation during Startup:** The signal passed to `start(signal)` covers the manager giving up on a start (a timeout); pass it to your startup operations (like database connections or fetch requests). It is not aborted when `stop()` or a shutdown arrives while `start()` is still in flight, unless that shutdown uses `abortPendingStarts`. To also cancel startup from `stop()`, create your own `AbortController` for each startup attempt, store it as an instance property on your component, pass `AbortSignal.any([signal, this.abortController.signal])` to your startup operations (listeners on that derived signal are not guarded like `signal`'s, so catch inside them), and call `this.abortController.abort()` at the very beginning of your `stop()` method. Because an aborted signal stays aborted permanently, create a fresh controller before each retry or restart. Because `stop()` is protected by the `stopPromise` guard, this abort will only ever be triggered once for each stop attempt. If the underlying operations honor cancellation, awaiting the in-flight `startPromise` immediately after allows shutdown to proceed once they settle. Aborting the signal alone does not guarantee prompt completion. However, for standard single-step operations (like binding an HTTP server via `listen()`), awaiting the in-flight promise to settle and then immediately shutting it down remains the simplest and safest path.

If the start signal aborts but `start()` stays
pending, the manager keeps that component's dependencies protected. Prefer making
`start()` resolve or reject after cancellation, once the component has stopped using
those dependencies. If it never
settles, unregistering the component explicitly releases the manager's protection;
it does not cancel the underlying work. Use that escape hatch only when your
application can safely abandon the work.

**Force-Closing Connections on Shutdown:** For servers using raw Node.js `http.Server`, active keep-alive connections will prevent the server from fully closing, causing `stop()` to stall. To handle this gracefully, you can run `this.server?.closeAllConnections?.()` from either place:

1. An `'abort'` listener on the signal passed to `stop(signal)`: it fires when the graceful timeout is hit, letting you nudge the existing `stop()` promise to settle - as a success, or later via late-resolution handling.
2. `onShutdownForce()`: Called during the force shutdown phase. Awaiting `this.stop()` here (after force-closing) allows you to clean up and settle during the force escalation phase.

See the [Stalled Component Recovery](#stalled-component-recovery) section for examples of how to implement these patterns.

### 8. Safe Resource Sharing via Dynamic Wrappers

When sharing resources (such as a database connection pool, a Redis client, or an API client) via `getValue()`, consumers, whether they are other registered components (like background workers), web servers, or middleware, should avoid holding onto direct, long-lived references to the underlying resource. Doing so can cause issues if the provider component restarts, stops, or goes offline.

Instead, the resource-providing component should manage the connection lifecycle and expose it via `getValue()`, while consumers use a **Wrapper** class that dynamically resolves the active resource on every call.

#### Step 1: The Resource Component

The component manages the database pool's lifecycle (creation, testing, and teardown). It can also implement logic to swap a live connection pool with zero downtime, or buffer replacement credentials for the next manager-driven startup when the pool is stopped or stopping.

```typescript
import {
  BaseComponent,
  type ComponentValueResult,
} from 'lifecycleion/lifecycle-manager';
import type { Logger } from 'lifecycleion/logger';
import { Pool } from 'pg';
import { ulid } from 'ulid';

export interface DatabaseConfig {
  // Required connection parameters
  user: string;
  host: string;
  database: string;
  password: string;
  port: number;

  // Optional pool configuration
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

// Default pool configuration values (uses Millis to match pg native options)
// See https://node-postgres.com/guides/pool-sizing for details on pool sizing
const DEFAULT_POOL_CONFIG = {
  max: 20, // Max number of clients in the pool
  min: 2, // Min number of idle clients to keep in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 2000, // How long to wait for a connection from the pool
};

const OLD_POOL_DRAIN_MS = 1000;

export interface DatabasePoolRef {
  pool: Pool;
  poolID: string;
}

export interface DatabaseStatusRef {
  connected: boolean;
  poolID: string | null;
  state: string;
  hasPendingConfig: boolean;
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
}

class DatabaseConnectionManager extends BaseComponent {
  private pool: Pool | null = null;
  private poolID: string | null = null;
  private config: DatabaseConfig;
  private pendingConfig: DatabaseConfig | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private configUpdateQueue: Promise<void> = Promise.resolve();
  private retiredPools = new Set<Pool>();
  private retiredPoolClosePromises = new Map<Pool, Promise<void>>();
  private retiredPoolTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(logger: Logger, config: DatabaseConfig) {
    super(logger, {
      name: 'database',
    });

    this.config = config;
  }

  async start(): Promise<void> {
    // Starting while shutdown is active is not a safe no-op
    if (this.stopPromise) {
      throw new Error(
        'Cannot start database connection manager while shutdown is in progress',
      );
    }

    // Return the same promise if start is already running, so concurrent callers
    // join the in-flight operation instead of starting a second concurrent startup.
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      // A buffered config is only consumed by a manager-driven startup attempt.
      const startupConfig = this.pendingConfig ?? this.config;

      this.logger.info('Connecting to database and creating pool...', {
        params: {
          host: startupConfig.host,
          database: startupConfig.database,
        },
      });

      // Create initial pool with defaults merged with provided config
      const poolConfig = {
        ...DEFAULT_POOL_CONFIG,
        ...startupConfig,
      };

      const pool = new Pool(poolConfig);

      // Handle unexpected errors on idle clients (e.g. if the database server drops
      // the socket, or if credentials rotate and connection attempts fail). This
      // prevents idle errors from raising unhandled exceptions and crashing the process.
      pool.on('error', (err) => {
        this.logger.errorObject(
          'Unexpected error on idle client in database pool',
          err,
        );
      });

      try {
        // Verify connection by checking out a client and running a test query
        const client = await pool.connect();

        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }

        this.pool = pool;
        this.poolID = ulid();

        // Promote the startup config only after the replacement pool is verified.
        this.config = startupConfig;
        this.pendingConfig = null;
        this.logger.success('Database pool successfully created and verified');
      } catch (error) {
        // Reset startup state on failure so startup can be retried
        this.pool = null;
        this.poolID = null;
        this.startPromise = null;
        await pool.end().catch(() => {});
        throw error;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      try {
        // Await active startup to settle before stopping, preventing orphaned pools
        // if shutdown is initiated mid-boot.
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Ignore startup errors since we are stopping anyway
          }
        }

        try {
          // Wait for any in-flight config swap before closing the active pool.
          await this.configUpdateQueue;
        } catch {
          // Ignore config update errors since we are stopping anyway
        }

        // Keep a local reference to close the pool gracefully.
        // pool.end() is graceful: it waits for all checked-out clients to be released
        // before resolving, but will hang if a client is leaked and never returned.
        const pool = this.pool;
        const retiredPools = [...this.retiredPools];

        for (const timer of this.retiredPoolTimers) {
          clearTimeout(timer);
        }

        this.retiredPoolTimers.clear();
        this.retiredPools.clear();

        if (pool) {
          this.logger.info('Closing database pool connections...');
          await pool.end();
        }

        for (const retiredPool of retiredPools) {
          await this.closeRetiredPool(retiredPool);
        }

        // Only clear references after a successful close.
        this.pool = null;
        this.poolID = null;
        this.startPromise = null;
        this.logger.success('Database pool closed');
      } finally {
        // Runs on both success and error to prevent stopPromise pointing at a rejected
        // promise forever. Errors still propagate normally to any awaiting caller.
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  /**
   * Safely updates the database pool configuration.
   */
  async updateConfig(newConfig: DatabaseConfig) {
    const runUpdate = async () => {
      // Await active startup to settle before swapping configuration. If startup
      // fails because credentials are stale, continue so the buffer path below
      // can buffer replacement credentials for the next startup attempt.
      if (this.startPromise) {
        await this.startPromise.catch(() => {});
      }

      // If there is no stable live pool to swap, buffer the new config for the
      // next manager-driven startup instead of mutating the active config.
      if (this.stopPromise || !this.pool) {
        this.pendingConfig = newConfig;

        this.logger.info(
          'Database pool configuration buffered for next start',
          {
            params: {
              host: newConfig.host,
              database: newConfig.database,
            },
          },
        );

        return;
      }

      const oldPool = this.pool;

      // Create new pool with updated config and default pool settings
      const updatedPoolConfig = {
        ...DEFAULT_POOL_CONFIG,
        ...newConfig,
      };

      const newPool = new Pool(updatedPoolConfig);

      // Handle unexpected errors on idle clients (e.g. if connection drops or login details expire)
      newPool.on('error', (err) => {
        this.logger.errorObject(
          'Unexpected error on idle client in database pool',
          err,
        );
      });

      try {
        // Verify connection by checking out a client and running a test query
        const client = await newPool.connect();

        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }

        // Swap the references upon successful connection test
        this.pool = newPool;
        this.poolID = ulid();
        this.config = newConfig;
        this.pendingConfig = null;

        this.logger.info('Database pool configuration updated', {
          params: {
            host: newConfig.host,
            database: newConfig.database,
          },
        });

        // Give requests that already captured the old pool a short drain window,
        // then gracefully close the old pool in the background.
        this.retiredPools.add(oldPool);

        const timer = setTimeout(() => {
          this.retiredPoolTimers.delete(timer);
          void this.closeRetiredPool(oldPool);
        }, OLD_POOL_DRAIN_MS);

        this.retiredPoolTimers.add(timer);
      } catch (error) {
        // Clean up the new pool and keep using the old one
        await newPool.end();
        throw error;
      }
    };

    // The promise chain is the queue: each update waits for the previous one
    // before it starts, so overlapping calls cannot swap or close the same pool.
    // Catching the prior update keeps one failure from blocking future updates.
    const update = this.configUpdateQueue.catch(() => {}).then(runUpdate);
    this.configUpdateQueue = update;

    return update;
  }

  private closeRetiredPool(pool: Pool): Promise<void> {
    const existingClose = this.retiredPoolClosePromises.get(pool);

    if (existingClose) {
      return existingClose;
    }

    const closePromise = pool
      .end()
      .catch((err) => {
        this.logger.errorObject('Failed to close old database pool', err);
      })
      .finally(() => {
        this.retiredPools.delete(pool);
        this.retiredPoolClosePromises.delete(pool);
      });

    this.retiredPoolClosePromises.set(pool, closePromise);

    return closePromise;
  }

  getValue<T = unknown>(
    key: string,
    from: string | null,
  ): ComponentValueResult<T> {
    const status = this.getSelfStatus();

    if (key === 'pool') {
      if (status?.state !== 'running' || !this.pool || !this.poolID) {
        return { found: false, value: undefined };
      }

      const value: DatabasePoolRef = {
        pool: this.pool,
        poolID: this.poolID,
      };

      return {
        found: true,
        value: value as T,
      };
    } else if (key === 'status') {
      const value: DatabaseStatusRef = {
        connected: this.pool !== null,
        poolID: this.poolID,
        state: status?.state ?? 'unknown',
        hasPendingConfig: this.pendingConfig !== null,
        totalConnections: this.pool?.totalCount ?? 0,
        idleConnections: this.pool?.idleCount ?? 0,
        waitingRequests: this.pool?.waitingCount ?? 0,
      };

      return {
        found: true,
        value: value as T,
      };
    } else {
      return { found: false, value: undefined };
    }
  }
}
```

#### Step 2: The Consumer Wrapper Helper

Consumers use a helper wrapper class to interact with the database. Instead of caching the connection pool, it queries the `DatabaseConnectionManager`'s shared value dynamically. The provider also exposes a `poolID` that changes every time a new pool is promoted, allowing the wrapper to retry client acquisition once when a request races with a pool swap without looping forever. In web applications, this helper is typically instantiated once and attached to the incoming request object (such as `req.db`) via middleware, making database operations safe and uniform across all handlers.

In a larger app or monorepo, place shared value types like `DatabasePoolRef` and `DatabaseStatusRef` in a shared types file imported by both the component and its consumers. Unit test the wrapper behavior too, especially unavailable pools, pool-swap retry, non-replayed writes, and transaction rollback paths.

```typescript
import { safeHandleCallback } from 'lifecycleion/safe-handle-callback';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { LifecycleValueProvider } from 'lifecycleion/lifecycle-manager';

export interface DatabasePoolRef {
  pool: Pool;
  poolID: string;
}

export interface DatabaseHelperOptions {
  onPoolSwapRetry?: (details: {
    mode: 'client' | 'query';
    previousPoolID: string;
    activePoolID: string;
  }) => void | Promise<void>;
}

export interface TransactionResult<T> {
  status: 'committed' | 'rolled_back';
  value?: T;
  error?: Error;
}

export class TransactionContext {
  private committed = false;
  private rolledBack = false;

  constructor(private client: PoolClient) {}

  /**
   * Run a query within this transaction.
   */
  async query(text: string, params?: unknown[]) {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction has already completed');
    }

    return this.client.query(text, params);
  }

  /**
   * Manually commit the transaction.
   */
  async commit() {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction has already completed');
    }

    await this.client.query('COMMIT');
    this.committed = true;
  }

  /**
   * Manually rollback the transaction.
   */
  async rollback() {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction has already completed');
    }

    await this.client.query('ROLLBACK');
    this.rolledBack = true;
  }

  /**
   * Check if the transaction has been manually finalized (committed or rolled back).
   */
  isCompleted() {
    return this.committed || this.rolledBack;
  }

  /**
   * Get the current status of the transaction.
   */
  getStatus(): 'pending' | 'committed' | 'rolled_back' {
    if (this.committed) {
      return 'committed';
    } else if (this.rolledBack) {
      return 'rolled_back';
    } else {
      return 'pending';
    }
  }
}

export class DatabaseHelper {
  constructor(
    private lifecycle: LifecycleValueProvider,
    private options: DatabaseHelperOptions = {},
  ) {
    if (
      options.onPoolSwapRetry !== undefined &&
      typeof options.onPoolSwapRetry !== 'function'
    ) {
      throw new TypeError('onPoolSwapRetry must be a function');
    }
  }

  /**
   * Retrieves the active connection pool reference or throws a descriptive error.
   */
  private getPoolRefOrThrow(): DatabasePoolRef {
    const result = this.lifecycle.getValue<DatabasePoolRef>('database', 'pool');

    if (!result.found || !result.value) {
      // Fetch the component status to provide a more specific error message
      const statusResult = this.lifecycle.getValue<{ state: string }>(
        'database',
        'status',
        { includeStopped: true, includeStalled: true },
      );

      const state = statusResult.value?.state ?? 'unknown';
      throw new Error(
        `Database connection is unavailable (manager state: ${state})`,
      );
    }

    return result.value;
  }

  private shouldRetryAfterPoolSwap(error: unknown): boolean {
    const retryableCodes = new Set([
      // Node.js network/socket errors
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      // PostgreSQL SQLSTATE connection exception class
      '08000',
      '08001',
      '08003',
      '08004',
      '08006',
      '08007',
      '08P01',
      // Server shutdown/restart conditions
      '57P01',
      '57P02',
      '57P03',
    ]);
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
    const message = describeError(error);

    return (
      (code !== null && retryableCodes.has(code)) ||
      message.includes('Cannot use a pool after calling end') ||
      message.includes('Connection terminated unexpectedly') ||
      message.includes('Client has encountered a connection error')
    );
  }

  private async runOperationWithPoolSwapRetry(
    mode: 'client',
  ): Promise<PoolClient>;
  private async runOperationWithPoolSwapRetry<
    T extends QueryResultRow = QueryResultRow,
  >(mode: 'query', text: string, params?: unknown[]): Promise<QueryResult<T>>;
  private async runOperationWithPoolSwapRetry<
    T extends QueryResultRow = QueryResultRow,
  >(
    mode: 'client' | 'query',
    text?: string,
    params?: unknown[],
  ): Promise<PoolClient | QueryResult<T>> {
    const poolRef = this.getPoolRefOrThrow();

    const run = (ref: DatabasePoolRef) => {
      switch (mode) {
        case 'client':
          return ref.pool.connect();

        case 'query':
          if (text === undefined) {
            throw new Error('Query text is required');
          }

          return ref.pool.query<T>(text, params);

        default:
          throw new Error(`Unsupported database operation mode: ${mode}`);
      }
    };

    try {
      return await run(poolRef);
    } catch (error) {
      // Retry once only when a pool/connection lifecycle error races with a newer pool.
      if (!this.shouldRetryAfterPoolSwap(error)) {
        throw error;
      }

      const activePoolRef = this.lifecycle.getValue<DatabasePoolRef>(
        'database',
        'pool',
      );
      const activePoolID = activePoolRef.value?.poolID ?? null;

      if (activePoolID === null || activePoolID === poolRef.poolID) {
        throw error;
      }

      // Keep telemetry hook failures from interrupting the database operation.
      if (this.options.onPoolSwapRetry) {
        safeHandleCallback(
          'DatabaseHelper onPoolSwapRetry',
          this.options.onPoolSwapRetry,
          {
            mode,
            previousPoolID: poolRef.poolID,
            activePoolID,
          },
        );
      }

      const nextPoolRef = this.getPoolRefOrThrow();
      return run(nextPoolRef);
    }
  }

  /**
   * Run a direct query against the pool.
   * Use this for writes, mixed statements, or reads that should not be replayed.
   * This method dynamically resolves the active pool but does not retry the SQL
   * after it has been sent, because the client cannot always know whether
   * PostgreSQL already ran it. Use runInTransaction() for multi-step atomic work.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const poolRef = this.getPoolRefOrThrow();
    return poolRef.pool.query<T>(text, params);
  }

  /**
   * Run a read-only query that is safe to replay once during pool rotation.
   * This method only accepts leading SELECT statements with no semicolons. It
   * cannot prove that custom functions are side-effect-free, so only use it for
   * reads your application considers safe to replay. For writes or reads that
   * are not safe to replay, use query() so the SQL is never replayed
   * automatically.
   */
  async readQuery<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const normalizedQuery = text.trimStart().toLowerCase();

    if (
      !normalizedQuery.startsWith('select') ||
      normalizedQuery.includes(';')
    ) {
      throw new Error('readQuery() only accepts replayable SELECT statements');
    }

    return this.runOperationWithPoolSwapRetry<T>('query', text, params);
  }

  /**
   * Run a series of queries inside a transaction.
   * Automatically starts a transaction and passes a TransactionContext to the callback.
   * The callback MUST explicitly call tx.commit() or tx.rollback() before resolving.
   * If it resolves without manual completion, the transaction is rolled back and an error is returned.
   * If the callback throws an error, the transaction is rolled back and the error is returned.
   * Returns a TransactionResult object detailing the status, return value, or caught error.
   * Releases the client safely under all circumstances.
   */
  async runInTransaction<T>(
    callback: (tx: TransactionContext) => Promise<T>,
  ): Promise<TransactionResult<T>> {
    const client = await this.runOperationWithPoolSwapRetry('client');
    const tx = new TransactionContext(client);

    try {
      await client.query('BEGIN');
      const result = await callback(tx);

      // Force manual completion: if resolved without explicit commit/rollback, we rollback and throw
      if (!tx.isCompleted()) {
        await tx.rollback().catch(() => {});
        throw new Error(
          'Transaction was resolved without being explicitly committed or rolled back',
        );
      }

      return {
        status: tx.getStatus() as 'committed' | 'rolled_back',
        value: result,
      };
    } catch (error) {
      const err = toError(error);

      // If not finalized yet, auto-rollback
      if (!tx.isCompleted()) {
        await tx.rollback().catch(() => {});
        return { status: 'rolled_back', error: err };
      }

      // If already finalized (e.g. committed, but a subsequent step in the callback failed),
      // return the correct transaction status along with the caught error.
      return {
        status: tx.getStatus() as 'committed' | 'rolled_back',
        error: err,
      };
    } finally {
      client.release();
    }
  }
}
```

## Known Limitations

### 1. Timeouts Do Not Force-Cancel Work

The LifecycleManager does not forcibly terminate work when timeouts are exceeded. JavaScript promises cannot be externally canceled without cooperation from the executing code.

When `start()` or `stop()` times out:

- The manager aborts the signal it passed to that `start()`, `stop()` or `onShutdownForce()` call - the only notification the component gets
- The manager proceeds with next steps (rollback for startup, force phase for shutdown)
- **Non-cooperative code continues running in the background** until completion or process exit
- If `start()` times out, the manager will stop the component automatically if that delayed startup eventually completes, unless the component sets `ownsLateStartCleanup: true` (see [Late-Start Cleanup](#late-start-cleanup)). Bulk startup deadlines perform this late cleanup regardless. This includes a start that reported an unexpected stop before its deadline (answered `component_unexpected_stop`): if its `start()` still fulfills later, `stop()` runs and the component stays `stopped`, whether or not the start used `forceStalled`.
- If shutdown begins while `start()` is in flight, a finite shutdown budget bounds the wait for startup and its automatic cleanup. When that budget expires, or the start times out while still unresolved, unfinished work and its dependencies can remain for a later cleanup pass. A synchronous shutdown request from `start()` does not wait for that same start to finish.

How to avoid surprises:

1. Implement cooperative cancellation (the start, stop and force signals, your own AbortController, flags, or library timeouts).
2. Pass those signals into long-running startup and shutdown work, and close resources from their `'abort'` listeners (or once `signal.aborted` is seen).
3. Favor libraries that support AbortSignal or configurable timeouts.

### 2. Stalled Promises Can Retain Memory

If a component stalls and its promise never resolves, the promise and any captured state remain in memory until process exit. This is a risk whenever async work never settles.

How to reduce the risk:

1. Ensure `start()`/`stop()` always settle (resolve or reject) on all paths.
2. Use timeouts and cancellation so work can terminate deterministically.
3. Keep long-lived closures small, and avoid capturing large buffers in stalled tasks.

### 3. No Atomic Restart

`restartAllComponents()` is not atomic. There is a window where components are stopped
before startup begins. Individual `restartComponent()` calls also interrupt the target
component and can be refused while dependents are active. Applications requiring
continuous availability need an application-level strategy, such as keeping another
service instance available during restart.

### Logger contract

The manager requires lifecycleion's `Logger`. Its own logging failures are contained
and reported on the global `'error'` channel with labels such as
`lifecycle-manager logger.warn`; they do not derail lifecycle work. This guard does not
cover logging performed by components or through the caller's logger.

Use ordinary promises or well-behaved thenables for asynchronous hooks. Native promises
with overridden own `then` properties remain observed, but custom promise subclasses
and thenables can still fail or never settle. Timeouts bound the manager's wait; they
do not cancel the underlying work.

Shutdown results record that operation's outcome. Late cleanup can change a stalled
component to stopped without rewriting an earlier failure result. Use
`getComponentStatus()` for current state. Late failures remain reported, but an older
attempt cannot overwrite a retry or replacement. A hook that throws
`ComponentStopTimeoutError` still reports a hook failure (`error`); only the
manager's own deadline counts as a timeout.

Shutdown warnings target running components, or stalled components included through
`retryStalled`. After `component:shutdown-warning` announces selection, the manager
rechecks the target before invoking its hook. A changed registration or state, or a
lifecycle phase that took the component meanwhile, emits
`component:shutdown-warning-skipped` with `{ name, reason, state }`: `reason` is
`component_not_found` once the component was unregistered, `component_changed` once
another instance holds its name, or `component_not_available` when it is no longer in
the state it was selected in, or still is but a phase owns it - its raw `start()` is
still pending, or a late start's cleanup keeps it `running` only to stop it. `state` is
the name's current state, and the key is omitted when nothing is registered under the
name.
This does not cancel a warning hook that has already begun.

Each `component:shutdown-warning` is followed by exactly one terminal event for that
component: `component:shutdown-warning-completed` when the hook resolves,
`component:shutdown-warning-failed` with `{ name, error }` when it throws
synchronously or rejects, `component:shutdown-warning-skipped` as above, or
`component:shutdown-warning-timeout` when it is still pending at the phase deadline.
The first outcome wins: a hook that settles after its timeout was announced emits
nothing further (a late failure is still logged as a warning), and the phase's
`lifecycle-manager:shutdown-warning-timeout` `pending` list names exactly the
components that got a timeout event, leaving out those that already completed,
failed, or were skipped. With `shutdownWarningTimeoutMS: 0` there is no deadline, so
every invoked hook reports completed or failed whenever it settles, possibly after
`lifecycle-manager:shutdown-warning-completed`.
