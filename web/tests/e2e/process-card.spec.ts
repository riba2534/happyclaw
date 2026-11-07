import { expect, test, type Page } from '@playwright/test';

// The process card of a streaming reply, through chat-render-harness: a
// headline over a window of steps that is limited in height and follows its
// end, and a settled card that folds to one summary row. Runs on the mobile
// project at 390px, where the preview is shortest; the desktop block pins
// the wide measures.

const HARNESS = '/tests/e2e/chat-render-harness.html';

declare global {
  interface Window {
    renderHarness: {
      start: () => void;
      emit: (event: Record<string, unknown>) => void;
      finish: (content: string) => void;
    };
  }
}

test.use({ viewport: { width: 390, height: 844 } });

/**
 * A tablet in landscape: touch, but not the phone layout, which has no window
 * in the chat (the 'on a phone' tests).
 */
const WIDE_TOUCH = { viewport: { width: 1100, height: 844 } };

const header = (page: Page) => page.locator('[data-hc-process-card] > button');
const win = (page: Page) => page.locator('[data-hc-process-window]');

async function open(page: Page, query: string) {
  await page.goto(`${HARNESS}?${query}`);
  await expect(page.locator('[data-hc-chat-view]')).toBeVisible();
}

/** Starts a run through the real reducer, with `count` commands done and one running. */
async function runCommands(page: Page, count: number, from = 0) {
  await page.evaluate(
    ([n, first]) => {
      const { start, emit } = window.renderHarness;
      if (first === 0) start();
      for (let i = first; i < first + n; i += 1) {
        if (i > 0) {
          emit({ eventType: 'tool_result', toolUseId: `c${i - 1}` });
          emit({ eventType: 'tool_use_end', toolUseId: `c${i - 1}` });
        }
        emit({
          eventType: 'tool_use_start',
          toolName: 'Bash',
          toolUseId: `c${i}`,
          toolInputSummary: `command: echo step-${i}`,
        });
      }
    },
    [count, from],
  );
}

/** `count` finished reads, with output, as the reducer takes them. */
async function readCalls(page: Page, count: number, from = 0) {
  await page.evaluate(
    ([n, first]) => {
      const { start, emit } = window.renderHarness;
      if (first === 0) start();
      for (let i = first; i < first + n; i += 1) {
        emit({
          eventType: 'tool_use_start',
          toolName: 'Read',
          toolUseId: `read${i}`,
          toolInputSummary: `{"file_path":"/repo/file-${i}.ts"}`,
        });
        emit({
          eventType: 'tool_result',
          toolUseId: `read${i}`,
          toolResult: `contents of file-${i}`,
        });
        emit({ eventType: 'tool_use_end', toolUseId: `read${i}` });
      }
    },
    [count, from],
  );
}

const scrollState = (page: Page) =>
  win(page).evaluate((el) => ({
    top: el.scrollTop,
    gap: el.scrollHeight - el.scrollTop - el.clientHeight,
    scrollable: el.scrollHeight > el.clientHeight,
    height: el.clientHeight,
  }));

async function expectNoSidewaysOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const card = document.querySelector('[data-hc-process-card]')!;
    const width = document.documentElement.clientWidth;
    const wide = [...card.querySelectorAll<HTMLElement>('*')].filter((el) => {
      if (el.getBoundingClientRect().right <= width + 1) return false;
      // A scroller of its own may hold more than it shows.
      for (let p = el.parentElement; p && p !== card; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return false;
      }
      return true;
    });
    const scroller = card.querySelector<HTMLElement>(
      '[data-hc-process-window]',
    );
    return {
      page: document.documentElement.scrollWidth - width,
      window: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
      wide: wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 3),
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.window).toBeLessThanOrEqual(0);
  expect(overflow.wide).toEqual([]);
}

test.describe('the live card', () => {
  test('its header is a whole row you can tap, 40px high, at either end', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 2);
    const row = header(page);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    const [box, card] = await Promise.all([
      row.boundingBox(),
      page.locator('[data-hc-process-card]').boundingBox(),
    ]);
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.width).toBeGreaterThanOrEqual(card!.width - 1);

    // Not only the chevron: the far left of the row folds it, the far right opens it.
    await page.touchscreen.tap(card!.x + 3, box!.y + box!.height / 2);
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(win(page)).toHaveCount(0);
    // The chat is anchored to its end: folding moved the row.
    const folded = await row.boundingBox();
    await page.touchscreen.tap(
      card!.x + card!.width - 3,
      folded!.y + folded!.height / 2,
    );
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(win(page)).toBeVisible();
  });

  test('says what the run is doing, and keeps up with it', async ({ page }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      const { start, emit } = window.renderHarness;
      start();
      emit({ eventType: 'status', statusText: 'requesting' });
    });
    await expect(header(page)).toContainText('正在思考…');
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'thinking_start' });
      emit({
        eventType: 'thinking_delta',
        text: '**核对行高估算**\n\n估算与实测不一致。',
      });
    });
    await expect(header(page)).toContainText('核对行高估算');
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'thinking_end', thinkingDurationMs: 1800 });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'b1',
        toolInputSummary: 'command: npx vitest run',
      });
    });
    await expect(header(page)).toContainText('运行命令 · npx vitest run');
    // The run's own time counts on the right.
    await expect(header(page)).toContainText(/\d+s/);
  });

  test.describe('on a wide touch screen', () => {
    test.use(WIDE_TOUCH);

    test('limits its window and follows the end, until the reader scrolls up', async ({
      page,
    }) => {
      await open(page, 'scenario=live');
      await runCommands(page, 14);
      await expect(win(page)).toBeVisible();
      await expect
        .poll(async () => (await scrollState(page)).scrollable)
        .toBe(true);
      // 240px with a mouse, and the end of the steps is in view.
      expect((await scrollState(page)).height).toBeLessThanOrEqual(241);
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeLessThan(4);
      await expect(win(page)).toHaveAttribute('data-scroll-fade', 'top');
      await expect(win(page).getByText('echo step-13')).toBeVisible();
      // The card does not push the answer away: it is as tall as header + window.
      const card = await page.locator('[data-hc-process-card]').boundingBox();
      expect(card!.height).toBeLessThan(220);

      // More steps keep the end in view...
      await runCommands(page, 1, 14);
      await expect(win(page).getByText('echo step-14')).toBeVisible();
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeLessThan(4);

      // ...until the reader has gone back to read.
      const box = (await win(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -2000);
      await expect(win(page)).not.toHaveAttribute('data-scroll-fade', 'top');
      await page.waitForTimeout(150);
      await runCommands(page, 1, 15);
      await expect(win(page).getByText('echo step-15')).toHaveCount(1);
      expect((await scrollState(page)).top).toBeLessThan(8);

      // Back at the end, it follows again.
      await page.mouse.wheel(0, 2000);
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeLessThan(4);
      await page.waitForTimeout(150);
      await runCommands(page, 1, 16);
      await expect(win(page).getByText('echo step-16')).toBeVisible();
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeLessThan(4);
    });
  });

  test('on a phone has no window of its own: its rows scroll with the chat', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 14);
    await expect(win(page).getByText('echo step-13')).toBeVisible();
    const state = await win(page).evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      overscroll: getComputedStyle(el).overscrollBehaviorY,
      scrollable: el.scrollHeight > el.clientHeight + 1,
    }));
    expect(state).toEqual({
      overflowY: 'visible',
      overscroll: 'auto',
      scrollable: false,
    });
    // The latest five and the fold above them, as on a desktop: bounded by
    // rows, not by a box.
    await expect(win(page).getByRole('listitem')).toHaveCount(6);
    const card = await page.locator('[data-hc-process-card]').boundingBox();
    expect(card!.height).toBeLessThan(360);
    await expectNoSidewaysOverflow(page);
  });

  test('on a phone, a row cut short opens to say all of it', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    // Under the 80 characters that open a row anyway, but past its width.
    const command =
      'cd /workspace/group/happyclaw && npx vitest run web/src/components/chat';
    await page.evaluate((summary) => {
      const { start, emit } = window.renderHarness;
      start();
      emit({
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'cut',
        toolInputSummary: `command: ${summary}`,
      });
      emit({ eventType: 'tool_use_end', toolUseId: 'cut' });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'short',
        toolInputSummary: 'command: ls',
      });
      emit({ eventType: 'tool_use_end', toolUseId: 'short' });
    }, command);
    const short = win(page)
      .getByRole('listitem')
      .filter({ hasText: /运行\s*ls/ });
    await expect(short).toBeVisible();
    // A row that shows all it has is no button.
    await expect(short.getByRole('button')).toHaveCount(0);
    const cut = win(page)
      .getByRole('listitem')
      .filter({ hasText: 'cd /workspace' });
    const row = cut.getByRole('button').first();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await row.tap();
    await expect(cut.locator('[data-hc-row-more]')).toHaveText(command);
  });

  test('opens a row to read it within one line down the left, and nothing sticks out', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      const { start, emit } = window.renderHarness;
      start();
      emit({ eventType: 'thinking_start' });
      emit({
        eventType: 'thinking_delta',
        text: '**比较两种做法**\n\n窄 selector 只订阅需要的字段，改动最小；拆分 store 更彻底，但要改动所有订阅方。\n\n```ts\nconst veryLongIdentifierName = useChatStore((s) => s.streaming[jid]?.partialText);\n```',
      });
      emit({ eventType: 'thinking_end', thinkingDurationMs: 2400 });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'long',
        toolInputSummary: `command: ${'/workspace/group/happyclaw/web/src/components/chat/'.repeat(4)}Card.tsx`,
      });
      emit({
        eventType: 'tool_result',
        toolUseId: 'long',
        toolResult: `⚠️ ${'没有权限读取这个文件，'.repeat(12)}`,
      });
      emit({ eventType: 'tool_use_end', toolUseId: 'long' });
    });
    const rows = win(page).getByRole('listitem');
    await rows.filter({ hasText: '比较两种做法' }).getByRole('button').click();
    const body = page.locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    await expect(body.locator('strong')).toHaveText('比较两种做法');
    await expect(body).toHaveCSS('border-left-width', '0px');

    // The failed command is open already, and wraps in its place.
    await expect(
      rows.filter({ hasText: '运行' }).getByRole('button'),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      rows
        .filter({ hasText: '运行' })
        .getByText(/没有权限读取这个文件/)
        .last(),
    ).toBeVisible();

    // One line, down the left of the window, and no other.
    const lines = await page.evaluate(
      () =>
        [
          ...document.querySelectorAll<HTMLElement>('[data-hc-process-card] *'),
        ].filter((el) => {
          const style = getComputedStyle(el);
          // A rule down the left only (a code block is boxed all round).
          return (
            parseFloat(style.borderLeftWidth) > 0 &&
            parseFloat(style.borderTopWidth) === 0
          );
        }).length,
    );
    expect(lines).toBe(1);
    await expectNoSidewaysOverflow(page);
  });

  test('keeps a long label, or a long headline, within its row', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming');
    // A sub-agent can be given a task of any length to name itself by.
    const long = '检查移动端滚动性能并对比三种虚拟列表实现的帧率差异'.repeat(4);
    const edges = await page.evaluate((text) => {
      const right = (el: Element) => el.getBoundingClientRect().right;
      const timeOf = (row: Element) =>
        [...row.querySelectorAll('span')].find((span) =>
          /^\d+(\.\d)?s$/.test(span.textContent ?? ''),
        )!;
      const agent = [
        ...document.querySelectorAll('[data-hc-step-timeline] button'),
      ].find((row) => row.textContent?.includes('检查移动端滚动性能'))!;
      agent.querySelector('span.font-medium')!.textContent = text;
      const head = document.querySelector('[data-hc-process-card] > button')!;
      head.querySelector('span.truncate')!.textContent = text;
      return {
        window: right(document.querySelector('[data-hc-process-window]')!),
        agentTime: right(timeOf(agent)),
        card: right(document.querySelector('[data-hc-process-card]')!),
        headTime: right(timeOf(head)),
      };
    }, long);
    // The time stays in its row, however long the words before it.
    expect(edges.agentTime).toBeLessThanOrEqual(edges.window + 1);
    expect(edges.headTime).toBeLessThanOrEqual(edges.card + 1);
    await expectNoSidewaysOverflow(page);
  });

  test('keeps a group the reader opened as more reads join it past the window', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await readCalls(page, 6);
    const group = win(page).getByRole('button', { name: /已浏览 6 个文件/ });
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(win(page).getByText('file-0.ts')).toBeVisible();

    // The seventh and eighth: the first would have slid out of a six-row window.
    await readCalls(page, 2, 6);
    const grown = win(page).getByRole('button', { name: /已浏览 8 个文件/ });
    await expect(grown).toHaveAttribute('aria-expanded', 'true');
    await expect(win(page).getByText('file-0.ts')).toBeVisible();
    await expect(win(page).getByText('较早')).toHaveCount(0);
  });

  // A run that streams reasoning faster than the browser draws frames, with a
  // tool call now and then: the window's content is briefly shorter and then
  // longer again within a frame, the browser clamps the scroll position and
  // queues a scroll event for it, and that event reaches the card a frame
  // later, when the content has grown again. It is not the reader scrolling
  // away, and the window must go on following the end.
  for (const delay of [2, 4, 6, 12]) {
    test(`follows the end of a burst of reasoning, a delta every ${delay}ms with a tool call between`, async ({
      page,
    }) => {
      await open(page, 'scenario=live');
      const result = await page.evaluate(async (delayMs) => {
        const { start, emit } = window.renderHarness;
        start();
        emit({ eventType: 'thinking_delta', text: '先' });
        const gapOf = () => {
          const el = document.querySelector<HTMLElement>(
            '[data-hc-process-window]',
          )!;
          return el.scrollHeight - el.scrollTop - el.clientHeight;
        };
        let lostAt = -1;
        let behindSince = -1;
        for (let i = 0; i < 150; i += 1) {
          if (i % 10 === 0) {
            emit({
              eventType: 'tool_use_start',
              toolName: 'Bash',
              toolUseId: `c${i}`,
              toolInputSummary: `command: echo ${i}`,
            });
          }
          emit({
            eventType: 'thinking_delta',
            text: `第 ${i} 段推理内容，逐条核对。\n\n`,
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          // A frame behind is the cost of drawing it; out of reach for a tenth
          // of a second is lost.
          if (i > 20 && gapOf() > 40) {
            if (behindSince < 0) behindSince = performance.now();
            if (performance.now() - behindSince > 100 && lostAt < 0) lostAt = i;
          } else {
            behindSince = -1;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { lostAt, endGap: Math.round(gapOf()) };
      }, delay);
      expect(result.lostAt).toBe(-1);
      expect(result.endGap).toBeLessThan(4);
    });
  }

  test.describe('on a wide touch screen', () => {
    test.use(WIDE_TOUCH);

    test('lets a reader who scrolls up with the wheel read, and takes the end again when they come back', async ({
      page,
    }) => {
      await open(page, 'scenario=live');
      await runCommands(page, 14);
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeLessThan(4);

      // Up with the wheel: not pulled back by what comes next.
      const box = (await win(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -200);
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeGreaterThan(60);
      await runCommands(page, 1, 15);
      await page.waitForTimeout(300);
      expect((await scrollState(page)).gap).toBeGreaterThan(60);

      // Back down to the end with the wheel: following again.
      await page.mouse.wheel(0, 600);
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeLessThan(4);
      await runCommands(page, 1, 16);
      await expect
        .poll(async () => (await scrollState(page)).gap)
        .toBeLessThan(4);
    });
  });

  test('keeps the output a reader opened, and their focus, when the next read makes it a group', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await readCalls(page, 1);
    const row = win(page)
      .getByRole('listitem')
      .filter({ hasText: 'file-0.ts' })
      .getByRole('button');
    await row.click();
    await expect(win(page).locator('pre')).toHaveText('contents of file-0');
    await expect(row).toBeFocused();

    await readCalls(page, 1, 1);
    const group = win(page).getByRole('button', { name: /已浏览 2 个文件/ });
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(win(page).locator('pre')).toHaveText('contents of file-0');
    // The row was rebuilt as a member of the group: focus went with it.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (
            !!el?.closest('[data-hc-step-timeline]') &&
            (el.textContent ?? '').includes('file-0.ts')
          );
        }),
      )
      .toBe(true);
  });

  test('stays as the reader left it while the run goes on', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 3);
    await header(page).click();
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
    await runCommands(page, 2, 3);
    await expect(header(page)).toContainText('echo step-4');
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(win(page)).toHaveCount(0);
  });
});

test.describe('the settled card', () => {
  test('is one summary row that opens to the steps in a window of at most 60vh', async ({
    page,
  }) => {
    await open(page, 'scenario=settled');
    const card = page.locator('[data-hc-stream-card="settled"]');
    const summary = card.locator('[data-hc-process-card] > button');
    // How long it worked, and that a call of the run failed; what it used is
    // inside.
    await expect(summary).toHaveText(/^已工作 \d+s · \d+ 个工具 · 1 个失败$/);
    await expect(summary.locator('[data-hc-work-problems]')).toHaveClass(
      /text-error/,
    );
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await expect(win(page)).toHaveCount(0);
    await expect(card.locator('.animate-spin, .shimmer')).toHaveCount(0);

    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(win(page)).toBeVisible();
    // Opened, the counts under the line say what failed: the line does not.
    await expect(summary).toHaveText(/^已工作 \d+s$/);
    await expect(win(page).locator('[data-hc-work-counts]')).toContainText(
      '6 个工具',
    );
    const { height } = await scrollState(page);
    expect(height).toBeLessThanOrEqual(0.6 * 844 + 1);
    await expect(
      win(page).getByRole('list', { name: '处理步骤' }),
    ).toBeVisible();
    await expect(win(page).getByText('检查移动端滚动性能')).toBeVisible();
    await expectNoSidewaysOverflow(page);

    await summary.click();
    await expect(win(page)).toHaveCount(0);
  });
});

// The calls of the `facts` scenario report what they did and what they
// printed, as a Runner that reads the SDK's structured results sends them. The
// card is settled and folded to its summary: open it.
async function openFacts(page: Page, scenario = 'facts') {
  await open(page, `scenario=${scenario}`);
  const summary = page.locator(
    '[data-hc-stream-card="settled"] [data-hc-process-card] > button',
  );
  await summary.click();
  await expect(win(page)).toBeVisible();
  // A live card folds the older rows; a settled one lists them all.
  const older = win(page).getByRole('button', { name: /较早 \d+ 步/ });
  if (await older.count()) await older.click();
}

const rowOf = (page: Page, text: string | RegExp) =>
  win(page).getByRole('listitem').filter({ hasText: text }).last();

test.describe('tool rows that say what they did', () => {
  test('give the facts of a call after what it was given, coloured, within the row', async ({
    page,
  }) => {
    await openFacts(page);
    const edit = rowOf(page, '编辑');
    await expect(edit).toContainText('+12 −3');
    await expect(rowOf(page, '写入')).toContainText('新建 · +24');
    await expect(rowOf(page, 'HTTP 200')).toContainText('HTTP 200 · 14 KB');

    // Lines added are the success colour, removed the error colour, and the
    // rest of the row's second-hand words are neither.
    const colours = await edit.evaluate((row) => {
      const color = (el: Element) => getComputedStyle(el).color;
      const spans = [...row.querySelectorAll('span')];
      const find = (text: string) =>
        spans.find((span) => span.textContent === text)!;
      return {
        added: color(find('+12')),
        removed: color(find('−3')),
        facts: color(find('+12').parentElement!),
      };
    });
    expect(colours.added).not.toBe(colours.removed);
    expect(colours.added).not.toBe(colours.facts);
    expect(colours.removed).not.toBe(colours.facts);

    // Facts, then time, then the chevron's room: nothing past the window.
    const box = await edit.getByText('+12 −3').boundingBox();
    const time = await edit.getByText(/^\d+(\.\d)?s$/).boundingBox();
    const area = await win(page).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(time!.x + 1);
    expect(time!.x + time!.width).toBeLessThanOrEqual(area!.x + area!.width);
    await expectNoSidewaysOverflow(page);
  });

  test('open a failed call to its output without being asked, in a box of at most 160px', async ({
    page,
  }) => {
    await openFacts(page);
    const failed = rowOf(page, 'npm run build:web');
    const button = failed.getByRole('button').first();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // The exit code and the first line of the output are in the row.
    await expect(button).toContainText('退出码 1 · src/part0.ts(10,5)');
    const output = failed.locator('pre');
    await expect(output).toContainText('src/part13.ts(23,5)');
    // The box that clips it, on a phone.
    const box = failed.locator('[data-hc-clamped]:has(pre)');
    const metrics = await box.evaluate((el) => {
      const style = getComputedStyle(el);
      const text = getComputedStyle(el.querySelector('pre')!);
      return {
        height: el.clientHeight,
        scrollHeight: el.scrollHeight,
        overflowY: style.overflowY,
        whiteSpace: text.whiteSpace,
        mono: text.fontFamily.toLowerCase().includes('mono'),
      };
    });
    expect(metrics.height).toBeLessThanOrEqual(161);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
    // No box in a box on a phone: a finger on it scrolls the chat, and all
    // of the output is a tap away.
    expect(metrics.overflowY).toBe('hidden');
    expect(metrics.whiteSpace).toBe('pre-wrap');
    expect(metrics.mono).toBe(true);
    await expectNoSidewaysOverflow(page);

    const viewAll = failed.getByRole('button', { name: '查看全部' });
    expect((await viewAll.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await viewAll.tap();
    const sheet = page.getByRole('dialog', { name: /输出/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('pre')).toContainText('src/part0.ts(10,5)');
    await expect(sheet.locator('pre')).toContainText('src/part13.ts(23,5)');
    // The sheet's body is the one scroller: header and handle stay put.
    const body = sheet.locator('[data-slot="sheet-body"]');
    await expect(body).toHaveCSS('overflow-y', 'auto');
  });

  test('open a good call that printed something when it is tapped, 40px high', async ({
    page,
  }) => {
    await openFacts(page);
    const ok = rowOf(page, 'vitest');
    const button = ok.getByRole('button').first();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(ok.locator('pre')).toHaveCount(0);
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await button.tap();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(ok.locator('pre')).toContainText('26 passed (26)');
    await expectNoSidewaysOverflow(page);
    await button.tap();
    await expect(ok.locator('pre')).toHaveCount(0);
  });

  test('leave a call that printed nothing without output to open', async ({
    page,
  }) => {
    await openFacts(page);
    // A row cut short at this width opens to its own text (touch has no
    // tooltip), never to an output it does not have.
    for (const text of ['HTTP 200', '编辑']) {
      const row = rowOf(page, text);
      const button = row.getByRole('button');
      if ((await button.count()) > 0) {
        await button.first().tap();
        await expect(row.locator('[data-hc-row-more]')).toBeVisible();
      }
      await expect(row.locator('pre')).toHaveCount(0);
    }
  });

  test('keep the facts of the calls a merged row holds', async ({ page }) => {
    await openFacts(page);
    const group = rowOf(page, '已浏览 1 个文件 · 搜索 2 次');
    await group.getByRole('button').first().click();
    await expect(group).toContainText('120/430 行');
    await expect(group).toContainText('24 处匹配 · 8 个文件');
    await expect(group).toContainText('31 个文件');
    await expectNoSidewaysOverflow(page);
  });

  test('say what a sub-agent did when its card is gone, and what it costs while it runs', async ({
    page,
  }) => {
    await openFacts(page);
    const agent = rowOf(page, '检查移动端滚动性能');
    await expect(agent).toContainText(
      '读 3 · 搜 2 · 改 1 · 命令 4 · +12 −3 · 1.2 万 token · 21 秒',
    );
    // Cut short in a phone's row, the facts are a tap away, whole.
    await agent.getByRole('button').first().tap();
    await expect(agent.locator('[data-hc-row-more]')).toHaveText(
      '读 3 · 搜 2 · 改 1 · 命令 4 · +12 −3 · 1.2 万 token · 21 秒',
    );
    await expectNoSidewaysOverflow(page);

    await open(page, 'scenario=facts-live');
    const live = win(page)
      .getByRole('listitem')
      .filter({ hasText: '检查移动端滚动性能' })
      .last();
    await expect(live).toContainText('14 个工具 · 1.2 万 token · 21 秒');
    await expectNoSidewaysOverflow(page);
  });
});

test.describe('on a wide screen', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });

  test('the facts of a call are read whole, between the path and the time', async ({
    page,
  }) => {
    await openFacts(page);
    const edit = rowOf(page, '编辑');
    const facts = edit.getByText('+12 −3');
    const whole = await facts.evaluate(
      (el) => el.scrollWidth <= el.clientWidth,
    );
    expect(whole).toBe(true);
    const [path, fact, time] = await Promise.all([
      edit.getByText(/ProcessRows\.tsx/).boundingBox(),
      facts.boundingBox(),
      edit.getByText(/^\d+(\.\d)?s$/).boundingBox(),
    ]);
    expect(path!.x).toBeLessThan(fact!.x);
    expect(fact!.x + fact!.width).toBeLessThanOrEqual(time!.x + 1);
    expect((await edit.boundingBox())!.height).toBeLessThan(32);
  });

  test('the window is taller, and the rows are compact', async ({ page }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 9);
    // Rows are 28px with a mouse: it takes reasoning being written to fill 240.
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'tool_result', toolUseId: 'c8' });
      emit({ eventType: 'tool_use_end', toolUseId: 'c8' });
      emit({ eventType: 'thinking_start' });
      emit({
        eventType: 'thinking_delta',
        text: Array.from(
          { length: 20 },
          (_, i) => `第 ${i} 段：逐条核对行高估算与实际高度的差异。`,
        ).join('\n\n'),
      });
    });
    await expect
      .poll(async () => (await scrollState(page)).scrollable)
      .toBe(true);
    const { height, gap } = await scrollState(page);
    expect(height).toBeGreaterThan(200);
    expect(height).toBeLessThanOrEqual(241);
    expect(gap).toBeLessThan(4);
    const row = await win(page)
      .getByRole('listitem')
      .filter({ hasText: 'echo step-' })
      .last()
      .boundingBox();
    expect(row!.height).toBeLessThan(32);
    expect((await header(page).boundingBox())!.height).toBeLessThan(36);
  });
});
