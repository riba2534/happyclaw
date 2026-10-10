import { expect, test } from '@playwright/test';

test('the phone session list shows a skeleton while its chunk downloads', async ({
  page,
}) => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    '**/src/components/chat/SessionSidebar.tsx*',
    async (route) => {
      await released;
      await route.continue();
    },
  );

  await page.goto('/tests/e2e/mobile-chat-harness.html?sessions=1');
  const skeleton = page.getByRole('status', { name: '正在加载会话列表' });
  await expect(skeleton).toBeVisible();
  await expect(page.locator('[data-hc-session-sidebar]')).toHaveCount(0);

  release();
  await expect(page.locator('[data-hc-session-sidebar]')).toBeVisible();
  await expect(skeleton).toHaveCount(0);
});
