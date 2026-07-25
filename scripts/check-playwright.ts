import { chromium } from '@playwright/test';

// The Playwright suites launch a real headless browser via
// `chromium.launch({ headless: true })`, which uses the `chrome-headless-shell`
// binary. That is a *separate* download from the full Chromium browser, so
// checking `chromium.executablePath()` (the full browser) is not enough — it can
// exist while the headless shell is missing or stale after a Playwright version
// bump. The only reliable guard is to actually launch the browser the way the
// tests do and bail with a clear message if it fails.
try {
  const browser = await chromium.launch({ headless: true });
  await browser.close();
} catch (error) {
  console.error(
    'Playwright Chromium could not launch. Run `bun run playwright:install` before `bun test`.',
  );
  console.error(error instanceof Error ? error.message : error);

  process.exit(1);
}
