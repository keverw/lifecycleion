/**
 * Whether this is Bun, told by its global rather than `process`, which React Native's and a
 * browser bundle's stand-in leave without `versions`. By the global's `version`, since a
 * page's own `Bun` variable, or an element with that id, is a global of the name too.
 */
export const isBunRuntime = ((): boolean => {
  // Guarded, as optional runtime probing never makes an import fail: a host may expose a
  // `Bun` global whose reads throw (a sandbox's accessor or `Proxy`).
  try {
    return (
      typeof (globalThis as { Bun?: { version?: unknown } }).Bun?.version ===
      'string'
    );
  } catch {
    return false;
  }
})();
