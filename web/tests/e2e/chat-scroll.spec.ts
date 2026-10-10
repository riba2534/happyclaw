import { expect, test, type Page } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/chat-scroll-harness.html';

interface ScrollMetrics {
  top: number;
  gap: number;
}

interface ScrollHarness {
  pushMessage: (content: string, sender?: string) => void;
  loadedOlderPages: () => number;
  startStreaming: (intervalMs?: number, initialText?: string) => void;
  finishStreaming: (finalize?: boolean) => void;
}

async function harness<K extends keyof ScrollHarness>(
  page: Page,
  name: K,
  ...args: Parameters<ScrollHarness[K]>
) {
  return page.evaluate(
    ({ name, args }) =>
      (
        (window as unknown as { __chatScroll: ScrollHarness }).__chatScroll[
          name
        ] as (...values: unknown[]) => unknown
      )(...args),
    { name, args: args as unknown[] },
  );
}

const LONG_REPLY = Array.from(
  { length: 80 },
  (_, i) =>
    `Paragraph ${i}: the quick brown fox jumps over the lazy dog, again and again.`,
).join('\n\n');

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

function bottomButton(page: Page) {
  return page.getByRole('button', { name: /^回到底部/ });
}

async function transcriptCenter(page: Page) {
  return page.evaluate(() => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
}

/** Largest bottom gap over `samples` reads `everyMs` apart. */
async function maxGapOver(page: Page, samples: number, everyMs: number) {
  let max = 0;
  for (let i = 0; i < samples; i += 1) {
    await page.waitForTimeout(everyMs);
    max = Math.max(max, (await metrics(page)).gap);
  }
  return max;
}

test('scrolling up right after a new message is not undone', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  await harness(page, 'pushMessage', `刚到达的新回复\n\n${'内容'.repeat(50)}`);
  await page.waitForTimeout(120);
  const center = await transcriptCenter(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -900);
  // While the jump is still animating the list applies the wheel's own delta
  // (900 / devicePixelRatio here); afterwards Chrome scrolls natively.
  await expect.poll(async () => (await metrics(page)).gap).toBeGreaterThan(200);

  await page.waitForTimeout(1500);
  expect((await metrics(page)).gap).toBeGreaterThan(200);
  await expect(bottomButton(page)).toBeVisible();
});

test('scrolling up while the jump to the bottom animates stops it there', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);

  await bottomButton(page).click();
  await page.waitForTimeout(150);
  const center = await transcriptCenter(page);
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(150);
  const afterWheel = (await metrics(page)).gap;
  expect(afterWheel).toBeGreaterThan(150);

  // Neither the animation nor its catch-up resumes the way down.
  await page.waitForTimeout(1500);
  expect(Math.abs((await metrics(page)).gap - afterWheel)).toBeLessThan(5);
  await expect(bottomButton(page)).toBeVisible();
});

test('scrolling up while the jump to the bottom finishes its last pixels still stops it', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);

  // The scroll handler counts the jump as landed within 10px of the bottom
  // while Chrome is still animating, and ignoring the wheel. Scroll up right
  // then; a synthetic wheel never scrolls natively, so only the takeover can
  // move the transcript.
  await page.evaluate(() => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const probe = window as unknown as { __landedAfterMs?: number };
    let clickedAt = 0;
    document.addEventListener(
      'click',
      () => {
        clickedAt = performance.now();
      },
      { capture: true, once: true },
    );
    const onScroll = () => {
      if (!clickedAt) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight >= 10) return;
      el.removeEventListener('scroll', onScroll);
      probe.__landedAfterMs = performance.now() - clickedAt;
      // After every scroll listener, including the one that records landing.
      setTimeout(() => {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -400,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };
    el.addEventListener('scroll', onScroll);
  });

  await bottomButton(page).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __landedAfterMs?: number }).__landedAfterMs,
      ),
    )
    .toBeDefined();
  const landedAfterMs = await page.evaluate(
    () => (window as unknown as { __landedAfterMs: number }).__landedAfterMs,
  );
  // Past the 600ms animation window the catch-up has already finished the
  // jump and native wheel scrolling works again: not the case under test.
  test.skip(landedAfterMs > 560, `jump landed after ${landedAfterMs}ms`);

  await expect.poll(async () => (await metrics(page)).gap).toBeGreaterThan(300);
  const afterWheel = (await metrics(page)).gap;
  await page.waitForTimeout(1500);
  expect(Math.abs((await metrics(page)).gap - afterWheel)).toBeLessThan(5);
  await expect(bottomButton(page)).toBeVisible();
});

/** A one-finger drag by `dy` (positive drags content down: scrolls up). */
async function touchDrag(page: Page, dy: number) {
  const center = await transcriptCenter(page);
  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(center.x);
  const y = Math.round(center.y) - 100;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 10; step += 1) {
    if (dy !== 0) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + (dy * step) / 10 }],
      });
    }
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

test('a touch scroll up while the jump to the bottom animates stops it there', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);

  await bottomButton(page).click();
  await page.waitForTimeout(150);
  await touchDrag(page, 300);
  await page.waitForTimeout(1500);
  // Touch slop and the stopped animation eat part of the drag; pulled back
  // down would leave no gap at all.
  expect((await metrics(page)).gap).toBeGreaterThan(150);
  await expect(bottomButton(page)).toBeVisible();
});

test('a tap while the jump to the bottom animates still lands at the bottom', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);

  await bottomButton(page).click();
  await page.waitForTimeout(150);
  await touchDrag(page, 0);
  await expect.poll(async () => (await metrics(page)).gap).toBeLessThan(24);
  await expect(bottomButton(page)).toHaveCount(0);
});

test('jumping to the bottom from far up during a stream lands pinned and keeps following', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  await harness(page, 'startStreaming', 100);
  await page.waitForTimeout(500);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);
  expect((await metrics(page)).gap).toBeGreaterThan(2500);

  await bottomButton(page).click();
  await expect
    .poll(async () => (await metrics(page)).gap, { timeout: 2000 })
    .toBeLessThan(24);
  // Still following 1.5s later; a stream left behind grows ~300px a second.
  expect(await maxGapOver(page, 10, 150)).toBeLessThan(100);
  await expect(bottomButton(page)).toHaveCount(0);
  await harness(page, 'finishStreaming', false);
});

test('jumps to the bottom without animating when reduced motion is preferred', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);

  await bottomButton(page).click();
  expect((await metrics(page)).gap).toBeLessThan(24);
});

test('a reader pinned through a streamed reply stays pinned when it finalizes', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  await harness(page, 'startStreaming', 0, LONG_REPLY);
  // Let the streamed reply render and the reader follow it down.
  await page.waitForTimeout(600);
  await expect.poll(async () => (await metrics(page)).gap).toBeLessThan(24);

  await harness(page, 'finishStreaming', true);
  await page.waitForTimeout(1000);
  expect((await metrics(page)).gap).toBeLessThan(24);
  await expect(bottomButton(page)).toHaveCount(0);

  // Still pinned, so the next reply is followed as it streams.
  await harness(page, 'startStreaming', 100);
  expect(await maxGapOver(page, 8, 150)).toBeLessThan(100);
  await harness(page, 'finishStreaming', false);
});

test('a finished reply does not pull a history reader back down', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  await harness(page, 'startStreaming', 0, LONG_REPLY);
  await page.waitForTimeout(500);
  // Well above the streaming block, among history rows.
  await scrollTranscriptTo(page, 2000);
  await page.waitForTimeout(300);
  const anchor = await firstVisibleRow(page);

  await harness(page, 'finishStreaming', true);
  await page.waitForTimeout(1000);
  const offset = await rowOffset(page, anchor.text);
  expect(offset).not.toBeNull();
  expect(Math.abs((offset ?? 0) - anchor.y)).toBeLessThan(3);
  expect((await metrics(page)).gap).toBeGreaterThan(2000);
});

test('the scroll buttons stay hidden when the transcript fits', async ({
  page,
}) => {
  await openHarness(page, { n: '2' });
  await page.waitForTimeout(500);
  const fits = await page.evaluate(() => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    return el.scrollHeight <= el.clientHeight;
  });
  expect(fits).toBe(true);
  await expect(page.getByRole('button', { name: '回到顶部' })).toHaveCount(0);
  await expect(bottomButton(page)).toHaveCount(0);
});

test('the jump-to-bottom button counts replies that arrived while reading history', async ({
  page,
}) => {
  await openHarness(page, { n: '60' });
  await settledAtBottom(page);
  const { top } = await metrics(page);
  await scrollTranscriptTo(page, top - 3000);
  await page.waitForTimeout(300);
  await expect(bottomButton(page)).toHaveAccessibleName('回到底部');
  await expect(page.getByRole('button', { name: '回到顶部' })).toBeVisible();

  await harness(page, 'pushMessage', '第一条新回复');
  await harness(page, 'pushMessage', '第二条新回复');
  await expect(bottomButton(page)).toHaveAccessibleName(
    '回到底部，有 2 条新消息',
  );

  await bottomButton(page).click();
  await expect.poll(async () => (await metrics(page)).gap).toBeLessThan(24);
  await expect(bottomButton(page)).toHaveCount(0);

  // Leaving the bottom again starts a fresh count.
  await scrollTranscriptTo(page, (await metrics(page)).top - 3000);
  await page.waitForTimeout(300);
  await harness(page, 'pushMessage', '第三条新回复');
  await expect(bottomButton(page)).toHaveAccessibleName(
    '回到底部，有 1 条新消息',
  );
});

test('the empty state scrolls to every starter on a short viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 400 });
  await page.goto(`${HARNESS_PATH}?n=0`);
  const starters = page.locator('[data-hc-empty-state] button');
  await expect(starters).toHaveCount(4);

  // It opens at the top, heading first.
  await page.waitForTimeout(500);
  await expect(page.locator('[data-hc-empty-state] h2')).toBeInViewport();

  const reach = await page.evaluate(() => {
    const scroller = document
      .querySelector('[data-hc-empty-state]')
      ?.closest<HTMLElement>('.overflow-y-auto');
    if (!scroller) return null;
    scroller.scrollTop = scroller.scrollHeight;
    const last = [
      ...document.querySelectorAll('[data-hc-empty-state] button'),
    ].at(-1)!;
    return {
      scrollable: scroller.scrollHeight > scroller.clientHeight,
      lastBottom: last.getBoundingClientRect().bottom,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
    };
  });
  expect(reach).not.toBeNull();
  expect(reach!.scrollable).toBe(true);
  expect(reach!.lastBottom).toBeLessThanOrEqual(reach!.scrollerBottom);

  await starters.last().click();
  await expect(page.locator('[data-hc-chat-view] textarea')).toHaveValue(
    '帮我定位和修复一个 Bug',
  );
});

test('an error callout copies its message', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openHarness(page, { n: '4' });
  await harness(
    page,
    'pushMessage',
    'agent_error:模型服务超时（504）',
    '__system__',
  );
  await page.getByRole('button', { name: '复制错误' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('模型服务超时（504）');
});
