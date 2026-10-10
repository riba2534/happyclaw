import { expect, test } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/sidebar-harness.html';

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
