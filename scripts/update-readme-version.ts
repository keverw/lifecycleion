/**
 * Simple script to update the README.md version from package.json
 * Can be run manually or added to version hooks
 */

import * as fs from 'fs';
import * as path from 'path';

interface PackageJson {
  version: string;
  name?: string;
}

// Get the project root directory
const rootDir = path.resolve(__dirname, '..');

// Read the package.json file
const packageJsonPath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(
  fs.readFileSync(packageJsonPath, 'utf8'),
) as PackageJson;
const version = packageJson.version;

// Human-friendly package name (capitalized)
// You can customize this if your package name differs from the display name
const packageDisplayName = 'Lifecycleion';

// Read the README.md file
const readmePath = path.join(rootDir, 'README.md');
let readmeContent = fs.readFileSync(readmePath, 'utf8');

// Update the version in the README.md file
// Match "# <PackageName>" followed by optional version (with or without v prefix)
const titleRegex = new RegExp(
  `^# ${packageDisplayName}(?: v?[0-9]+\\.[0-9]+\\.[0-9]+)?`,
  'm',
);

const newTitle = `# ${packageDisplayName} v${version}`;

let action: string;

if (titleRegex.test(readmeContent)) {
  readmeContent = readmeContent.replace(titleRegex, newTitle);
  action = 'Updated';
} else {
  // If heading not found, prepend it to the top
  readmeContent = `${newTitle}\n\n${readmeContent}`;
  action = 'Prepended';
}

// Write the updated README.md file
fs.writeFileSync(readmePath, readmeContent);

console.log(`${action} README.md with version ${version}`);
