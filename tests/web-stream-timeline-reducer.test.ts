import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  GroupInfo,
  Message,
  StreamEvent,
  StreamSnapshotData,
} from '../web/src/stores/chat';
import {
  THINKING_OMITTED_MARKER,
  MAX_THINKING_TEXT,
} from '../web/src/lib/thinking-text';
import { answerStart } from '../web/src/lib/stream-steps';
import { SPEECH_TOOL_NAME } from '../web/src/lib/process-visibility';
import { countTraceTools } from '../web/src/components/chat/ExecutionTrace';

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: apiPatchMock,
    delete: vi.fn(),
  },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));

vi.mock('../web/src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../web/src/stores/files', () => ({
  useFileStore: { getState: () => ({ loadFiles: vi.fn() }) },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

vi.mock('../web/src/utils/toast', () => ({
  showToast: vi.fn(),
  notifyIfHidden: vi.fn(),
  shouldEmitBackgroundTaskNotice: vi.fn(() => false),
  showNotificationPromptToast: vi.fn(),
}));

vi.mock('../web/src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { useChatStore } = await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

const JID = 'web:timeline';
const SESSION = 'session-1';
const SESSION_JID = `${JID}#agent:${SESSION}`;
const RUN = 'run-1';

const rafCallbacks: FrameRequestCallback[] = [];
function flushRaf(): void {
  for (const cb of rafCallbacks.splice(0)) cb(0);
}

function reset(): void {
  useChatStore.setState(
    {
      ...initialState,
      groups: {},
      activeRuns: {},
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stopRequests: {},
      settledStreaming: {},
      clearing: {},
      agents: {},
      agentStreaming: {},
      activeAgentTab: {},
      agentMessages: {},
      agentWaiting: {},
      agentHasMore: {},
      unreadReplies: {},
    },
    true,
  );
}

function emit(event: StreamEvent, agentId: string = SESSION): void {
  useChatStore.getState().handleStreamEvent(JID, event, agentId, RUN);
}

/** Emit a thinking or text delta and let the frame apply it. */
function delta(kind: 'thinking_delta' | 'text_delta', text: string): void {
  emit({ eventType: kind, text });
  flushRaf();
}

function tool(id: string, name = 'Read', summary?: string): void {
  emit({
    eventType: 'tool_use_start',
    toolName: name,
    toolUseId: id,
    toolInputSummary: summary,
  });
}

const live = () => useChatStore.getState().agentStreaming[SESSION]!;

function setWorkspace(
  mode: 'assistant' | 'proactive',
  visibility?: 'hidden' | 'activity' | 'full',
): void {
  useChatStore.setState({
    groups: {
      [JID]: {
        name: 'w',
        folder: 'timeline',
        added_at: '2026-01-01T00:00:00.000Z',
        interaction_mode: mode,
        process_visibility: visibility,
      } as GroupInfo,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rafCallbacks.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks[id - 1] = () => {};
  });
  reset();
  useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reasoning text', () => {
  it('separates bursts with a blank line, not the first one', () => {
    delta('thinking_delta', '先读文件。');
    expect(live().thinkingText).toBe('先读文件。');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('thinking_delta', '再比较方案。');
    expect(live().thinkingText).toBe('先读文件。\n\n再比较方案。');
    delta('thinking_delta', '继续。');
    expect(live().thinkingText).toBe('先读文件。\n\n再比较方案。继续。');
  });

  it('opens a burst at thinking_start without adding a second gap', () => {
    delta('thinking_delta', '第一段。');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    emit({ eventType: 'thinking_start' });
    expect(live().isThinking).toBe(true);
    delta('thinking_delta', '第二段。');
    expect(live().thinkingText).toBe('第一段。\n\n第二段。');
    expect(live().steps?.filter((s) => s.kind === 'thinking')).toHaveLength(2);
  });

  it('starts a new block after the answer text', () => {
    delta('thinking_delta', '先想。');
    delta('text_delta', '部分回答。');
    delta('thinking_delta', '再想。');
    expect(live().thinkingText).toBe('先想。\n\n再想。');
  });

  it('ends the reasoning so far when a new request begins', () => {
    delta('thinking_delta', '第一段。');
    emit({ eventType: 'status', statusText: 'requesting' });
    expect(live().isThinking).toBe(false);
    expect(live().awaitingModel).toBe(true);
    delta('thinking_delta', '第二段。');
    expect(live().thinkingText).toBe('第一段。\n\n第二段。');
    expect(live().steps?.filter((s) => s.kind === 'thinking')).toHaveLength(2);
  });

  it('keeps one block through events that are not text, a tool or a request', () => {
    delta('thinking_delta', '先想');
    emit({
      eventType: 'hook_started',
      hookName: 'check',
      hookEvent: 'PreToolUse',
    });
    emit({ eventType: 'task_progress', taskId: 'task-1', summary: '子任务' });
    emit({ eventType: 'todo_update', todos: [] });
    emit({ eventType: 'status', statusText: 'compacting' });
    delta('thinking_delta', '下去。');
    // One block of text; the sub-agent that started in between is a step of
    // its own, so the reasoning continues in a second step.
    expect(live().thinkingText).toBe('先想下去。');
    expect(live().steps?.map((s) => s.kind)).toEqual([
      'thinking',
      'task',
      'thinking',
    ]);
  });

  it('keeps the main reasoning going through a sub-agents tool', () => {
    delta('thinking_delta', '先想');
    emit({
      eventType: 'tool_use_start',
      toolName: 'Read',
      toolUseId: 'sub-t1',
      parentToolUseId: 'task-1',
    });
    expect(live().isThinking).toBe(true);
    delta('thinking_delta', '下去。');
    expect(live().thinkingText).toBe('先想下去。');
  });

  it('is thinking from thinking_start even with no text at all', () => {
    emit({ eventType: 'status', statusText: 'requesting' });
    emit({ eventType: 'thinking_start' });
    expect(live().isThinking).toBe(true);
    expect(live().thinkingText).toBe('');
    expect(live().awaitingModel).toBe(false);
    emit({ eventType: 'thinking_end', thinkingDurationMs: 4200 });
    expect(live().isThinking).toBe(false);
    expect(live().thinkingDurationMs).toBe(4200);
    expect(live().steps?.[0]).toMatchObject({
      kind: 'thinking',
      status: 'done',
      durationMs: 4200,
    });
  });

  it('adds up the models own timing over bursts', () => {
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_end', thinkingDurationMs: 1500 });
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_end', thinkingDurationMs: 2500 });
    expect(live().thinkingDurationMs).toBe(4000);
    // Text after the end does not count the burst a second time.
    delta('text_delta', '回答');
    expect(live().thinkingDurationMs).toBe(4000);
  });

  it('counts the wait before reasoning that returns no text and arrives whole', () => {
    // A model that reasons silently (the ChatGPT subscription's): nothing for
    // 13 s, then the reasoning block opens and closes within a frame, with a
    // timing of a few milliseconds. The reply thought for 13 s, and says so.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    emit({ eventType: 'status', statusText: 'requesting' });
    vi.setSystemTime(new Date('2026-10-10T00:00:13.000Z'));
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_end', thinkingDurationMs: 3 });
    expect(live().thinkingDurationMs).toBe(13_000);
    expect(live().steps?.[0]).toMatchObject({
      kind: 'thinking',
      status: 'done',
      text: '',
      durationMs: 13_000,
    });
  });

  it('keeps timing by the clock when the runner sends no thinking events', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    delta('thinking_delta', '想');
    vi.setSystemTime(new Date('2026-10-10T00:00:05.000Z'));
    delta('text_delta', '答');
    expect(live().thinkingDurationMs).toBeGreaterThanOrEqual(5000);
  });

  it('ignores a sub-agents thinking events', () => {
    emit({ eventType: 'thinking_start', parentToolUseId: 'task-1' });
    emit({
      eventType: 'thinking_end',
      parentToolUseId: 'task-1',
      thinkingDurationMs: 9000,
    });
    expect(live()?.isThinking ?? false).toBe(false);
    expect(live()?.thinkingDurationMs).toBeUndefined();
  });

  it('keeps a title for the collapsed label', () => {
    delta('thinking_delta', '**确认订阅范围**\n\n先看 store。');
    expect(live().thinkingTitle).toBe('确认订阅范围');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('thinking_delta', '**比较方案**\n\n两种做法。');
    expect(live().thinkingTitle).toBe('比较方案');
  });

  it('bounds the text at a paragraph and says what it dropped', () => {
    const paragraph = (i: number) => `第 ${i} 段：${'思考内容'.repeat(25)}。`;
    for (let i = 0; i < 400; i += 1) {
      delta('thinking_delta', `${i === 0 ? '' : '\n\n'}${paragraph(i)}`);
    }
    const text = live().thinkingText;
    expect(text.length).toBeLessThanOrEqual(MAX_THINKING_TEXT);
    expect(text.startsWith(`${THINKING_OMITTED_MARKER}\n\n`)).toBe(true);
    expect(text.endsWith(paragraph(399))).toBe(true);
    const first = text.slice(THINKING_OMITTED_MARKER.length + 2);
    expect(first.startsWith('第 ')).toBe(true);
  });
});

describe('the wait for the model', () => {
  it('is the model at work from the request, until something comes back', () => {
    emit({ eventType: 'status', statusText: 'requesting' });
    expect(live().awaitingModel).toBe(true);
    expect(live().phaseStartedAt).toBeTypeOf('number');
    delta('thinking_delta', '想');
    expect(live().awaitingModel).toBe(false);

    emit({ eventType: 'status', statusText: 'requesting' });
    expect(live().awaitingModel).toBe(true);
    delta('text_delta', '答');
    expect(live().awaitingModel).toBe(false);
  });

  it('is cleared by a tool start too', () => {
    emit({ eventType: 'status', statusText: 'requesting' });
    tool('t1');
    expect(live().awaitingModel).toBe(false);
  });
});

describe('steps', () => {
  it('lists reasoning, tools and the answer in the order they happened', () => {
    delta('thinking_delta', '**计划**\n\n先读。');
    tool('t1', 'Read', 'a.ts');
    emit({ eventType: 'tool_result', toolUseId: 't1', toolResult: 'ok' });
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('text_delta', '结论。');
    const steps = live().steps!;
    expect(steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      'thinking:done',
      'tool:done',
      'text:running',
    ]);
    expect(steps[0].title).toBe('计划');
    expect(steps[1]).toMatchObject({
      toolName: 'Read',
      summary: 'a.ts',
      resultPreview: 'ok',
    });
    expect(answerStart(steps, live().partialBase ?? 0)).toBe(0);
  });

  it('turns text before a tool into commentary and puts the answer after it', () => {
    delta('text_delta', '我先看一下文件。');
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    delta('text_delta', '结论如下。');
    const state = live();
    expect(state.partialText).toBe('我先看一下文件。结论如下。');
    const kinds = state.steps!.map((s) => s.kind);
    expect(kinds).toEqual(['text', 'tool', 'text']);
    expect(state.steps![0]).toMatchObject({
      status: 'done',
      text: '我先看一下文件。',
    });
    const start = answerStart(state.steps, state.partialBase ?? 0)!;
    expect(state.partialText.slice(start)).toBe('结论如下。');
  });

  it('updates a tool in place and does not write a trace row per progress', () => {
    tool('t1', 'Bash');
    const rows = live().traceEvents.length;
    for (let i = 0; i < 30; i += 1) {
      emit({
        eventType: 'tool_progress',
        toolUseId: 't1',
        toolName: 'Bash',
        elapsedSeconds: i,
        toolInputSummary: i === 5 ? 'npm test' : undefined,
      });
    }
    expect(live().traceEvents).toHaveLength(rows);
    expect(live().steps![0].summary).toBe('npm test');
    const row = live().traceEvents.find((r) => r.toolUseId === 't1');
    expect(row).toMatchObject({ title: '工具 Bash', summary: 'npm test' });
  });

  it('starts a step for progress of a tool it never saw start', () => {
    emit({
      eventType: 'tool_progress',
      toolUseId: 'late',
      toolName: 'Grep',
      toolInputSummary: 'foo',
    });
    expect(live().steps![0]).toMatchObject({
      kind: 'tool',
      toolName: 'Grep',
      summary: 'foo',
    });
    expect(live().traceEvents.map((r) => r.title)).toEqual(['工具 Grep']);
  });

  it('says on the tools row what its progress says, as any trace row does', () => {
    tool('t1', 'Bash');
    emit({
      eventType: 'tool_progress',
      toolUseId: 't1',
      toolName: 'Bash',
      summary: '正在安装依赖',
    });
    const rows = live().traceEvents.filter((r) => r.toolUseId === 't1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '工具 Bash',
      summary: '正在安装依赖',
    });
  });

  it('renames the row of a tool that turns out to be a skill, once', () => {
    tool('t1', 'Skill');
    emit({
      eventType: 'tool_progress',
      toolUseId: 't1',
      toolName: 'Skill',
      skillName: 'deploy',
    });
    emit({
      eventType: 'tool_progress',
      toolUseId: 't1',
      toolName: 'Skill',
      skillName: 'deploy',
    });
    const rows = live().traceEvents.filter((r) => r.toolUseId === 't1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'skill', title: '技能 deploy' });
  });

  it('writes the row of a skill whose start it never saw, named as a start would', () => {
    emit({
      eventType: 'tool_progress',
      toolUseId: 'late',
      toolName: 'Skill',
      skillName: 'deploy',
      parentToolUseId: 'task-1',
    });
    expect(live().traceEvents).toHaveLength(1);
    expect(live().traceEvents[0]).toMatchObject({
      kind: 'skill',
      title: '技能 deploy',
      toolUseId: 'late',
      parentToolUseId: 'task-1',
    });
  });

  it('keeps no trace row for a bare heartbeat of a tool it never saw start', () => {
    emit({
      eventType: 'tool_progress',
      toolUseId: 'late',
      toolName: 'Grep',
      elapsedSeconds: 4,
    });
    expect(live().traceEvents).toEqual([]);
  });

  it('marks a failed result and a denied call as errors', () => {
    tool('t1', 'Bash');
    emit({
      eventType: 'tool_result',
      toolUseId: 't1',
      toolResult: '⚠️ 失败了',
    });
    tool('t2', 'Write');
    emit({
      eventType: 'permission_denied',
      permissionDenied: {
        toolName: 'Write',
        toolUseId: 't2',
        reason: '被权限策略拒绝',
        message: 'denied',
      },
    });
    const [first, second] = live().steps!;
    expect(first).toMatchObject({ status: 'error', resultPreview: '失败了' });
    expect(second).toMatchObject({
      status: 'error',
      resultPreview: '被权限策略拒绝',
    });
  });

  it('merges a Task tool, its task events and its progress into one step', () => {
    tool('task-1', 'Task', '检查滚动');
    emit({
      eventType: 'task_start',
      toolUseId: 'task-1',
      taskId: 'task-1',
      taskDescription: '检查移动端滚动',
    });
    emit({
      eventType: 'task_progress',
      toolUseId: 'task-1',
      taskId: 'task-1',
      summary: '已读完 3 个文件',
    });
    // Its own tools belong to its card, not the timeline.
    emit({
      eventType: 'tool_use_start',
      toolName: 'Read',
      toolUseId: 'inner',
      parentToolUseId: 'task-1',
      isNested: true,
    });
    let steps = live().steps!;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      kind: 'task',
      status: 'running',
      title: '检查移动端滚动',
      summary: '已读完 3 个文件',
    });
    emit({
      eventType: 'task_notification',
      taskId: 'task-1',
      toolUseId: 'task-1',
      taskStatus: 'completed',
      taskSummary: '检查完成',
    });
    steps = live().steps!;
    expect(steps[0]).toMatchObject({ status: 'done', summary: '检查完成' });
  });

  it('lists the tools run under a skill as the models own calls', () => {
    tool('skill-1', 'Skill');
    emit({
      eventType: 'tool_use_start',
      toolName: 'Edit',
      toolUseId: 'e1',
      parentToolUseId: 'skill-1',
      isNested: true,
    });
    expect(live().steps!.map((s) => s.toolUseId)).toEqual(['skill-1', 'e1']);
  });

  it('keeps the cap and counts what it dropped', () => {
    for (let i = 0; i < 130; i += 1) {
      tool(`t${i}`);
      emit({ eventType: 'tool_use_end', toolUseId: `t${i}` });
    }
    expect(live().steps).toHaveLength(100);
    expect(live().stepsDropped).toBe(30);
  });

  it('finishes the steps when the run settles', () => {
    delta('thinking_delta', '想。');
    tool('t1');
    delta('text_delta', '答案。');
    useChatStore.getState().handleRunFinished(SESSION_JID, RUN);
    const settled = useChatStore.getState().settledStreaming[SESSION_JID]!;
    expect(settled.steps!.every((s) => s.status !== 'running')).toBe(true);
    expect(settled.steps!.map((s) => s.kind)).toEqual([
      'thinking',
      'tool',
      'text',
    ]);
  });

  it('marks a tool that was running when the run was stopped', () => {
    delta('text_delta', '先说一句。');
    tool('t1', 'Bash');
    emit({ eventType: 'status', statusText: 'interrupted' });
    const frozen = useChatStore.getState().agentStreaming[SESSION]!;
    expect(frozen.interrupted).toBe(true);
    const bash = frozen.steps!.find((s) => s.toolUseId === 't1')!;
    expect(bash).toMatchObject({ status: 'error', resultPreview: '已停止' });
  });
});

describe('what a finished reply keeps', () => {
  const finalMessage = (id: string): Message => ({
    id,
    chat_jid: SESSION_JID,
    sender: 'happyclaw-agent',
    sender_name: 'HappyClaw',
    content: '最终答案。',
    timestamp: '2026-10-10T00:00:00.000Z',
    is_from_me: true,
    source_kind: 'sdk_final',
    finalization_reason: 'completed',
    turn_id: 'turn-1',
  });

  it('carries over thinking time even when the model gave no summary', () => {
    emit({ eventType: 'thinking_start', turnId: 'turn-1' });
    emit({
      eventType: 'thinking_end',
      thinkingDurationMs: 6400,
      turnId: 'turn-1',
    });
    delta('text_delta', '最终答案。');
    useChatStore.getState().handleRunFinished(SESSION_JID, RUN);
    expect(useChatStore.getState().settledStreaming[SESSION_JID]).toBeDefined();
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1'), SESSION);
    const state = useChatStore.getState();
    expect(state.thinkingCache['final-1']).toBeUndefined();
    expect(state.thinkingDurationCache['final-1']).toBe(6400);
  });

  it('settles a reply that only reasoned silently', () => {
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_end', thinkingDurationMs: 3000 });
    useChatStore.getState().handleRunFinished(SESSION_JID, RUN);
    expect(useChatStore.getState().settledStreaming[SESSION_JID]).toBeDefined();
  });

  it('does not settle a run with nothing to carry over', () => {
    tool('t1');
    emit({ eventType: 'tool_use_end', toolUseId: 't1' });
    useChatStore.getState().handleRunFinished(SESSION_JID, RUN);
    expect(
      useChatStore.getState().settledStreaming[SESSION_JID],
    ).toBeUndefined();
  });
});

describe('a proactive workspace', () => {
  beforeEach(() => {
    reset();
  });

  function start(): void {
    useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
  }

  it('never takes model text, at any level', () => {
    for (const level of ['hidden', 'activity', 'full'] as const) {
      reset();
      setWorkspace('proactive', level);
      start();
      emit({ eventType: 'text_delta', text: '内部想法' });
      flushRaf();
      emit({
        eventType: 'text_delta',
        text: '子 Agent 的话',
        parentToolUseId: 'task-1',
      });
      expect(
        useChatStore.getState().agentStreaming[SESSION]?.partialText ?? '',
      ).toBe('');
    }
  });

  it('takes the narration before a tool call as a step at the full level only', () => {
    for (const level of ['hidden', 'activity', 'full'] as const) {
      reset();
      setWorkspace('proactive', level);
      start();
      emit({ eventType: 'thinking_start' });
      emit({ eventType: 'thinking_end', thinkingDurationMs: 1500 });
      emit({ eventType: 'commentary', text: '先查一下记忆。' });
      tool('t1', 'Read', 'memory.md');
      const steps =
        useChatStore.getState().agentStreaming[SESSION]?.steps ?? [];
      const notes = steps.filter((step) => step.kind === 'text');
      if (level === 'full') {
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({
          commentary: true,
          status: 'done',
          text: '先查一下记忆。',
        });
        // Written before the call it introduces, after the reasoning.
        expect(steps.map((step) => step.kind)).toEqual([
          'thinking',
          'text',
          'tool',
        ]);
      } else {
        expect(notes, level).toHaveLength(0);
      }
      // Never the reply: no partial text, so no card for it.
      expect(
        useChatStore.getState().agentStreaming[SESSION]?.partialText ?? '',
      ).toBe('');
    }
  });

  it('keeps narration out of the trace rows and ends the reasoning burst', () => {
    setWorkspace('proactive', 'full');
    start();
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'commentary', text: '先看看。' });
    const state = live();
    expect(state.isThinking).toBe(false);
    expect(
      state.traceEvents.filter((row) => row.title.includes('先看看')),
    ).toEqual([]);
    expect(state.traceEvents).toEqual([]);
  });

  it("never takes a sub-Agent's narration", () => {
    setWorkspace('proactive', 'full');
    start();
    emit({
      eventType: 'commentary',
      text: '子 Agent 的话',
      agentScope: 'subagent',
      parentToolUseId: 'task-1',
    });
    expect(
      useChatStore.getState().agentStreaming[SESSION]?.steps ?? [],
    ).toEqual([]);
  });

  it('shows only the spinner when the process is hidden', () => {
    setWorkspace('proactive', 'hidden');
    start();
    emit({ eventType: 'status', statusText: 'requesting' });
    tool('t1', 'Bash', 'ls');
    emit({ eventType: 'thinking_start' });
    const state = live();
    expect(state.activeTools).toEqual([]);
    expect(state.steps ?? []).toEqual([]);
    expect(state.systemStatus).toBe('requesting');
  });

  it('takes the activity, never the reasoning text, at the activity level', () => {
    setWorkspace('proactive', 'activity');
    start();
    emit({ eventType: 'thinking_start' });
    emit({ eventType: 'thinking_delta', text: '不该出现的思考' });
    flushRaf();
    emit({ eventType: 'thinking_end', thinkingDurationMs: 2000 });
    tool('t1', 'Bash', 'npm test');
    emit({
      eventType: 'tool_result',
      toolUseId: 't1',
      toolResult: '秘密输出',
      detail: '秘密输出',
    });
    const state = live();
    expect(state.thinkingText).toBe('');
    expect(state.thinkingDurationMs).toBe(2000);
    const kinds = state.steps!.map((s) => s.kind);
    expect(kinds).toEqual(['thinking', 'tool']);
    expect(state.steps![1].resultPreview).toBeUndefined();
    expect(JSON.stringify(state.traceEvents)).not.toContain('秘密输出');
  });

  it('takes the reasoning text at the full level', () => {
    setWorkspace('proactive', 'full');
    start();
    emit({ eventType: 'thinking_start' });
    delta('thinking_delta', '**检查文件**\n\n先看目录。');
    expect(live().thinkingText).toContain('先看目录');
    expect(live().thinkingTitle).toBe('检查文件');
  });

  it('keeps what a sub-agent was asked and answered out, at every level', () => {
    for (const level of ['activity', 'full'] as const) {
      reset();
      setWorkspace('proactive', level);
      start();
      emit({
        eventType: 'task_start',
        taskId: 'task-1',
        toolUseId: 'task-1',
        taskDescription: '检查滚动',
        detail: '子 Agent 的提示词：不要泄露',
      });
      emit({
        eventType: 'task_notification',
        taskId: 'task-1',
        toolUseId: 'task-1',
        taskStatus: 'completed',
        taskResult: '子 Agent 的答复',
        toolResult: '子 Agent 的答复',
      });
      emit({
        eventType: 'task_progress',
        taskId: 'wf-1',
        taskType: 'local_workflow',
        workflowRun: {
          taskId: 'wf-1',
          summary: '并行审查',
          status: 'running',
          phases: [],
          agents: [
            {
              index: 0,
              label: '审查员',
              state: 'running',
              promptPreview: '提示词原文',
              resultPreview: '结果原文',
              lastToolSummary: 'a.ts',
            },
          ],
        },
      });
      const state = live();
      const text = JSON.stringify(state);
      for (const secret of [
        '子 Agent 的提示词',
        '子 Agent 的答复',
        '提示词原文',
        '结果原文',
      ]) {
        expect(text, `${level} shows "${secret}"`).not.toContain(secret);
      }
      // The progress itself is still there.
      expect(state.taskStates['wf-1'].workflowRun?.agents[0]).toMatchObject({
        label: '审查员',
        lastToolSummary: 'a.ts',
      });
      expect(state.taskStates['task-1'].title).toBe('检查滚动');
    }
  });

  describe('and its speech tool', () => {
    const say = (id = 'say-1') =>
      emit({
        eventType: 'tool_use_start',
        toolName: SPEECH_TOOL_NAME,
        toolUseId: id,
        toolInputSummary: '{"text":"已发送的回复"}',
      });
    const finishSaying = (id = 'say-1') => {
      emit({ eventType: 'tool_progress', toolUseId: id, elapsedSeconds: 1 });
      emit({ eventType: 'tool_result', toolUseId: id });
      emit({ eventType: 'tool_use_end', toolUseId: id });
    };

    it('is the reply, not work: no step, no latest tool, no count', () => {
      for (const level of ['activity', 'full'] as const) {
        reset();
        setWorkspace('proactive', level);
        start();
        emit({ eventType: 'status', statusText: 'requesting' });
        tool('t1', 'Bash', 'npm test');
        emit({ eventType: 'tool_result', toolUseId: 't1' });
        emit({ eventType: 'tool_use_end', toolUseId: 't1' });
        say();
        expect(live().activeTools.map((t) => t.toolName)).toEqual([]);
        finishSaying();

        const state = live();
        expect(state.steps!.map((s) => s.toolName)).toEqual(['Bash']);
        expect(state.activeTools).toEqual([]);
        const text = JSON.stringify(state);
        expect(text, level).not.toContain(SPEECH_TOOL_NAME);
        expect(text, level).not.toContain('已发送的回复');
        // One tool used, live as after a reload.
        expect(countTraceTools(state.traceEvents)).toBe(1);
      }
    });

    it('still ends the reasoning before it', () => {
      setWorkspace('proactive', 'full');
      start();
      emit({ eventType: 'status', statusText: 'requesting' });
      emit({ eventType: 'thinking_start' });
      delta('thinking_delta', '想一想。');
      expect(live().isThinking).toBe(true);
      say();
      expect(live().isThinking).toBe(false);
      expect(live().awaitingModel).toBe(false);
    });

    it('applies the reasoning that came before it first', () => {
      setWorkspace('proactive', 'full');
      start();
      emit({ eventType: 'status', statusText: 'requesting' });
      emit({ eventType: 'thinking_start' });
      // This delta still waits for its frame when the speech tool starts.
      emit({ eventType: 'thinking_delta', text: '最后想一想。' });
      say();
      flushRaf();
      expect(live().thinkingText).toBe('最后想一想。');
      expect(live().isThinking).toBe(false);
      expect(live().steps!.filter((s) => s.kind === 'thinking')).toHaveLength(
        1,
      );
    });

    it('is one tool like any other for an Assistant workspace', () => {
      setWorkspace('assistant');
      start();
      say();
      expect(live().steps!.map((s) => s.toolName)).toEqual([SPEECH_TOOL_NAME]);
      expect(live().activeTools.map((t) => t.toolName)).toEqual([
        SPEECH_TOOL_NAME,
      ]);
    });

    it('is one tool like any other for a spawn agent', () => {
      setWorkspace('proactive', 'activity');
      useChatStore.setState({
        agents: { [JID]: [{ id: 'spawn-1', kind: 'spawn' } as never] },
      });
      useChatStore.getState().handleRunStarted(`${JID}#agent:spawn-1`, 'run-s');
      useChatStore.getState().handleStreamEvent(
        JID,
        {
          eventType: 'tool_use_start',
          toolName: SPEECH_TOOL_NAME,
          toolUseId: 'say-s',
        },
        'spawn-1',
        'run-s',
      );
      expect(
        useChatStore.getState().agentStreaming['spawn-1']?.activeTools,
      ).toHaveLength(1);
    });

    it('is followed by call id only for the run that made it', () => {
      setWorkspace('proactive', 'activity');
      start();
      say('say-1');
      // A later run reusing the id for another tool is not the speech tool.
      useChatStore.getState().handleRunFinished(SESSION_JID, RUN);
      useChatStore.getState().handleRunStarted(SESSION_JID, 'run-2');
      useChatStore.getState().handleStreamEvent(
        JID,
        {
          eventType: 'tool_use_start',
          toolName: 'Bash',
          toolUseId: 'say-1',
        },
        SESSION,
        'run-2',
      );
      expect(live().steps!.map((s) => s.toolName)).toEqual(['Bash']);
    });
  });

  it('takes the compaction notice from the activity level up', () => {
    const notice = {
      eventType: 'compact_boundary' as const,
      title: 'Context compacted',
      summary: 'auto: 150000 → 20000 tokens',
    };
    setWorkspace('proactive', 'hidden');
    start();
    emit(notice);
    expect(
      JSON.stringify(useChatStore.getState().agentStreaming[SESSION] ?? {}),
    ).not.toContain('Context compacted');

    for (const level of ['activity', 'full'] as const) {
      reset();
      setWorkspace('proactive', level);
      start();
      emit(notice);
      expect(live().traceEvents.map((row) => row.title)).toContain(
        'Context compacted',
      );
    }
  });

  it('never takes a notification or an init, at any level', () => {
    for (const level of ['hidden', 'activity', 'full'] as const) {
      reset();
      setWorkspace('proactive', level);
      start();
      emit({ eventType: 'notification', text: '通知' });
      emit({ eventType: 'init' });
      expect(
        JSON.stringify(useChatStore.getState().agentStreaming[SESSION] ?? {}),
      ).not.toContain('通知');
    }
  });

  it('treats a missing level as hidden', () => {
    setWorkspace('proactive', undefined);
    start();
    tool('t1');
    expect(
      useChatStore.getState().agentStreaming[SESSION]?.steps ?? [],
    ).toEqual([]);
  });

  it('keeps the Assistant contract for a spawn agent in its workspace', () => {
    setWorkspace('proactive', 'hidden');
    useChatStore.setState({
      agents: {
        [JID]: [{ id: 'spawn-1', kind: 'spawn' } as never],
      },
    });
    useChatStore.getState().handleRunStarted(`${JID}#agent:spawn-1`, 'run-s');
    useChatStore
      .getState()
      .handleStreamEvent(
        JID,
        { eventType: 'text_delta', text: '并行任务的回复' },
        'spawn-1',
        'run-s',
      );
    flushRaf();
    expect(useChatStore.getState().agentStreaming['spawn-1']?.partialText).toBe(
      '并行任务的回复',
    );
  });

  it('does not settle a card: its messages are not replies', () => {
    setWorkspace('proactive', 'full');
    start();
    emit({ eventType: 'thinking_start' });
    delta('thinking_delta', '想了很多。');
    useChatStore.getState().handleRunFinished(SESSION_JID, RUN);
    expect(
      useChatStore.getState().settledStreaming[SESSION_JID],
    ).toBeUndefined();
  });

  it('does not touch an Assistant workspace', () => {
    setWorkspace('assistant', 'hidden');
    start();
    delta('text_delta', '正常回复');
    tool('t1');
    expect(live().partialText).toBe('正常回复');
    expect(live().steps!.map((s) => s.kind)).toEqual(['text', 'tool']);
  });
});

describe('a reconnect snapshot', () => {
  const snapshot = (over: Partial<StreamSnapshotData> = {}) =>
    ({
      partialText: '正在回答',
      thinkingText: '**计划**\n\n先读。',
      thinkingDurationMs: 4000,
      activeTools: [
        {
          toolName: 'Bash',
          toolUseId: 't2',
          startTime: Date.now() - 2000,
          toolInputSummary: 'ls',
        },
      ],
      recentEvents: [],
      traceEvents: [
        {
          id: 'a',
          timestamp: 100,
          kind: 'tool',
          title: '工具 Read',
          summary: 'a.ts',
          toolUseId: 't1',
        },
        {
          id: 'b',
          timestamp: 300,
          kind: 'tool',
          title: '工具 Bash',
          summary: 'ls',
          toolUseId: 't2',
        },
      ],
      systemStatus: null,
      turnId: 'turn-9',
      ...over,
    }) as StreamSnapshotData;

  it('rebuilds a plausible order for a tab that has no steps', () => {
    useChatStore.getState().handleStreamSnapshot(JID, snapshot(), SESSION, RUN);
    const state = live();
    expect(state.steps!.map((s) => `${s.kind}:${s.status}`)).toEqual([
      'thinking:done',
      'tool:done',
      'tool:running',
      'text:running',
    ]);
    expect(state.thinkingTitle).toBe('计划');
    expect(state.thinkingDurationMs).toBe(4000);
  });

  it('carries the input of a running tool for its card', () => {
    useChatStore.getState().handleStreamSnapshot(
      JID,
      snapshot({
        activeTools: [
          {
            toolName: 'AskUserQuestion',
            toolUseId: 'q1',
            startTime: Date.now(),
            toolInput: { questions: [{ question: '继续吗？' }] },
            skillName: undefined,
            isNested: false,
            elapsedSeconds: 3,
          },
        ],
      }),
      SESSION,
      RUN,
    );
    expect(live().activeTools[0]).toMatchObject({
      toolUseId: 'q1',
      toolInput: { questions: [{ question: '继续吗？' }] },
      elapsedSeconds: 3,
      isNested: false,
    });
  });

  describe('of a proactive workspace', () => {
    const leaky = () =>
      snapshot({
        recentEvents: [
          {
            id: 'e1',
            timestamp: 1,
            kind: 'tool',
            text: '工具: mcp__happyclaw__send_message {"text":"没发出去的回复"}',
          },
        ],
        partialText: '没发出去的回复',
        thinkingText: '**检查**\n\n主 Agent 的思考。',
        activeTools: [
          {
            toolName: 'Bash',
            toolUseId: 't2',
            startTime: Date.now(),
            toolInputSummary: 'ls',
            toolInput: { command: 'ls' },
          },
        ],
        taskStates: {
          'task-1': {
            id: 'task-1',
            title: '检查滚动',
            status: 'running',
            thinkingTail: '子 Agent 的思考',
            textTail: '子 Agent 的话',
            activeTools: [],
            recentTools: [],
            updatedAt: 1,
          },
        },
      });
    const restore = (level: 'hidden' | 'activity' | 'full') => {
      reset();
      setWorkspace('proactive', level);
      useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
      useChatStore.getState().handleStreamSnapshot(JID, leaky(), SESSION, RUN);
      return live();
    };

    it('keeps no log of recent events at any level', () => {
      for (const level of ['hidden', 'activity', 'full'] as const) {
        expect(restore(level).recentEvents, level).toEqual([]);
      }
    });

    it('shows nothing but the spinner when the process is hidden', () => {
      const state = restore('hidden');
      expect(state.partialText).toBe('');
      expect(state.thinkingText).toBe('');
      expect(state.activeTools).toEqual([]);
      expect(state.steps ?? []).toEqual([]);
      expect(state.taskStates).toEqual({});
    });

    it('keeps the activity, not the reasoning or the text, at the activity level', () => {
      const state = restore('activity');
      expect(state.partialText).toBe('');
      expect(state.thinkingText).toBe('');
      expect(state.steps!.every((s) => (s.text ?? '') === '')).toBe(true);
      expect(state.activeTools[0].toolInputSummary).toBe('ls');
      expect(state.activeTools[0].toolInput).toBeUndefined();
      expect(state.taskStates['task-1']).toMatchObject({
        title: '检查滚动',
        thinkingTail: '',
        textTail: '',
      });
    });

    it('adds the reasoning at the full level, still not the reply or sub-agent text', () => {
      const state = restore('full');
      expect(state.thinkingText).toContain('主 Agent 的思考');
      expect(state.partialText).toBe('');
      expect(state.activeTools[0].toolInput).toBeUndefined();
      expect(state.taskStates['task-1']).toMatchObject({
        thinkingTail: '子 Agent 的思考',
        textTail: '',
      });
    });

    it('leaves the speech tool out and follows its call to the end', () => {
      reset();
      setWorkspace('proactive', 'activity');
      useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
      const row = (title: string, toolUseId: string) => ({
        id: `${title}-${toolUseId}`,
        timestamp: 1,
        kind: 'tool' as const,
        title,
        toolUseId,
      });
      useChatStore.getState().handleStreamSnapshot(
        JID,
        snapshot({
          activeTools: [
            {
              toolName: SPEECH_TOOL_NAME,
              toolUseId: 'say-1',
              startTime: Date.now(),
            },
            {
              toolName: 'Bash',
              toolUseId: 't2',
              startTime: Date.now(),
              toolInputSummary: 'ls',
            },
          ],
          traceEvents: [
            row('工具 Read', 't1'),
            row('工具 Bash', 't2'),
            row(`工具 ${SPEECH_TOOL_NAME}`, 'say-1'),
          ],
        }),
        SESSION,
        RUN,
      );
      expect(live().activeTools.map((t) => t.toolName)).toEqual(['Bash']);
      expect(live().traceEvents.map((r) => r.title)).toEqual([
        '工具 Read',
        '工具 Bash',
      ]);
      expect(live().steps!.map((s) => s.toolName ?? s.kind)).not.toContain(
        SPEECH_TOOL_NAME,
      );
      // The rest of that call arrives with only its id.
      emit({ eventType: 'tool_result', toolUseId: 'say-1' });
      emit({ eventType: 'tool_use_end', toolUseId: 'say-1' });
      expect(live().traceEvents.map((r) => r.title)).toEqual([
        '工具 Read',
        '工具 Bash',
      ]);
    });

    it('leaves an Assistant workspace snapshot whole', () => {
      reset();
      setWorkspace('assistant', 'hidden');
      useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
      useChatStore.getState().handleStreamSnapshot(JID, leaky(), SESSION, RUN);
      expect(live().partialText).toBe('没发出去的回复');
      expect(live().recentEvents).toHaveLength(1);
      expect(live().taskStates['task-1'].textTail).toBe('子 Agent 的话');
    });
  });

  it('keeps the steps this tab already has for the same turn', () => {
    emit({
      eventType: 'tool_use_start',
      toolName: 'Read',
      toolUseId: 't1',
      turnId: 'turn-9',
    });
    delta('text_delta', '正在回答');
    const before = live().steps;
    useChatStore.getState().handleStreamSnapshot(JID, snapshot(), SESSION, RUN);
    expect(live().steps).toBe(before);
  });
});

describe('changing the process visibility', () => {
  beforeEach(() => {
    reset();
    apiPatchMock.mockResolvedValue({ success: true });
  });

  it('drops the narration of a run in flight when the level is lowered', async () => {
    setWorkspace('proactive', 'full');
    useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
    emit({ eventType: 'commentary', text: '先看看。' });
    tool('t1', 'Read');
    expect(live().steps!.some((step) => step.commentary)).toBe(true);
    apiPatchMock.mockResolvedValueOnce({
      success: true,
      process_visibility: 'activity',
    });
    await useChatStore.getState().updateProcessVisibility(JID, 'activity');
    const steps = live().steps!;
    expect(steps.some((step) => step.commentary)).toBe(false);
    // The tool it introduced stays: that is activity.
    expect(steps.map((step) => step.kind)).toContain('tool');
  });

  it('sends the level, keeps the mode and needs no restart', async () => {
    setWorkspace('proactive', 'hidden');
    const saved = await useChatStore
      .getState()
      .updateProcessVisibility(JID, 'activity');
    expect(saved).toBe(true);
    expect(apiPatchMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(JID)}`,
      { process_visibility: 'activity' },
    );
    const group = useChatStore.getState().groups[JID];
    expect(group.process_visibility).toBe('activity');
    expect(group.interaction_mode).toBe('proactive');
  });

  it('takes the level the server says is now in force', async () => {
    setWorkspace('proactive', 'hidden');
    apiPatchMock.mockResolvedValueOnce({
      success: true,
      interaction_mode: 'proactive',
      process_visibility: 'activity',
    });
    await useChatStore.getState().updateProcessVisibility(JID, 'full');
    expect(useChatStore.getState().groups[JID].process_visibility).toBe(
      'activity',
    );
  });

  it('reports a failed save and keeps the old level', async () => {
    setWorkspace('proactive', 'activity');
    apiPatchMock.mockRejectedValueOnce(new Error('forbidden'));
    const saved = await useChatStore
      .getState()
      .updateProcessVisibility(JID, 'full');
    expect(saved).toBe(false);
    expect(useChatStore.getState().groups[JID].process_visibility).toBe(
      'activity',
    );
    expect(useChatStore.getState().error).toBe('forbidden');
  });

  it('drops what a lowered level hides from a turn that is running', async () => {
    setWorkspace('proactive', 'full');
    useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
    emit({ eventType: 'thinking_start' });
    delta('thinking_delta', '**检查**\n\n不该再显示的思考。');
    tool('t1', 'Bash', 'npm test');
    expect(live().thinkingText).toContain('不该再显示');

    await useChatStore.getState().updateProcessVisibility(JID, 'activity');
    const kept = live();
    expect(kept.thinkingText).toBe('');
    expect(kept.steps!.map((step) => step.kind)).toEqual(['thinking', 'tool']);
    expect(kept.steps![0].text).toBe('');

    await useChatStore.getState().updateProcessVisibility(JID, 'hidden');
    expect(live().steps ?? []).toEqual([]);
    expect(live().activeTools).toEqual([]);
  });

  it('does not touch an Assistant workspace turn', async () => {
    setWorkspace('assistant', 'full');
    useChatStore.getState().handleRunStarted(SESSION_JID, RUN);
    delta('thinking_delta', '助手的思考。');
    await useChatStore.getState().updateProcessVisibility(JID, 'hidden');
    expect(live().thinkingText).toBe('助手的思考。');
  });
});
