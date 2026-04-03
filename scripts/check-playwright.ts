import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const executablePath = chromium.executablePath();

if (!executablePath || !existsSync(executablePath)) {
  console.error(
    'Playwright Chromium is not installed. Run `bun run playwright:install` before `bun test`.',
  );

  process.exit(1);
}
