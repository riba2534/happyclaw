import { defineConfig, devices } from '@playwright/test';

const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
// Playwright's compact headless shell does not host Chromium's native PDF
// viewer, so PDF iframe load/focus behaviour must run against the full
// browser in CI. Local callers can still supply a system binary.
const chromiumChannel = systemChromium ? {} : { channel: 'chromium' as const };
// WebKit needs its own browser download (`npx playwright install --with-deps
// webkit`); its projects run when PLAYWRIGHT_WEBKIT is set.
const withWebKit = Boolean(process.env.PLAYWRIGHT_WEBKIT);
// Parallel worktrees each pass their own PLAYWRIGHT_PORT; with one set, a
// server already listening there is never reused, so a run cannot silently
// test another checkout's Vite.
const port = Number(process.env.PLAYWRIGHT_PORT) || 5173;
const ownPort = Boolean(process.env.PLAYWRIGHT_PORT);

/** Specs whose composer and layout behaviour also run in a desktop window. */
const desktopSpecs =
  /(composer|model-selector|chat-scroll|chat-stream-render|phone-nav|reply-table|team-mode|multitask|visual-baseline)\.spec\.ts$/;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: systemChromium
      ? { executablePath: systemChromium }
      : undefined,
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'], ...chromiumChannel },
    },
    {
      name: 'chromium-desktop',
      testMatch: desktopSpecs,
      use: { ...devices['Desktop Chrome'], ...chromiumChannel },
    },
    ...(withWebKit
      ? [
          {
            name: 'webkit-iphone',
            // Phone specs, where iOS focus, keyboard and touch rules apply for
            // real; holds and drags go through tests/e2e/touchscreen.ts.
            testMatch:
              /(composer|model-selector|overlay|viewport|touch-primitives|chat-reading|phone-nav|mobile-chat|workspace-pages|settings-admin|chat-code-split)\.spec\.ts$/,
            use: { ...devices['iPhone 14'] },
          },
          {
            name: 'webkit-desktop',
            testMatch: /composer\.spec\.ts$/,
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : []),
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/tests/e2e/mobile-chat-harness.html`,
    reuseExistingServer: !process.env.CI && !ownPort,
    timeout: 120_000,
  },
});
