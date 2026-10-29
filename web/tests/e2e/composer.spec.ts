import { expect, test, type Locator, type Page } from '@playwright/test';

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

/** The composer's editor (Tiptap, contenteditable). */
const composer = (page: Page) =>
  page.locator('[data-hc-composer] [data-composer-editor]');

/** The composer's text, line breaks included. */
const composerText = (page: Page) =>
  composer(page).evaluate((element) =>
    (
      element as HTMLElement & {
        editor: { getText: (options: { blockSeparator: string }) => string };
      }
    ).editor.getText({ blockSeparator: '\n' }),
  );

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

/** A `context-usage` answer (or push payload). */
const contextUsage = (
  usedTokens: number | null,
  contextWindow: number | null,
) => ({
  usedTokens,
  contextWindow,
  percentage:
    usedTokens !== null && contextWindow
      ? (usedTokens / contextWindow) * 100
      : null,
  model: usedTokens === null ? null : 'claude-opus-5-5',
  updatedAt: usedTokens === null ? null : new Date().toISOString(),
});

/**
 * Room the message list keeps below its last row: its scroller's padding
 * plus the content's, where a phone's floating dock reserves its height.
 */
const listRoomBelow = (page: Page) =>
  page.evaluate(() => {
    const scroller = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const content = scroller.querySelector<HTMLElement>(
      ':scope > .overflow-y-clip > div',
    )!;
    return (
      Number.parseFloat(getComputedStyle(scroller).paddingBottom) +
      Number.parseFloat(getComputedStyle(content).paddingBottom)
    );
  });

/** Waits for enter animations: a sliding sheet's handle is still moving. */
const settleAnimations = (scope: Locator) =>
  scope.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );

/** Times ChatView handed back to the page. */
const harnessBacks = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { composerHarness: { backs: number } })
        .composerHarness.backs,
  );

/**
 * Where a run status could move things: the card's top, the list's bottom
 * edge and the room it keeps below its last row.
 */
const runLayout = async (page: Page) => ({
  cardTop: (await page.locator('[data-composer-card]').boundingBox())!.y,
  ...(await page.evaluate(() => {
    const scroller = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    return { listBottom: scroller.getBoundingClientRect().bottom };
  })),
  room: await listRoomBelow(page),
});

/** A run starting and ending leaves the composer and the list where they were. */
async function expectSteadyAcrossRun(page: Page) {
  await openHarness(page);
  const bar = page.locator('[data-composer-status-bar]');
  // Reserved before any run.
  await expect(bar).toHaveCount(1);
  const before = await runLayout(page);
  await callHarness(page, 'setRunning', true);
  await expect(
    page.getByRole('button', { name: '停止当前运行' }),
  ).toBeVisible();
  expect(await runLayout(page)).toEqual(before);
  await callHarness(page, 'setRunning', false);
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  expect(await runLayout(page)).toEqual(before);
}

/** A row of the phone's + sheet. */
const plusAction = (page: Page, name: string) =>
  page
    .locator('[data-composer-plus-sheet]')
    .getByRole('button', { name, exact: true });

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
    await expect(composer(page)).toHaveText('');
    await expect(
      page.getByRole('button', { name: '预览图片：main-only.png' }),
    ).toHaveCount(0);
    await composer(page).fill('会话 A 的草稿');

    await switchTo(page, 'a2');
    await expect(composer(page)).toHaveText('');
    await composer(page).fill('会话 B 的草稿');

    await switchTo(page, null);
    await expect(composer(page)).toHaveText('写给主会话的草稿');

    await switchTo(page, 'a1');
    await expect(composer(page)).toHaveText('会话 A 的草稿');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveText('');
    expect((await harnessState(page)).sent).toEqual([
      { to: 'a1', content: '会话 A 的草稿', images: 0 },
    ]);

    await switchTo(page, 'a2');
    await expect(composer(page)).toHaveText('会话 B 的草稿');
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
    await expect(composer(page)).toHaveText('first message second thought');

    await expect
      .poll(async () => (await harnessState(page)).sent.length)
      .toBe(1);
    await expect(composer(page)).toHaveText('second thought');
    await expect(
      page.getByRole('button', { name: '预览图片：later.png' }),
    ).toBeVisible();
    expect((await harnessState(page)).sent[0]).toEqual({
      to: 'main',
      content: 'first message',
      images: 0,
    });
  });

  test('switching away and back during a send does not offer it again', async ({
    page,
  }) => {
    await openHarness(page);
    await page.evaluate(() => {
      (
        window as unknown as { composerHarness: { sendDelayMs: number } }
      ).composerHarness.sendDelayMs = 1500;
    });
    await composer(page).fill('hello main');
    // Let the debounced draft save land before sending.
    await page.waitForTimeout(400);
    await composer(page).press('Enter');
    await switchTo(page, 'a1');
    await switchTo(page, null);
    await expect(composer(page)).toHaveText('');

    await page.waitForTimeout(1700);
    await expect(composer(page)).toHaveText('');
    await composer(page).press('Enter');
    await page.waitForTimeout(200);
    expect((await harnessState(page)).sent).toEqual([
      { to: 'main', content: 'hello main', images: 0 },
    ]);
  });

  test('Enter sends in a narrow desktop window and the steer shortcut works', async ({
    page,
  }) => {
    await openHarness(page);
    await composer(page).fill('narrow window enter');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveText('');

    await callHarness(page, 'setRunning', true);
    await composer(page).fill('change direction');
    await composer(page).press('Control+Shift+Enter');
    await expect(composer(page)).toHaveText('');
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
    // Clear it the way a person does (WebKit's fill('') leaves the text).
    await composer(page).press('ControlOrMeta+a');
    await composer(page).press('Backspace');
    await expect(composer(page)).toHaveText('');
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
  test('a long paste folds into a chip and is sent in full', async ({
    page,
  }) => {
    await openHarness(page);
    const log = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}`).join(
      '\n',
    );
    await composer(page).click();
    await page.keyboard.type('看看这段日志：');
    await composer(page).evaluate((element, text) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, log);
    await expect(composer(page).locator('[data-pasted-text-chip]')).toHaveText(
      '粘贴文本 · 30 行',
    );
    await expect(composer(page)).not.toContainText('log line 2');
    await composer(page).press('Enter');
    await expect
      .poll(async () => (await harnessState(page)).sent)
      .toEqual([{ to: 'main', content: `看看这段日志：${log}`, images: 0 }]);
  });

  test('clicking a long-paste chip turns it back into editable text', async ({
    page,
  }) => {
    await openHarness(page);
    const log = Array.from({ length: 30 }, (_, i) => `log line ${i + 1}`).join(
      '\n',
    );
    await composer(page).click();
    await composer(page).evaluate((element, text) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, log);
    await composer(page).locator('[data-pasted-text-chip]').click();
    await expect(composer(page).locator('[data-pasted-text-chip]')).toHaveCount(
      0,
    );
    await expect(composer(page)).toContainText('log line 30');
    expect(await composerText(page)).toBe(log);
  });

  test('an empty conversation centres the composer and docks it after the first message', async ({
    page,
  }) => {
    await page.goto(`${HARNESS_PATH}?empty=1`);
    const card = page.locator('[data-composer-card]');
    await expect(card).toBeVisible();
    const heading = page.getByRole('heading', { name: '今天想做什么？' });
    await expect(heading).toBeVisible();
    const starters = page.locator('[data-hc-starter]');
    await expect(starters).toHaveCount(4);

    const viewport = page.viewportSize()!;
    const header = (await page.locator('header').first().boundingBox())!;
    const centred = (await card.boundingBox())!;
    const columnMiddle =
      header.y +
      header.height +
      (viewport.height - header.y - header.height) / 2;
    expect(
      Math.abs(centred.y + centred.height / 2 - columnMiddle),
    ).toBeLessThan(viewport.height * 0.15);
    // cindy's new-chat card: about 140px tall before typing.
    expect(centred.height).toBeGreaterThanOrEqual(140);
    // Heading above, starters below.
    expect((await heading.boundingBox())!.y).toBeLessThan(centred.y);
    expect((await starters.first().boundingBox())!.y).toBeGreaterThan(
      centred.y + centred.height,
    );

    // A starter fills the composer in place.
    await starters.last().click();
    await expect(composer(page)).toHaveText('帮我定位和修复一个 Bug');

    await callHarness(page, 'pushMessage', '第一条消息');
    await expect(heading).toHaveCount(0);
    await expect(starters).toHaveCount(0);
    await expect
      .poll(async () => {
        const docked = (await card.boundingBox())!;
        return viewport.height - (docked.y + docked.height);
      })
      .toBeLessThan(40);
    // Docking keeps the composer and what it holds.
    await expect(composer(page)).toHaveText('帮我定位和修复一个 Bug');
  });

  test('the run status row sits right above the card, reserved run or not', async ({
    page,
  }) => {
    await page.goto(`${HARNESS_PATH}?statusbar=1`);
    const card = page.locator('[data-composer-card]');
    const bar = page.locator('[data-composer-status-bar]');
    await expect(card).toBeVisible();
    // Idle: the row is there, empty.
    await expect(bar).toHaveCount(1);
    await expect(bar.getByTestId('status-bar-probe')).toHaveCount(0);
    const idle = (await card.boundingBox())!;
    const row = (await bar.boundingBox())!;
    const gap = idle.y - (row.y + row.height);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(10);
    expect(Math.abs(row.x - idle.x)).toBeLessThan(1);
    expect(Math.abs(row.width - idle.width)).toBeLessThan(1);

    await callHarness(page, 'setStatusRunning', true);
    await expect(bar.getByTestId('status-bar-probe')).toBeVisible();
    // Showing the status moves neither its row nor the card.
    expect(await bar.boundingBox()).toEqual(row);
    expect(await card.boundingBox()).toEqual(idle);

    await callHarness(page, 'setStatusRunning', false);
    await expect(bar.getByTestId('status-bar-probe')).toHaveCount(0);
    expect(await bar.boundingBox()).toEqual(row);
    expect(await card.boundingBox()).toEqual(idle);
  });

  test('a run starting and ending moves neither the card nor the list', async ({
    page,
  }) => {
    await expectSteadyAcrossRun(page);
  });

  test('back in a narrow desktop window steps to the session list', async ({
    page,
  }) => {
    await openHarness(page);
    await page.setViewportSize({ width: 700, height: 800 });
    await page.getByRole('button', { name: '返回' }).click();
    // Not a phone: the workspace's sessions, still inside ChatView.
    await expect(page.locator('header h2').first()).toBeHidden();
    expect(await harnessBacks(page)).toBe(0);
  });

  test('a docked composer is about 120px tall, with no conversation title in its row', async ({
    page,
  }) => {
    await openHarness(page);
    const card = (await page.locator('[data-composer-card]').boundingBox())!;
    expect(card.height).toBeGreaterThanOrEqual(118);
    expect(card.height).toBeLessThan(130);

    await switchTo(page, 'a1');
    const toolbar = page.locator('[data-composer-toolbar]');
    await expect(toolbar).toBeVisible();
    await expect(toolbar).not.toContainText('会话 A');
    await expect(toolbar.locator('[title^="发送到"]')).toHaveCount(0);
  });

  test('the context ring sits in the toolbar after the tools, moving nothing', async ({
    page,
  }) => {
    // What the server holds; a push updates it as a finished turn would.
    const server: Record<string, ReturnType<typeof contextUsage>> = {
      main: contextUsage(null, null),
      a1: contextUsage(150_000, 200_000),
    };
    await page.route('**/api/groups/*/context-usage*', (route) => {
      const session = new URL(route.request().url()).searchParams.get(
        'agentId',
      );
      return route.fulfill({ json: server[session ?? 'main'] });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await openHarness(page);
    const card = page.locator('[data-composer-card]');
    const toolbar = page.locator('[data-composer-toolbar]');
    const ring = toolbar.locator('[data-context-usage]');
    const terminal = toolbar.getByRole('button', { name: '终端', exact: true });
    const slot = page.locator('[data-composer-model-slot]');
    const send = toolbar.getByRole('button', { name: '发送消息' });
    const layout = () =>
      Promise.all(
        [card, terminal, slot, send].map((item) => item.boundingBox()),
      );
    // Nothing ran yet: no ring, its slot already in place.
    await expect(toolbar.locator('[data-composer-context]')).toHaveCount(1);
    await expect(ring).toHaveCount(0);
    const before = await layout();
    // Nothing under the card but the bar's own bottom padding.
    const composerBox = (await page
      .locator('[data-hc-composer]')
      .boundingBox())!;
    expect(
      composerBox.y + composerBox.height - (before[0]!.y + before[0]!.height),
    ).toBeLessThanOrEqual(16);

    server.main = contextUsage(120_000, 1_000_000);
    await callHarness(page, 'pushContextUsage', server.main);
    await expect(ring).toHaveText('12%');
    expect(await layout()).toEqual(before);

    // After the tools, centred on their 30px row, clear of the model slot.
    for (const width of [1280, 640]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(ring).toBeVisible();
      const [, tool, model, sendBox] = await layout();
      const box = (await ring.boundingBox())!;
      expect(box.x, `${width}px`).toBeGreaterThanOrEqual(tool!.x + tool!.width);
      expect(box.x + box.width, `${width}px`).toBeLessThanOrEqual(model!.x);
      expect(model!.x + model!.width, `${width}px`).toBeLessThanOrEqual(
        sendBox!.x + 0.5,
      );
      expect(
        Math.abs(box.y + box.height / 2 - (tool!.y + tool!.height / 2)),
        `${width}px`,
      ).toBeLessThan(1.5);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    // Less motion: no fade, no sweep.
    expect(
      await ring.evaluate((element) => [
        getComputedStyle(element).animationName,
        getComputedStyle(element.querySelectorAll('circle')[1])
          .transitionProperty,
      ]),
    ).toEqual(['none', 'none']);

    await ring.hover();
    await expect(page.getByRole('tooltip')).toHaveText(
      '上下文 已用 120K / 1M（12%）',
    );

    // A session shows its own usage, and its own pushes.
    await switchTo(page, 'a1');
    await expect(ring).toHaveText('75%');
    server.a1 = contextUsage(192_000, 200_000);
    await callHarness(page, 'pushContextUsage', {
      agentId: 'a1',
      ...server.a1,
    });
    await expect(ring).toHaveText('96%');
    await expect(ring).toHaveClass(/\btext-error\b/);
    await switchTo(page, null);
    await expect(ring).toHaveText('12%');
  });

  test('/ offers commands and skills; @ inserts a workspace file', async ({
    page,
  }) => {
    await page.route('**/api/skills', (route) =>
      route.fulfill({
        json: {
          skills: [
            {
              id: 'review',
              name: 'review',
              description: '审查代码改动',
              source: 'user',
              effective: true,
              enabled: true,
              userInvocable: true,
            },
          ],
        },
      }),
    );
    await page.route('**/api/groups/*/files*', (route) =>
      route.fulfill({
        json: {
          currentPath: '',
          files: [
            { name: 'docs', path: 'docs', type: 'directory' },
            { name: 'notes.txt', path: 'notes.txt', type: 'file' },
          ],
        },
      }),
    );
    await openHarness(page);
    const palette = page.getByRole('listbox');

    await composer(page).click();
    await page.keyboard.type('/');
    await expect(palette.getByRole('option')).toHaveText([
      /^\/clear/,
      /^\/fresh/,
      /^\/review审查代码改动/,
    ]);
    await page.keyboard.type('rev');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(composer(page)).toHaveText('/review');
    await expect(composer(page).locator('.slash-cmd-pill')).toHaveText(
      '/review',
    );

    await page.keyboard.type('看 @no');
    await expect(palette.getByRole('option')).toHaveText(['notes.txt']);
    await page.keyboard.press('Enter');
    await expect(composer(page).locator('[data-mention-chip]')).toHaveText(
      'notes.txt',
    );
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await harnessState(page)).sent)
      .toEqual([{ to: 'main', content: '/review 看 @"notes.txt"', images: 0 }]);
  });

  test('↑ recalls what was sent here; a draft survives a reload', async ({
    page,
  }) => {
    await openHarness(page);
    await composer(page).click();
    await page.keyboard.press('ArrowUp');
    await expect(composer(page)).toHaveText('第 10 条提问');
    await page.keyboard.press('ArrowUp');
    await expect(composer(page)).toHaveText('第 8 条提问');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(composer(page)).toHaveText('');

    await composer(page).fill('刷新以后还在');
    await page.waitForTimeout(400);
    await page.reload();
    await expect(composer(page)).toHaveText('刷新以后还在');
  });

  test('clicking blank space in the card focuses the editor', async ({
    page,
  }) => {
    await openHarness(page);
    const card = await page.locator('[data-composer-card]').boundingBox();
    const toolbar = await page.locator('[data-composer-toolbar]').boundingBox();
    // Between the toolbar's button groups.
    await page.mouse.click(
      toolbar!.x + toolbar!.width / 2,
      toolbar!.y + toolbar!.height / 2,
    );
    await expect(composer(page)).toBeFocused();
    expect(card!.height).toBeGreaterThan(0);
  });
});

test.describe('touch composer', () => {
  // A phone: touch only, narrow, typing on a software keyboard.
  test.use({
    viewport: { width: 412, height: 839 },
    isMobile: true,
    hasTouch: true,
  });

  test('a narrow row folds clear-context and terminal into the + menu', async ({
    page,
  }) => {
    await openHarness(page);
    await page.setViewportSize({ width: 390, height: 839 });
    const toolbar = page.locator('[data-composer-toolbar]');
    const plus = toolbar.getByRole('button', { name: '更多操作' });
    // Only + is left on the row.
    await expect(
      toolbar.locator('[data-composer-tools]').getByRole('button'),
    ).toHaveCount(1);

    // Clearing still asks first.
    await plus.click();
    await plusAction(page, '清除上下文').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '清除', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { composerHarness: { resets: unknown[] } })
              .composerHarness.resets,
        ),
      )
      .toEqual([{ jid: 'web:e2e-composer', agentId: null }]);
    // The menu-to-dialog hand-off leaves the page usable.
    await composer(page).click();
    await page.keyboard.type('还能输入');
    await expect(composer(page)).toHaveText('还能输入');

    await plus.click();
    await plusAction(page, '终端').click();
    await expect(page.getByRole('dialog', { name: '终端' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '终端' })).toHaveCount(0);

    // The terminal belongs to the main conversation only.
    await switchTo(page, 'a1');
    await plus.click();
    await expect(plusAction(page, '清除上下文')).toBeVisible();
    await expect(plusAction(page, '终端')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Wider than 480px the actions are buttons again, in the card the
    // resting pill opens into.
    await page.setViewportSize({ width: 600, height: 839 });
    await composer(page).click();
    await expect(
      toolbar.getByRole('button', { name: '清除当前会话上下文' }),
    ).toBeVisible();
  });

  test('on a phone the status bar rides in the dock, over the keyboard too', async ({
    page,
  }) => {
    await page.goto(`${HARNESS_PATH}?statusbar=1`);
    const card = page.locator('[data-composer-card]');
    const bar = page.locator('[data-composer-status-bar]');
    await expect(card).toBeVisible();
    const dockHeight = () =>
      page.evaluate(() =>
        Number.parseFloat(
          getComputedStyle(
            document.querySelector('[data-composer-dock-host]')!,
          ).getPropertyValue('--composer-dock-height') || '0',
        ),
      );
    // Reserved before any run, and counted in what the list keeps free.
    await expect(bar).toHaveCount(1);
    const idleDock = await dockHeight();
    const barHeight = (await bar.boundingBox())!.height;
    expect(idleDock).toBeGreaterThan(barHeight);
    await callHarness(page, 'setStatusRunning', true);
    await expect(bar.getByTestId('status-bar-probe')).toBeVisible();
    // The same room while a run shows, and after it ends.
    expect(await dockHeight()).toBe(idleDock);
    const before = [(await bar.boundingBox())!, (await card.boundingBox())!];
    await simulateKeyboard(page, 300);
    await expect
      .poll(async () => Math.round((await card.boundingBox())!.y))
      .toBe(Math.round(before[1].y - 300));
    // Bar and card move together.
    const after = (await bar.boundingBox())!;
    expect(Math.round(before[0].y - after.y)).toBe(300);
  });

  test('a run starting and ending moves neither the dock nor the list', async ({
    page,
  }) => {
    await expectSteadyAcrossRun(page);
  });

  test('back on a phone goes straight to the list, from a session too', async ({
    page,
  }) => {
    await openHarness(page);
    const back = page.getByRole('button', { name: '返回' });
    const title = page.locator('header h2').first();
    await back.click();
    // ChatPage's list path, not the ?sessions=1 level it would redirect.
    await expect.poll(() => harnessBacks(page)).toBe(1);
    await expect(title).toBeVisible();

    await switchTo(page, 'a1');
    await back.click();
    await expect.poll(() => harnessBacks(page)).toBe(2);
    await expect(page.locator('header h2').first()).toHaveText('会话 A');
  });

  test('a phone keeps a compact card and leaves the context ring off its row', async ({
    page,
  }) => {
    let requests = 0;
    await page.route('**/api/groups/*/context-usage*', (route) => {
      requests += 1;
      return route.fulfill({ json: contextUsage(120_000, 1_000_000) });
    });
    await openHarness(page);
    await page.waitForLoadState('networkidle');
    // No room on the phone row: the ring is neither shown nor loaded.
    await expect(page.locator('[data-composer-context]')).toHaveCount(0);
    expect(requests).toBe(0);
    const card = (await page.locator('[data-composer-card]').boundingBox())!;
    expect(card.height).toBeLessThan(110);
  });

  test('a phone types a newline on Enter; mod+Enter sends', async ({
    page,
  }) => {
    await openHarness(page);
    expect(
      await page.evaluate(
        () => matchMedia('(pointer: coarse) and (hover: none)').matches,
      ),
    ).toBe(true);
    await composer(page).fill('第一行');
    await composer(page).press('Enter');
    await expect.poll(() => composerText(page)).toBe('第一行\n');
    expect((await harnessState(page)).sent).toEqual([]);

    await composer(page).press('Control+Enter');
    await expect(composer(page)).toHaveText('');
    expect((await harnessState(page)).sent).toEqual([
      { to: 'main', content: '第一行', images: 0 },
    ]);
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

  test('a phone header floats over the conversation, with its actions in a ⋯ sheet', async ({
    page,
  }) => {
    await openHarness(page);
    const header = page.locator('[data-hc-chat-view] header');
    // Transparent and borderless; the conversation scrolls under it.
    expect(
      await header.evaluate((element) => [
        getComputedStyle(element).position,
        getComputedStyle(element).borderBottomWidth,
      ]),
    ).toEqual(['absolute', '0px']);
    // A round 40px back button; the title centred at 16px, semibold.
    const back = page.getByRole('button', { name: '返回' });
    expect(await back.boundingBox()).toMatchObject({ width: 40, height: 40 });
    expect(
      await back.evaluate((element) => getComputedStyle(element).borderRadius),
    ).not.toBe('0px');
    const title = header.getByRole('heading', { name: '输入框测试工作区' });
    const titleBox = (await title.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(
      Math.abs(titleBox.x + titleBox.width / 2 - viewport.width / 2),
    ).toBeLessThan(2);
    expect(
      await title.evaluate((element) => [
        getComputedStyle(element).fontSize,
        getComputedStyle(element).fontWeight,
      ]),
    ).toEqual(['16px', '600']);

    // The run state shows in the streaming area, not the header; stop is
    // the dock's 34px solid button.
    await callHarness(page, 'setRunning', true);
    await expect(page.getByTestId('chat-run-indicator')).toBeHidden();
    const stop = (await page
      .getByRole('button', { name: '停止当前运行' })
      .boundingBox())!;
    expect([Math.round(stop.width), Math.round(stop.height)]).toEqual([34, 34]);
    await callHarness(page, 'setRunning', false);

    // ⋯ holds the workspace actions, the terminal and clearing the context.
    await page.getByRole('button', { name: '更多选项' }).click();
    const sheet = page.locator('[data-chat-options-sheet]');
    await expect(sheet.getByRole('button')).toHaveText([
      '工作区设置',
      '渠道绑定',
      '终端',
      '清除上下文',
    ]);
    await sheet.getByRole('button', { name: '清除上下文' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '清除', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { composerHarness: { resets: unknown[] } })
              .composerHarness.resets,
        ),
      )
      .toEqual([{ jid: 'web:e2e-composer', agentId: null }]);

    // Dragging the sheet's handle down closes it (once it has slid in).
    await page.getByRole('button', { name: '更多选项' }).click();
    await expect(sheet).toBeVisible();
    await settleAnimations(sheet);
    const handle = (await sheet.locator('[data-sheet-handle]').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 10);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 160, {
      steps: 8,
    });
    await page.mouse.up();
    await expect(sheet).toHaveCount(0);
  });

  test('the context sheet opens at full and drags down to half', async ({
    page,
  }) => {
    await openHarness(page);
    await page.getByRole('button', { name: '展开上下文面板' }).click();
    const sheet = page.getByTestId('mobile-context-sheet');
    await expect(sheet).toHaveAttribute('data-snap', 'full');
    const viewport = page.viewportSize()!;
    const height = async () => Math.round((await sheet.boundingBox())!.height);
    await expect.poll(height).toBe(viewport.height - 64);

    await settleAnimations(sheet);
    const handle = (await sheet.locator('[data-sheet-handle]').boundingBox())!;
    const x = handle.x + handle.width / 2;
    await page.mouse.move(x, handle.y + 10);
    await page.mouse.down();
    // Past the midpoint between the detents, slowly: a flick would close it.
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(x, handle.y + 10 + step * 25);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    await expect
      .poll(height)
      .toBe(Math.max(320, Math.round(viewport.height * 0.56)));
  });

  test('a phone composer rests as a pill and opens into the card on tap', async ({
    page,
  }) => {
    await openHarness(page);
    const dock = page.locator('[data-hc-composer]');
    const card = page.locator('[data-composer-card]');
    await expect(dock).toHaveAttribute('data-composer-dock', 'pill');
    const viewport = page.viewportSize()!;
    const pill = (await card.boundingBox())!;
    // 16px from the sides, 8px above the bottom edge, one line tall.
    expect(Math.round(pill.x)).toBe(16);
    expect(Math.round(viewport.width - pill.x - pill.width)).toBe(16);
    expect(Math.round(viewport.height - pill.y - pill.height)).toBe(8);
    expect(pill.height).toBeLessThan(56);
    // + and send only: the model waits in the card.
    await expect(
      page.locator('[data-composer-tools]').getByRole('button'),
    ).toHaveCount(1);
    await expect(page.locator('[data-composer-model-slot]')).toBeHidden();
    // Tools: 34px with a light fill and a hairline.
    const plus = page.locator('[data-composer-tools] button').first();
    expect(
      await plus.evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          element.getBoundingClientRect().width,
          style.borderTopWidth,
          style.backgroundColor === 'rgba(0, 0, 0, 0)',
        ];
      }),
    ).toEqual([34, '1px', false]);
    // The editor stays at 16px: iOS zooms into smaller text.
    expect(
      await composer(page).evaluate(
        (element) => getComputedStyle(element).fontSize,
      ),
    ).toBe('16px');
    // The message list keeps the dock's height free below its last row.
    const dockBox = (await dock.boundingBox())!;
    expect(await listRoomBelow(page)).toBeGreaterThanOrEqual(dockBox.height);

    // A tap focuses the text and opens the card in the same gesture.
    await composer(page).tap();
    await expect(composer(page)).toBeFocused();
    await expect(dock).toHaveAttribute('data-composer-dock', 'card');
    await expect(page.locator('[data-composer-model-slot]')).toBeVisible();
    const opened = (await card.boundingBox())!;
    expect(opened.height).toBeGreaterThan(pill.height + 40);
    await expect
      .poll(() =>
        card.evaluate((element) => getComputedStyle(element).borderRadius),
      )
      .toBe('30px');
    // The list follows the taller dock.
    await expect
      .poll(
        async () =>
          (await listRoomBelow(page)) - (await dock.boundingBox())!.height,
      )
      .toBeGreaterThanOrEqual(0);

    // Leaving the empty composer folds it back into the pill.
    await page.locator('[data-hc-chat-view] h2').first().click();
    await expect(dock).toHaveAttribute('data-composer-dock', 'pill');
  });
});

test.describe('tablet composer', () => {
  // iPad in landscape: touch-only, wide, typing on a hardware keyboard.
  test.use({
    viewport: { width: 1180, height: 820 },
    isMobile: true,
    hasTouch: true,
  });

  test('Enter sends on a hardware keyboard, not with the software keyboard up', async ({
    page,
  }) => {
    await openHarness(page);
    expect(
      await page.evaluate(
        () => matchMedia('(pointer: coarse) and (hover: none)').matches,
      ),
    ).toBe(true);
    await composer(page).fill('硬件键盘');
    await composer(page).press('Enter');
    await expect(composer(page)).toHaveText('');

    await simulateKeyboard(page, 360);
    await composer(page).fill('软键盘');
    await composer(page).press('Enter');
    await expect.poll(() => composerText(page)).toBe('软键盘\n');
    await composer(page).press('Meta+Enter');
    await expect(composer(page)).toHaveText('');
    expect((await harnessState(page)).sent).toEqual([
      { to: 'main', content: '硬件键盘', images: 0 },
      { to: 'main', content: '软键盘', images: 0 },
    ]);
  });

  test('an empty conversation keeps the composer docked above the keyboard', async ({
    page,
  }) => {
    await page.goto(`${HARNESS_PATH}?empty=1`);
    const root = page.locator('[data-hc-composer]');
    const card = page.locator('[data-composer-card]');
    const heading = page.getByRole('heading', { name: '今天想做什么？' });
    await expect(heading).toBeVisible();
    // Wide, but touch: no centring.
    await expect(root).toHaveAttribute('data-composer-layout', 'docked');
    const viewport = page.viewportSize()!;
    const docked = (await card.boundingBox())!;
    expect(viewport.height - (docked.y + docked.height)).toBeLessThan(40);
    expect(
      (await page.locator('[data-hc-starter]').last().boundingBox())!.y,
    ).toBeLessThan(docked.y);

    // The docked bar makes room for a software keyboard.
    await simulateKeyboard(page, 360);
    await expect
      .poll(async () => {
        const box = (await card.boundingBox())!;
        return viewport.height - (box.y + box.height);
      })
      .toBeGreaterThan(300);
  });
});
