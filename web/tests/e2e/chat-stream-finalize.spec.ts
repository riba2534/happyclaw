import { expect, test, type Page } from '@playwright/test';

// Streaming lifecycle through the app's real WebSocket subscriptions and run
// lifecycle (chat-scroll-harness): the finish swap, reconnect snapshots,
// switching workspaces mid-stream, and tool status.

const HARNESS_PATH = '/tests/e2e/chat-scroll-harness.html';
const JID = 'web:e2e-scroll';
const OTHER_JID = 'web:e2e-scroll-other';

declare global {
  interface Window {
    __chatScroll: {
      wsEmit: (type: string, data: unknown) => void;
      runStarted: (runId: string, jid?: string) => void;
      runFinished: (runId: string, jid?: string) => void;
      switchTo: (jid: string) => void;
    };
    __frames: FrameSample[];
    __sampling: boolean;
  }
}

interface FrameSample {
  top: number;
  gap: number;
  /** The reply's first and last paragraphs are both in the DOM. */
  whole: boolean;
  /** Viewport offset of the anchor paragraph, if on screen. */
  anchorY: number | null;
  final: boolean;
}

const REPLY = Array.from(
  { length: 60 },
  (_, i) =>
    `Paragraph ${i}: the quick brown fox jumps over the lazy dog, again and again.`,
).join('\n\n');

async function openHarness(page: Page) {
  await page.goto(`${HARNESS_PATH}?n=40`);
  await expect(
    page.locator('[data-hc-chat-view] [data-index]').first(),
  ).toBeVisible();
  await expect.poll(() => metrics(page).then((m) => m.gap)).toBeLessThan(24);
  await page.waitForTimeout(800);
}

async function metrics(page: Page) {
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

/** Emits a stream event of `runId` for the harness workspace. */
async function streamEvent(
  page: Page,
  runId: string,
  event: Record<string, unknown>,
  chatJid = JID,
) {
  await page.evaluate(
    ({ runId, event, chatJid }) =>
      window.__chatScroll.wsEmit('stream_event', { chatJid, runId, event }),
    { runId, event, chatJid },
  );
}

/** Streams REPLY with a thinking burst and one tool call before it. */
async function streamReply(page: Page, runId: string) {
  await page.evaluate((id) => window.__chatScroll.runStarted(id), runId);
  await streamEvent(page, runId, {
    eventType: 'status',
    statusText: 'requesting',
    turnId: 'turn-1',
  });
  await page.waitForTimeout(1100);
  await streamEvent(page, runId, {
    eventType: 'thinking_delta',
    text: '先确认需求，再组织答案。',
    turnId: 'turn-1',
  });
  await streamEvent(page, runId, {
    eventType: 'tool_use_start',
    toolName: 'Read',
    toolUseId: 'tool-read',
    toolInputSummary: 'README.md',
    turnId: 'turn-1',
  });
  await streamEvent(page, runId, {
    eventType: 'tool_result',
    toolUseId: 'tool-read',
    toolResult: '# README',
    turnId: 'turn-1',
  });
  const chunks = REPLY.match(/[\s\S]{1,400}/g) ?? [];
  for (const text of chunks) {
    await streamEvent(page, runId, {
      eventType: 'text_delta',
      text,
      turnId: 'turn-1',
    });
  }
  await expect(
    page.locator('[data-hc-streaming-block]').getByText('Paragraph 59:'),
  ).toBeVisible();
  await page.waitForTimeout(500);
}

/** Samples every frame: scroll position, reply presence, anchor offset. */
async function startSampling(page: Page, anchor: string) {
  await page.evaluate((anchorText) => {
    window.__frames = [];
    window.__sampling = true;
    const view = document.querySelector('[data-hc-chat-view]')!;
    const scroller = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const tick = () => {
      const text = view.textContent ?? '';
      const anchorEl = [...view.querySelectorAll('p')].find((p) =>
        p.textContent?.startsWith(anchorText),
      );
      const top = scroller.getBoundingClientRect().top;
      window.__frames.push({
        top: scroller.scrollTop,
        gap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        whole: text.includes('Paragraph 0:') && text.includes('Paragraph 59:'),
        anchorY: anchorEl ? anchorEl.getBoundingClientRect().top - top : null,
        final: !view.querySelector('[data-hc-streaming-block] p'),
      });
      if (window.__sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, anchor);
}

/** run_finished, then the final message 60ms later, as the server sends them. */
async function finishLikeServer(page: Page, runId: string) {
  await page.evaluate(
    ({ runId, chatJid, content }) => {
      window.__chatScroll.runFinished(runId);
      window.setTimeout(() => {
        window.__chatScroll.wsEmit('new_message', {
          chatJid,
          message: {
            id: `final-${runId}`,
            chat_jid: chatJid,
            sender: 'happyclaw-agent',
            sender_name: '测试智能体',
            content,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            source_kind: 'sdk_final',
            finalization_reason: 'completed',
            turn_id: 'turn-1',
          },
        });
      }, 60);
    },
    { runId, chatJid: JID, content: REPLY },
  );
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    window.__sampling = false;
    return window.__frames;
  });
}

test('a pinned reader sees the reply swap to its final with no blank frame or roll-back', async ({
  page,
}) => {
  await openHarness(page);
  await streamReply(page, 'run-pinned');
  expect((await metrics(page)).gap).toBeLessThan(24);

  await startSampling(page, 'Paragraph 59:');
  const frames = await finishLikeServer(page, 'run-pinned');

  expect(frames.at(-1)?.final).toBe(true);
  expect(frames.filter((f) => !f.whole)).toEqual([]);
  // Pinned throughout: no frame leaves the bottom or jumps back a screen.
  expect(Math.max(...frames.map((f) => f.gap))).toBeLessThan(30);
  for (let i = 1; i < frames.length; i += 1) {
    expect(frames[i].top - frames[i - 1].top).toBeGreaterThan(-30);
  }
  await expect(page.getByRole('button', { name: /^回到底部/ })).toHaveCount(0);

  // The final reply keeps the thinking and execution details it streamed.
  const reply = page
    .locator('[data-index]')
    .filter({ hasText: 'Paragraph 59:' });
  await expect(reply.getByRole('button', { name: /已思考 \d/ })).toBeVisible();
  await expect(
    reply.getByRole('button', { name: /执行详情.*已使用 1 个工具/ }),
  ).toBeVisible();
});

test('a reader scrolled into the reply keeps their place through the finish', async ({
  page,
}) => {
  await openHarness(page);
  await streamReply(page, 'run-reading');

  // Scroll up to read the start of the streamed reply.
  await page.evaluate(() => {
    const view = document.querySelector('[data-hc-chat-view]')!;
    const scroller = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-chat-view] .overflow-y-auto',
      ),
    ].sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    const p = [...view.querySelectorAll('p')].find((el) =>
      el.textContent?.startsWith('Paragraph 5:'),
    )!;
    scroller.scrollTop +=
      p.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      200;
  });
  await page.waitForTimeout(400);
  const before = await metrics(page);
  expect(before.gap).toBeGreaterThan(500);

  await startSampling(page, 'Paragraph 5:');
  const frames = await finishLikeServer(page, 'run-reading');

  expect(frames.at(-1)?.final).toBe(true);
  expect(frames.filter((f) => !f.whole)).toEqual([]);
  const offsets = frames.map((f) => f.anchorY);
  expect(offsets.every((y) => y !== null)).toBe(true);
  const ys = offsets as number[];
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(3);
  // A reply the reader watched stream is not counted as a new message.
  await expect(page.getByRole('button', { name: '回到底部' })).toBeVisible();
});

test("the next queued run streams next to the previous reply until that reply's final lands", async ({
  page,
}) => {
  await openHarness(page);
  await streamReply(page, 'run-a');
  // Remember A's DOM: settling keeps it, it is not rebuilt.
  await page.evaluate(() => {
    const p = [
      ...document.querySelectorAll('[data-hc-streaming-block] p'),
    ].find((el) => el.textContent?.startsWith('Paragraph 59:'));
    (window as unknown as { __markA: Element | undefined }).__markA = p;
  });
  await startSampling(page, 'Paragraph 59:');

  await page.evaluate(() => {
    window.__chatScroll.runFinished('run-a');
    window.__chatScroll.runStarted('run-b');
  });
  // B opens its request and streams before A's final arrives.
  await streamEvent(page, 'run-b', {
    eventType: 'status',
    statusText: 'requesting',
    turnId: 'turn-2',
  });
  await streamEvent(page, 'run-b', {
    eventType: 'text_delta',
    text: '第二轮的回答正在输出。',
    turnId: 'turn-2',
  });
  const live = page.locator('[data-hc-stream-card="live"]');
  const settled = page.locator('[data-hc-stream-card="settled"]');
  await expect(live.getByText('第二轮的回答正在输出。')).toBeVisible();
  await expect(settled.getByText('Paragraph 59:')).toBeVisible();
  expect(
    await page.evaluate(() => {
      const mark = (window as unknown as { __markA?: Element }).__markA;
      return !!mark?.isConnected;
    }),
  ).toBe(true);

  const frames = await finishLikeServer(page, 'run-a');
  expect(frames.filter((f) => !f.whole)).toEqual([]);
  await expect(settled).toHaveCount(0);
  await expect(live.getByText('第二轮的回答正在输出。')).toBeVisible();
  const reply = page
    .locator('[data-message-id="final-run-a"]')
    .filter({ hasText: 'Paragraph 59:' });
  await expect(reply.getByRole('button', { name: /已思考 \d/ })).toBeVisible();
});

test('a reconnect snapshot never cuts the reply this tab already shows', async ({
  page,
}) => {
  await openHarness(page);
  await page.evaluate(() => window.__chatScroll.runStarted('run-snap'));
  const opening =
    'Kubernetes 调度入门：' + '调度器为 Pod 选择节点。'.repeat(300);
  await streamEvent(page, 'run-snap', {
    eventType: 'text_delta',
    text: opening,
    turnId: 'turn-1',
  });
  const block = page.locator('[data-hc-streaming-block]');
  await expect(block.getByText(/^Kubernetes 调度入门/)).toBeVisible();

  // An older server's 4000-character raw tail must not replace it.
  await page.evaluate(
    ({ chatJid, tail }) =>
      window.__chatScroll.wsEmit('stream_snapshot', {
        chatJid,
        runId: 'run-snap',
        snapshot: {
          partialText: tail,
          activeTools: [],
          recentEvents: [],
          systemStatus: null,
          turnId: 'turn-1',
        },
      }),
    { chatJid: JID, tail: opening.slice(-4000) },
  );
  await page.waitForTimeout(300);
  await expect(block.getByText(/^Kubernetes 调度入门/)).toBeVisible();

  // A full snapshot with text this tab missed is taken.
  await page.evaluate(
    ({ chatJid, full }) =>
      window.__chatScroll.wsEmit('stream_snapshot', {
        chatJid,
        runId: 'run-snap',
        snapshot: {
          partialText: full,
          activeTools: [],
          recentEvents: [],
          systemStatus: null,
          turnId: 'turn-1',
        },
      }),
    { chatJid: JID, full: `${opening}\n\n断线期间的新段落。` },
  );
  await expect(block.getByText('断线期间的新段落。')).toBeVisible();
  await expect(block.getByText(/^Kubernetes 调度入门/)).toBeVisible();
});

test('switching workspaces mid-stream loses none of the deltas', async ({
  page,
}) => {
  await openHarness(page);
  await page.evaluate(() => window.__chatScroll.runStarted('run-switch'));
  const probe = (i: number) => `探针段落 ${i}。`;
  for (let i = 1; i <= 3; i += 1) {
    await streamEvent(page, 'run-switch', {
      eventType: 'text_delta',
      text: `${probe(i)}\n\n`,
    });
  }
  await expect(page.getByText(probe(3))).toBeVisible();

  await page.evaluate((jid) => window.__chatScroll.switchTo(jid), OTHER_JID);
  await expect(page.getByText(probe(3))).toHaveCount(0);
  for (let i = 4; i <= 6; i += 1) {
    await streamEvent(page, 'run-switch', {
      eventType: 'text_delta',
      text: `${probe(i)}\n\n`,
    });
  }
  await page.waitForTimeout(200);

  await page.evaluate((jid) => window.__chatScroll.switchTo(jid), JID);
  await streamEvent(page, 'run-switch', {
    eventType: 'text_delta',
    text: probe(7),
  });
  const block = page.locator('[data-hc-streaming-block]');
  await expect(block.getByText(probe(7))).toBeVisible();
  const text = (await block.textContent()) ?? '';
  const positions = [1, 2, 3, 4, 5, 6, 7].map((i) => text.indexOf(probe(i)));
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test('a returned tool stops claiming to run and the status moves on', async ({
  page,
}) => {
  await openHarness(page);
  await page.evaluate(() => window.__chatScroll.runStarted('run-tools'));
  const block = page.locator('[data-hc-streaming-block]');

  await streamEvent(page, 'run-tools', {
    eventType: 'tool_use_start',
    toolName: 'Glob',
    toolUseId: 'tool-glob',
    toolInputSummary: '**/*.md',
  });
  await expect(block.getByText('正在查找文件', { exact: true })).toBeVisible();

  await streamEvent(page, 'run-tools', {
    eventType: 'tool_result',
    toolUseId: 'tool-glob',
    toolResult: 'README.md',
  });
  await expect(block.getByText('正在思考', { exact: true })).toBeVisible();
  await expect(block.getByText('正在查找文件', { exact: true })).toHaveCount(0);

  await streamEvent(page, 'run-tools', {
    eventType: 'tool_use_start',
    toolName: 'Bash',
    toolUseId: 'tool-bash',
    toolInputSummary: 'ls',
  });
  await expect(block.getByText('正在运行命令', { exact: true })).toBeVisible();
  // The runner now ends it on its result too; the card goes either way.
  await streamEvent(page, 'run-tools', {
    eventType: 'tool_use_end',
    toolUseId: 'tool-bash',
  });
  await expect(block.getByText('正在思考', { exact: true })).toBeVisible();
});
