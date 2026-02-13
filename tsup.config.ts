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
  entry: ['src/index.ts', 'src/lib/arrays.ts', 'src/lib/ascii-tables/index.ts'],
  outDir: 'dist',
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: allExternals,
});
