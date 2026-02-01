# Simple LifecycleManager Example

A minimal example demonstrating the core features of LifecycleManager.

## Features Demonstrated

- Component registration
- Dependency-ordered startup (API depends on Database)
- Graceful shutdown with warning phase
- Signal handling (Ctrl+C, reload)
- Logger exit hook integration
- Health checks
- Event monitoring

## Running the Example

```bash
bun run src/lib/lifecycle-manager/example/index.ts
```

## Components

### Database Component

- No dependencies
- Starts first
- Simulates database connection

### API Component

- Depends on Database
- Starts after Database
- Simulates HTTP server

## Startup Order

```
database → api
```

## Shutdown Order

```
api → database
```

## Interactive Controls

- **Ctrl+C** - Trigger graceful shutdown
- **R** - Trigger reload (calls `onReload()` on all components)

## Logger Exit Hook

This example demonstrates the logger exit hook integration feature:

- **`enableLoggerExitHook: true`** - Automatically enables graceful shutdown when logger exits
- **`shutdownOptions: { timeoutMS: 30000 }`** - Maximum time to wait for shutdown (30 seconds)

With this enabled, calling `logger.exit(code)` or `logger.error('message', { exitCode: 1 })` will:

1. Trigger graceful component shutdown (in reverse dependency order)
2. Wait up to 30 seconds for all components to stop
3. Exit the process with the specified exit code

This is useful for handling fatal errors gracefully:

```typescript
// Fatal error triggers graceful shutdown
logger.error('Database connection lost', { exitCode: 1 });
// Components will stop gracefully before process exits
```

## Expected Output

```
=== LifecycleManager Simple Demo ===

[demo] [database] Component registered
[demo] [api] Component registered
Startup order: database → api

[demo] Starting all components
[demo] [database] Starting component
[database] Connecting to database...
[database] Database connected
[demo] [database] Component started
✓ database started
[demo] [api] Starting component
[api] Starting API server...
[api] API server started on port 3000
[demo] [api] Component started
✓ api started
[demo] All components started

All components started!

Health: HEALTHY ✓
  database: Connected
  api: No health check implemented

=== Demo Running ===
Press Ctrl+C to trigger graceful shutdown
Press R to trigger reload
```

When you press Ctrl+C:

```
[demo] Shutdown signal received
[demo] Stopping all components
[demo] Shutdown warning phase
[database] Shutdown warning - preparing to close
[demo] [api] Stopping component
[demo] [api] Graceful shutdown started
[api] Stopping API server...
[api] API server stopped
[demo] [api] Component stopped gracefully
✓ api stopped
[demo] [database] Stopping component
[demo] [database] Graceful shutdown started
[database] Closing database...
[database] Database closed
[demo] [database] Component stopped gracefully
✓ database stopped
[demo] Shutdown completed
Shutdown complete
```

## Code Structure

The example shows:

1. **Component Definition** - Extend `BaseComponent` and implement `start()` and `stop()`
2. **Dependencies** - Declare in constructor options
3. **Lifecycle Manager** - Create with logger exit hook integration enabled
4. **Signal Handling** - Attach signals for graceful shutdown
5. **Logger Integration** - Graceful shutdown on fatal errors via `logger.exit()`
6. **Events** - Listen to lifecycle events for monitoring

This is the minimal code needed to use LifecycleManager effectively.
