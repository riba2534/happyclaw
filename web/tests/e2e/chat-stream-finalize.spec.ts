import { expect, test, type Page } from '@playwright/test';

// Streaming lifecycle through the app's real WebSocket subscriptions and run
// lifecycle (chat-scroll-harness): the finish swap, reconnect snapshots,
// switching workspaces mid-stream, and tool status.

const HARNESS_PATH = '/tests/e2e/chat-scroll-harness.html';
const JID = 'web:e2e-scroll';
const OTHER_JID = 'web:e2e-scroll-other';
/** The harness workspace's session, which streams. */
const SESSION = 'scroll-session';
const SESSION_JID = `${JID}#agent:${SESSION}`;

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
    ({ runId, event, chatJid, agentId }) =>
      window.__chatScroll.wsEmit('stream_event', {
        chatJid,
        agentId,
        runId,
        event,
      }),
    { runId, event, chatJid, agentId: SESSION },
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

/**
 * Streams REPLY as a timeline run: two reasoning blocks (with their timing),
 * two tool calls that return, then the answer.
 */
async function streamTimelineReply(page: Page, runId: string) {
  const turn = { turnId: 'turn-1' };
  await page.evaluate((id) => window.__chatScroll.runStarted(id), runId);
  await streamEvent(page, runId, {
    eventType: 'status',
    statusText: 'requesting',
    ...turn,
  });
  await page.waitForTimeout(1100);
  await streamEvent(page, runId, { eventType: 'thinking_start', ...turn });
  await streamEvent(page, runId, {
    eventType: 'thinking_delta',
    text: '**确认需求**\n\n先看项目结构，再决定读哪些文件。',
    ...turn,
  });
  await streamEvent(page, runId, {
    eventType: 'thinking_end',
    thinkingDurationMs: 3200,
    ...turn,
  });
  for (const [id, name, summary] of [
    ['tool-read', 'Read', 'README.md'],
    ['tool-bash', 'Bash', 'npm test'],
  ]) {
    await streamEvent(page, runId, {
      eventType: 'tool_use_start',
      toolName: name,
      toolUseId: id,
      toolInputSummary: summary,
      ...turn,
    });
    await streamEvent(page, runId, {
      eventType: 'tool_result',
      toolUseId: id,
      toolResult: 'ok',
      ...turn,
    });
  }
  await streamEvent(page, runId, { eventType: 'thinking_start', ...turn });
  await streamEvent(page, runId, {
    eventType: 'thinking_delta',
    text: '**整理结论**\n\n测试通过，可以回答了。',
    ...turn,
  });
  await streamEvent(page, runId, {
    eventType: 'thinking_end',
    thinkingDurationMs: 1800,
    ...turn,
  });
  const chunks = REPLY.match(/[\s\S]{1,400}/g) ?? [];
  for (const text of chunks) {
    await streamEvent(page, runId, { eventType: 'text_delta', text, ...turn });
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

/** run_finished alone: the card folds, and the final has not come yet. */
async function endRun(page: Page, runId: string) {
  await page.evaluate((id) => window.__chatScroll.runFinished(id), runId);
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    window.__sampling = false;
    return window.__frames;
  });
}

/**
 * The final reply of `runId`'s turn-1, as a new_message frame. The page stamps
 * it (`emitFinal`): its clock is the one the history was written by.
 */
function finalFrame(runId: string) {
  return {
    chatJid: JID,
    agentId: SESSION,
    message: {
      id: `final-${runId}`,
      chat_jid: SESSION_JID,
      sender: 'happyclaw-agent',
      sender_name: '测试智能体',
      content: REPLY,
      is_from_me: true,
      source_kind: 'sdk_final',
      finalization_reason: 'completed',
      turn_id: 'turn-1',
    },
  };
}

/** run_finished, then the final message 60ms later, as the server sends them. */
async function finishLikeServer(page: Page, runId: string) {
  await page.evaluate(
    ({ runId, frame }) => {
      window.__chatScroll.runFinished(runId);
      window.setTimeout(
        () =>
          window.__chatScroll.wsEmit('new_message', {
            ...frame,
            message: { ...frame.message, timestamp: new Date().toISOString() },
          }),
        60,
      );
    },
    { runId, frame: finalFrame(runId) },
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

  // The card folds to its summary when the run ends: the page is that much
  // shorter, and a pinned reader's scroll position with it.
  const folded = (await page.locator('[data-hc-process-card]').boundingBox())!
    .height;
  await startSampling(page, 'Paragraph 59:');
  const frames = await finishLikeServer(page, 'run-pinned');

  expect(frames.at(-1)?.final).toBe(true);
  expect(frames.filter((f) => !f.whole)).toEqual([]);
  // Pinned throughout: no frame leaves the bottom or jumps back a screen.
  expect(Math.max(...frames.map((f) => f.gap))).toBeLessThan(30);
  for (let i = 1; i < frames.length; i += 1) {
    expect(frames[i].top - frames[i - 1].top).toBeGreaterThan(-(folded + 30));
  }
  await expect(page.getByRole('button', { name: /^回到底部/ })).toHaveCount(0);

  // The final reply keeps the process it streamed, as the settled card.
  const reply = page
    .locator('[data-index]')
    .filter({ hasText: 'Paragraph 59:' });
  await expect(
    reply.locator('[data-hc-process-card][data-mode="settled"] > button'),
  ).toHaveText(/^已工作 \d+s$/);
  await expect(reply.getByRole('button', { name: /执行详情/ })).toHaveCount(0);
});

test('a final that lands while the run still closes takes the card away at once', async ({
  page,
}) => {
  await openHarness(page);
  await streamTimelineReply(page, 'run-closing');
  const stop = page.getByRole('button', { name: '停止当前运行' });
  await expect(stop).toBeVisible();
  await startSampling(page, 'Paragraph 59:');

  // The final first, while the run is still closing.
  await page.evaluate(
    (frame) =>
      window.__chatScroll.wsEmit('new_message', {
        ...frame,
        message: { ...frame.message, timestamp: new Date().toISOString() },
      }),
    finalFrame('run-closing'),
  );
  await page.waitForTimeout(800);

  // Nothing of the card is left, not even a "preparing" row, while the run
  // is still there to stop.
  const block = page.locator('[data-hc-streaming-block]');
  await expect(block).toHaveText('');
  await expect(stop).toBeVisible();
  const reply = page
    .locator('[data-index]')
    .filter({ hasText: 'Paragraph 59:' });
  await expect(
    reply.locator('[data-hc-process-card][data-mode="settled"] > button'),
  ).toHaveText(/^已工作 \d+s$/);

  // run_finished brings nothing back.
  const frames = await endRun(page, 'run-closing');
  await expect(block).toHaveText('');
  await expect(stop).toHaveCount(0);

  expect(frames.at(-1)?.final).toBe(true);
  expect(frames.filter((f) => !f.whole)).toEqual([]);
  // A pinned reader stays at the end through the swap.
  expect(Math.max(...frames.map((f) => f.gap))).toBeLessThan(30);
  await expect(page.getByRole('button', { name: /^回到底部/ })).toHaveCount(0);
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

// Chromium holds a reader's place by itself when what is above them changes
// size; Safari does not. Both are run, the second with that turned off, so the
// card has to keep the place on its own.
for (const anchoring of ['native', 'none'] as const) {
  test(`a reader scrolled into the reply keeps their place at the end of the run (scroll anchoring: ${anchoring})`, async ({
    page,
  }) => {
    await openHarness(page);
    if (anchoring === 'none') {
      await page.addStyleTag({
        content: '[data-hc-chat-view] * { overflow-anchor: none !important }',
      });
    }
    await readerFolds(page);
  });
}

async function readerFolds(page: Page) {
  await streamReply(page, 'run-fold');
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
  const card = page.locator('[data-hc-process-card]');
  // The process folded when the answer started: the end has nothing to fold.
  await expect(card).toHaveAttribute('data-mode', 'live');
  await expect(card).toHaveAttribute('data-folded', '');
  const liveHeight = (await card.boundingBox())!.height;
  expect((await metrics(page)).gap).toBeGreaterThan(500);

  await startSampling(page, 'Paragraph 5:');
  const frames = await endRun(page, 'run-fold');

  // The card settled at its height, and the text did not move.
  await expect(card).toHaveAttribute('data-mode', 'settled');
  expect(
    Math.abs((await card.boundingBox())!.height - liveHeight),
  ).toBeLessThan(1);
  expect(frames.filter((f) => !f.whole)).toEqual([]);
  const ys = frames.map((f) => f.anchorY);
  expect(ys.every((y) => y !== null)).toBe(true);
  expect(
    Math.max(...(ys as number[])) - Math.min(...(ys as number[])),
  ).toBeLessThan(3);
}

test('a pinned reader stays at the end, and the answer stays put, as the card folds when the answer starts', async ({
  page,
}) => {
  await openHarness(page);
  await page.evaluate(() => window.__chatScroll.runStarted('run-fold-start'));
  const turn = { turnId: 'turn-fold-start' };
  for (const [id, name, summary] of [
    ['tool-a', 'Read', 'README.md'],
    ['tool-b', 'Bash', 'npm test'],
    ['tool-c', 'Grep', 'useChatStore'],
  ]) {
    await streamEvent(page, 'run-fold-start', {
      eventType: 'tool_use_start',
      toolName: name,
      toolUseId: id,
      toolInputSummary: summary,
      ...turn,
    });
    await streamEvent(page, 'run-fold-start', {
      eventType: 'tool_result',
      toolUseId: id,
      toolResult: 'ok',
      ...turn,
    });
  }
  const card = page.locator('[data-hc-process-card]');
  await expect(card.getByRole('listitem')).toHaveCount(3);
  const workingHeight = (await card.boundingBox())!.height;
  await page.waitForTimeout(400);
  expect((await metrics(page)).gap).toBeLessThan(24);

  const chunks = REPLY.match(/[\s\S]{1,400}/g) ?? [];
  for (const text of chunks.slice(0, 3)) {
    await streamEvent(page, 'run-fold-start', {
      eventType: 'text_delta',
      text,
      ...turn,
    });
  }
  await page.waitForTimeout(800);

  await expect(card).toHaveAttribute('data-folded', '');
  expect((await card.boundingBox())!.height).toBeLessThan(workingHeight - 20);
  // The fold above the answer never pulled the reader off the end.
  expect((await metrics(page)).gap).toBeLessThan(24);
  await expect(page.getByRole('button', { name: /^回到底部/ })).toHaveCount(0);
});

test('a pinned reader stays at the end, and the answer stays put, at the end of the run', async ({
  page,
}) => {
  await openHarness(page);
  await streamReply(page, 'run-fold-pinned');
  const card = page.locator('[data-hc-process-card]');
  await expect(card).toHaveAttribute('data-mode', 'live');
  await expect(card).toHaveAttribute('data-folded', '');
  const liveHeight = (await card.boundingBox())!.height;

  await startSampling(page, 'Paragraph 59:');
  const frames = await endRun(page, 'run-fold-pinned');

  await expect(card).toHaveAttribute('data-mode', 'settled');
  expect(
    Math.abs((await card.boundingBox())!.height - liveHeight),
  ).toBeLessThan(1);
  expect(Math.max(...frames.map((f) => f.gap))).toBeLessThan(30);
  const ys = frames.map((f) => f.anchorY);
  expect(ys.every((y) => y !== null)).toBe(true);
  expect(
    Math.max(...(ys as number[])) - Math.min(...(ys as number[])),
  ).toBeLessThan(3);
  await expect(page.getByRole('button', { name: /^回到底部/ })).toHaveCount(0);
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
  await expect(
    reply.locator('[data-hc-process-card][data-mode="settled"] > button'),
  ).toHaveText(/^已工作 \d+s$/);
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
    { chatJid: SESSION_JID, tail: opening.slice(-4000) },
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
    { chatJid: SESSION_JID, full: `${opening}\n\n断线期间的新段落。` },
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
  const phase = page.locator('[data-hc-run-status-bar] [data-hc-run-phase]');

  await streamEvent(page, 'run-tools', {
    eventType: 'tool_use_start',
    toolName: 'Glob',
    toolUseId: 'tool-glob',
    toolInputSummary: '**/*.md',
  });
  await expect(phase).toHaveText('查找文件');

  await streamEvent(page, 'run-tools', {
    eventType: 'tool_result',
    toolUseId: 'tool-glob',
    toolResult: 'README.md',
  });
  await expect(phase).toHaveText('思考中');

  await streamEvent(page, 'run-tools', {
    eventType: 'tool_use_start',
    toolName: 'Bash',
    toolUseId: 'tool-bash',
    toolInputSummary: 'ls',
  });
  await expect(phase).toHaveText('运行命令');
  // The runner now ends it on its result too; the card goes either way.
  await streamEvent(page, 'run-tools', {
    eventType: 'tool_use_end',
    toolUseId: 'tool-bash',
  });
  await expect(phase).toHaveText('思考中');
});

test('a timeline of steps folds into the finished message and the answer does not move', async ({
  page,
}) => {
  await openHarness(page);
  await streamTimelineReply(page, 'run-timeline');
  expect((await metrics(page)).gap).toBeLessThan(24);

  // While the answer streams the steps are folded into how long they took;
  // opened, they are rows in order, and the answer is below them.
  const live = page.locator('[data-hc-streaming-block] [data-hc-process-card]');
  await expect(live).toHaveAttribute('data-folded', '');
  const header = live.getByRole('button', { name: /^已工作 \d+s$/ });
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  // Clicked where it is: a locator click would first scroll it into view.
  await header.evaluate((el) => (el as HTMLElement).click());
  const timeline = page.getByRole('list', { name: '处理步骤' });
  await expect(timeline.getByRole('listitem')).toHaveCount(4);
  await expect(
    timeline.getByRole('button', { name: /确认需求.*3\.2s/ }),
  ).toBeVisible();
  await expect(
    timeline.getByRole('button', { name: /整理结论.*1\.8s/ }),
  ).toBeVisible();

  // Opening them above the answer keeps a pinned reader at the end.
  await page.waitForTimeout(400);
  expect((await metrics(page)).gap).toBeLessThan(24);

  await startSampling(page, 'Paragraph 59:');
  const frames = await finishLikeServer(page, 'run-timeline');

  expect(frames.at(-1)?.final).toBe(true);
  expect(frames.filter((f) => !f.whole)).toEqual([]);
  // The final message's card is as the reader left the live one, open on
  // the same steps. On a desktop the answer does not move; on a phone the
  // running reply holds no place for the final reply's action row (a blank
  // band over the floating composer), so the row arrives with the final and
  // the follow glide carries it in: the answer slides up by at most the row
  // (44px and its 6px margin) and the reader is back at the end.
  const onPhone = await page.evaluate(
    () => matchMedia('(max-width: 1023px) and (pointer: coarse)').matches,
  );
  const ys = frames.map((f) => f.anchorY);
  expect(ys.every((y) => y !== null)).toBe(true);
  const travel = Math.max(...(ys as number[])) - Math.min(...(ys as number[]));
  if (onPhone) {
    const ACTION_ROW = 44 + 6;
    expect(Math.max(...frames.map((f) => f.gap))).toBeLessThanOrEqual(
      ACTION_ROW + 4,
    );
    expect(frames.at(-1)?.gap).toBeLessThan(1);
    expect(travel).toBeLessThanOrEqual(ACTION_ROW + 4);
  } else {
    expect(Math.max(...frames.map((f) => f.gap))).toBeLessThan(30);
    expect(travel).toBeLessThan(3);
  }
  await expect(page.getByRole('button', { name: /^回到底部/ })).toHaveCount(0);

  // The final message keeps the steps behind the same one summary row:
  // reasoning (both blocks) and tools, in order, open as the reader left them.
  const reply = page
    .locator('[data-index]')
    .filter({ hasText: 'Paragraph 59:' });
  const card = reply.locator('[data-hc-process-card]');
  await expect(card).toHaveAttribute('data-mode', 'settled');
  await expect(card.locator('> button')).toHaveText(/^已工作 \d+s$/);
  await expect(card.locator('> button')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(card.locator('[data-hc-work-counts]')).toHaveText(
    '2 个工具 · 2 段思考',
  );
  await expect(reply.getByRole('button', { name: /执行详情/ })).toHaveCount(0);
  const settled = reply.getByRole('list', { name: '处理步骤' });
  await expect(settled.getByRole('listitem')).toHaveCount(4);
  await expect(
    settled.getByRole('button', { name: /确认需求.*3\.2s/ }),
  ).toBeVisible();
  await expect(
    settled.getByRole('button', { name: /整理结论.*1\.8s/ }),
  ).toBeVisible();
  const rows = await settled.getByRole('listitem').allInnerTexts();
  expect(rows[0]).toContain('确认需求');
  expect(rows[1]).toContain('README.md');
  expect(rows[2]).toContain('npm test');
  expect(rows[3]).toContain('整理结论');
});

test('a pinned reader stays pinned while the wait row gives way to reasoning and a tool', async ({
  page,
}) => {
  await openHarness(page);
  // The race: the placeholder for the model's wait gives way to a shorter
  // thinking row (the card shrinks, the browser clamps the scroll position and
  // queues its scroll event), then a tool row grows the card again before that
  // event is delivered. Delivered late, the clamp reads as the reader
  // scrolling up. It depends on frame timing, so it runs several rounds.
  for (let round = 0; round < 8; round += 1) {
    const runId = `run-race-${round}`;
    const turn = { turnId: `turn-race-${round}` };
    await page.evaluate((id) => window.__chatScroll.runStarted(id), runId);
    await streamEvent(page, runId, {
      eventType: 'status',
      statusText: 'requesting',
      ...turn,
    });
    await expect(page.locator('[data-hc-model-wait]')).toBeVisible();
    await page.waitForTimeout(400);
    expect((await metrics(page)).gap).toBeLessThan(24);

    await streamEvent(page, runId, {
      eventType: 'thinking_delta',
      text: '先确认需求，再组织答案。',
      ...turn,
    });
    await streamEvent(page, runId, {
      eventType: 'tool_use_start',
      toolName: 'Read',
      toolUseId: `tool-race-${round}`,
      toolInputSummary: 'README.md',
      ...turn,
    });
    await expect(
      page.getByRole('list', { name: '处理步骤' }).getByText('README.md'),
    ).toBeVisible();
    await page.waitForTimeout(250);
    expect((await metrics(page)).gap, `round ${round}`).toBeLessThan(24);
    await expect(page.getByRole('button', { name: /^回到底部/ })).toHaveCount(
      0,
    );

    await page.evaluate((id) => window.__chatScroll.runFinished(id), runId);
    await page.waitForTimeout(100);
  }
});
