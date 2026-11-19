import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-trace-'));
const dataDir = path.join(root, 'data');
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [dataDir, storeDir, groupsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const {
  MAX_TURN_TRACE_EVENTS,
  MAX_TURN_TRACE_THINKING_BYTES,
  TurnTraceAccumulator,
  TurnTraceTracker,
  markMessagesWithTrace,
  presentTurnTrace,
  resolveTurnTraceExposure,
} = await import('../src/turn-trace.js');
const { TurnStepRecorder } = await import('../src/turn-steps.js');
const { MAX_STEPS } = await import('../src/stream-steps.js');
const { THINKING_OMITTED_MARKER } = await import('../src/thinking-text.js');

import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';

const OWNER = 'trace-owner';

function ev(eventType: StreamEventType, extra: Partial<StreamEvent> = {}) {
  return { eventType, ...extra } as StreamEvent;
}

type StoreInput = Parameters<typeof db.upsertTurnTrace>[0];

function tracker(
  mode: InteractionMode,
  visibility: { current: ProcessVisibility } = { current: 'full' },
) {
  const stored: StoreInput[] = [];
  const instance = new TurnTraceTracker({
    mode,
    getVisibility: () => visibility.current,
    store: (input) => {
      stored.push(input);
    },
  });
  return { instance, stored, visibility };
}

/** One tool-using turn: reasoning, a tool call with a result, an answer. */
function playTurn(
  t: InstanceType<typeof TurnTraceTracker>,
  inputId: string,
  startAt = 1_000,
): void {
  t.observe(inputId, ev('status', { statusText: 'requesting' }), startAt);
  t.observe(inputId, ev('thinking_start'), startAt + 100);
  t.observe(inputId, ev('thinking_delta', { text: '先看目录' }), startAt + 200);
  t.observe(
    inputId,
    ev('thinking_end', { thinkingDurationMs: 300 }),
    startAt + 300,
  );
  t.observe(
    inputId,
    ev('tool_use_start', {
      toolName: 'Bash',
      toolUseId: 'tool-1',
      toolInputSummary: 'command: ls',
    }),
    startAt + 400,
  );
  t.observe(
    inputId,
    ev('tool_result', {
      toolUseId: 'tool-1',
      toolResult: 'a.txt',
      detail: 'a.txt',
    }),
    startAt + 500,
  );
  t.observe(
    inputId,
    ev('tool_use_end', { toolUseId: 'tool-1' }),
    startAt + 510,
  );
  t.observe(inputId, ev('status', { statusText: 'requesting' }), startAt + 520);
  t.observe(inputId, ev('thinking_start'), startAt + 700);
  t.observe(inputId, ev('thinking_delta', { text: '再总结' }), startAt + 710);
  t.observe(inputId, ev('thinking_end'), startAt + 720);
  t.observe(inputId, ev('text_delta', { text: '这是答案' }), startAt + 800);
}

describe('TurnTraceAccumulator', () => {
  test('collects thinking, timing and trace rows of a turn', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('thinking_delta', { text: '想' }), 100);
    acc.observe(
      ev('tool_use_start', { toolName: 'Bash', toolUseId: 't' }),
      400,
    );
    acc.observe(ev('tool_use_end', { toolUseId: 't' }), 500);
    const content = acc.toContent({ includeThinking: true, now: 600 })!;
    expect(content.thinking).toBe('想');
    expect(content.thinkingDurationMs).toBe(400);
    expect(content.trace.map((row) => row.title)).toEqual([
      '工具 Bash',
      '工具完成 t',
    ]);
    expect(acc.isEmpty).toBe(false);
  });

  test('live usage totals never become trace rows', () => {
    const acc = new TurnTraceAccumulator(0);
    for (let at = 10; at <= 30; at += 10) {
      acc.observe(
        ev('usage_progress', {
          usageProgress: {
            calls: at / 10,
            inputTokens: 10,
            cacheReadInputTokens: 990,
            cacheCreationInputTokens: 0,
            outputTokens: 100,
            streamOutputTokens: 100,
            streamMs: 2_000,
          },
        }),
        at,
      );
    }
    expect(acc.isEmpty).toBe(true);
    expect(acc.toContent({ includeThinking: true })).toBeNull();
  });

  test('a turn that did nothing worth keeping yields no content', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('text_delta', { text: '你好' }), 10);
    acc.observe(ev('status', { statusText: 'requesting' }), 20);
    expect(acc.isEmpty).toBe(true);
    expect(acc.toContent({ includeThinking: true })).toBeNull();
  });

  test('reasoning without any text still records that, and for how long', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('thinking_start'), 1_000);
    acc.observe(ev('thinking_end', { thinkingDurationMs: 2_000 }), 1_500);
    expect(acc.toContent({ includeThinking: true })).toEqual({
      thinking: '',
      thinkingDurationMs: 2_000,
      trace: [],
      steps: [
        {
          id: 'thinking-0',
          kind: 'thinking',
          at: 0,
          endedAt: 1_500,
          status: 'done',
          text: '',
          durationMs: 2_000,
        },
      ],
      stepsDropped: 0,
    });
  });

  test('tool_progress updates the tool row instead of adding rows', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('tool_use_start', { toolName: 'Bash', toolUseId: 'b' }), 10);
    acc.observe(
      ev('tool_use_start', { toolName: 'Skill', toolUseId: 's' }),
      20,
    );
    // a long-running tool reports its elapsed time again and again
    for (let i = 0; i < 100; i += 1) {
      acc.observe(
        ev('tool_progress', {
          toolName: 'Bash',
          toolUseId: 'b',
          elapsedSeconds: i,
        }),
        30 + i,
      );
    }
    acc.observe(
      ev('tool_progress', {
        toolName: 'Bash',
        toolUseId: 'b',
        toolInputSummary: 'command: sleep 100',
      }),
      200,
    );
    acc.observe(
      ev('tool_progress', {
        toolName: 'Skill',
        toolUseId: 's',
        skillName: 'pdf',
      }),
      210,
    );
    acc.observe(ev('tool_use_end', { toolUseId: 'b' }), 300);
    const { trace } = acc.toContent({ includeThinking: false })!;
    expect(trace.map((row) => [row.kind, row.title, row.summary])).toEqual([
      ['tool', '工具 Bash', 'command: sleep 100'],
      ['skill', '技能 pdf', undefined],
      ['tool', '工具完成 b', undefined],
    ]);
  });

  test('keeps the newest 200 trace rows', () => {
    const acc = new TurnTraceAccumulator(0);
    for (let i = 0; i < MAX_TURN_TRACE_EVENTS + 25; i += 1) {
      acc.observe(
        ev('tool_use_start', { toolName: `T${i}`, toolUseId: `t${i}` }),
        i,
      );
    }
    const { trace } = acc.toContent({ includeThinking: false })!;
    expect(trace).toHaveLength(MAX_TURN_TRACE_EVENTS);
    expect(trace[0].title).toBe('工具 T25');
    expect(trace.at(-1)!.title).toBe(`工具 T${MAX_TURN_TRACE_EVENTS + 24}`);
  });

  test('thinking beyond 64KB keeps the tail and says it was cut', () => {
    const acc = new TurnTraceAccumulator(0);
    const paragraph = `${'推理'.repeat(500)}\n\n`;
    for (let i = 0; i < 120; i += 1) {
      acc.observe(ev('thinking_delta', { text: `${i}:${paragraph}` }), i + 1);
    }
    const { thinking } = acc.toContent({ includeThinking: true })!;
    expect(Buffer.byteLength(thinking, 'utf8')).toBeLessThanOrEqual(
      MAX_TURN_TRACE_THINKING_BYTES,
    );
    expect(thinking.startsWith('…\n\n')).toBe(true);
    // the newest paragraph survives, whole
    expect(thinking.trimEnd().endsWith(`119:${'推理'.repeat(500)}`)).toBe(true);
  });

  test('absorb appends a later part of the same reply sequence', () => {
    const first = new TurnTraceAccumulator(0);
    first.observe(ev('thinking_delta', { text: '甲' }), 100);
    first.observe(ev('text_delta', { text: '字' }), 300);
    const second = new TurnTraceAccumulator(1_000);
    second.observe(ev('thinking_delta', { text: '乙' }), 1_100);
    second.observe(ev('text_delta', { text: '字' }), 1_150);
    first.absorb(second, 2_000);
    const content = first.toContent({ includeThinking: true })!;
    expect(content.thinking).toBe('甲\n\n乙');
    expect(content.thinkingDurationMs).toBe(300 + 150);
    // the steps of the later part follow the earlier one's
    expect(content.steps.map((s) => [s.kind, s.text])).toEqual([
      ['thinking', '甲'],
      ['thinking', '乙'],
    ]);
  });

  test('the steps of a turn come in the order it ran, without the answer', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('thinking_delta', { text: '**读**\n\n先读。' }), 100);
    acc.observe(ev('text_delta', { text: '我读一下。' }), 200);
    acc.observe(
      ev('tool_use_start', {
        toolName: 'Read',
        toolUseId: 'r',
        toolInputSummary: 'a.ts',
      }),
      300,
    );
    acc.observe(ev('tool_use_end', { toolUseId: 'r' }), 400);
    acc.observe(ev('text_delta', { text: '结论。' }), 500);
    const { steps, stepsDropped } = acc.toContent({
      includeThinking: true,
      now: 600,
    })!;
    expect(
      steps.map((s) => [s.kind, s.status, s.title ?? s.text ?? s.toolName]),
    ).toEqual([
      ['thinking', 'done', '读'],
      ['text', 'done', '我读一下。'],
      ['tool', 'done', 'Read'],
    ]);
    expect(stepsDropped).toBe(0);
  });

  test('steps alone are worth keeping, even when no trace row was made for them', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(
      ev('tool_use_start', {
        toolName: 'Read',
        toolUseId: 'r',
        displayLevel: 'debug',
      }),
      10,
    );
    expect(acc.isEmpty).toBe(false);
    const content = acc.toContent({ includeThinking: true, now: 20 })!;
    expect(content.trace).toEqual([]);
    expect(content.thinkingDurationMs).toBeNull();
    expect(content.steps.map((s) => s.toolName)).toEqual(['Read']);
  });

  test('a turn with only an answer has no steps, and so yields nothing', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('text_delta', { text: '你好' }), 10);
    expect(acc.isEmpty).toBe(true);
    expect(acc.toContent({ includeThinking: true })).toBeNull();
  });

  test('without the thinking text a step keeps its status and times only, and no note', () => {
    const acc = new TurnTraceAccumulator(0);
    acc.observe(ev('thinking_delta', { text: '**机密**\n\n内容。' }), 100);
    acc.observe(ev('text_delta', { text: '我先看看。' }), 200);
    acc.observe(
      ev('tool_use_start', { toolName: 'Read', toolUseId: 'r' }),
      300,
    );
    const { steps } = acc.toContent({ includeThinking: false, now: 400 })!;
    expect(steps.map((s) => s.kind)).toEqual(['thinking', 'tool']);
    expect(steps[0]).toEqual({
      id: 'thinking-0',
      kind: 'thinking',
      at: 0,
      endedAt: 200,
      status: 'done',
      durationMs: 200,
    });
    expect(JSON.stringify(steps)).not.toContain('机密');
    expect(JSON.stringify(steps)).not.toContain('我先看看');
  });

  test('keeps the newest steps and says how many went, even when none of them ever finished', () => {
    const acc = new TurnTraceAccumulator(0);
    for (let i = 0; i < MAX_STEPS + 20; i += 1) {
      acc.observe(
        ev('tool_use_start', { toolName: 'Read', toolUseId: `r${i}` }),
        i,
      );
    }
    const { steps, stepsDropped } = acc.toContent({
      includeThinking: true,
      now: 1_000,
    })!;
    expect(steps).toHaveLength(MAX_STEPS);
    expect(stepsDropped).toBe(20);
    expect(steps[0].toolUseId).toBe('r20');
  });

  test('thinking beyond 64KB is cut from the oldest step; titles and times stay', () => {
    const acc = new TurnTraceAccumulator(0);
    const paragraph = `${'推理'.repeat(500)}\n\n`;
    // 40 bursts of ~3KB each, set apart by tools: 120KB in all
    for (let i = 0; i < 40; i += 1) {
      acc.observe(
        ev('thinking_delta', { text: `**第${i}段**\n\n${paragraph}` }),
        i * 10,
      );
      acc.observe(
        ev('tool_use_start', { toolName: 'Read', toolUseId: `r${i}` }),
        i * 10 + 5,
      );
    }
    const { steps } = acc.toContent({ includeThinking: true, now: 1_000 })!;
    const thinking = steps.filter((s) => s.kind === 'thinking');
    expect(thinking).toHaveLength(40);
    const bytes = thinking.reduce(
      (sum, s) => sum + Buffer.byteLength(s.text ?? '', 'utf8'),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(MAX_TURN_TRACE_THINKING_BYTES);
    // the oldest lost its text but not its title, the newest is whole
    expect(thinking[0].text).toBe(THINKING_OMITTED_MARKER);
    // no burst reads as one that had nothing to show
    expect(thinking.every((s) => !!s.text)).toBe(true);
    expect(thinking[0].title).toBe('第0段');
    expect(thinking[0].endedAt).toBeDefined();
    expect(thinking[39].text).toContain('推理'.repeat(500));
    expect(thinking.at(-1)!.title).toBe('第39段');
  });

  test('a fault in the step recorder costs the steps, not the trace', () => {
    const observe = vi
      .spyOn(TurnStepRecorder.prototype, 'observe')
      .mockImplementation(() => {
        throw new Error('boom');
      });
    try {
      const acc = new TurnTraceAccumulator(0);
      acc.observe(ev('thinking_delta', { text: '想' }), 100);
      acc.observe(ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }), 200);
      acc.observe(ev('tool_use_end', { toolUseId: 'a' }), 300);
      // the recorder is not asked again after it failed
      expect(observe).toHaveBeenCalledTimes(1);
      const content = acc.toContent({ includeThinking: true, now: 400 })!;
      expect(content.thinking).toBe('想');
      expect(content.trace.map((row) => row.title)).toEqual([
        '工具 A',
        '工具完成 a',
      ]);
      expect(content.steps).toEqual([]);
      expect(content.stepsDropped).toBe(0);
    } finally {
      observe.mockRestore();
    }
  });
});

describe('TurnTraceTracker', () => {
  test('an Assistant turn is recorded as it ran, tool results included', () => {
    const { instance, stored } = tracker('assistant');
    playTurn(instance, 'in-1');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(true);
    expect(stored).toHaveLength(1);
    const [row] = stored;
    expect(row).toMatchObject({
      chatJid: 'web:a',
      turnId: 'in-1',
      thinking: '先看目录\n\n再总结',
    });
    const trace = JSON.parse(row.traceJson);
    expect(trace.map((r: { title: string }) => r.title)).toEqual([
      '工具 Bash',
      '工具结果',
      '工具完成 tool-1',
    ]);
    // the result text is part of what an Assistant workspace shows
    expect(trace[1].detail).toBe('a.txt');
    expect(row.thinkingDurationMs).toBeGreaterThan(0);
    // once stored, the turn is no longer pending
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(false);
  });

  test('an Assistant turn stores its steps in order, without the answer', () => {
    const { instance, stored } = tracker('assistant');
    playTurn(instance, 'in-1');
    instance.persist({ chatJid: 'web:a', inputId: 'in-1', now: 5_000 });
    const [row] = stored;
    expect(row.stepsDropped).toBe(0);
    const steps = JSON.parse(row.stepsJson!);
    expect(
      steps.map(
        (s: {
          kind: string;
          status: string;
          text?: string;
          toolName?: string;
        }) => [s.kind, s.status, s.text ?? s.toolName],
      ),
    ).toEqual([
      ['thinking', 'done', '先看目录'],
      ['tool', 'done', 'Bash'],
      ['thinking', 'done', '再总结'],
    ]);
    expect(steps[1]).toMatchObject({
      toolUseId: 'tool-1',
      summary: 'command: ls',
      resultPreview: 'a.txt',
    });
    expect(row.stepsJson).not.toContain('这是答案');
  });

  test('activity stores the structure of the steps but no thinking text or title', () => {
    const { instance, stored } = tracker('proactive', { current: 'activity' });
    playTurn(instance, 'in-1');
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    const steps = JSON.parse(stored[0].stepsJson!);
    expect(steps.map((s: { kind: string }) => s.kind)).toEqual([
      'thinking',
      'tool',
      'thinking',
    ]);
    expect(stored[0].stepsJson).not.toContain('先看目录');
    expect(steps[0].text).toBeUndefined();
    expect(steps[0].title).toBeUndefined();
    expect(steps[0].durationMs).toBeGreaterThan(0);
  });

  test('a proactive turn omits its speech tool and keeps commentary at full (withheld at activity)', () => {
    const { instance, stored, visibility } = tracker('proactive', {
      current: 'full',
    });
    instance.observe('in-1', ev('thinking_delta', { text: '想' }), 10);
    instance.observe(
      'in-1',
      ev('commentary', { agentScope: 'main', text: '我先读文件。' }),
      20,
    );
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'Read', toolUseId: 'r' }),
      30,
    );
    instance.observe(
      'in-1',
      ev('tool_use_start', {
        toolName: 'mcp__happyclaw__send_message',
        toolUseId: 'say',
        toolInputSummary: '你好',
      }),
      40,
    );
    instance.observe('in-1', ev('tool_result', { toolUseId: 'say' }), 50);
    instance.persist({ chatJid: 'web:a', inputId: 'in-1', keep: true });
    const steps = JSON.parse(stored[0].stepsJson!);
    expect(steps.map((s: { kind: string }) => s.kind)).toEqual([
      'thinking',
      'text',
      'tool',
    ]);
    expect(steps[1]).toMatchObject({
      kind: 'text',
      commentary: true,
      text: '我先读文件。',
    });
    expect(stored[0].stepsJson).not.toContain('send_message');
    // the existing trace is untouched by this
    expect(stored[0].traceJson).toContain('send_message');

    visibility.current = 'activity';
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    const activitySteps = JSON.parse(stored[1].stepsJson!);
    expect(activitySteps.map((s: { kind: string }) => s.kind)).toEqual([
      'thinking',
      'tool',
    ]);
    expect(stored[1].stepsJson).not.toContain('我先读文件');
  });

  test('the number of steps dropped at the cap is stored with the rest', () => {
    const { instance, stored } = tracker('assistant');
    for (let i = 0; i < MAX_STEPS + 20; i += 1) {
      instance.observe(
        'in-1',
        ev('tool_use_start', { toolName: 'Read', toolUseId: `r${i}` }),
        i,
      );
      instance.observe('in-1', ev('tool_use_end', { toolUseId: `r${i}` }), i);
    }
    instance.persist({ chatJid: 'web:a', inputId: 'in-1', now: 1_000 });
    expect(stored[0].stepsDropped).toBe(20);
    const steps = JSON.parse(stored[0].stepsJson!);
    expect(steps).toHaveLength(MAX_STEPS);
    expect(steps[0].toolUseId).toBe('r20');
  });

  test('an Assistant turn keeps the speech tool as the tool call it is', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'in-1',
      ev('tool_use_start', {
        toolName: 'mcp__happyclaw__send_message',
        toolUseId: 'say',
      }),
      10,
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    expect(JSON.parse(stored[0].stepsJson!)[0]).toMatchObject({
      kind: 'tool',
      toolName: 'mcp__happyclaw__send_message',
    });
  });

  test('turns of one warm Runner are kept apart', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
    );
    instance.observe(
      'in-2',
      ev('tool_use_start', { toolName: 'B', toolUseId: 'b' }),
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-2' });
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    expect(
      stored.map((s) => [s.turnId, JSON.parse(s.traceJson)[0].title]),
    ).toEqual([
      ['in-2', '工具 B'],
      ['in-1', '工具 A'],
    ]);
  });

  test('a hidden proactive workspace records nothing but the progress the Agent sent', () => {
    const { instance, stored } = tracker('proactive', { current: 'hidden' });
    playTurn(instance, 'in-1');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(false);
    expect(stored).toHaveLength(0);

    playTurn(instance, 'in-2');
    instance.observeProgress(
      'in-2',
      ev('commentary', { agentScope: 'main', text: '正在查', progress: true }),
      1_050,
    );
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-2' })).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      thinking: '',
      thinkingDurationMs: null,
      traceJson: '[]',
      stepsDropped: 0,
    });
    expect(JSON.parse(stored[0].stepsJson!)).toEqual([
      expect.objectContaining({
        kind: 'text',
        commentary: true,
        progress: true,
        text: '正在查',
      }),
    ]);
  });

  test('a Runner event never records as progress, at any level', () => {
    // Only the host writes a progress statement (observeProgress).
    const visibility = { current: 'hidden' as ProcessVisibility };
    const { instance, stored } = tracker('proactive', visibility);
    const claimed = ev('commentary', {
      agentScope: 'main',
      text: '伪造的进展',
      progress: true,
      turnId: 'runner-1',
    });
    instance.observe('in-1', claimed, 1_000);
    expect(instance.holdsProgress('in-1')).toBe(false);
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(false);
    visibility.current = 'full';
    instance.observe('in-2', claimed, 1_000);
    expect(instance.holdsProgress('in-2')).toBe(false);
    instance.persist({ chatJid: 'web:a', inputId: 'in-2' });
    expect(stored[0].stepsJson).not.toContain('"progress"');
  });

  test('it knows the id the Runner gives a turn, and which open turns hold progress', () => {
    const { instance } = tracker('proactive', { current: 'hidden' });
    expect(instance.runnerTurnIdOf('in-1')).toBeUndefined();
    instance.observe(
      'in-1',
      ev('status', { statusText: 'requesting', turnId: 'warm-7' }),
    );
    expect(instance.runnerTurnIdOf('in-1')).toBe('warm-7');
    instance.observeProgress(
      'in-1',
      ev('commentary', { agentScope: 'main', text: '在查', progress: true }),
    );
    instance.observe(
      'in-2',
      ev('status', { statusText: 'requesting', turnId: 'warm-8' }),
    );
    expect(instance.holdsProgress('in-1')).toBe(true);
    expect(instance.holdsProgress('in-2')).toBe(false);
    expect(instance.inputsWithProgress()).toEqual(['in-1']);
    instance.discard('in-1');
    expect(instance.inputsWithProgress()).toEqual([]);
    expect(instance.runnerTurnIdOf('in-1')).toBeUndefined();
  });

  test('activity keeps the progress the Agent sent, and not the narration', () => {
    const { instance, stored } = tracker('proactive', { current: 'activity' });
    playTurn(instance, 'in-1');
    instance.observeProgress(
      'in-1',
      ev('commentary', {
        agentScope: 'main',
        text: '先确认环境',
        progress: true,
      }),
      1_050,
    );
    instance.observe(
      'in-1',
      ev('commentary', { agentScope: 'main', text: '我先读文件。' }),
      1_060,
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    const texts = JSON.parse(stored[0].stepsJson!).filter(
      (step: { kind: string }) => step.kind === 'text',
    );
    expect(texts).toEqual([
      expect.objectContaining({ progress: true, text: '先确认环境' }),
    ]);
  });

  test('activity keeps the structure but never the thinking text', () => {
    const { instance, stored } = tracker('proactive', { current: 'activity' });
    playTurn(instance, 'in-1');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(true);
    const [row] = stored;
    expect(row.thinking).toBe('');
    expect(row.thinkingDurationMs).toBeGreaterThan(0);
    expect(
      JSON.parse(row.traceJson).map((r: { title: string }) => r.title),
    ).toEqual(['工具 Bash', '工具结果', '工具完成 tool-1']);
  });

  test('full keeps thinking; no proactive level keeps what a tool returned', () => {
    const { instance, stored } = tracker('proactive', { current: 'full' });
    playTurn(instance, 'in-1');
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    const [row] = stored;
    expect(row.thinking).toBe('先看目录\n\n再总结');
    const result = JSON.parse(row.traceJson).find(
      (r: { title: string }) => r.title === '工具结果',
    );
    expect(result.detail).toBeUndefined();
    expect(row.traceJson).not.toContain('a.txt');
    expect(row.traceJson).not.toContain('这是答案');
  });

  test('the visibility is read live: a turn follows a change made while it runs', () => {
    const visibility = { current: 'hidden' as ProcessVisibility };
    const { instance, stored } = tracker('proactive', visibility);
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'Early', toolUseId: 'e' }),
    );
    visibility.current = 'activity';
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'Late', toolUseId: 'l' }),
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-1' });
    expect(
      JSON.parse(stored[0].traceJson).map((r: { title: string }) => r.title),
    ).toEqual(['工具 Late']);

    // lowered to hidden before the turn settles: nothing is written
    visibility.current = 'full';
    instance.observe(
      'in-2',
      ev('tool_use_start', { toolName: 'X', toolUseId: 'x' }),
    );
    visibility.current = 'hidden';
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-2' })).toBe(false);
    expect(stored).toHaveLength(1);
  });

  test('a held reply sequence is written under its first turn id, and grows', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
      10,
    );
    // first held part: the sequence's DB turn id is the first input's
    instance.persist({
      chatJid: 'web:a',
      inputId: 'in-1',
      turnId: 'in-1',
      keep: true,
    });
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'B', toolUseId: 'b' }),
      20,
    );
    // the continuation turn has its own input id
    instance.observe(
      'in-2',
      ev('tool_use_start', { toolName: 'C', toolUseId: 'c' }),
      30,
    );
    instance.persist({ chatJid: 'web:a', inputId: 'in-2', turnId: 'in-1' });
    expect(stored.map((s) => s.turnId)).toEqual(['in-1', 'in-1']);
    expect(
      JSON.parse(stored[1].traceJson).map((r: { title: string }) => r.title),
    ).toEqual(['工具 A', '工具 B', '工具 C']);
    // the steps grow with the sequence, each part after the one before
    expect(
      JSON.parse(stored[0].stepsJson!).map(
        (s: { toolName: string }) => s.toolName,
      ),
    ).toEqual(['A']);
    const steps = JSON.parse(stored[1].stepsJson!);
    expect(steps.map((s: { toolName: string }) => s.toolName)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(new Set(steps.map((s: { id: string }) => s.id)).size).toBe(3);
  });

  test('a background sub-agent that ends in a later part of a held reply sequence is still one step', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'in-1',
      ev('tool_use_start', {
        toolName: 'Agent',
        toolUseId: 'ag1',
        toolInputSummary: '后台调研',
      }),
      10,
    );
    instance.observe(
      'in-1',
      ev('task_start', {
        taskId: 'ag1',
        toolUseId: 'ag1',
        taskDescription: '后台调研',
      }),
      20,
    );
    // the first part is delivered while the sub-agent still runs
    instance.persist({
      chatJid: 'web:a',
      inputId: 'in-1',
      turnId: 'in-1',
      keep: true,
      now: 100,
    });
    // the continuation turn only hears that it finished
    instance.observe(
      'in-2',
      ev('task_notification', {
        taskId: 'ag1',
        toolUseId: 'ag1',
        taskStatus: 'completed',
        taskSummary: '调研完成：3 处',
      }),
      900,
    );
    instance.persist({
      chatJid: 'web:a',
      inputId: 'in-2',
      turnId: 'in-1',
      now: 1_000,
    });
    expect(stored).toHaveLength(2);
    const steps = JSON.parse(stored[1].stepsJson!);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      id: 'task-ag1',
      kind: 'task',
      title: '后台调研',
      summary: '调研完成：3 处',
      status: 'done',
      endedAt: 900,
    });
  });

  test('a failing store never loses the reply', () => {
    const instance = new TurnTraceTracker({
      mode: 'assistant',
      getVisibility: () => 'full',
      store: () => {
        throw new Error('disk full');
      },
    });
    instance.observe(
      'in-1',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
    );
    expect(instance.persist({ chatJid: 'web:a', inputId: 'in-1' })).toBe(false);
  });

  test('discard forgets a turn; a queue of unsettled turns stays bounded', () => {
    const { instance, stored } = tracker('assistant');
    instance.observe(
      'gone',
      ev('tool_use_start', { toolName: 'A', toolUseId: 'a' }),
    );
    instance.discard('gone');
    expect(instance.persist({ chatJid: 'web:a', inputId: 'gone' })).toBe(false);

    for (let i = 0; i < 100; i += 1) {
      instance.observe(
        `t${i}`,
        ev('tool_use_start', { toolName: 'A', toolUseId: `a${i}` }),
      );
    }
    expect(instance.persist({ chatJid: 'web:a', inputId: 't0' })).toBe(false);
    expect(instance.persist({ chatJid: 'web:a', inputId: 't99' })).toBe(true);
    expect(stored).toHaveLength(1);
  });
});

function createUser(id: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

function createWorkspace(
  folder: string,
  mode: InteractionMode,
  visibility: ProcessVisibility,
): void {
  const profile = db.getOrCreateDefaultAgentProfile(OWNER);
  db.setRegisteredGroup(`web:${folder}`, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    created_by: OWNER,
    executionMode: 'container',
  });
  db.assignWorkspaceAgentProfile(folder, profile.id, mode, visibility);
}

const JID = 'web:trace-chat';
let minute = 0;

function storeMessage(
  id: string,
  turnId: string | undefined,
  options: { fromMe?: boolean; sender?: string; chatJid?: string } = {},
): void {
  const chatJid = options.chatJid ?? JID;
  db.ensureChatExists(chatJid);
  minute += 1;
  db.storeMessageDirect(
    id,
    chatJid,
    options.sender ?? (options.fromMe === false ? 'user-1' : 'happyclaw-agent'),
    options.fromMe === false ? 'User' : 'HappyClaw',
    `content ${id}`,
    `2026-10-12T00:${String(minute).padStart(2, '0')}:00.000Z`,
    options.fromMe !== false,
    turnId ? { meta: { turnId } } : undefined,
  );
}

function storeTrace(turnId: string, chatJid = JID): void {
  db.upsertTurnTrace({
    chatJid,
    turnId,
    thinking: '想了想',
    thinkingDurationMs: 1_200,
    traceJson: JSON.stringify([
      { id: '1-a', timestamp: 1, kind: 'tool', title: '工具 Bash' },
    ]),
  });
}

describe('stored traces and the messages that carry them', () => {
  beforeAll(() => {
    db.initDatabase();
    createUser(OWNER);
  });
  afterAll(() => {
    db.closeDatabase();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the real store keeps what the tracker collected', () => {
    const real = new TurnTraceTracker({
      mode: 'assistant',
      getVisibility: () => 'full',
    });
    playTurn(real, 'real-1');
    storeMessage('m-real', 'real-1');
    expect(real.persist({ chatJid: JID, inputId: 'real-1' })).toBe(true);
    const record = db.getTurnTrace(JID, 'real-1')!;
    expect(record.thinking).toBe('先看目录\n\n再总结');
    expect(presentTurnTrace(record, { includeThinking: true })).toMatchObject({
      turn_id: 'real-1',
      thinking: '先看目录\n\n再总结',
      thinking_duration_ms: record.thinking_duration_ms,
      trace: [
        { title: '工具 Bash' },
        { title: '工具结果' },
        { title: '工具完成 tool-1' },
      ],
      steps: [
        { kind: 'thinking', text: '先看目录' },
        { kind: 'tool', toolName: 'Bash' },
        { kind: 'thinking', text: '再总结' },
      ],
      steps_dropped: 0,
    });
  });

  test('a stored turn without steps reads as none', () => {
    storeTrace('no-steps');
    const record = db.getTurnTrace(JID, 'no-steps')!;
    expect(record.steps_json).toBe('[]');
    expect(record.steps_dropped).toBe(0);
    expect(presentTurnTrace(record, { includeThinking: true })).toMatchObject({
      steps: [],
      steps_dropped: 0,
    });
  });

  test('presenting honours the exposure and survives a damaged trace', () => {
    storeTrace('present-1');
    const record = db.getTurnTrace(JID, 'present-1')!;
    expect(presentTurnTrace(record, { includeThinking: false })).toMatchObject({
      thinking: '',
      thinking_duration_ms: 1_200,
    });
    expect(
      presentTurnTrace(
        { ...record, trace_json: '{not json' },
        { includeThinking: true },
      ),
    ).toMatchObject({ thinking: '想了想', trace: [] });
  });

  test('the newest agent message of a turn is its last one', () => {
    storeMessage('t1-user', 'turn-1', { fromMe: false });
    storeMessage('t1-a', 'turn-1');
    storeMessage('t1-b', 'turn-1');
    storeMessage('t1-notice', 'turn-1', { sender: '__system__' });
    expect(db.getLastAgentMessageIdForTurn(JID, 'turn-1')).toBe('t1-b');
    expect(
      db.getLastAgentMessageIdForTurn(JID, 'no-such-turn'),
    ).toBeUndefined();
    expect(
      db.getLastAgentMessageIdForTurn('web:other', 'turn-1'),
    ).toBeUndefined();
  });

  test('has_trace goes on the last agent message of a traced turn only', () => {
    storeMessage('t2-user', 'turn-2', { fromMe: false });
    storeMessage('t2-a', 'turn-2');
    storeMessage('t2-b', 'turn-2');
    storeMessage('t3-a', 'turn-3');
    storeMessage('t4-a', undefined);
    storeTrace('turn-2');
    const wanted = new Set(['t2-user', 't2-a', 't2-b', 't3-a', 't4-a']);
    const listed = db
      .getMessagesPage(JID, undefined, 200)
      .filter((m) => wanted.has(m.id));
    expect(listed).toHaveLength(5);
    const marked = markMessagesWithTrace(listed, { includeThinking: true });
    expect(marked.filter((m) => m.has_trace).map((m) => m.id)).toEqual([
      't2-b',
    ]);

    // a page that ends before the turn does: the flag waits for the page that
    // holds the true last message
    const olderPage = marked.filter((m) => m.id !== 't2-b');
    expect(
      markMessagesWithTrace(olderPage, { includeThinking: true }).some(
        (m) => m.has_trace,
      ),
    ).toBe(false);

    // where the process is hidden, a turn without progress is not flagged
    expect(
      markMessagesWithTrace(listed, {
        progressOnly: true,
        includeThinking: false,
        proactive: true,
      }).some((m) => m.has_trace),
    ).toBe(false);
  });

  test('at hidden, the turns that sent progress are flagged and read as that progress alone', () => {
    // The tracker of a hidden workspace keeps the progress statements only;
    // a refresh then finds them on the turn's last reply.
    const real = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'hidden',
    });
    playTurn(real, 'hid-1');
    real.observeProgress(
      'hid-1',
      ev('commentary', {
        agentScope: 'main',
        text: '先看日志',
        progress: true,
      }),
      1_050,
    );
    // narration is not progress, whatever the level it was sent at
    real.observe(
      'hid-1',
      ev('commentary', { agentScope: 'main', text: '我先读文件。' }),
      1_060,
    );
    storeMessage('hid-1-reply', 'hid-1');
    storeMessage('hid-2-reply', 'hid-2');
    storeTrace('hid-2');
    expect(real.persist({ chatJid: JID, inputId: 'hid-1' })).toBe(true);

    const hidden = {
      progressOnly: true,
      includeThinking: false,
      proactive: true,
    } as const;
    const listed = db
      .getMessagesPage(JID, undefined, 200)
      .filter((m) => m.id === 'hid-1-reply' || m.id === 'hid-2-reply');
    expect(
      markMessagesWithTrace(listed, hidden)
        .filter((m) => m.has_trace)
        .map((m) => m.id),
    ).toEqual(['hid-1-reply']);

    const record = db.getTurnTrace(JID, 'hid-1')!;
    expect(record.thinking).toBe('');
    expect(record.trace_json).toBe('[]');
    expect(presentTurnTrace(record, hidden)).toMatchObject({
      thinking: '',
      thinking_duration_ms: null,
      trace: [],
      steps: [{ kind: 'text', progress: true, text: '先看日志' }],
    });
    expect(presentTurnTrace(record, hidden)!.steps).toHaveLength(1);
    // a turn without progress shows nothing at all at hidden
    expect(presentTurnTrace(db.getTurnTrace(JID, 'hid-2')!, hidden)).toBeNull();
  });

  test('a closing note is kept out of the history a fresh session replays', () => {
    storeMessage('hist-user', 'hist-1', { fromMe: false });
    storeMessage('hist-note', 'hist-1');
    db.excludeMessageFromHistoryRecovery(JID, 'hist-note');
    const replayed = db
      .getConversationHistoryMessagesPage(JID, new Set(), 200)
      .map((m) => m.id);
    expect(replayed).toContain('hist-user');
    expect(replayed).not.toContain('hist-note');
    // The chat still lists it.
    expect(
      db.getMessagesPage(JID, undefined, 200).some((m) => m.id === 'hist-note'),
    ).toBe(true);
  });

  test('a trace stored at a higher level shows only its progress once hidden', () => {
    const real = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'full',
    });
    playTurn(real, 'lvl-1');
    real.observeProgress(
      'lvl-1',
      ev('commentary', {
        agentScope: 'main',
        text: '已经找到原因',
        progress: true,
      }),
      1_050,
    );
    storeMessage('lvl-1-reply', 'lvl-1');
    expect(real.persist({ chatJid: JID, inputId: 'lvl-1' })).toBe(true);
    const record = db.getTurnTrace(JID, 'lvl-1')!;
    const kinds = (exposure: Parameters<typeof presentTurnTrace>[1]) =>
      presentTurnTrace(record, exposure)!.steps.map((step) =>
        step.kind === 'text' ? `text:${step.text}` : step.kind,
      );
    expect(kinds({ includeThinking: true, proactive: true })).toContain(
      'text:已经找到原因',
    );
    expect(kinds({ includeThinking: false, proactive: true })).toEqual([
      'thinking',
      'tool',
      'thinking',
      'text:已经找到原因',
    ]);
    expect(
      kinds({ progressOnly: true, includeThinking: false, proactive: true }),
    ).toEqual(['text:已经找到原因']);
  });

  test('deleting the last message of a turn takes its trace along', () => {
    storeMessage('t5-a', 'turn-5');
    storeMessage('t5-b', 'turn-5');
    storeTrace('turn-5');
    expect(db.deleteMessage(JID, 't5-a')).toBe(true);
    expect(db.getTurnTrace(JID, 'turn-5')).toBeDefined();
    expect(db.deleteMessage(JID, 't5-b')).toBe(true);
    expect(db.getTurnTrace(JID, 'turn-5')).toBeUndefined();
  });

  test('clearing a chat removes its traces and spares the others', () => {
    const other = 'web:trace-other';
    storeMessage('c-a', 'turn-c', { chatJid: 'web:trace-clear' });
    storeMessage('o-a', 'turn-c', { chatJid: other });
    storeTrace('turn-c', 'web:trace-clear');
    storeTrace('turn-c', other);
    db.deleteChatHistory('web:trace-clear');
    expect(db.getTurnTrace('web:trace-clear', 'turn-c')).toBeUndefined();
    expect(db.getTurnTrace(other, 'turn-c')).toBeDefined();
  });

  test('a chat tree takes its Runtime Session traces with it, exactly', () => {
    const base = 'web:tree_1';
    for (const jid of [
      base,
      `${base}#agent:s1`,
      `${base}#agent:s2`,
      'web:treeX1',
      `${base}2`,
    ]) {
      storeMessage(`tree-${jid}`, 'turn-t', { chatJid: jid });
      storeTrace('turn-t', jid);
    }
    expect(db.deleteTurnTracesForChatTree(base)).toBe(3);
    expect(db.getTurnTrace('web:treeX1', 'turn-t')).toBeDefined();
    expect(db.getTurnTrace(`${base}2`, 'turn-t')).toBeDefined();
    expect(db.getTurnTrace(`${base}#agent:s1`, 'turn-t')).toBeUndefined();
  });

  test('exposure follows the workspace contract and its current visibility', () => {
    createWorkspace('expo-assistant', 'assistant', 'hidden');
    createWorkspace('expo-hidden', 'proactive', 'hidden');
    createWorkspace('expo-activity', 'proactive', 'activity');
    createWorkspace('expo-full', 'proactive', 'full');
    expect(resolveTurnTraceExposure('expo-assistant')).toEqual({
      includeThinking: true,
    });
    expect(resolveTurnTraceExposure('expo-hidden')).toEqual({
      progressOnly: true,
      includeThinking: false,
      proactive: true,
    });
    expect(resolveTurnTraceExposure('expo-activity')).toEqual({
      progressOnly: false,
      includeThinking: false,
      proactive: true,
    });
    expect(resolveTurnTraceExposure('expo-full')).toEqual({
      progressOnly: false,
      includeThinking: true,
      proactive: true,
    });
    // fire-and-forget Spawn Agents keep Assistant semantics
    expect(
      resolveTurnTraceExposure('expo-hidden', { agentKind: 'spawn' }),
    ).toEqual({
      includeThinking: true,
    });
    // a change takes effect at once, whatever the turn was recorded under
    db.setWorkspaceProcessVisibility('expo-hidden', 'full');
    expect(resolveTurnTraceExposure('expo-hidden').progressOnly).toBe(false);
  });
});
