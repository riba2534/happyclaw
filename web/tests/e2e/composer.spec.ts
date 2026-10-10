import { expect, test, type Page } from '@playwright/test';

const HARNESS_PATH = '/tests/e2e/composer-harness.html';
// 2x2 PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJgQEAKxkDAWi0fZcAAAAASUVORK5CYII=';

interface HarnessState {
  sent: Array<{ to: string; content: string; images: number; mode?: string }>;
  uploads: string[][];
  stops: string[];
  queueActions: Array<{ id: string; action: string; content?: string }>;
}

async function openHarness(page: Page) {
  await page.goto(HARNESS_PATH);
  await expect(composer(page)).toBeVisible();
}

const composer = (page: Page) => page.locator('[data-hc-composer] textarea');

const harnessState = (page: Page) =>
  page.evaluate(() => {
    const h = (window as unknown as { composerHarness: HarnessState })
      .composerHarness;
    return {
      sent: h.sent,
      uploads: h.uploads,
      stops: h.stops,
      queueActions: h.queueActions,
    };
  });

const callHarness = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ([name, params]) => {
      const h = (window as unknown as Record<string, Record<string, unknown>>)
        .composerHarness;
      (h[name as string] as (...a: unknown[]) => void)(
        ...(params as unknown[]),
      );
    },
    [method, args] as const,
  );

async function switchTo(page: Page, sessionId: string | null) {
  await callHarness(page, 'switchTo', sessionId);
  const title =
    sessionId === 'a1'
      ? '会话 A'
      : sessionId === 'a2'
        ? '会话 B'
        : '输入框测试工作区';
  await expect(page.locator('header h2')).toHaveText(title);
}

async function pasteImage(page: Page, name: string) {
  await composer(page).evaluate(
    (element, [fileName, base64]) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], fileName, { type: 'image/png' }));
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [name, PNG_BASE64] as const,
  );
}

/** Dispatches a file drag (enter → over → drop) on the element showing `text`. */
async function dragFilesOnto(
  page: Page,
  target: string,
  files: Array<{ name: string; type: string }>,
  { drop = true } = {},
) {
  return page.evaluate(
    ([text, fileList, base64, shouldDrop]) => {
      const element = document.evaluate(
        `//*[text()='${text}']`,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
      if (!element) throw new Error(`No element with text ${text}`);
      const transfer = new DataTransfer();
      for (const file of fileList) {
        const bytes =
          file.type === 'image/png'
            ? Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
            : new TextEncoder().encode('hello');
        transfer.items.add(new File([bytes], file.name, { type: file.type }));
      }
      const fire = (type: string) => {
        const event = new DragEvent(type, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const enter = fire('dragenter');
      const over = fire('dragover');
      const dropped = shouldDrop ? fire('drop') : null;
      return { enter, over, dropped };
    },
    [target, files, PNG_BASE64, drop] as const,
  );
}

/** Height between the header and the composer: what the conversation gets. */
async function conversationHeight(page: Page) {
  const header = await page.locator('header').first().boundingBox();
  const input = await page.locator('[data-hc-composer]').boundingBox();
  if (!header || !input) throw new Error('missing layout boxes');
  return input.y - (header.y + header.height);
}

async function simulateKeyboard(page: Page, height: number) {
  await page.evaluate((keyboard) => {
    const viewport = window.visualViewport!;
    const full = window.innerHeight;
    Object.defineProperty(viewport, 'height', {
      configurable: true,
      get: () => full - keyboard,
    });
    viewport.dispatchEvent(new Event('resize'));
  }, height);
}

test.describe('desktop composer', () => {
  // Narrower than the 1024px layout breakpoint, but a mouse and keyboard.
  test.use({
    viewport: { width: 1000, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });

  test('drafts and attachments stay with the session they were written in', async ({
    page,
  }) => {
    await openHarness(page);
    await composer(page).fill('写给主会话的草稿');
    await pasteImage(page, 'main-only.png');
    await expect(
      page.getByRole('button', { name: '预览图片：main-only.png' }),
    ).toBeVisible();

    await switchTo(page, 'a1');
    await expect(composer(page)).toHaveValue('');
    await expect(
      page.getByRole('button', { name: '预览图片：main-only.png' }),
    ).toHaveCount(0);
    await composer(page).fill('会话 A 的草稿');

    await switchTo(page, 'a2');
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('会话 B 的草稿');

    await switchTo(page, null);
    await expect(composer(page)).toHaveValue('写给主会话的草稿');

    await switchTo(page, 'a1');
    await expect(composer(page)).toHaveValue('会话 A 的草稿');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveValue('');
    expect((await harnessState(page)).sent).toEqual([
      { to: 'a1', content: '会话 A 的草稿', images: 0 },
    ]);

    await switchTo(page, 'a2');
    await expect(composer(page)).toHaveValue('会话 B 的草稿');
    const drafts = await page.evaluate(() =>
      (
        window as unknown as {
          composerHarness: { drafts: () => Record<string, string> };
        }
      ).composerHarness.drafts(),
    );
    expect(drafts).toEqual({
      'web:e2e-composer': '写给主会话的草稿',
      'web:e2e-composer#agent:a2': '会话 B 的草稿',
    });
  });

  test('typing during an in-flight send survives its success', async ({
    page,
  }) => {
    await openHarness(page);
    await page.evaluate(() => {
      (
        window as unknown as { composerHarness: { sendDelayMs: number } }
      ).composerHarness.sendDelayMs = 1500;
    });
    await composer(page).fill('first message');
    await composer(page).press('Enter');
    await page.keyboard.type(' second thought');
    await pasteImage(page, 'later.png');
    await expect(composer(page)).toHaveValue('first message second thought');

    await expect
      .poll(async () => (await harnessState(page)).sent.length)
      .toBe(1);
    await expect(composer(page)).toHaveValue('second thought');
    await expect(
      page.getByRole('button', { name: '预览图片：later.png' }),
    ).toBeVisible();
    expect((await harnessState(page)).sent[0]).toEqual({
      to: 'main',
      content: 'first message',
      images: 0,
    });
  });

  test('Enter sends in a narrow desktop window and the steer shortcut works', async ({
    page,
  }) => {
    await openHarness(page);
    await composer(page).fill('narrow window enter');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveValue('');

    await callHarness(page, 'setRunning', true);
    await composer(page).fill('change direction');
    await composer(page).press('Control+Shift+Enter');
    await expect(composer(page)).toHaveValue('');
    expect((await harnessState(page)).sent).toEqual([
      { to: 'main', content: 'narrow window enter', images: 0 },
      { to: 'main', content: 'change direction', images: 0, mode: 'steer' },
    ]);
  });

  test('files dropped on the conversation attach to the composer', async ({
    page,
  }) => {
    await openHarness(page);
    const during = await dragFilesOnto(
      page,
      '第 2 条提问',
      [{ name: 'notes.txt', type: 'text/plain' }],
      { drop: false },
    );
    expect(during).toMatchObject({ enter: true, over: true });
    await expect(page.getByTestId('chat-drop-overlay')).toBeVisible();
    await expect(page.getByTestId('chat-drop-overlay')).toContainText(
      '松开上传文件',
    );

    const result = await dragFilesOnto(page, '第 4 条提问', [
      { name: 'notes.txt', type: 'text/plain' },
      { name: 'shot.png', type: 'image/png' },
    ]);
    // The browser would otherwise navigate the tab to the file.
    expect(result.dropped).toBe(true);
    await expect(page.getByTestId('chat-drop-overlay')).toHaveCount(0);
    await expect
      .poll(async () => (await harnessState(page)).uploads)
      .toEqual([['notes.txt']]);
    await expect(page.getByTitle(/notes\.txt（已上传/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: '预览图片：shot.png' }),
    ).toBeVisible();

    // Text drags are left to the browser.
    const textDrag = await page.evaluate(() => {
      const element = document.evaluate(
        "//*[text()='第 2 条提问']",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue!;
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'hello');
      const event = new DragEvent('dragover', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(textDrag).toBe(false);
  });

  test('"上传文件" uploads picked images to the workspace', async ({
    page,
  }) => {
    await openHarness(page);
    const bytes = Buffer.from(PNG_BASE64, 'base64');
    await page
      .locator(
        '[data-hc-composer] input[type="file"]:not([accept]):not([webkitdirectory])',
      )
      .setInputFiles([
        { name: 'photo.png', mimeType: 'image/png', buffer: bytes },
        { name: 'report.pdf', mimeType: 'application/pdf', buffer: bytes },
      ]);
    await expect
      .poll(async () => (await harnessState(page)).uploads)
      .toEqual([['photo.png', 'report.pdf']]);
    await expect(page.getByTitle(/photo\.png（已上传/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: '预览图片：photo.png' }),
    ).toHaveCount(0);
  });

  test('queued items edit with keyboard shortcuts and label image-only items', async ({
    page,
  }) => {
    await openHarness(page);
    await callHarness(page, 'setRunning', true);
    await callHarness(page, 'setQueue', 2, null, true);
    await expect(page.getByTestId('queued-follow-ups')).toContainText('[图片]');
    await expect(
      page.getByRole('button', { name: '立即发送：[图片]' }),
    ).toBeAttached();

    const second = '排队消息 2：做完以后顺便检查一下第 2 个模块';
    await page.getByText(second).hover();
    await page.getByRole('button', { name: `编辑：${second}` }).click();
    const editor = page.getByRole('textbox', { name: '编辑排队消息' });
    await expect(editor).toBeFocused();
    expect(
      await editor.evaluate(
        (el: HTMLTextAreaElement) =>
          el.selectionStart === el.value.length &&
          el.selectionEnd === el.value.length,
      ),
    ).toBe(true);
    await page.keyboard.type('（简短）');
    await expect(editor).toHaveValue(`${second}（简短）`);

    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    expect((await harnessState(page)).queueActions).toEqual([]);
    // Esc inside the editor must not also stop the run.
    expect((await harnessState(page)).stops).toEqual([]);

    await page.getByText(second).hover();
    await page.getByRole('button', { name: `编辑：${second}` }).click();
    await page.keyboard.type('（简短）');
    await page.keyboard.press('Control+Enter');
    await expect(editor).toHaveCount(0);
    expect((await harnessState(page)).queueActions).toEqual([
      { id: 'q2', action: 'edit', content: `${second}（简短）` },
    ]);
  });

  test('stop stays reachable with a draft, and Esc stops an idle composer', async ({
    page,
  }) => {
    await openHarness(page);
    await callHarness(page, 'setRunning', true);
    await composer(page).fill('下一条');
    await expect(
      page.getByRole('button', { name: '加入队列，下一轮发送' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '停止当前运行' }).click();
    await expect
      .poll(async () => (await harnessState(page)).stops)
      .toEqual(['web:e2e-composer']);
    const stopCount = async () => (await harnessState(page)).stops.length;

    await callHarness(page, 'setRunning', true);
    await composer(page).fill('');
    await composer(page).press('Escape');
    await expect.poll(stopCount).toBe(2);

    // With nothing focused, Esc on the page stops too.
    await callHarness(page, 'setRunning', true);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press('Escape');
    await expect.poll(stopCount).toBe(3);

    // A draft in the focused composer keeps Esc for itself.
    await callHarness(page, 'setRunning', true);
    await composer(page).fill('还没发');
    await composer(page).press('Escape');
    await page.waitForTimeout(100);
    expect(await stopCount()).toBe(3);
  });

  test('pending images open in the lightbox and keep a 24px remove button', async ({
    page,
  }) => {
    await openHarness(page);
    await pasteImage(page, 'preview.png');
    const remove = page.getByRole('button', { name: '移除图片' });
    const box = await remove.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);

    const thumbnail = page.getByRole('button', {
      name: '预览图片：preview.png',
    });
    const src = await thumbnail.locator('img').getAttribute('src');
    await thumbnail.click();
    await expect
      .poll(() =>
        page.evaluate(
          (blob) =>
            Array.from(document.querySelectorAll('img')).filter(
              (img) =>
                img.getAttribute('src') === blob &&
                !img.closest('[data-hc-composer]'),
            ).length,
          src,
        ),
      )
      .toBeGreaterThan(0);
  });
});

test.describe('touch composer', () => {
  test('Enter inserts a newline on touch input', async ({ page }) => {
    await openHarness(page);
    expect(
      await page.evaluate(
        () => matchMedia('(pointer: coarse) and (hover: none)').matches,
      ),
    ).toBe(true);
    await composer(page).fill('第一行');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveValue('第一行\n');
    expect((await harnessState(page)).sent).toEqual([]);
  });

  test('a running queue collapses to one line and keeps the conversation visible', async ({
    page,
  }) => {
    await openHarness(page);
    await callHarness(page, 'setRunning', true);
    await callHarness(page, 'setQueue', 3);
    const viewportHeight = page.viewportSize()!.height;
    const panel = page.getByTestId('queued-follow-ups');

    await expect(panel).toHaveAttribute('data-state', 'closed');
    const summary = panel.getByRole('button', { name: /3 条已排队/ });
    await expect(summary).toContainText('展开');
    await expect(panel.getByText(/^排队消息 1/)).toHaveCount(0);
    expect(await conversationHeight(page)).toBeGreaterThan(viewportHeight / 2);

    await summary.click();
    await expect(panel).toHaveAttribute('data-state', 'open');
    const list = page.getByTestId('queued-follow-ups-list');
    const listBox = await list.boundingBox();
    expect(listBox!.height).toBeLessThanOrEqual(viewportHeight * 0.3 + 1);
    // Actions share the item's row: "立即发送" inline, the rest in a menu.
    const firstItem = panel.getByText(/^排队消息 1/);
    const itemBox = await firstItem.boundingBox();
    const sendNow = panel.getByRole('button', {
      name: /^立即发送：排队消息 1/,
    });
    const sendBox = await sendNow.boundingBox();
    expect(Math.abs(sendBox!.y - itemBox!.y)).toBeLessThan(20);
    expect(sendBox!.height).toBeGreaterThanOrEqual(40);

    await panel.getByRole('button', { name: /^更多操作：排队消息 2/ }).click();
    await page.getByRole('menuitem', { name: '上移' }).click();
    expect((await harnessState(page)).queueActions).toEqual([
      { id: 'q2', action: 'move_up' },
    ]);

    // The keyboard coming up folds the queue back to its summary.
    await simulateKeyboard(page, 320);
    await expect(panel).toHaveAttribute('data-state', 'closed');
    expect(await conversationHeight(page)).toBeGreaterThan(150);
  });

  test('editing from the item menu focuses the editor', async ({ page }) => {
    await openHarness(page);
    await callHarness(page, 'setRunning', true);
    await callHarness(page, 'setQueue', 2);
    const panel = page.getByTestId('queued-follow-ups');
    await panel.getByRole('button', { name: /2 条已排队/ }).click();
    await panel.getByRole('button', { name: /^更多操作：排队消息 2/ }).click();
    await page.getByRole('menuitem', { name: '编辑' }).click();
    const editor = page.getByRole('textbox', { name: '编辑排队消息' });
    await expect(editor).toBeFocused();
    // Its keyboard coming up must not fold the editor away.
    await simulateKeyboard(page, 320);
    await expect(panel).toHaveAttribute('data-state', 'open');
    await expect(editor).toBeVisible();
  });

  test('pinch-zoom is not mistaken for the keyboard', async ({ page }) => {
    await openHarness(page);
    const padding = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--keyboard-height')
          .trim(),
      );
    await simulateKeyboard(page, 300);
    await expect.poll(padding).toBe('300px');
    await page.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, 'scale', {
        configurable: true,
        get: () => 2,
      });
      Object.defineProperty(viewport, 'height', {
        configurable: true,
        get: () => window.innerHeight / 2,
      });
      viewport.dispatchEvent(new Event('resize'));
    });
    await expect.poll(padding).toBe('0px');
  });

  test('phone header shows the run state and a 40px back button', async ({
    page,
  }) => {
    await openHarness(page);
    await expect(page.getByTestId('chat-run-indicator')).toHaveCount(0);
    await callHarness(page, 'setRunning', true);
    await expect(page.getByTestId('chat-run-indicator')).toBeVisible();
    const back = await page.getByRole('button', { name: '返回' }).boundingBox();
    expect(back!.width).toBeGreaterThanOrEqual(40);
    expect(back!.height).toBeGreaterThanOrEqual(40);
    const send = await page
      .getByRole('button', { name: '停止当前运行' })
      .boundingBox();
    expect(send!.width).toBeGreaterThanOrEqual(40);
  });
});
