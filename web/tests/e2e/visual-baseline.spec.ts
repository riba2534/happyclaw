import { expect, test, type Locator, type Page } from '@playwright/test';

// Visual regression baselines: a few key surfaces in every colour scheme,
// light and dark, compared pixel by pixel against committed screenshots.
//
//   Surfaces   chat     ChatView over chat-render-harness (?scenario=facts):
//                       user messages, replies and the settled process card
//                       whose tool calls sit folded under it
//              sheet    the phone's model picker sheet (composer-harness)
//              empty    the line-drawn empty state of the automations list
//                       (workspace-pages-harness ?automations=0)
//   Schemes    teal (`default`), orange, neutral × light, dark
//   Widths     phone    390×844 at 1× (chromium-mobile): chat, sheet, empty
//                       in all 8 looks
//              desktop  1440×900 at 1× (chromium-desktop): chat and empty in
//                       all 8 looks; the sheet is phone-only, a desktop
//                       opens the picker as a menu
//
// Chromium only: WebKit renders fonts differently, so its projects never
// match this file. Baselines live in visual-baseline.spec.ts-snapshots/ with
// the platform suffix (darwin); another platform records its own.
//
// Update the baselines after an intended visual change (from web/):
//   VITE_API_PROXY_TARGET=http://127.0.0.1:9 VITE_WS_PROXY_TARGET=ws://127.0.0.1:9 \
//     PLAYWRIGHT_PORT=5186 npx playwright test tests/e2e/visual-baseline.spec.ts \
//     --update-snapshots
// Name the file by path: a bare `visual-baseline` filter also matches a
// checkout whose directory has that name, and runs every spec. Both widths
// render at 1×, which keeps the set near 1.6 MB; open the changed PNGs and
// check them before committing.
//
// Stable on purpose: the clock is fixed (relative times read the same),
// Math.random is seeded, motion is reduced and CSS animations are
// fast-forwarded, fonts have loaded, and the caret is hidden.
//
// Not covered: the streaming and waiting states, the desktop model menu,
// the session sidebar and the rest of the app shell, settings pages, the
// `font-anthropic` font style, `system` mode, other widths (tablet, 320px),
// WebKit/iOS Safari rendering, and real backend data.

const SCHEMES = ['default', 'orange', 'neutral'] as const;
const MODES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];
type Mode = (typeof MODES)[number];

const LOOKS = SCHEMES.flatMap((scheme) =>
  MODES.map((mode) => ({ scheme, mode, name: `${scheme}-${mode}` })),
);

/** 2026-11-01 10:00 in Shanghai, the time every harness reads. */
const NOW = new Date('2026-11-01T02:00:00.000Z');

test.use({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'baselines are recorded in Chromium',
);

/**
 * Applies a scheme and mode the way useTheme does: the stored keys for a
 * component that reads them, and the classes on <html> (a harness may set
 * its own at load, so they are set again once it has rendered).
 */
async function prepare(page: Page, scheme: Scheme, mode: Mode) {
  await page.clock.setFixedTime(NOW);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: mode });
  await page.addInitScript(
    ({ scheme, mode }) => {
      // A seeded generator, so ids and jitter come out the same every run.
      let seed = 0x2f6b1d;
      Math.random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      if (mode === 'dark') localStorage.setItem('happyclaw-theme', 'dark');
      else localStorage.removeItem('happyclaw-theme');
      if (scheme === 'orange') {
        localStorage.removeItem('happyclaw-color-scheme');
      } else {
        localStorage.setItem('happyclaw-color-scheme', scheme);
      }
    },
    { scheme, mode },
  );
}

async function applyLook(page: Page, scheme: Scheme, mode: Mode) {
  await page.evaluate(
    async ({ scheme, mode }) => {
      const root = document.documentElement;
      root.classList.toggle('dark', mode === 'dark');
      root.classList.toggle('theme-orange', scheme === 'orange');
      root.classList.toggle('theme-neutral', scheme === 'neutral');
      await document.fonts.ready;
    },
    { scheme, mode },
  );
  // A baseline compared against the system fallback font fails on every
  // glyph and says nothing useful; say what is wrong instead. (Vite answers
  // 403 for font files under a node_modules symlinked from outside the
  // checkout.)
  const inter = await page.evaluate(() =>
    document.fonts.check('16px "Inter Variable"'),
  );
  expect(
    inter,
    'Inter Variable did not load; the shot would use a fallback font',
  ).toBe(true);
}

/** Waits until nothing in the scope is still animating in. */
async function settle(scope: Locator) {
  await scope.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

const SHOT = { animations: 'disabled', caret: 'hide' } as const;

// ─── Chat ────────────────────────────────────────────────────────

async function openChat(page: Page, scheme: Scheme, mode: Mode) {
  await prepare(page, scheme, mode);
  await page.goto('/tests/e2e/chat-render-harness.html?scenario=facts');
  await expect(page.locator('[data-hc-composer]')).toBeVisible();
  await expect(page.getByText('帮我看看侧栏组件为什么').first()).toBeVisible();
  await applyLook(page, scheme, mode);
  await settle(page.locator('body'));
}

// ─── Model sheet ─────────────────────────────────────────────────

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The connections the picker lists: eight models, so a phone opens the sheet. */
const MODEL_SELECTION = {
  selectedModelConfigId: 'chatgpt',
  selectedModel: 'gpt-6-astra',
  selectedEffort: 'high',
  default: { source: 'none', modelConfigId: null },
  options: [
    {
      id: 'relay',
      name: '中转站',
      kind: 'third_party',
      model: 'relay-a',
      usable: true,
      models: ['relay-a', 'relay-b', 'relay-c', 'relay-d'].map((id) => ({
        id,
        contextWindow: null,
      })),
    },
    {
      id: 'official',
      name: 'Claude 官方',
      kind: 'official',
      model: 'opus',
      usable: true,
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT 订阅 (someone@example.com)',
      kind: 'codex',
      model: 'gpt-6.1-sol',
      usable: true,
      codex: {
        defaultModel: 'gpt-6.1-sol',
        defaultEffort: 'low',
        source: 'live',
        needsReauth: false,
        models: [
          {
            value: 'gpt-6.1-sol',
            label: 'gpt-6.1-sol（主力编码）',
            efforts: EFFORTS,
            defaultEffort: 'low',
          },
          {
            value: 'gpt-6-astra',
            label: 'gpt-6-astra（旗舰·最强推理）',
            efforts: EFFORTS,
            defaultEffort: 'medium',
          },
          {
            value: 'gpt-5.5',
            label: 'gpt-5.5（遗留）',
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
    },
  ],
};

async function openModelSheet(page: Page, scheme: Scheme, mode: Mode) {
  await prepare(page, scheme, mode);
  await page.route('**/api/groups/**/model-selection**', (route) =>
    route.fulfill({ json: MODEL_SELECTION }),
  );
  await page.goto('/tests/e2e/composer-harness.html');
  await applyLook(page, scheme, mode);
  await page.locator('[data-model-pill]').tap();
  const sheet = page.getByRole('dialog', { name: '选择模型' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-snap', 'full');
  await expect(sheet.locator('[data-model-row]').first()).toBeVisible();
  await settle(sheet);
  return sheet;
}

// ─── Empty state ─────────────────────────────────────────────────

async function openEmptyState(page: Page, scheme: Scheme, mode: Mode) {
  await prepare(page, scheme, mode);
  // The shell around the page asks for workspaces and the like; an empty
  // answer keeps it quiet.
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => route.fulfill({ json: {} }),
  );
  await page.goto(
    '/tests/e2e/workspace-pages-harness.html?automations=0#/automations',
  );
  const empty = page
    .locator('[data-slot="empty"]')
    .filter({ hasText: '暂无自动化' });
  await expect(empty).toBeVisible();
  await applyLook(page, scheme, mode);
  await settle(page.locator('body'));
  return empty;
}

// ─── Phone ───────────────────────────────────────────────────────

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone baselines');
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

  for (const { scheme, mode, name } of LOOKS) {
    test(`chat ${name}`, async ({ page }) => {
      await openChat(page, scheme, mode);
      await expect(page).toHaveScreenshot(`phone-chat-${name}.png`, SHOT);
    });

    test(`model sheet ${name}`, async ({ page }) => {
      const sheet = await openModelSheet(page, scheme, mode);
      await expect(sheet).toHaveScreenshot(
        `phone-model-sheet-${name}.png`,
        SHOT,
      );
    });

    test(`empty state ${name}`, async ({ page }) => {
      const empty = await openEmptyState(page, scheme, mode);
      await expect(empty).toHaveScreenshot(`phone-empty-${name}.png`, SHOT);
    });
  }
});

// ─── Desktop ─────────────────────────────────────────────────────

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop baselines');
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  for (const { scheme, mode, name } of LOOKS) {
    test(`chat ${name}`, async ({ page }) => {
      await openChat(page, scheme, mode);
      await expect(page).toHaveScreenshot(`desktop-chat-${name}.png`, SHOT);
    });

    test(`empty state ${name}`, async ({ page }) => {
      const empty = await openEmptyState(page, scheme, mode);
      await expect(empty).toHaveScreenshot(`desktop-empty-${name}.png`, SHOT);
    });
  }
});
