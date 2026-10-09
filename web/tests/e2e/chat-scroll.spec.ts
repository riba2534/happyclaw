import { expect, test, type Page } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/chat-scroll-harness.html';

interface ScrollMetrics {
  top: number;
  gap: number;
}

async function openHarness(page: Page, query: Record<string, string>) {
  await page.goto(`${HARNESS_PATH}?${new URLSearchParams(query)}`);
  await expect(
    page.locator('[data-hc-chat-view] [data-index]').first(),
  ).toBeVisible();
}

/** The transcript scroller is the tallest scroll container in the chat view. */
async function metrics(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    return {
      top: el.scrollTop,
      gap: el.scrollHeight - el.scrollTop - el.clientHeight,
    };
  });
}

async function scrollTranscriptTo(page: Page, top: number) {
  await page.evaluate(async (target) => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    el.scrollTop = target;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, top);
}

/** Text and viewport offset of the first message row at least partly visible. */
async function firstVisibleRow(page: Page) {
  return page.evaluate(() => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>('[data-index]')]
      .filter(
        (node) =>
          node.querySelector('.group') &&
          node.getBoundingClientRect().bottom > top,
      )
      .sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )[0];
    return {
      text: row.textContent ?? '',
      y: row.getBoundingClientRect().top - top,
    };
  });
}

async function rowOffset(page: Page, text: string) {
  return page.evaluate((wanted) => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const row = [...el.querySelectorAll<HTMLElement>('[data-index]')].find(
      (node) => node.textContent === wanted,
    );
    return row
      ? row.getBoundingClientRect().top - el.getBoundingClientRect().top
      : null;
  }, text);
}

test('a first page that arrives after mount still lands at the bottom', async ({
  page,
}) => {
  await openHarness(page, { late: '1', n: '60' });
  await expect.poll(async () => (await metrics(page)).gap).toBeLessThan(24);
});

test('a late-loading image keeps a reader pinned to the bottom', async ({
  page,
}) => {
  await page.route('https://e2e.invalid/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#0891b2"/></svg>',
    });
  });
  await openHarness(page, { n: '40', slowImage: '1' });
  const image = page.getByRole('button', { name: '放大图片：图表' });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight), {
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  await expect.poll(async () => (await metrics(page)).gap).toBeLessThan(24);
});

async function settledAtBottom(page: Page) {
  await expect.poll(async () => (await metrics(page)).gap).toBeLessThan(24);
  // Let the first page finish its bottom-pinning window before acting.
  await page.waitForTimeout(800);
}

test('a new message does not pull a history reader back down', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);
  const anchor = await firstVisibleRow(page);

  await page.evaluate(() =>
    (
      window as unknown as {
        __chatScroll: { pushMessage: (content: string) => void };
      }
    ).__chatScroll.pushMessage('新到的一条回复'),
  );
  await page.waitForTimeout(1000);

  const offset = await rowOffset(page, anchor.text);
  expect(offset).not.toBeNull();
  expect(Math.abs((offset ?? 0) - anchor.y)).toBeLessThan(3);
  expect((await metrics(page)).gap).toBeGreaterThan(2000);
});

test('older pages load above the reader without moving the visible rows', async ({
  page,
}) => {
  await openHarness(page, { n: '60', hasMore: '1' });
  await settledAtBottom(page);

  await scrollTranscriptTo(page, 400);
  await scrollTranscriptTo(page, 50);
  const anchor = await firstVisibleRow(page);
  const loaded = () =>
    page.evaluate(() =>
      (
        window as unknown as {
          __chatScroll: { loadedOlderPages: () => number };
        }
      ).__chatScroll.loadedOlderPages(),
    );
  await expect.poll(loaded).toBe(1);
  await page.waitForTimeout(300);

  const offset = await rowOffset(page, anchor.text);
  expect(offset).not.toBeNull();
  expect(Math.abs((offset ?? 0) - anchor.y)).toBeLessThan(3);
  expect((await metrics(page)).top).toBeGreaterThan(100);

  // Scrolling up again keeps paging until the history is exhausted.
  for (let i = 0; i < 2; i += 1) {
    await scrollTranscriptTo(page, 50);
    await expect.poll(loaded).toBe(i + 2);
  }
});
