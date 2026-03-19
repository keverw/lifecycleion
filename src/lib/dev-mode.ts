// Stored in globalThis so state survives module re-evaluation and works across
// module boundaries.
const GLOBAL_KEY = '__lifecycleion_is_dev__';
const INIT_PARAM_KEY = '__lifecycleion_init_param__';

type DevModeSource = 'cmd' | 'node_env' | 'both';
type InitParam =
  | boolean
  | { detect: DevModeSource; strict?: boolean }
  | undefined;

// Cast once at module level — avoids repeating the assertion in every function.
const g = globalThis as typeof globalThis & Record<string, unknown>;

function detectValue(detect: DevModeSource, isStrict?: boolean): boolean {
  // Guard against environments where process or its properties may not exist
  // (e.g. browser without polyfill, Deno without Node compat, edge runtimes).
  // Vite statically replaces process.env.NODE_ENV at build time, so it is safe
  // on the client. process.argv is an empty array shim in browsers — harmless.
  const argv: string[] =
    typeof process !== 'undefined' ? (process.argv ?? []) : [];
  const env: string | undefined =
    typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;

  const cmdArg = argv.find((a) => a === 'dev' || a === 'prod');

  if (isStrict && detect === 'cmd' && cmdArg === undefined) {
    throw new Error('initDevMode: expected "dev" or "prod" as a CLI argument');
  }

  const isFromCmd = cmdArg !== undefined ? cmdArg === 'dev' : false;
  const isFromEnv = env === 'development';

  if (detect === 'cmd') {
    return isFromCmd;
  }

  if (detect === 'node_env') {
    return isFromEnv;
  }

  // 'both': cmd wins when explicitly present, otherwise fall back to NODE_ENV
  return cmdArg !== undefined ? isFromCmd : isFromEnv;
}

function resolveInitParam(param: InitParam): boolean {
  if (param === undefined) {
    return detectValue('both');
  }

  if (typeof param === 'boolean') {
    return param;
  }

  return detectValue(param.detect, param.strict);
}

/**
 * Returns the current dev mode value.
 *
 * Reads `globalThis.__lifecycleion_is_dev__`. Defaults to `false` if
 * `initDevMode()` has not been called yet.
 */
export function getDevMode(): boolean {
  return typeof g[GLOBAL_KEY] === 'boolean' ? g[GLOBAL_KEY] : false;
}

/**
 * Sets the dev mode global for the current process.
 *
 * First-wins: if the global is already set (e.g. set by the HTML injection on
 * the client, or by a prior `initDevMode()` call), this is a no-op. Call once
 * at startup before serving any requests.
 *
 * @param param
 *   - `true` / `false` — explicit value
 *   - `{ detect: 'cmd' }` — read from `process.argv` ("dev" or "prod")
 *   - `{ detect: 'node_env' }` — read from `NODE_ENV`
 *   - `{ detect: 'both' }` — argv takes precedence, falls back to `NODE_ENV`
 *   - `{ detect: 'cmd', strict: true }` — argv required, throws if absent
 *   - omitted — same as `{ detect: 'both' }`
 */
export function initDevMode(
  param?: boolean | { detect: DevModeSource; strict?: boolean },
): void {
  if (typeof g[GLOBAL_KEY] === 'boolean') {
    return; // first-wins — already initialized, no-op
  }

  g[INIT_PARAM_KEY] = param; // save original param so 'redetect' can replay it
  g[GLOBAL_KEY] = resolveInitParam(param);
}

/**
 * Bypasses first-wins semantics and forces the dev mode value.
 *
 * Intended for testing or tooling — not for production use.
 *
 * Pass `'redetect'` to re-run the same detection logic that
 * `initDevMode()` used originally.
 */
export function overrideDevMode(value: boolean | 'redetect'): void {
  const savedParam = g[INIT_PARAM_KEY] as InitParam;
  g[GLOBAL_KEY] = value === 'redetect' ? resolveInitParam(savedParam) : value;
}
