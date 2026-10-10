import { expect, test } from '@playwright/test';

const HARNESS = '/tests/e2e/chat-render-harness.html';

test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
});

test('a stopped reply is marked as incomplete', async ({ page }) => {
  await page.goto(`${HARNESS}?scenario=history`);
  const note = page.getByLabel('已中断：回复在完成前被停止，或被新消息打断');
  await expect(note).toBeVisible();
  await expect(note).toHaveText('已中断');
  // Completed replies carry no note.
  await expect(page.getByText('已中断')).toHaveCount(1);
});

test('message actions become visible when focused from the keyboard', async ({
  page,
}) => {
  await page.goto(`${HARNESS}?scenario=history`);
  const copy = page.getByRole('button', { name: '复制消息' }).last();
  const actions = copy.locator('xpath=..');
  await expect(actions).toHaveCSS('opacity', '0');
  await copy.focus();
  await expect(actions).toHaveCSS('opacity', '1');
});

test('the image viewer is a dialog with Esc, arrow keys and focus return', async ({
  page,
}) => {
  await page.goto(`${HARNESS}?scenario=history`);
  const thumbnail = page.getByRole('button', { name: 'layout.svg' });
  await thumbnail.click();
  const viewer = page.getByRole('dialog', { name: /图片预览 1 \/ 2/ });
  await expect(viewer).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('dialog', { name: /图片预览 2 \/ 2/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '下一张' })).toBeDisabled();
  await page.getByRole('button', { name: '上一张' }).click();
  await expect(
    page.getByRole('dialog', { name: /图片预览 1 \/ 2/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
});

test('copy as text keeps code verbatim', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`${HARNESS}?scenario=markdown`);
  // The code-only reply.
  const menus = page.getByRole('button', { name: '消息菜单' });
  await menus.nth(3).click();
  await page.getByRole('menuitem', { name: '复制文本' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // No fence, and the code (backticks, template syntax) exactly as written.
  expect(copied).toBe(
    'export const answer = 42;\nconsole.log(`answer = ${answer}`);',
  );
});

test('a long streamed reply renders in full with the run status in view', async ({
  page,
}) => {
  await page.goto(`${HARNESS}?scenario=markdown-streaming`);
  await page.waitForFunction(() => 'markdownHarness' in window);
  const sink = await page.evaluate(
    () =>
      (window as unknown as { markdownHarness: { kitchenSink: string } })
        .markdownHarness.kitchenSink,
  );
  for (let end = 1500; end < sink.length; end += 1500) {
    await page.evaluate(
      (text) =>
        (
          window as unknown as {
            markdownHarness: { setPartial: (t: string) => void };
          }
        ).markdownHarness.setPartial(text),
      sink.slice(0, end),
    );
    await page.waitForTimeout(150);
  }
  const state = await page.evaluate(() => {
    const scroller = [...document.querySelectorAll('div')]
      .filter((d) => getComputedStyle(d).overflowY === 'auto')
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    scroller.scrollTop = scroller.scrollHeight;
    const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
    let rawFence = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (
        !n.parentElement?.closest('pre,code') &&
        n.textContent?.includes('```')
      )
        rawFence = true;
    }
    const status = [...scroller.querySelectorAll('.sticky')].pop();
    const s = status?.getBoundingClientRect();
    const c = scroller.getBoundingClientRect();
    return {
      rawFence,
      text: scroller.innerText,
      statusInView: !!s && s.top >= c.top - 1 && s.bottom <= c.bottom,
    };
  });
  // The beginning is still there (no tail-only rendering), fences intact.
  expect(state.text).toContain('一级标题：Markdown 渲染全量样例');
  expect(state.rawFence).toBe(false);
  expect(state.statusInView).toBe(true);
});
