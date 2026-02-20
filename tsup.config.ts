import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';
import { join } from 'path';

// Read package.json to get all dependencies
const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
);

// Get all dependencies (regular + peer + dev) for external list
const getAllDependencies = (additionalDeps?: string[]) => {
  const deps = new Set<string>();

  // Add regular dependencies
  if (packageJson.dependencies) {
    for (const dep of Object.keys(packageJson.dependencies)) {
      deps.add(dep);
    }
  }

  // Add peer dependencies
  if (packageJson.peerDependencies) {
    for (const dep of Object.keys(packageJson.peerDependencies)) {
      deps.add(dep);
    }
  }

  // Add dev dependencies (in case they're used in build)
  if (packageJson.devDependencies) {
    for (const dep of Object.keys(packageJson.devDependencies)) {
      deps.add(dep);
    }
  }

  // Add additional dependencies if provided
  if (additionalDeps) {
    for (const dep of additionalDeps) {
      deps.add(dep);
    }
  }

  return Array.from(deps).sort();
};

const allExternals = getAllDependencies();

// NOTE: This configuration externalizes ALL dependencies for NPM distribution
// By default, tsup only excludes "dependencies" and "peerDependencies" but bundles "devDependencies"
// For a library published to NPM, we want EVERYTHING external so users install their own deps
// This approach automatically stays in sync with package.json changes

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/lib/arrays.ts',
    'src/lib/ascii-tables/index.ts',
    'src/lib/clamp.ts',
    'src/lib/constants.ts',
    'src/lib/curly-brackets.ts',
    'src/lib/deep-clone.ts',
    'src/lib/error-to-string.ts',
    'src/lib/event-emitter.ts',
    'src/lib/id-helpers.ts',
    'src/lib/is-function.ts',
    'src/lib/is-number.ts',
    'src/lib/is-promise.ts',
    'src/lib/json-helpers.ts',
    'src/lib/is-boolean.ts',
    'src/lib/is-plain-object.ts',
    'src/lib/lifecycle-manager/index.ts',
    'src/lib/logger/index.ts',
    'src/lib/padding-utils.ts',
    'src/lib/process-signal-manager.ts',
    'src/lib/promise-protected-resolver.ts',
    'src/lib/retry-utils/index.ts',
    'src/lib/safe-handle-callback.ts',
    'src/lib/single-event-observer.ts',
    'src/lib/sleep.ts',
    'src/lib/strings.ts',
    'src/lib/tmp-dir.ts',
    'src/lib/serialize-error/index.ts',
    'src/lib/unix-time-helpers.ts',
  ],
  outDir: 'dist',
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: allExternals,
});
