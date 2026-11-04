import { expect, test, type Locator, type Page } from '@playwright/test';

import { touchscreen, type TouchPoint } from './touchscreen';

// Reading a conversation on a phone (Pixel 7): the message menu and its long
// press, long user messages, the image viewer's gestures, Markdown links and
// small targets, the question card, and the transcript keeping its place when
// the keyboard comes up. Through chat-render-harness and chat-scroll-harness.

const RENDER = '/tests/e2e/chat-render-harness.html';
const SCROLL = '/tests/e2e/chat-scroll-harness.html';

declare global {
  interface Window {
    chatHarness: {
      append: (id: string, fromMe: boolean, content: string) => void;
    };
  }
}

async function open(page: Page, query: string) {
  await page.goto(`${RENDER}?${query}`);
  // A cold dev server takes a while under parallel load.
  await expect(page.locator('[data-hc-chat-view]')).toBeVisible({
    timeout: 20_000,
  });
}

async function expectNoSidewaysOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function longPress(page: Page, at: TouchPoint) {
  const fingers = await touchscreen(page);
  await fingers.down([at]);
  await page.waitForTimeout(700);
  await fingers.up();
}

/**
 * Brings `locator` to the middle of the transcript (clear of the floating
 * header and composer) and lets the virtual list settle around it. While the
 * first page settles the list takes a scroll without reader input for layout
 * and pins the bottom again (WebKit measures late enough to hit that), so it
 * scrolls again until the element stays in view.
 */
async function reveal(locator: Locator) {
  await expect(async () => {
    await locator
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'center' }), undefined, {
        timeout: 1000,
      });
    await locator.page().waitForTimeout(300);
    const inView = await locator.first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight;
    });
    expect(inView).toBe(true);
  }).toPass();
}

async function center(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('the message menu', () => {
  test('opens as a sheet on a long press, with a way to select the text', async ({
    page,
  }) => {
    await open(page, 'scenario=history');
    const bubble = page
      .locator('[data-hc-chat-view] p')
      .filter({ hasText: '那继续把会话列表也改成虚拟滚动吧' });
    await reveal(bubble);
    const sheet = page.getByRole('dialog', { name: '消息操作' });
    // The virtual list may still be settling (it pins the bottom again while
    // the first page measures): bring the bubble back into view before each
    // press and press only where it is on screen, again if it moved away.
    await expect(async () => {
      await reveal(bubble);
      const box = (await bubble.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.y + 10).toBeGreaterThan(0);
      expect(box.y + 10).toBeLessThan(viewport.height);
      await longPress(page, { x: box.x + 30, y: box.y + 10 });
      await expect(sheet).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: 15_000 });
    for (const label of [
      '复制文本',
      '复制 Markdown',
      '选择文本',
      '删除聊天记录',
    ]) {
      const row = sheet.getByRole('button', { name: label });
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    await sheet.getByRole('button', { name: '选择文本' }).tap();
    const select = page.getByRole('dialog', { name: '选择文本' });
    await expect(select).toBeVisible();
    const text = select.locator('[data-hc-select-text]');
    await expect(text).toContainText('长列表大概会有 1000 个会话');
    // Safari only knows the prefixed property.
    expect(
      await text.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.userSelect || style.webkitUserSelect;
      }),
    ).toBe('text');
    await expectNoSidewaysOverflow(page);
  });

  test('「⋯」 opens the same sheet, a finger high', async ({ page }) => {
    await open(page, 'scenario=history');
    const menu = page.getByRole('button', { name: '消息菜单' }).last();
    await reveal(menu);
    const box = (await menu.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await menu.tap();
    await expect(page.getByRole('dialog', { name: '消息操作' })).toBeVisible();
  });
});

test.describe('user messages', () => {
  test('are set at the size of the reply', async ({ page }) => {
    await open(page, 'scenario=history');
    const user = page
      .locator('[data-hc-chat-view] p')
      .filter({ hasText: '把 1 到 300 逐行列出来' });
    const reply = page.locator('[data-markdown-root]').last();
    const [userSize, replySize] = await Promise.all([
      user.evaluate((el) => getComputedStyle(el).fontSize),
      reply.evaluate((el) => getComputedStyle(el).fontSize),
    ]);
    expect(userSize).toBe('17px');
    expect(userSize).toBe(replySize);
  });

  test('fold past fourteen lines to ten, with 展开', async ({ page }) => {
    await open(page, 'scenario=history');
    await page.evaluate(() =>
      window.chatHarness.append(
        'long-user',
        false,
        Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行日志`).join('\n'),
      ),
    );
    const text = page.locator('[data-hc-user-text]');
    await expect(text).toHaveAttribute('data-hc-user-text', 'folded');
    const lineHeight = await text.evaluate((el) =>
      parseFloat(getComputedStyle(el).lineHeight),
    );
    const folded = (await text.boundingBox())!.height;
    expect(Math.round(folded / lineHeight)).toBe(10);

    const toggle = page.getByRole('button', { name: '展开', exact: true });
    await reveal(toggle);
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.tap();
    await expect(
      page.getByRole('button', { name: '收起', exact: true }),
    ).toBeVisible();
    const whole = page
      .locator('[data-hc-chat-view] p')
      .filter({ hasText: '第 20 行日志' });
    expect(Math.round((await whole.boundingBox())!.height / lineHeight)).toBe(
      20,
    );
  });

  test('of a few lines stay whole', async ({ page }) => {
    await open(page, 'scenario=history');
    await expect(page.locator('[data-hc-user-text="folded"]')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '展开', exact: true }),
    ).toHaveCount(0);
  });
});

test.describe('the image viewer', () => {
  async function openImage(page: Page) {
    await open(page, 'scenario=markdown');
    const image = page.locator('img[data-hc-md-image]').first();
    await reveal(image);
    await image.tap();
    const viewer = page.getByRole('dialog', { name: /图片预览/ });
    await expect(viewer).toBeVisible();
    return viewer;
  }

  const transform = (page: Page) =>
    page.locator('[data-hc-zoom-content]').evaluate((el) => {
      const matrix = new DOMMatrix(getComputedStyle(el).transform);
      return { scale: matrix.a, x: matrix.e, y: matrix.f };
    });

  test('takes Markdown images, pages through them, and keeps its close button clear', async ({
    page,
  }) => {
    const viewer = await openImage(page);
    // Every image of the reply is a page of it.
    await expect(viewer).toHaveAccessibleName(/图片预览 1 \/ [2-9]/);
    const close = viewer.getByRole('button', { name: '关闭' });
    const box = (await close.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y).toBeGreaterThanOrEqual(16);
    await expectNoSidewaysOverflow(page);
  });

  test('zooms about the midpoint of two fingers, pans, and springs back past the edge', async ({
    page,
  }) => {
    await openImage(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const fingers = await touchscreen(page);
    const mid = await center(page, '[data-hc-zoom-content]');
    const anchor = { x: mid.x + 40, y: mid.y };
    await fingers.down([
      { x: anchor.x - 40, y: anchor.y },
      { x: anchor.x + 40, y: anchor.y },
    ]);
    for (let step = 1; step <= 5; step += 1) {
      await fingers.move([
        { x: anchor.x - 40 - step * 8, y: anchor.y },
        { x: anchor.x + 40 + step * 8, y: anchor.y },
      ]);
    }
    await fingers.up();
    const zoomed = await transform(page);
    expect(zoomed.scale).toBeCloseTo(2, 1);
    // The point between the fingers stayed under them: it was 40px right of
    // the centre and is 40px right of it still, so the image moved left.
    expect(zoomed.x).toBeCloseTo(-40, 0);
    await expect(page.locator('[data-hc-zoom-content]')).toHaveAttribute(
      'data-zoomed',
      'true',
    );

    // One finger drags the zoomed image; far past its edge it springs back
    // to the edge, not beyond.
    await fingers.down([mid]);
    for (let step = 1; step <= 10; step += 1) {
      await fingers.move([{ x: mid.x + step * 60, y: mid.y }]);
    }
    await fingers.up();
    const width = await page
      .locator('[data-hc-zoom-content]')
      .evaluate((el) => (el as HTMLElement).offsetWidth);
    const viewport = page.viewportSize()!.width;
    // WebKit may still ease the spring back: motion reads the emulated
    // reduced-motion setting late there.
    await expect
      .poll(async () => (await transform(page)).x)
      .toBeCloseTo(Math.max(0, (width * 2 - viewport) / 2), 0);

    // A double tap zooms back out to 1×.
    for (let tap = 0; tap < 2; tap += 1) {
      await fingers.down([mid]);
      await fingers.up();
    }
    await expect(page.locator('[data-hc-zoom-content]')).toHaveAttribute(
      'data-zoomed',
      'false',
    );
    await expect.poll(async () => (await transform(page)).scale).toBe(1);
    await expect(page.getByRole('dialog', { name: /图片预览/ })).toBeVisible();
  });

  test('a double tap zooms in; a pull down at 1× closes', async ({ page }) => {
    await openImage(page);
    const fingers = await touchscreen(page);
    const mid = await center(page, '[data-hc-zoom-content]');
    for (let tap = 0; tap < 2; tap += 1) {
      await fingers.down([mid]);
      await fingers.up();
    }
    await expect(page.locator('[data-hc-zoom-content]')).toHaveAttribute(
      'data-zoomed',
      'true',
    );
    for (let tap = 0; tap < 2; tap += 1) {
      await fingers.down([mid]);
      await fingers.up();
    }
    await expect(page.locator('[data-hc-zoom-content]')).toHaveAttribute(
      'data-zoomed',
      'false',
    );
    await page.waitForTimeout(350);
    await fingers.down([mid]);
    for (let step = 1; step <= 10; step += 1) {
      await fingers.move([{ x: mid.x, y: mid.y + step * 20 }]);
    }
    await fingers.up();
    await expect(page.getByRole('dialog', { name: /图片预览/ })).toHaveCount(0);
  });
});

test.describe('Markdown', () => {
  test('opens a workspace file inside the app, not in a new tab', async ({
    page,
  }) => {
    await page.route('**/files/preview/**', (route) =>
      route.fulfill({ contentType: 'text/plain', body: '报告正文' }),
    );
    await open(page, 'scenario=markdown');
    const link = page.getByRole('link', { name: 'report.md' }).first();
    await reveal(link);
    await expect(link).not.toHaveAttribute('target', '_blank');
    const url = page.url();
    await link.tap();
    const sheet = page.getByRole('dialog', { name: 'report.md' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('iframe[data-hc-file-preview]')).toHaveAttribute(
      'src',
      /files\/preview\//,
    );
    await expect(sheet.frameLocator('iframe').locator('body')).toContainText(
      '报告正文',
    );
    // A download that works in an installed app too (no `download` link).
    const download = page.waitForEvent('download');
    await sheet.getByRole('button', { name: '下载' }).tap();
    expect((await download).suggestedFilename()).toBe('report.md');
    expect(page.url()).toBe(url);
    expect(page.context().pages()).toHaveLength(1);
  });

  test('keeps other links in a new tab', async ({ page }) => {
    await open(page, 'scenario=markdown');
    await expect(
      page.getByRole('link', { name: 'React 官方文档' }).first(),
    ).toHaveAttribute('target', '_blank');
  });

  test('gives footnote marks and summaries a finger-sized target', async ({
    page,
  }) => {
    await open(page, 'scenario=markdown');
    const ref = page.locator('sup a[data-hc-anchor]').first();
    await reveal(ref);
    const box = (await ref.boundingBox())!;
    // The mark itself is a few pixels wide; 18px off its centre still hits it.
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return !!el?.closest('a[data-hc-anchor]');
      },
      { x: box.x + box.width / 2 + 18, y: box.y + box.height / 2 + 18 },
    );
    expect(hit).toBe(true);

    const summary = page.locator('[data-markdown-root] summary').first();
    await reveal(summary);
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoSidewaysOverflow(page);
  });
});

test('a question shows what each option means, and an option grows to fit it', async ({
  page,
}) => {
  await open(page, 'scenario=live');
  await page.evaluate(() => {
    const harness = (
      window as unknown as {
        renderHarness: {
          start: () => void;
          emit: (e: Record<string, unknown>) => void;
        };
      }
    ).renderHarness;
    harness.start();
    harness.emit({
      eventType: 'tool_use_start',
      toolName: 'AskUserQuestion',
      toolUseId: 'q1',
      toolInput: {
        questions: [
          {
            question: '用哪个方案？',
            options: [
              {
                label: '窄 selector',
                description: '只订阅需要的字段，改动最小',
              },
              { label: '先不改' },
              {
                label:
                  '拆分 store，把流式状态单独放进一个 store，侧栏和会话列表只订阅它们各自需要的那一部分',
                description:
                  '更彻底，但要改动所有订阅方，并重新验证每个页面在流式输出时的渲染次数',
              },
            ],
          },
        ],
      },
    });
  });
  const options = page.locator('[data-hc-question-option]');
  await expect(options).toHaveCount(3);
  await expect(options.first()).toContainText('只订阅需要的字段，改动最小');
  const [described, plain, long] = await Promise.all([
    options.nth(0).boundingBox(),
    options.nth(1).boundingBox(),
    options.nth(2).boundingBox(),
  ]);
  expect(plain!.height).toBeGreaterThanOrEqual(44);
  expect(described!.height).toBeGreaterThanOrEqual(44);
  // A long label and its description wrap rather than run out of the option
  // (options on one line share its height).
  expect(long!.height).toBeGreaterThan(80);
  expect(long!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expectNoSidewaysOverflow(page);
});

test.describe('the transcript', () => {
  // A finger's scroll goes through CDP.
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP touch');
  async function openScroll(page: Page) {
    await page.goto(`${SCROLL}?n=60`);
    await expect(
      page.locator('[data-hc-chat-view] [data-index]').first(),
    ).toBeVisible();
    await page.waitForTimeout(400);
  }

  /** Reads up the history with a finger, away from the bottom. */
  async function readUp(page: Page) {
    const fingers = await touchscreen(page);
    const view = page.viewportSize()!;
    const x = view.width / 2;
    await fingers.down([{ x, y: 250 }]);
    for (let step = 1; step <= 10; step += 1) {
      await fingers.move([{ x, y: 250 + step * 40 }]);
      await page.waitForTimeout(16);
    }
    await fingers.up();
    await page.waitForTimeout(600);
  }

  test('keeps the lines being read in view when the keyboard shrinks it', async ({
    page,
  }) => {
    await openScroll(page);
    await readUp(page);
    await expect(page.getByRole('button', { name: /回到底部/ })).toBeVisible();
    /** A row near the bottom of the list and how far above its bottom it sits. */
    const near = (wanted?: string) =>
      page.evaluate((wanted) => {
        const el = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-hc-chat-view] .overflow-y-auto',
          ),
        ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        const bottom = el.getBoundingClientRect().bottom;
        const rows = [...el.querySelectorAll<HTMLElement>('[data-index]')];
        const row = wanted
          ? rows.find((r) => r.getAttribute('data-index') === wanted)
          : rows.find((r) => {
              const box = r.getBoundingClientRect();
              return box.top < bottom - 150 && box.bottom > bottom - 150;
            });
        return row
          ? {
              index: row.getAttribute('data-index')!,
              offset: bottom - row.getBoundingClientRect().top,
            }
          : null;
      }, wanted);
    const before = (await near())!;
    const view = page.viewportSize()!;
    // An Android keyboard: the page itself gets shorter (resizes-content).
    await page.setViewportSize({
      width: view.width,
      height: view.height - 300,
    });
    await page.waitForTimeout(400);
    // The row keeps its place above the bottom: the top gave way instead.
    const after = (await near(before.index))!;
    expect(Math.abs(after.offset - before.offset)).toBeLessThan(8);
  });

  test('keeps them in view when an iOS keyboard covers the page instead', async ({
    page,
  }) => {
    await openScroll(page);
    await readUp(page);
    await expect(page.getByRole('button', { name: /回到底部/ })).toBeVisible();
    const top = () =>
      page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[data-hc-chat-view] .overflow-y-auto',
            ),
          ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0].scrollTop,
      );
    const before = await top();
    // iOS: the layout stays, the visual viewport loses the keyboard's height.
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      const full = window.innerHeight;
      Object.defineProperty(viewport, 'height', {
        configurable: true,
        get: () => full - 300,
      });
      viewport.dispatchEvent(new Event('resize'));
    });
    // What was just above the composer moves up with it, by the keyboard.
    await expect.poll(top).toBeGreaterThan(before + 290);
    expect(await top()).toBeLessThan(before + 310);
  });

  test('a scroll by hand puts the keyboard away', async ({ page }) => {
    await openScroll(page);
    const editor = page.locator('[data-hc-chat-view] [contenteditable="true"]');
    await editor.first().focus();
    const editing = () =>
      page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.isContentEditable,
      );
    expect(await editing()).toBe(true);
    // A drag makes no click, so nothing else would take the focus away.
    await readUp(page);
    expect(await editing()).toBe(false);
  });

  test('its jump to the bottom is a finger wide', async ({ page }) => {
    await openScroll(page);
    await readUp(page);
    const jump = page.getByRole('button', { name: /回到底部/ });
    await expect(jump).toBeVisible();
    const box = (await jump.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expectNoSidewaysOverflow(page);
  });
});

test('queued messages reorder from a sheet on touch, and say what 立即发送 does', async ({
  page,
}) => {
  await open(page, 'scenario=streaming');
  const panel = page.getByTestId('queued-follow-ups');
  await expect(panel).toBeVisible();
  const toggle = panel.getByRole('button', { name: /展开/ });
  if (await toggle.count()) await toggle.first().tap();
  await expect(panel.getByTestId('queued-follow-ups-hint')).toContainText(
    '将停止当前回复',
  );
  await panel
    .getByRole('button', { name: /更多操作/ })
    .last()
    .tap();
  const sheet = page.getByRole('dialog', { name: '排队消息操作' });
  await expect(sheet).toBeVisible();
  const up = sheet.getByRole('button', { name: '上移' });
  expect((await up.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(up).toBeEnabled();
  await expect(sheet.getByRole('button', { name: '下移' })).toBeDisabled();
});
