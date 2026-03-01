# Change Log

<!-- toc -->

- [0.0.1 (Feb 23, 2026)](#001-feb-23-2026)
- [0.0.2 (Feb 28, 2026)](#002-feb-28-2026)
- [0.0.3 (Feb 28, 2026)](#003-feb-28-2026)

<!-- tocstop -->

## 0.0.1 (Feb 23, 2026)

- Initial package publish

## 0.0.2 (Feb 28, 2026)

- LifecycleManager error and warning logs now pass full error objects in `params.error` for consistency with other component-operation log paths

## 0.0.3 (Feb 28, 2026)

- Added `attachSignalsBeforeStartup` for attaching signal handlers before startup begins while preserving the original `attachSignalsOnStart` behavior
- LifecycleManager now automatically stops components that finish starting after LifecycleManager shutdown has already begun
- Startup timeouts without `onStartupAborted()` now auto-stop the component if that delayed startup later completes
