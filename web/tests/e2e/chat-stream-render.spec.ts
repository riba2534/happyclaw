import { expect, test, type Page } from '@playwright/test';

// What the streaming card shows, through chat-render-harness: the step
// timeline and its classic fallback, reasoning as Markdown, the silent wait,
// a proactive workspace's process at each visibility, and the reasoning and
// trace the server kept of an earlier reply. Runs on the mobile project (the
// CI one); the desktop blocks pin the wide layout.

const HARNESS = '/tests/e2e/chat-render-harness.html';

type WordSeen = { inserted: number[]; fading: boolean[]; frames: number[] };

declare global {
  interface Window {
    renderHarness: {
      start: () => void;
      emit: (event: Record<string, unknown>) => void;
      finish: (content: string) => void;
    };
    /** The answer's word spans as `watchWords` saw them, by text. */
    __words: Record<string, WordSeen>;
    /** Each text the answer showed, and when (`recordAnswer`). */
    __answer: { at: number; text: string }[];
    /** Fading words of the first block when the second appeared. */
    __fadingWhenClosed: number[];
  }
}

async function open(page: Page, query: string) {
  await page.goto(`${HARNESS}?${query}`);
  await expect(page.locator('[data-hc-chat-view]')).toBeVisible();
}

const block = (page: Page) => page.locator('[data-hc-streaming-block]');

/**
 * Nothing of the chat leaves the viewport sideways: the page does not scroll
 * across, and no element sticks out unless its own scroller clips it (a code
 * block scrolls inside itself).
 */
async function expectNoSidewaysOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.hasAttribute('data-hc-streaming-block')) return false;
        if (getComputedStyle(p).overflowX !== 'visible') return true;
      }
      return false;
    };
    const wide = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-streaming-block] *, [data-hc-chat-view] [data-hc-process-panel] *',
      ),
    ].filter(
      (el) => el.getBoundingClientRect().right > width + 1 && !clipped(el),
    );
    return {
      page: document.documentElement.scrollWidth - width,
      wide: wide.map((el) => el.tagName + '.' + el.className).slice(0, 3),
    };
  });
  expect(overflow.wide).toEqual([]);
  expect(overflow.page).toBeLessThanOrEqual(0);
}

test.describe('the step timeline', () => {
  test('lists the steps in the order they happened, with the answer below', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming');
    const card = block(page).locator('[data-hc-process-card]');
    await expect(card).toHaveAttribute('data-mode', 'live');
    const timeline = block(page).getByRole('list', { name: '处理步骤' });
    await expect(timeline).toBeVisible();
    await expect(timeline).toHaveAttribute('data-hc-step-timeline', '');

    // The header says what the run is doing now: the reasoning being written.
    const header = card.getByRole('button', { name: /核对行高估算/ }).first();
    await expect(header).toHaveAttribute('aria-expanded', 'true');

    // The oldest steps fold into one line that says what they were.
    await expect(
      timeline.getByRole('button', { name: /较早 5 步 · 3 个工具/ }),
    ).toBeVisible();
    // The latest five are rows: commentary, running tool, the sub-agent and the
    // reasoning being written; the finished reasoning before them is folded.
    await expect(timeline.getByText('比较方案')).toHaveCount(0);
    await expect(
      timeline.getByText('我先把渲染循环换成虚拟列表，再跑测试。'),
    ).toBeVisible();
    await expect(
      timeline.getByText(/npx vitest run tests\/frontend-session-sidebar-copy/),
    ).toBeVisible();
    await expect(timeline.getByText('检查移动端滚动性能')).toBeVisible();
    // The reasoning being written is titled by the header, once: its row says
    // only that it is reasoning, and holds what it wrote.
    const writing = timeline.getByRole('button', { name: /^思考.*进行中/ });
    await expect(writing).toBeVisible();
    await expect(writing).not.toContainText('核对行高估算');
    await expect(
      timeline.locator('[data-hc-thinking-body]').getByText('核对行高估算'),
    ).toBeVisible();

    // The answer is the text under the steps' window, not one of them.
    const answer = block(page).getByText(
      /^正在把会话列表改成虚拟滚动。目前已经替换了/,
    );
    await expect(answer).toBeVisible();
    const [window, text] = await Promise.all([
      card.locator('[data-hc-process-window]').boundingBox(),
      answer.boundingBox(),
    ]);
    expect(text!.y).toBeGreaterThanOrEqual(window!.y + window!.height - 1);
    await expectNoSidewaysOverflow(page);
  });

  test('opens a folded line to the steps it holds', async ({ page }) => {
    await open(page, 'scenario=streaming');
    const timeline = block(page).getByRole('list', { name: '处理步骤' });
    const folded = timeline.getByRole('button', { name: /较早 5 步/ });
    await expect(folded).toHaveAttribute('aria-expanded', 'false');
    await expect(timeline.getByText('已浏览 1 个文件 · 搜索 1 次')).toHaveCount(
      0,
    );
    await folded.click();
    await expect(folded).toHaveAttribute('aria-expanded', 'true');
    // The two read-only calls among them are one row, which opens in its turn.
    const group = timeline.getByRole('button', {
      name: /已浏览 1 个文件 · 搜索 1 次/,
    });
    await expect(timeline.getByText('useVirtualizer in web/src')).toHaveCount(
      0,
    );
    await group.click();
    await expect(timeline.getByText('useVirtualizer in web/src')).toBeVisible();
    // A failed call says why, in its own row, and is open to its output.
    await expect(timeline.getByText('被权限策略拒绝').first()).toBeVisible();
    await expect(
      timeline.locator('pre', { hasText: '被权限策略拒绝' }),
    ).toBeVisible();
  });

  test('has touch-sized buttons and nothing that sticks out sideways', async ({
    page,
    hasTouch,
  }) => {
    await open(page, 'scenario=streaming');
    const card = block(page).locator('[data-hc-process-card]');
    const buttons = card.getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(3);
    for (let i = 0; i < count; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      // 40px is the touch target the coarse-pointer variants ask for.
      if (hasTouch) expect(box!.height).toBeGreaterThanOrEqual(39);
    }
    await expectNoSidewaysOverflow(page);
  });

  test('is the classic stack of cards when the reader chose that layout', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming&layout=classic');
    await expect(block(page).getByText('思考中…')).toBeVisible();
    await expect(page.locator('[data-hc-step-timeline]')).toHaveCount(0);
    await expect(
      block(page).getByRole('button', { name: /执行详情/ }),
    ).toBeVisible();
    await expect(block(page).getByText('检查移动端滚动性能')).toBeVisible();
    await expectNoSidewaysOverflow(page);
  });

  test('is shaped like the finished message once the run is over', async ({
    page,
  }) => {
    await open(page, 'scenario=settled');
    const card = page.locator('[data-hc-stream-card="settled"]');
    await expect(card).toBeVisible();
    // The process folds to one summary row; nothing spins.
    const summary = card.getByRole('button', { name: /^已工作 \d+s$/ });
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-hc-step-timeline]')).toHaveCount(0);
    await expect(card.locator('.animate-spin')).toHaveCount(0);
    await expect(card.getByText('正在把会话列表改成虚拟滚动。')).toBeVisible();
  });
});

test.describe('reasoning', () => {
  test('reads as Markdown: titles, lists and code', async ({ page }) => {
    await open(page, 'scenario=thinking-markdown');
    const body = block(page).locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    await expect(body.locator('strong')).toHaveCount(3);
    await expect(body.locator('li')).toHaveCount(2);
    await expect(body.locator('pre code')).toContainText('useChatStore');
    // The latest title is the card's headline too.
    await expect(
      block(page)
        .locator('[data-hc-process-card] > button')
        .filter({ hasText: '确认行高估算' }),
    ).toBeVisible();
    await expectNoSidewaysOverflow(page);
  });

  test('follows its own end while it arrives, until the reader scrolls up', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      window.renderHarness.start();
      window.renderHarness.emit({ eventType: 'thinking_start' });
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: Array.from(
          { length: 30 },
          (_, i) => `第 ${i} 段：逐条核对行高估算与实际高度的差异。`,
        ).join('\n\n'),
      });
    });
    const body = page.locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    const state = () =>
      body.evaluate((el) => ({
        top: el.scrollTop,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        scrollable: el.scrollHeight > el.clientHeight,
      }));
    await expect.poll(async () => (await state()).scrollable).toBe(true);
    await expect.poll(async () => (await state()).gap).toBeLessThan(4);

    // More text keeps the end in view...
    await page.evaluate(() =>
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: '\n\n又想到一点：补充一条回归测试。',
      }),
    );
    await expect(body).toContainText('补充一条回归测试');
    await expect.poll(async () => (await state()).gap).toBeLessThan(4);

    // ...but not once the reader went back to re-read.
    await body.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(150);
    await page.evaluate(() =>
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: '\n\n最后再确认一次边界。',
      }),
    );
    await expect(body).toContainText('最后再确认一次边界');
    expect((await state()).top).toBeLessThan(8);
  });

  test('scrolls in its own area with a mouse; folds on a phone, all of it a tap away', async ({
    page,
    isMobile,
  }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      window.renderHarness.start();
      window.renderHarness.emit({ eventType: 'thinking_start' });
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: Array.from({ length: 30 }, (_, i) => `第 ${i} 段。`).join('\n\n'),
      });
    });
    const body = page.locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    if (!isMobile) {
      await expect(body).toHaveCSS('overscroll-behavior-y', 'contain');
      await expect(body).toHaveCSS('overflow-y', 'auto');
      await expect(page.getByRole('button', { name: '查看全部' })).toHaveCount(
        0,
      );
      return;
    }
    // No box in a box on a phone: a finger on it scrolls the chat.
    await expect(body).toHaveCSS('overflow-y', 'hidden');
    await expect(body).toHaveCSS('overscroll-behavior-y', 'auto');
    await expect(body).toHaveAttribute('data-hc-clamped', 'cut');
    const viewAll = page.getByRole('button', { name: '查看全部' });
    expect((await viewAll.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await viewAll.tap();
    const sheet = page.getByRole('dialog', { name: '思考' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('第 0 段。');
    await expect(sheet).toContainText('第 29 段。');
  });
});

test.describe('the wait for the model', () => {
  test('says the model is thinking, with a placeholder and a timer', async ({
    page,
  }) => {
    await open(page, 'scenario=silent');
    const wait = page.locator('[data-hc-model-wait]');
    await expect(wait).toBeVisible();
    await expect(wait).toContainText('正在思考…');
    await expect(wait).toContainText(/\d+s/);
    // Decorative lines are hidden from assistive tech.
    await expect(wait.locator('[aria-hidden="true"]').first()).toBeAttached();
    // "Processing" is for a proactive workspace; an assistant is thinking.
    await expect(block(page).getByText('正在处理')).toHaveCount(0);
    await expectNoSidewaysOverflow(page);
  });
});

test.describe('a proactive workspace', () => {
  const secrets = [
    '这段是还没发出去的回复草稿',
    '用户希望保持排序',
    '确认订阅范围',
    '核对行高估算',
    // A sub-agent's text is never shown, its reasoning only at the full level.
    '正在用 Playwright 录制',
    '子 Agent 的思考',
  ];

  async function expectNoModelText(page: Page, except: string[] = []) {
    const text = await block(page).innerText();
    for (const secret of secrets.filter((s) => !except.includes(s))) {
      expect(text, `shows "${secret}"`).not.toContain(secret);
    }
  }

  test('hidden: only that it is working, and a way to change that', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=hidden');
    const bar = page.locator('[data-hc-run-status-bar]');
    await expect(bar.locator('[data-hc-run-phase]')).toHaveText('处理中');
    await expect(bar.getByRole('button', { name: '显示过程' })).toBeVisible();
    await expect(bar).not.toContainText(/运行命令|搜索|Bash/);
    await expect(page.locator('[data-hc-process-panel]')).toHaveCount(0);
    const text = await block(page).innerText();
    for (const word of ['Bash', 'Grep', 'vitest', '检查移动端滚动性能']) {
      expect(text).not.toContain(word);
    }
    await expectNoModelText(page);
  });

  test('activity: the process line and its steps, open while it runs; never the model text', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=activity');
    const panel = page.locator('[data-hc-process-panel]');
    const toggle = panel.getByRole('button', { name: /处理过程/ });
    // Asked to be watched: the steps are there without opening anything.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toContainText('正在运行命令');
    await expect(toggle).toContainText('1 个子 Agent 运行中');
    await expect(toggle).toContainText(/\d+s/);
    await expectNoModelText(page);

    // It folds to its one line, and opens again.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByRole('list', { name: '处理步骤' })).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = panel.getByRole('list', { name: '处理步骤' });
    await expect(
      steps.getByText(/npx vitest run tests\/frontend-session-sidebar-copy/),
    ).toBeVisible();
    await expect(steps.getByText('检查移动端滚动性能')).toBeVisible();
    // With none of its text to show, the sub-agent is a row, not a card to open.
    await expect(
      steps.getByRole('button', { name: /检查移动端滚动性能/ }),
    ).toHaveCount(0);
    // The model reasoned for 6.4 seconds; what it wrote stays out of view.
    await expect(steps.getByText('6.4s')).toBeVisible();
    await expect(steps.getByText('确认订阅范围')).toHaveCount(0);
    await expect(panel.getByText('计划')).toBeVisible();
    await expectNoModelText(page);
    await expectNoSidewaysOverflow(page);
  });

  test('full: adds the reasoning summary, still not the reply text', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=full');
    const panel = page.locator('[data-hc-process-panel]');
    const steps = panel.getByRole('list', { name: '处理步骤' });
    const reasoning = steps.getByRole('button', { name: /确认订阅范围/ });
    await expect(reasoning).toContainText('6.4s');
    await reasoning.click();
    await expect(
      steps
        .locator('[data-hc-thinking-body]')
        .filter({ hasText: '用户希望保持排序' }),
    ).toBeVisible();
    // A sub-agent's reasoning comes with it, in a row that opens; its text
    // never does.
    const agent = steps.getByRole('button', { name: /检查移动端滚动性能/ });
    await expect(agent).toBeVisible();
    await expect(steps.getByText('子 Agent 的思考')).toHaveCount(0);
    await agent.click();
    await expect(steps.getByText('子 Agent 的思考')).toBeVisible();
    await expectNoModelText(page, [
      '确认订阅范围',
      '用户希望保持排序',
      '子 Agent 的思考',
    ]);
    await expectNoSidewaysOverflow(page);
  });

  const PROGRESS = '收到，我先跑一遍侧栏的测试，再看滚动帧率，大概要一两分钟。';

  for (const visibility of ['hidden', 'activity', 'full'] as const) {
    test(`${visibility}: the progress the Agent sent, in the panel and the status bar`, async ({
      page,
    }) => {
      await open(
        page,
        `scenario=proactive&visibility=${visibility}&progress=1`,
      );
      const panel = page.locator('[data-hc-process-panel]');
      const steps = panel.getByRole('list', { name: '处理步骤' });
      await expect(steps.getByText(PROGRESS)).toBeVisible();
      const bar = page.locator('[data-hc-run-status-bar]');
      await expect(bar.locator('[data-hc-run-progress]')).toHaveText(PROGRESS);
      await expect(bar.locator('[data-hc-run-phase]')).toHaveText(
        visibility === 'hidden' ? '处理中' : '运行命令',
      );
      if (visibility === 'hidden') {
        // Nothing else of the process: no tool, no plan, no phase of the work.
        const toggle = panel.getByRole('button', { name: /处理过程/ });
        await expect(toggle).toContainText('正在处理');
        await expect(toggle).not.toContainText(/运行命令|子 Agent|最近/);
        const text = await panel.innerText();
        for (const word of [
          'Bash',
          'Grep',
          'vitest',
          '检查移动端滚动性能',
          '计划',
        ]) {
          expect(text).not.toContain(word);
        }
      }
      // The reasoning title is `full`'s to show.
      await expectNoModelText(
        page,
        visibility === 'full' ? ['确认订阅范围'] : [],
      );
      await expectNoSidewaysOverflow(page);
    });
  }

  test('"显示过程" opens the reply-mode settings with the visibility levels', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=hidden');
    await page
      .locator('[data-hc-run-status-bar]')
      .getByRole('button', { name: '显示过程' })
      .click();
    const dialog = page.getByRole('dialog', { name: '工作区设置' });
    await expect(dialog).toBeVisible();
    const levels = dialog.getByRole('group', { name: '过程可见性' });
    await expect(levels.getByRole('radio')).toHaveCount(3);
    await expect(levels.getByRole('radio', { name: /隐藏/ })).toBeChecked();
    await expect(
      dialog.getByText('只影响 Web', { exact: false }),
    ).toBeVisible();
  });
});

test.describe('a finished reply that has its steps', () => {
  test('is one summary row that opens to the steps, and the older reply keeps its rows', async ({
    page,
  }) => {
    await open(page, 'scenario=history&steps=1');
    // A reply with no steps keeps the reasoning row it has.
    await expect(
      page.locator('[data-message-id="m8"]').getByText('已思考 3.4 秒'),
    ).toBeVisible();

    const reply = page.locator('[data-message-id="m4"]');
    await reply.scrollIntoViewIfNeeded();
    const card = reply.locator('[data-hc-process-card]');
    await expect(card).toHaveAttribute('data-mode', 'settled');
    const summary = card.getByRole('button', { name: /^已工作 \d+s$/ });
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    // The two rows the card replaces are not there; the steps stay folded.
    await expect(reply.getByRole('button', { name: /已思考/ })).toHaveCount(0);
    await expect(reply.getByRole('button', { name: /执行详情/ })).toHaveCount(
      0,
    );
    await expect(reply.getByRole('list', { name: '处理步骤' })).toHaveCount(0);

    await summary.click();
    const steps = reply.getByRole('list', { name: '处理步骤' });
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    // A finished run lists all its rows: none folds away at this length.
    await expect(steps.getByText(/较早/)).toHaveCount(0);
    await expect(
      steps.getByRole('button', { name: /确认订阅范围.*5\.8s/ }),
    ).toBeVisible();
    await expect(
      steps.getByRole('button', { name: /已浏览 1 个文件 · 搜索 1 次/ }),
    ).toBeVisible();
    await expect(
      steps.getByRole('button', { name: /比较方案.*7\.0s/ }),
    ).toBeVisible();
    await expect(
      steps.getByText(/npx vitest run tests\/frontend/),
    ).toBeVisible();
    await expect(steps.getByText('检查移动端滚动性能')).toBeVisible();
    await expectNoSidewaysOverflow(page);
  });

  test('has a summary row the touch target asks for, as high as the streaming card keeps', async ({
    page,
    hasTouch,
  }) => {
    await open(page, 'scenario=history&steps=1');
    const summary = page
      .locator('[data-message-id="m4"] [data-hc-process-card] > button')
      .first();
    await summary.scrollIntoViewIfNeeded();
    const final = (await summary.boundingBox())!;
    // The touch target applies to coarse pointers only.
    if (hasTouch) expect(final.height).toBeGreaterThanOrEqual(39);

    await open(page, 'scenario=settled');
    const frozen = (await page
      .locator(
        '[data-hc-stream-card="settled"] [data-hc-process-card] > button',
      )
      .boundingBox())!;
    expect(Math.abs(frozen.height - final.height)).toBeLessThan(1);
  });

  test('opens and folds in the virtual list without moving the reader or overlapping a neighbour', async ({
    page,
  }) => {
    await open(page, 'scenario=history&steps=1');
    // Let the list measure its rows before the reader is placed in it.
    await page.waitForTimeout(800);
    const reply = page.locator('[data-message-id="m4"]');
    await reply.scrollIntoViewIfNeeded();
    const summary = reply.locator('[data-hc-process-card] > button');
    await expect(summary).toBeVisible();
    // The row itself in view, so pressing it does not scroll the list.
    await summary.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    const layout = () =>
      page.evaluate(() => {
        const scroller = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-hc-chat-view] .overflow-y-auto',
          ),
        ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[data-message-id]'),
        ]
          .map((el) => el.getBoundingClientRect())
          .sort((a, b) => a.top - b.top);
        return {
          scrollTop: scroller.scrollTop,
          // How far a row reaches into the one below it (0 or less is none).
          overlap: Math.max(
            ...rows.slice(1).map((rect, i) => rows[i].bottom - rect.top),
          ),
        };
      });
    const rowTop = async () => (await summary.boundingBox())!.y;

    const closedTop = await rowTop();
    const closed = await layout();
    expect(closed.overlap).toBeLessThanOrEqual(1);

    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(400);
    // The row stays where the reader pressed it; the card unfolds below it.
    expect(Math.abs((await rowTop()) - closedTop)).toBeLessThan(2);
    const opened = await layout();
    expect(opened.scrollTop).toBe(closed.scrollTop);
    expect(opened.overlap).toBeLessThanOrEqual(1);

    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(400);
    expect(Math.abs((await rowTop()) - closedTop)).toBeLessThan(2);
    const folded = await layout();
    expect(folded.scrollTop).toBe(closed.scrollTop);
    expect(folded.overlap).toBeLessThanOrEqual(1);
  });

  test('is the older two rows in the classic layout', async ({ page }) => {
    await open(page, 'scenario=history&steps=1&layout=classic');
    const reply = page.locator('[data-message-id="m4"]');
    await reply.scrollIntoViewIfNeeded();
    await expect(
      reply.getByRole('button', { name: /已思考 12 秒/ }),
    ).toBeVisible();
    await expect(reply.getByRole('button', { name: /执行详情/ })).toBeVisible();
    await expect(reply.locator('[data-hc-process-card]')).toHaveCount(0);
  });
});

test.describe('the reasoning and trace the server kept', () => {
  const TURN = {
    turn_id: 'turn-kept',
    thinking: '**确认范围**\n\n先看订阅层级，再比较方案。',
    thinking_duration_ms: 6_400,
    trace: [
      {
        id: 'k1',
        timestamp: 1,
        kind: 'tool',
        title: '工具 Grep',
        summary: 'useChatStore in web/src',
        toolUseId: 'kt1',
      },
    ],
    steps: [],
    steps_dropped: 0,
    created_at: '2026-10-10T00:00:00.000Z',
  };
  /** The same turn as a server that keeps the ordered steps sends it. */
  const TURN_WITH_STEPS = {
    ...TURN,
    steps: [
      {
        id: 'thinking-0',
        kind: 'thinking',
        at: 1_000_000,
        endedAt: 1_006_400,
        status: 'done',
        durationMs: 6_400,
        title: '确认范围',
        text: '**确认范围**\n\n先看订阅层级，再比较方案。',
      },
      {
        id: 'tool-kt1',
        kind: 'tool',
        at: 1_006_400,
        endedAt: 1_007_400,
        status: 'done',
        toolUseId: 'kt1',
        toolName: 'Grep',
        summary: 'useChatStore in web/src',
      },
    ],
  };

  const route = (page: Page, handler: Parameters<Page['route']>[1]) =>
    page.route('**/api/groups/*/turn-traces/*', handler);

  test('is one collapsed row that loads the settled card, open on the steps', async ({
    page,
    hasTouch,
  }) => {
    const requests: string[] = [];
    await route(page, (r) => {
      requests.push(new URL(r.request().url()).pathname);
      return r.fulfill({ json: TURN_WITH_STEPS });
    });
    await open(page, 'scenario=lazy-trace');
    const row = page.getByRole('button', { name: '处理过程' });
    await expect(row).toBeVisible();
    await expect(page.getByRole('button', { name: '思考过程' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '执行详情' })).toHaveCount(0);
    // Nothing is asked for until the row is opened.
    expect(requests).toEqual([]);
    const rowBox = (await row.boundingBox())!;
    if (hasTouch) expect(rowBox.height).toBeGreaterThanOrEqual(39);

    await row.click();
    const card = page.locator('[data-hc-process-card]');
    await expect(card).toHaveAttribute('data-mode', 'settled');
    // The card's summary row is the row that was pressed: same size, same place
    // across, so nothing shifts but what unfolds below it.
    const summaryBox = (await card.locator('> button').boundingBox())!;
    expect(summaryBox.height).toBeCloseTo(rowBox.height, 0);
    expect(summaryBox.width).toBeCloseTo(rowBox.width, 0);
    expect(summaryBox.x).toBeCloseTo(rowBox.x, 0);
    await expect(
      card.getByRole('button', { name: /^已工作 \d+s$/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    const steps = card.getByRole('list', { name: '处理步骤' });
    await expect(steps.getByText('useChatStore in web/src')).toBeVisible();
    await expect(
      steps.getByRole('button', { name: /确认范围.*6\.4s/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '处理过程' })).toHaveCount(0);
    expect(requests).toEqual([
      '/api/groups/web%3Arender-harness%23agent%3Arender-session/turn-traces/turn-kept',
    ]);
    // The reply itself did not move out from under the reader.
    await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
  });

  test('is the older two rows once an older turn is loaded, the reasoning open', async ({
    page,
  }) => {
    await route(page, (r) => r.fulfill({ json: TURN }));
    await open(page, 'scenario=lazy-trace');
    await page.getByRole('button', { name: '处理过程' }).click();
    await expect(
      page.getByRole('button', { name: /已思考 6.4 秒/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page.getByRole('button', { name: /执行详情.*已使用 1 个工具/ }),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-hc-process-card]')).toHaveCount(0);
    await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
  });

  test('shows two collapsed rows in the classic layout, loaded when one is opened', async ({
    page,
  }) => {
    const requests: string[] = [];
    await route(page, (r) => {
      requests.push(new URL(r.request().url()).pathname);
      return r.fulfill({ json: TURN });
    });
    await open(page, 'scenario=lazy-trace&layout=classic');
    const thinking = page.getByRole('button', { name: '思考过程' });
    const trace = page.getByRole('button', { name: '执行详情' });
    await expect(thinking).toBeVisible();
    await expect(trace).toBeVisible();
    await expect(page.getByRole('button', { name: '处理过程' })).toHaveCount(0);
    // Nothing is asked for until a row is opened.
    expect(requests).toEqual([]);

    await trace.click();
    await expect(
      page.getByRole('button', { name: /已思考 6.4 秒/ }),
    ).toBeVisible();
    // The row that was pressed is the block that opened.
    const loaded = page.getByRole('button', {
      name: /执行详情.*已使用 1 个工具/,
    });
    await expect(loaded).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('useChatStore in web/src')).toBeVisible();
    expect(requests).toEqual([
      '/api/groups/web%3Arender-harness%23agent%3Arender-session/turn-traces/turn-kept',
    ]);
    // The reply itself did not move out from under the reader.
    await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
  });

  test('asks again after a failure, and drops the row when the server has nothing', async ({
    page,
  }) => {
    let calls = 0;
    await route(page, (r) => {
      calls += 1;
      if (calls === 1) return r.fulfill({ status: 500, json: { error: 'x' } });
      if (calls === 2) return r.fulfill({ status: 404, json: { error: 'x' } });
      return r.fulfill({ json: TURN_WITH_STEPS });
    });
    await open(page, 'scenario=lazy-trace');
    await page.getByRole('button', { name: '处理过程' }).click();
    await expect(page.getByText('暂时无法加载，点击重试')).toBeVisible();
    // The page shows no error toast for it.
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    await page.getByRole('button', { name: '处理过程' }).click();
    await expect(page.getByRole('button', { name: '处理过程' })).toHaveCount(0);
    await expect(page.locator('[data-hc-process-card]')).toHaveCount(0);
    await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
    expect(calls).toBe(2);
  });

  test('a proactive turn does not count its speech tool among the tools used', async ({
    page,
  }) => {
    const SAY = 'mcp__happyclaw__send_message';
    await route(page, (r) =>
      r.fulfill({
        json: {
          ...TURN_WITH_STEPS,
          thinking: '',
          trace: [
            ...TURN.trace,
            {
              id: 's1',
              timestamp: 2,
              kind: 'tool',
              title: `工具 ${SAY}`,
              toolUseId: 'say-1',
            },
            {
              id: 's2',
              timestamp: 3,
              kind: 'tool',
              title: '工具结果',
              toolUseId: 'say-1',
            },
            {
              id: 's3',
              timestamp: 4,
              kind: 'tool',
              title: `工具完成 ${SAY}`,
              toolUseId: 'say-1',
            },
          ],
          // A stale server may still send the speech call as a step.
          steps: [
            ...TURN_WITH_STEPS.steps,
            {
              id: 'tool-say-1',
              kind: 'tool',
              at: 1_007_400,
              endedAt: 1_008_000,
              status: 'done',
              toolUseId: 'say-1',
              toolName: SAY,
              summary: '说点什么',
            },
          ],
        },
      }),
    );
    await open(page, 'scenario=lazy-trace&mode=proactive&visibility=activity');
    await page.getByRole('button', { name: '处理过程' }).click();
    const card = page.locator('[data-hc-process-card]');
    await expect(
      card.getByRole('button', { name: /^已工作 \d+s$/ }),
    ).toHaveAttribute('aria-expanded', 'true');
    // The speech tool is not among the tools it says it used.
    await expect(card.locator('[data-hc-work-counts]')).toHaveText(
      '1 个工具 · 1 段思考',
    );
    await expect(page.getByText('useChatStore in web/src')).toBeVisible();
    await expect(page.getByText(SAY)).toHaveCount(0);
    await expect(page.getByText('说点什么')).toHaveCount(0);
  });

  // At hidden the server flags only a turn that sent progress, so a flagged
  // reply offers its process at every level.
  for (const visibility of ['hidden', 'activity', 'full'] as const) {
    test(`a proactive reply at the ${visibility} level offers its process`, async ({
      page,
    }) => {
      await route(page, (r) => r.fulfill({ json: TURN_WITH_STEPS }));
      await open(
        page,
        `scenario=lazy-trace&mode=proactive&visibility=${visibility}`,
      );
      await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
      await expect(page.getByRole('button', { name: '处理过程' })).toHaveCount(
        1,
      );
      // The older rows are the classic layout's.
      await expect(page.getByRole('button', { name: '思考过程' })).toHaveCount(
        0,
      );
      await expect(page.getByRole('button', { name: '执行详情' })).toHaveCount(
        0,
      );
    });
  }

  for (const layout of ['timeline', 'classic'] as const) {
    test(`a proactive reply at the hidden level opens to the progress alone (${layout})`, async ({
      page,
    }) => {
      const progress = '先看订阅层级，稍后给结论。';
      await route(page, (r) =>
        r.fulfill({
          json: {
            ...TURN,
            thinking: '',
            thinking_duration_ms: null,
            trace: [],
            steps: [
              {
                id: 'note-p',
                kind: 'text',
                at: 1_000_000,
                endedAt: 1_000_000,
                status: 'done',
                commentary: true,
                progress: true,
                text: progress,
              },
            ],
          },
        }),
      );
      await open(
        page,
        `scenario=lazy-trace&layout=${layout}&mode=proactive&visibility=hidden`,
      );
      const row = page.getByRole('button', { name: '处理过程' });
      await expect(row).toHaveCount(1);
      await expect(page.getByRole('button', { name: '执行详情' })).toHaveCount(
        0,
      );
      await expect(page.getByText(progress)).toHaveCount(0);
      await row.click();
      const card = page.locator('[data-hc-process-card]');
      await expect(card.getByText(progress)).toBeVisible();
      await expect(card.locator('[data-hc-work-counts]')).toHaveText(
        '1 条进展',
      );
      await expect(page.getByText('useChatStore in web/src')).toHaveCount(0);
    });
  }

  for (const [visibility, reasoning, trace] of [
    ['activity', false, true],
    ['full', true, true],
  ] as const) {
    test(`a proactive reply in the classic layout at the ${visibility} level offers ${
      reasoning ? 'the trace and the reasoning' : 'the trace only'
    }`, async ({ page }) => {
      await route(page, (r) => r.fulfill({ json: TURN }));
      await open(
        page,
        `scenario=lazy-trace&layout=classic&mode=proactive&visibility=${visibility}`,
      );
      await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
      await expect(page.getByRole('button', { name: '思考过程' })).toHaveCount(
        reasoning ? 1 : 0,
      );
      await expect(page.getByRole('button', { name: '执行详情' })).toHaveCount(
        trace ? 1 : 0,
      );
    });
  }
});

test.describe('on a wide screen', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });

  test('the timeline sits in the message column and stays readable', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming');
    const timeline = block(page).getByRole('list', { name: '处理步骤' });
    await expect(timeline).toBeVisible();
    const [list, card] = await Promise.all([
      timeline.boundingBox(),
      block(page).boundingBox(),
    ]);
    expect(list!.x).toBeGreaterThanOrEqual(card!.x);
    expect(list!.x + list!.width).toBeLessThanOrEqual(
      card!.x + card!.width + 1,
    );
    // Rows are 28px tall with a mouse; the touch-sized variant does not apply.
    const folded = timeline.getByRole('button', { name: /较早 5 步/ });
    expect((await folded.boundingBox())!.height).toBeLessThan(32);
  });

  test('the speech tool of a proactive turn is not its latest tool or a step', async ({
    page,
  }) => {
    await open(page, 'scenario=live&mode=proactive&visibility=activity');
    await page.evaluate(() => {
      const { start, emit } = window.renderHarness;
      start();
      emit({ eventType: 'status', statusText: 'requesting' });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'b1',
        toolInputSummary: 'npm test',
      });
      emit({ eventType: 'tool_result', toolUseId: 'b1' });
      emit({ eventType: 'tool_use_end', toolUseId: 'b1' });
      emit({
        eventType: 'tool_use_start',
        toolName: 'mcp__happyclaw__send_message',
        toolUseId: 'say-1',
        toolInputSummary: '{"text":"已发送的回复"}',
      });
    });
    const panel = page.locator('[data-hc-process-panel]');
    const toggle = panel.getByRole('button', { name: /处理过程/ });
    await expect(toggle).toContainText('最近：运行 npm test');
    const steps = panel.getByRole('list', { name: '处理步骤' });
    await expect(steps.getByRole('listitem')).toHaveCount(1);

    // The rest of that call changes nothing.
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'tool_result', toolUseId: 'say-1' });
      emit({ eventType: 'tool_use_end', toolUseId: 'say-1' });
    });
    await page.waitForTimeout(150);
    await expect(steps.getByRole('listitem')).toHaveCount(1);
    await expect(toggle).toContainText('最近：运行 npm test');
    await expect(page.locator('[data-hc-streaming-block]')).not.toContainText(
      /send_message|已发送的回复/,
    );
  });

  test('full: the narration before a tool call is a step, and silent reasoning says it was silent', async ({
    page,
  }) => {
    await open(page, 'scenario=live&mode=proactive&visibility=full');
    await page.evaluate(() => {
      const { start, emit } = window.renderHarness;
      start();
      emit({ eventType: 'status', statusText: 'requesting' });
    });
    // The model reasons silently, then the whole block arrives at once.
    await page.waitForTimeout(1300);
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'thinking_start' });
      emit({ eventType: 'thinking_end', thinkingDurationMs: 2 });
      emit({ eventType: 'commentary', text: '先查一下记忆再回答。' });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Read',
        toolUseId: 'r1',
        toolInputSummary: 'memory.md',
      });
    });
    const panel = page.locator('[data-hc-process-panel]');
    const steps = panel.getByRole('list', { name: '处理步骤' });
    await expect(steps.getByText('先查一下记忆再回答。')).toBeVisible();
    await expect(steps.getByText('memory.md')).toBeVisible();
    await expect(steps.getByText(/^1\.\ds$/)).toBeVisible();
    await expect(steps.getByText('模型未返回思考内容')).toBeVisible();
    // Never the reply: nothing of it outside the process panel.
    await expect(page.locator('[data-hc-streaming-block]')).not.toContainText(
      /回复草稿/,
    );
    await expectNoSidewaysOverflow(page);
  });

  test('activity: the narration is not shown, and nothing claims the model was silent', async ({
    page,
  }) => {
    await open(page, 'scenario=live&mode=proactive&visibility=activity');
    await page.evaluate(() => {
      const { start, emit } = window.renderHarness;
      start();
      emit({ eventType: 'status', statusText: 'requesting' });
    });
    await page.waitForTimeout(1300);
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'thinking_start' });
      emit({ eventType: 'thinking_end', thinkingDurationMs: 2 });
      emit({ eventType: 'commentary', text: '先查一下记忆再回答。' });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Read',
        toolUseId: 'r1',
        toolInputSummary: 'memory.md',
      });
    });
    const steps = page
      .locator('[data-hc-process-panel]')
      .getByRole('list', { name: '处理步骤' });
    await expect(steps.getByText('memory.md')).toBeVisible();
    await expect(steps.getByText(/^1\.\ds$/)).toBeVisible();
    await expect(page.locator('[data-hc-streaming-block]')).not.toContainText(
      '先查一下记忆再回答。',
    );
    // The reasoning text is withheld at this level, not missing.
    await expect(page.locator('[data-hc-streaming-block]')).not.toContainText(
      '模型未返回思考内容',
    );
  });

  test('the process line of a proactive workspace names its latest tool', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=activity');
    const toggle = page
      .locator('[data-hc-process-panel]')
      .getByRole('button', { name: /处理过程/ });
    await expect(toggle).toContainText('最近：运行');
  });
});

test.describe('the streamed answer', () => {
  const ANSWER = '[data-hc-streaming-block] [data-markdown-root]';

  const emitText = (page: Page, text: string) =>
    page.evaluate(
      (delta) =>
        window.renderHarness.emit({ eventType: 'text_delta', text: delta }),
      text,
    );

  /** Record each text the answer shows, and when. */
  const recordAnswer = (page: Page) =>
    page.evaluate((answer) => {
      window.__answer = [];
      let last = '';
      new MutationObserver(() => {
        const text = document.querySelector(answer)?.textContent ?? '';
        if (text === last) return;
        last = text;
        window.__answer.push({ at: performance.now(), text });
      }).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }, ANSWER);

  /**
   * Watch each word span of the answer: its opacity when it entered the DOM,
   * whether it was fading then, and its opacity on every frame after.
   */
  async function watchWords(page: Page) {
    await page.evaluate((answer) => {
      const words: Record<string, WordSeen> = {};
      window.__words = words;
      const seen = (span: HTMLElement) =>
        (words[span.textContent!.trim()] ??= {
          inserted: [],
          fading: [],
          frames: [],
        });
      const selector = `${answer} span`;
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const spans = node.matches(selector)
              ? [node]
              : [...node.querySelectorAll<HTMLElement>('span')].filter((span) =>
                  span.matches(selector),
                );
            for (const span of spans) {
              const word = seen(span);
              word.inserted.push(Number(getComputedStyle(span).opacity));
              word.fading.push(span.getAnimations().length > 0);
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      const frame = () => {
        for (const span of document.querySelectorAll<HTMLElement>(selector)) {
          seen(span).frames.push(Number(getComputedStyle(span).opacity));
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, ANSWER);
  }

  const watched = (page: Page) => page.evaluate(() => window.__words);

  /**
   * Start the reply and let the page settle: mounting the live reply sets
   * the composer and highlighter up in a long task, which must not fall
   * between two renders a test times against a fade.
   */
  const startSettled = (page: Page) =>
    page.evaluate(() => {
      window.renderHarness.start();
      return new Promise<void>((resolve) =>
        requestIdleCallback(() => resolve(), { timeout: 2000 }),
      );
    });

  /**
   * Emit `text`, and `next` the moment the answer has a word span `shown`
   * accepts: from inside the page, so no round trip to the test runner
   * widens the gap while the words fade.
   */
  const emitThenOnShown = (
    page: Page,
    text: string,
    next: string,
    shown: string | null,
  ) =>
    page.evaluate(
      ({ answer, text, next, shown }) =>
        new Promise<void>((resolve) => {
          const observer = new MutationObserver(() => {
            const spans = document.querySelectorAll(`${answer} span`);
            const ready = [...spans].some(
              (span) => shown === null || span.textContent?.trim() === shown,
            );
            if (!ready) return;
            observer.disconnect();
            window.renderHarness.emit({ eventType: 'text_delta', text: next });
            resolve();
          });
          observer.observe(document.body, { childList: true, subtree: true });
          window.renderHarness.emit({ eventType: 'text_delta', text });
        }),
      { answer: ANSWER, text, next, shown },
    );

  /** A word never loses any opacity it showed: nothing fades in twice. */
  function expectNeverFadesAgain(frames: number[], word: string) {
    frames.forEach((opacity, i) => {
      if (i > 0) {
        expect(opacity, word).toBeGreaterThanOrEqual(frames[i - 1] - 0.01);
      }
    });
  }

  test('fades each new word in once, and a word shown never fades again', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await watchWords(page);
    await page.evaluate(() => window.renderHarness.start());
    for (const delta of [
      'Alpha bravo charlie. ',
      'Delta echo ',
      'foxtrot golf ',
      'hotel india.',
    ]) {
      await emitText(page, delta);
      await page.waitForTimeout(130);
    }
    const text = 'Alpha bravo charlie. Delta echo foxtrot golf hotel india.';
    const answer = block(page).getByText(text);
    await expect(answer).toBeVisible();
    await page.waitForTimeout(400);
    const words = await watched(page);
    for (const word of ['Alpha', 'charlie.', 'Delta', 'golf', 'india.']) {
      // It entered transparent and fading...
      expect(words[word].fading[0], word).toBe(true);
      expect(words[word].inserted[0], word).toBeLessThan(0.5);
      // ...became opaque, and never lost any of it through the renders
      // that followed.
      expect(words[word].frames.at(-1), word).toBe(1);
      expectNeverFadesAgain(words[word].frames, word);
    }
    // A copy of the words reads exactly as the text.
    const copied = await answer.evaluate((paragraph) => {
      getSelection()!.selectAllChildren(paragraph);
      return getSelection()!.toString();
    });
    expect(copied).toBe(text);
  });

  test('a block re-read mid-fade resumes its words instead of restarting them', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await watchWords(page);
    await startSettled(page);
    // The setext underline turns the paragraph into a heading (new elements),
    // sent as soon as the last word is in, while it fades.
    await emitThenOnShown(page, 'Heading words arrive', '\n===', 'arrive');
    await expect(block(page).locator('h1')).toHaveText('Heading words arrive');
    await page.waitForTimeout(400);
    const words = await watched(page);
    // The last word was still fading when the heading replaced it, and its
    // new element picked the fade up where it was.
    expect(words.arrive.fading).toEqual([true, true]);
    expect(words.arrive.inserted[1]).toBeGreaterThan(0.05);
    for (const word of ['Heading', 'words', 'arrive']) {
      expect(words[word].frames.at(-1), word).toBe(1);
      expectNeverFadesAgain(words[word].frames, word);
    }
  });

  test('a paragraph that closes mid-fade finishes fading in', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await watchWords(page);
    // Enough words that they are still fading when the next block opens, as
    // soon as they are in.
    const first =
      'One two three four five six seven eight nine ten eleven twelve.';
    await page.evaluate((answer) => {
      window.__fadingWhenClosed = [];
      new MutationObserver(() => {
        const roots = document.querySelectorAll(answer);
        if (roots.length === 2 && window.__fadingWhenClosed.length === 0) {
          window.__fadingWhenClosed.push(
            roots[0].querySelectorAll('.hc-stream-word').length,
          );
        }
      }).observe(document.body, { childList: true, subtree: true });
    }, ANSWER);
    await startSettled(page);
    await emitThenOnShown(page, first, '\n\nSecond one', null);
    // Once its words are in, the closed paragraph shows as final again.
    const closed = page.locator(ANSWER).first();
    await expect(page.locator(ANSWER)).toHaveCount(2);
    await expect(closed.locator('span')).toHaveCount(0);
    await expect(closed).toHaveText(first);
    // When the second block appeared, the first was still fading in...
    const [fading] = await page.evaluate(() => window.__fadingWhenClosed);
    expect(fading).toBeGreaterThan(0);
    // ...and none of its words (a burst fades in a few at a time) lost any
    // of what they showed on the way.
    const words = Object.entries(await watched(page)).filter(([word]) =>
      first.includes(word),
    );
    expect(words.length).toBeGreaterThan(5);
    for (const [word, { frames }] of words) {
      expectNeverFadesAgain(frames, word);
    }
  });

  test('a block after a paragraph break sent on its own fades in', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await watchWords(page);
    await page.evaluate(() => window.renderHarness.start());
    await emitText(page, 'Opening words');
    await expect(block(page).getByText('Opening words')).toBeVisible();
    // A render that ends in the blank lines of the break.
    await emitText(page, '\n\n');
    await page.waitForTimeout(150);
    await emitText(page, 'Following block');
    await expect(block(page).getByText('Following block')).toBeVisible();
    const words = await watched(page);
    for (const word of ['Following', 'block']) {
      expect(words[word].fading[0], word).toBe(true);
    }
  });

  test('does not fade when less motion is asked for', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'scenario=live');
    await page.evaluate(() => window.renderHarness.start());
    await emitText(page, '这是一段**普通**的回复，不带淡入。');
    await expect(block(page).getByText(/^这是一段普通的回复/)).toBeVisible();
    await expect(page.locator(`${ANSWER} span`)).toHaveCount(0);
  });

  test('never shows the asterisks or link syntax still being written', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    const reply =
      '这是**重点内容**，然后是~~删除线~~，参见[文档](https://example.com/doc)。';
    await recordAnswer(page);
    // One character every 30ms: renders land mid-syntax.
    await page.evaluate(async (text) => {
      window.renderHarness.start();
      for (const char of text) {
        window.renderHarness.emit({ eventType: 'text_delta', text: char });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }, reply);
    const answer = page.locator(ANSWER).first();
    await expect(answer.locator('strong')).toHaveText('重点内容');
    await expect(answer.locator('del')).toHaveText('删除线');
    await expect(answer.locator('a')).toHaveText('文档');
    const shown = (await page.evaluate(() => window.__answer)).map(
      ({ text }) => text,
    );
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.filter((text) => /\*\*|~~|\]\(|\(https/.test(text))).toEqual(
      [],
    );

    // The final message is the plain rendering, with no word spans left.
    await page.evaluate(
      (content) => window.renderHarness.finish(content),
      reply,
    );
    const final = page.locator('[data-message-id="live-final"]');
    await expect(final.locator('strong')).toHaveText('重点内容');
    await expect(final.locator('a')).toHaveAttribute(
      'href',
      'https://example.com/doc',
    );
    await expect(final.locator('[data-markdown-root] span')).toHaveCount(0);
  });

  test('renders less often while the reader types in the composer', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await recordAnswer(page);
    await page.evaluate(() => window.renderHarness.start());
    /** Median milliseconds between renders of the answer as text streams. */
    const cadence = async (typing: boolean) => {
      const [from, to] = await page.evaluate(async (typing) => {
        // The composer's Tiptap editor, as typing reaches it.
        const composer = (
          document.querySelector('[data-composer-editor]') as HTMLElement & {
            editor: { commands: { insertContent: (text: string) => void } };
          }
        ).editor;
        const from = performance.now();
        for (let i = 0; i < 60; i += 1) {
          window.renderHarness.emit({
            eventType: 'text_delta',
            text: `word${i} `,
          });
          if (typing) composer.commands.insertContent('a');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return [from, performance.now()];
      }, typing);
      const renders = (await page.evaluate(() => window.__answer))
        .map(({ at }) => at)
        .filter((at) => at >= from && at <= to);
      const gaps = renders
        .slice(1)
        .map((at, i) => at - renders[i])
        .sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)];
    };
    expect(await cadence(false)).toBeLessThan(180);
    expect(await cadence(true)).toBeGreaterThanOrEqual(240);
  });
});
