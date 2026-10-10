import { expect, test } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/sidebar-harness.html';

// The harness mocks every store the sidebar and its dialogs load from. Any
// API request is a missing mock: answer it locally so a backend behind the
// dev proxy (whose 401 makes the API client redirect to /login) cannot
// influence the run, and fail the test.
let unmockedApiCalls: string[] = [];
test.beforeEach(async ({ page }) => {
  unmockedApiCalls = [];
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    (route) => {
      unmockedApiCalls.push(route.request().url());
      return route.fulfill({ status: 503, json: { error: 'not mocked' } });
    },
  );
});
test.afterEach(() => {
  expect(unmockedApiCalls).toEqual([]);
});

test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
});

test('marks the opened workspace and its main conversation as current', async ({
  page,
}) => {
  await page.goto(HARNESS_PATH);
  const nav = page.getByRole('navigation', { name: '主导航' });
  const alpha = nav.getByRole('button', { name: 'Alpha 工作区', exact: true });
  const beta = nav.getByRole('button', { name: 'Beta 工作区', exact: true });
  await expect(alpha).toHaveAttribute('aria-current', 'page');

  await beta.click();
  await expect(page.getByTestId('route')).toHaveText('/chat/beta');
  await expect(beta).toHaveAttribute('aria-current', 'page');
  await expect(alpha).not.toHaveAttribute('aria-current', 'page');
  // The workspace item holds its row and, when expanded, its sessions.
  const betaItem = nav.locator('li').filter({
    has: page.getByRole('button', { name: 'Beta 工作区', exact: true }),
  });
  await expect(
    betaItem.locator('[aria-current="page"]', { hasText: '当前对话' }),
  ).toHaveCount(1);

  await betaItem.getByRole('button', { name: 'beta 会话 1' }).click();
  await expect(page.getByTestId('route')).toHaveText(
    '/chat/beta?agent=beta-s1',
  );
  await expect(
    betaItem.locator('[aria-current="page"]', { hasText: 'beta 会话 1' }),
  ).toHaveCount(1);
  await expect(
    betaItem.locator('[aria-current="page"]', { hasText: '当前对话' }),
  ).toHaveCount(0);
});

test('a dialog whose chunk fails to load closes with a toast instead of taking the app down', async ({
  page,
}) => {
  let blocked = true;
  await page.route(
    '**/src/components/chat/CreateContainerDialog.tsx*',
    (route) =>
      blocked ? route.abort('internetdisconnected') : route.continue(),
  );
  let loads = 0;
  page.on('load', () => (loads += 1));
  await page.goto(HARNESS_PATH);
  const nav = page.getByRole('navigation', { name: '主导航' });
  const create = nav.getByRole('button', { name: '新建工作区' }).first();

  await create.click();
  const toast = page.getByText('加载失败，请检查网络后重试');
  await expect(toast).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(nav).toBeVisible();
  // Neither the failed idle preload nor the failed open reloads by itself.
  await page.waitForTimeout(500);
  expect(loads).toBe(1);

  blocked = false;
  await page.getByRole('button', { name: '刷新页面' }).click();
  await expect.poll(() => loads).toBe(2);
  await create.click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('opening a row menu from the keyboard focuses its first item', async ({
  page,
}) => {
  await page.goto(HARNESS_PATH);
  const nav = page.getByRole('navigation', { name: '主导航' });
  const more = nav.getByRole('button', { name: 'Beta 工作区的更多操作' });

  await more.focus();
  await page.keyboard.press('Enter');
  const items = page.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Later opens are Radix's own and land on the first item as well.
  await more.focus();
  await page.keyboard.press(' ');
  await expect(page.getByRole('menuitem').first()).toBeFocused();
});
