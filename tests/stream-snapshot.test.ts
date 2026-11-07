import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-snapshot-'));
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
const web = await import('../src/web.js');

import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';

let sequence = 0;
/** A fresh workspace JID with an exact run, so its events are accepted. */
function startRun(): {
  jid: string;
  emit: (type: StreamEventType, extra?: Partial<StreamEvent>) => void;
} {
  sequence += 1;
  const jid = `web:snapshot-${sequence}`;
  const runId = `run-${sequence}`;
  web.broadcastRunStarted(jid, runId, Date.now());
  return {
    jid,
    emit: (eventType, extra = {}) =>
      web.broadcastStreamEvent(jid, {
        eventType,
        turnId: 'turn-1',
        ...extra,
      } as StreamEvent),
  };
}

beforeAll(() => {
  db.initDatabase();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('stream_snapshot of a run in progress', () => {
  test('a run that has shown nothing yet restores nothing', () => {
    const run = startRun();
    run.emit('status', { statusText: 'requesting' });
    expect(web.buildStreamSnapshot(run.jid)).toBeNull();
    expect(web.buildStreamSnapshot('web:never-ran')).toBeNull();
  });

  test('the reasoning arrives whole, separated per block and timed from the request', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00.000Z'));
    const run = startRun();
    run.emit('status', { statusText: 'requesting' });
    vi.setSystemTime(new Date('2026-10-12T00:00:14.000Z'));
    run.emit('thinking_start');
    run.emit('thinking_delta', { text: '先看目录。' });
    vi.setSystemTime(new Date('2026-10-12T00:00:16.000Z'));

    let { snapshot } = web.buildStreamSnapshot(run.jid)!;
    expect(snapshot.thinkingText).toBe('先看目录。');
    expect(snapshot.isThinking).toBe(true);
    // backdated to the model request, not the first delta
    expect(snapshot.thinkingStartedAt).toBe(
      Date.parse('2026-10-12T00:00:00.000Z'),
    );
    expect(snapshot.thinkingDurationMs).toBeUndefined();

    run.emit('thinking_end', { thinkingDurationMs: 100 });
    run.emit('tool_use_start', { toolName: 'Bash', toolUseId: 't1' });
    vi.setSystemTime(new Date('2026-10-12T00:00:20.000Z'));
    run.emit('tool_use_end', { toolUseId: 't1' });
    run.emit('status', { statusText: 'requesting' });
    run.emit('thinking_start');
    run.emit('thinking_delta', { text: '再总结。' });

    ({ snapshot } = web.buildStreamSnapshot(run.jid)!);
    expect(snapshot.thinkingText).toBe('先看目录。\n\n再总结。');
    expect(snapshot.isThinking).toBe(true);
    // the first burst ended at the tool call: 16s after the request
    expect(snapshot.thinkingDurationMs).toBe(16_000);
    expect(snapshot.thinkingStartedAt).toBe(
      Date.parse('2026-10-12T00:00:20.000Z'),
    );
    expect(snapshot.phaseStartedAt).toBeUndefined();

    run.emit('text_delta', { text: '答' });
    ({ snapshot } = web.buildStreamSnapshot(run.jid)!);
    expect(snapshot.isThinking).toBe(false);
    expect(snapshot.thinkingStartedAt).toBeUndefined();
    expect(snapshot.partialText).toBe('答');
  });

  test('a reasoning block without text is still a reasoning run', () => {
    const run = startRun();
    run.emit('thinking_start');
    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    expect(snapshot.thinkingText).toBe('');
    expect(snapshot.isThinking).toBe(true);
    expect(snapshot.thinkingStartedAt).toBeTypeOf('number');
  });

  test('reasoning is kept to the last 32000 characters, cut at a paragraph', () => {
    const run = startRun();
    const paragraph = (i: number) => `${i}:${'思'.repeat(995)}`; // 1000 chars
    for (let i = 0; i < 60; i += 1) {
      run.emit('thinking_delta', {
        text: i === 0 ? paragraph(i) : `\n\n${paragraph(i)}`,
      });
    }
    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    const text = snapshot.thinkingText!;
    expect(text.length).toBeLessThanOrEqual(32_000);
    expect(text.length).toBeGreaterThan(30_000);
    // starts at a paragraph, ends with the newest
    expect(text).toMatch(/^\d+:思/);
    expect(text.endsWith(paragraph(59))).toBe(true);
  });

  test('running tools keep what the Web needs to draw them', () => {
    const run = startRun();
    run.emit('tool_use_start', {
      toolName: 'Skill',
      toolUseId: 'skill-1',
      skillName: 'pdf',
      toolInputSummary: 'skill: pdf',
    });
    run.emit('tool_progress', {
      toolUseId: 'skill-1',
      toolInput: { questions: [{ question: '选哪个?' }] },
      elapsedSeconds: 4,
    });
    run.emit('tool_use_start', {
      toolName: 'Read',
      toolUseId: 'nested-1',
      parentToolUseId: 'skill-1',
      isNested: true,
    });
    // progress for a tool started before this projection began
    run.emit('tool_progress', {
      toolName: 'Bash',
      toolUseId: 'late-1',
      elapsedSeconds: 9,
    });

    let { snapshot } = web.buildStreamSnapshot(run.jid)!;
    expect(snapshot.activeTools).toMatchObject([
      {
        toolUseId: 'skill-1',
        skillName: 'pdf',
        toolInputSummary: 'skill: pdf',
        toolInput: { questions: [{ question: '选哪个?' }] },
        elapsedSeconds: 4,
      },
      { toolUseId: 'nested-1', isNested: true, parentToolUseId: 'skill-1' },
      { toolUseId: 'late-1', toolName: 'Bash', elapsedSeconds: 9 },
    ]);

    // a repeated start updates the tool instead of listing it twice
    run.emit('tool_use_start', {
      toolName: 'Skill',
      toolUseId: 'skill-1',
      skillName: 'pdf',
      toolInputSummary: 'skill: pdf (2)',
    });
    run.emit('tool_use_end', { toolUseId: 'nested-1' });
    ({ snapshot } = web.buildStreamSnapshot(run.jid)!);
    expect(snapshot.activeTools.map((t) => t.toolUseId)).toEqual([
      'skill-1',
      'late-1',
    ]);
    expect(snapshot.activeTools[0].toolInputSummary).toBe('skill: pdf (2)');
  });

  test('sub-agent states carry their recent tools, like the live Web state', () => {
    const run = startRun();
    run.emit('task_start', {
      taskId: 'task-1',
      toolUseId: 'task-1',
      taskDescription: '审查代码',
    });
    run.emit('tool_use_start', {
      toolName: 'Grep',
      toolUseId: 'g1',
      parentToolUseId: 'task-1',
      toolInputSummary: 'pattern: TODO',
    });
    run.emit('tool_use_start', {
      toolName: 'Skill',
      toolUseId: 'g2',
      skillName: 'lint',
      parentToolUseId: 'task-1',
    });
    run.emit('tool_progress', {
      toolUseId: 'g1',
      parentToolUseId: 'task-1',
      elapsedSeconds: 3,
    });
    run.emit('tool_use_end', {
      toolUseId: 'g1',
      toolName: 'Grep',
      parentToolUseId: 'task-1',
    });

    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    const task = snapshot.taskStates!['task-1'] as {
      recentTools: Array<{ kind: string; text: string }>;
      activeTools: Array<{ toolUseId: string }>;
    };
    expect(task.recentTools.map((r) => [r.kind, r.text])).toEqual([
      ['tool', '工具 Grep (pattern: TODO)'],
      ['skill', '技能 lint'],
      ['tool', '✓ Grep'],
    ]);
    expect(task.activeTools.map((t) => t.toolUseId)).toEqual(['g2']);
  });

  test('a sub-agent a stop killed is restored as stopped, not failed', () => {
    const run = startRun();
    for (const id of ['notified', 'killed', 'failed']) {
      run.emit('task_start', { taskId: id, toolUseId: id });
    }
    run.emit('task_notification', {
      taskId: 'notified',
      taskStatus: 'stopped',
    });
    run.emit('task_updated', {
      taskId: 'killed',
      taskPatch: { status: 'killed' },
    });
    run.emit('task_updated', {
      taskId: 'failed',
      taskPatch: { status: 'failed' },
    });
    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    const status = (id: string) =>
      (snapshot.taskStates![id] as { status: string }).status;
    expect(status('notified')).toBe('stopped');
    expect(status('killed')).toBe('stopped');
    expect(status('failed')).toBe('error');
  });

  test('trace rows read exactly as the Web builds them', () => {
    const run = startRun();
    run.emit('tool_use_start', {
      toolName: 'Bash',
      toolUseId: 't1',
      toolInputSummary: 'command: ls',
    });
    run.emit('tool_use_start', {
      toolName: 'Skill',
      toolUseId: 't2',
      skillName: 'pdf',
    });
    // not rows: the SDK heartbeat, debug events, reasoning markers, lifecycle
    run.emit('tool_progress', {
      toolName: 'Bash',
      toolUseId: 't1',
      elapsedSeconds: 3,
    });
    run.emit('raw_sdk_event', {
      rawType: 'stream_event/message_stop',
      displayLevel: 'debug',
    });
    run.emit('thinking_start');
    run.emit('status', { statusText: 'compacting' });
    run.emit('tool_result', { toolUseId: 't1', toolResult: 'a', detail: 'a' });
    run.emit('permission_denied', { toolName: 'Write' });

    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    expect(snapshot.traceEvents!.map((r) => [r.kind, r.title])).toEqual([
      ['tool', '工具 Bash'],
      ['skill', '技能 pdf'],
      ['tool', '工具结果'],
      ['permission', '权限拒绝 Write'],
    ]);
    expect(snapshot.traceEvents![0].summary).toBe('command: ls');
  });

  test('tool progress updates the tool row, so a reconnect shows what the live view did', () => {
    const run = startRun();
    run.emit('tool_use_start', { toolName: 'Skill', toolUseId: 's1' });
    run.emit('tool_use_start', { toolName: 'Bash', toolUseId: 'b1' });
    for (let i = 0; i < 30; i += 1) {
      run.emit('tool_progress', {
        toolName: 'Bash',
        toolUseId: 'b1',
        elapsedSeconds: i,
      });
    }
    run.emit('tool_progress', {
      toolName: 'Skill',
      toolUseId: 's1',
      skillName: 'pdf',
    });
    run.emit('tool_progress', {
      toolName: 'Bash',
      toolUseId: 'b1',
      toolInputSummary: 'command: make test',
    });

    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    expect(
      snapshot.traceEvents!.map((r) => [r.kind, r.title, r.summary]),
    ).toEqual([
      ['skill', '技能 pdf', undefined],
      ['tool', '工具 Bash', 'command: make test'],
    ]);
    // the running tools themselves are tracked separately, and still advance
    expect(
      snapshot.activeTools.find((t) => t.toolUseId === 'b1'),
    ).toMatchObject({
      elapsedSeconds: 29,
      toolInputSummary: 'command: make test',
    });
  });

  test('the trace keeps the newest 200 rows', () => {
    const run = startRun();
    for (let i = 0; i < 230; i += 1) {
      run.emit('tool_use_start', { toolName: `T${i}`, toolUseId: `t${i}` });
    }
    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    expect(snapshot.traceEvents).toHaveLength(200);
    expect(snapshot.traceEvents![0].title).toBe('工具 T30');
  });

  test('the narration before a tool call (commentary) is nowhere in what a client or a shutdown keeps', () => {
    const run = startRun();
    run.emit('status', { statusText: 'requesting' });
    run.emit('commentary', { text: '这是一段过程说明，不能进入任何快照。' });
    run.emit('tool_use_start', { toolName: 'Read', toolUseId: 't1' });
    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    // It is a live-only note: no partial reply text, no event line, no trace
    // row, no sub-agent tail, and nothing the shutdown would save as a reply.
    expect(snapshot.partialText).toBe('');
    expect(JSON.stringify(snapshot)).not.toContain('过程说明');
    expect(snapshot.traceEvents!.map((row) => row.title)).toEqual([
      '工具 Read',
    ]);
    expect(web.getActiveStreamingTexts().get(run.jid)).toBeUndefined();
  });

  test('a new turn starts a fresh projection; idle without a run clears it', () => {
    const run = startRun();
    run.emit('thinking_delta', { text: '旧回合' });
    expect(web.buildStreamSnapshot(run.jid)!.snapshot.thinkingText).toBe(
      '旧回合',
    );
    web.broadcastStreamEvent(run.jid, {
      eventType: 'thinking_delta',
      text: '新回合',
      turnId: 'turn-2',
    } as StreamEvent);
    const { snapshot } = web.buildStreamSnapshot(run.jid)!;
    expect(snapshot.thinkingText).toBe('新回合');
    expect(snapshot.turnId).toBe('turn-2');
  });
});
