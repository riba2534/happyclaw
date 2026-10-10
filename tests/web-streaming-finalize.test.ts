import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, StreamEvent } from '../web/src/stores/chat';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    patch: vi.fn(),
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

const JID = 'web:finalize';
const AGENT = 'agent-1';
const AGENT_JID = `${JID}#agent:${AGENT}`;

const rafCallbacks: FrameRequestCallback[] = [];
function flushRaf(): void {
  for (const cb of rafCallbacks.splice(0)) cb(0);
}

function reset(): void {
  useChatStore.setState(
    {
      ...initialState,
      groups: {},
      messages: { [JID]: [] },
      waiting: {},
      activeRuns: {},
      streaming: {},
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stopRequests: {},
      settledStreaming: {},
      pendingThinking: {},
      pendingThinkingDuration: {},
      clearing: {},
      agents: {},
      agentStreaming: {},
      activeAgentTab: {},
      agentMessages: { [AGENT]: [] },
      agentWaiting: {},
      agentHasMore: {},
      unreadReplies: {},
    },
    true,
  );
}

function emit(event: StreamEvent, runId: string, agentId?: string): void {
  useChatStore.getState().handleStreamEvent(JID, event, agentId, runId);
}

function finalMessage(
  id: string,
  content: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    chat_jid: JID,
    sender: 'happyclaw-agent',
    sender_name: 'HappyClaw',
    content,
    timestamp: '2026-10-10T00:00:00.000Z',
    is_from_me: true,
    source_kind: 'sdk_final',
    finalization_reason: 'completed',
    turn_id: 'turn-1',
    ...extra,
  };
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('run_finished before the final message', () => {
  function streamAReply(runtimeJid: string, agentId?: string) {
    useChatStore.getState().handleRunStarted(runtimeJid, 'run-a');
    emit(
      { eventType: 'thinking_delta', text: '先想一想。', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    flushRaf();
    emit(
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInputSummary: 'ls',
        turnId: 'turn-1',
      },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'tool_use_end', toolUseId: 'tool-1', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    emit(
      { eventType: 'text_delta', text: '最终答案。', turnId: 'turn-1' },
      'run-a',
      agentId,
    );
    // The last frame is still waiting for rAF when the run ends.
  }

  it('keeps the main reply on screen until its final replaces it in one update', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');

    let state = useChatStore.getState();
    const settled = state.settledStreaming[JID];
    expect(settled?.settling).toBe(true);
    expect(settled?.runId).toBe('run-a');
    // The frame buffered for rAF was applied, not dropped.
    expect(settled?.partialText).toBe('最终答案。');
    expect(settled?.activeTools).toEqual([]);
    // The live slot is free for the next run.
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.waiting[JID]).toBe(false);

    const updates: Array<{ settled: boolean; messages: number }> = [];
    const unsubscribe = useChatStore.subscribe((s) =>
      updates.push({
        settled: !!s.settledStreaming[JID],
        messages: s.messages[JID]?.length ?? 0,
      }),
    );
    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-1', '最终答案。'));
    unsubscribe();

    // Never a state with neither the card nor the final message.
    expect(updates).toEqual([{ settled: false, messages: 1 }]);
    state = useChatStore.getState();
    expect(state.thinkingCache['final-1']).toBe('先想一想。');
    expect(state.thinkingDurationCache['final-1']).toBeGreaterThanOrEqual(0);
    expect(
      state.traceCache['final-1']?.some((e) => e.title === '工具 Bash'),
    ).toBe(true);
  });

  it('keeps a session reply settled and carries its thinking to the final', () => {
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    streamAReply(AGENT_JID, AGENT);
    useChatStore.getState().handleRunFinished(AGENT_JID, 'run-a');

    let state = useChatStore.getState();
    expect(state.settledStreaming[AGENT_JID]?.partialText).toBe('最终答案。');
    expect(state.agentStreaming[AGENT]).toBeUndefined();

    useChatStore
      .getState()
      .handleWsNewMessage(
        JID,
        finalMessage('agent-final', '最终答案。', { chat_jid: AGENT_JID }),
        AGENT,
      );
    state = useChatStore.getState();
    expect(state.settledStreaming[AGENT_JID]).toBeUndefined();
    expect(state.agentMessages[AGENT].map((m) => m.id)).toEqual([
      'agent-final',
    ]);
    expect(state.thinkingCache['agent-final']).toBe('先想一想。');
    expect(state.traceCache['agent-final']?.length).toBeGreaterThan(0);
  });

  it('re-syncs a settled card whose final never arrives, then lets it go', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    apiGetMock.mockResolvedValueOnce({
      messages: [finalMessage('final-rest', '最终答案。')],
    });

    await vi.advanceTimersByTimeAsync(1600);

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.messages[JID].map((m) => m.id)).toEqual(['final-rest']);
    expect(state.thinkingCache['final-rest']).toBe('先想一想。');
  });

  it('drops a settled card when the re-sync finds nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    apiGetMock.mockResolvedValueOnce({ messages: [] });

    await vi.advanceTimersByTimeAsync(1600);

    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    // Not left for a later, unrelated reply to pick up.
    expect(state.pendingThinking[JID]).toBeUndefined();
  });

  it('keeps the settled card across the next queued run until the final lands', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.getState().handleRunStarted(JID, 'run-b');

    let state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.partialText).toBe('最终答案。');
    expect(state.waiting[JID]).toBe(true);

    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-a', '最终答案。'));
    state = useChatStore.getState();
    // A's card became A's reply; B (still preparing) has no projection yet.
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.streaming[JID]).toBeUndefined();
    expect(state.thinkingCache['final-a']).toBe('先想一想。');
    expect(state.waiting[JID]).toBe(true);
  });

  it("keeps A's settled card while B streams before A's final, then swaps only A", () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.getState().handleRunStarted(JID, 'run-b');
    // The SDK opens every request with a status; B then streams text.
    emit(
      { eventType: 'status', statusText: 'requesting', turnId: 'turn-2' },
      'run-b',
    );
    emit(
      { eventType: 'text_delta', text: 'B 的回答', turnId: 'turn-2' },
      'run-b',
    );
    flushRaf();

    let state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.partialText).toBe('最终答案。');
    expect(state.streaming[JID]?.partialText).toBe('B 的回答');

    // A reconnect snapshot for B leaves A alone too.
    useChatStore.getState().handleStreamSnapshot(
      JID,
      {
        partialText: 'B 的回答，更多',
        activeTools: [],
        recentEvents: [],
        systemStatus: null,
        turnId: 'turn-2',
      },
      undefined,
      'run-b',
    );
    expect(useChatStore.getState().settledStreaming[JID]?.partialText).toBe(
      '最终答案。',
    );

    useChatStore
      .getState()
      .handleWsNewMessage(JID, finalMessage('final-a', '最终答案。'));
    state = useChatStore.getState();
    expect(state.settledStreaming[JID]).toBeUndefined();
    expect(state.thinkingCache['final-a']).toBe('先想一想。');
    expect(state.traceCache['final-a']?.length).toBeGreaterThan(0);
    expect(state.streaming[JID]?.partialText).toBe('B 的回答，更多');
    expect(state.waiting[JID]).toBe(true);
  });

  it("settles a replaced attempt's card when the next run starts without run_finished", () => {
    streamAReply(JID);
    useChatStore.getState().handleRunStarted(JID, 'run-b');
    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.runId).toBe('run-a');
    expect(state.streaming[JID]).toBeUndefined();
  });

  it('replaces the settled card of a group-mode scheduled task with its result', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');

    const updates: Array<{ settled: boolean; ids: string[] }> = [];
    const unsubscribe = useChatStore.subscribe((s) =>
      updates.push({
        settled: !!s.settledStreaming[JID],
        ids: (s.messages[JID] ?? []).map((m) => m.id),
      }),
    );
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('sched-1', '## 定时任务结果\n\n最终答案。', {
        source_kind: 'scheduled_task_result',
      }),
      undefined,
      'scheduled_task',
    );
    unsubscribe();

    // One update: the result in, the card out. Never both on screen.
    expect(updates).toEqual([{ settled: false, ids: ['sched-1'] }]);
    const state = useChatStore.getState();
    expect(state.thinkingCache['sched-1']).toBe('先想一想。');
    expect(state.pendingThinking[JID]).toBeUndefined();
  });

  it("leaves another turn's settled card for its own final", () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    useChatStore.getState().handleWsNewMessage(
      JID,
      finalMessage('sched-other', '另一个任务', {
        source_kind: 'scheduled_task_result',
        turn_id: 'turn-other',
      }),
      undefined,
      'scheduled_task',
    );
    const state = useChatStore.getState();
    expect(state.settledStreaming[JID]?.partialText).toBe('最终答案。');
    expect(state.thinkingCache['sched-other']).toBeUndefined();
  });

  it('ignores a run_finished for another attempt', () => {
    streamAReply(JID);
    useChatStore.getState().handleRunFinished(JID, 'run-other');
    flushRaf();
    expect(useChatStore.getState().settledStreaming[JID]).toBeUndefined();
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe(
      '最终答案。',
    );
    expect(useChatStore.getState().waiting[JID]).toBe(true);
  });
});

describe('reconnect snapshot', () => {
  const snapshot = (partialText: string, turnId = 'turn-1') => ({
    partialText,
    activeTools: [],
    recentEvents: [],
    systemStatus: null,
    turnId,
  });

  beforeEach(() => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    emit(
      {
        eventType: 'text_delta',
        text: 'Kubernetes 调度入门：' + '内容'.repeat(100),
        turnId: 'turn-1',
      },
      'run-a',
    );
    flushRaf();
  });

  it('never replaces the longer text of the same turn with a shorter tail', () => {
    const local = useChatStore.getState().streaming[JID]!.partialText;
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot('…\n\n内容内容'), undefined, 'run-a');
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe(local);
  });

  it('takes the snapshot when it has text this tab missed', () => {
    const full = useChatStore.getState().streaming[JID]!.partialText + '新增';
    useChatStore
      .getState()
      .handleStreamSnapshot(JID, snapshot(full), undefined, 'run-a');
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe(full);
  });

  it('takes the snapshot of a newer turn', () => {
    useChatStore
      .getState()
      .handleStreamSnapshot(
        JID,
        snapshot('新一轮', 'turn-2'),
        undefined,
        'run-a',
      );
    expect(useChatStore.getState().streaming[JID]?.partialText).toBe('新一轮');
  });
});

describe('tool and thinking status', () => {
  beforeEach(() => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
  });

  it('ends a tool on its result and returns the phase to the model', () => {
    emit(
      { eventType: 'tool_use_start', toolName: 'Glob', toolUseId: 'g1' },
      'run-a',
    );
    emit(
      { eventType: 'tool_use_start', toolName: 'Task', toolUseId: 't1' },
      'run-a',
    );
    emit(
      { eventType: 'tool_result', toolUseId: 'g1', toolResult: 'a.ts' },
      'run-a',
    );
    emit(
      { eventType: 'tool_result', toolUseId: 't1', toolResult: 'launched' },
      'run-a',
    );
    const stream = useChatStore.getState().streaming[JID]!;
    // Task keeps its own lifecycle (task_notification / tool_use_end).
    expect(stream.activeTools.map((t) => t.toolUseId)).toEqual(['t1']);
    expect(stream.awaitingModel).toBe(true);
  });

  it('replays mixed thinking and text of one frame in arrival order', () => {
    emit({ eventType: 'thinking_delta', text: '想' }, 'run-a');
    emit({ eventType: 'text_delta', text: '答' }, 'run-a');
    flushRaf();
    expect(useChatStore.getState().streaming[JID]?.isThinking).toBe(false);

    emit({ eventType: 'text_delta', text: '再答' }, 'run-a');
    emit({ eventType: 'thinking_delta', text: '再想' }, 'run-a');
    flushRaf();
    expect(useChatStore.getState().streaming[JID]?.isThinking).toBe(true);
  });

  it('times a late thinking burst from the model request, not its first delta', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    emit({ eventType: 'status', statusText: 'requesting' }, 'run-a');
    // The model reasons silently, then its thinking arrives in one burst.
    vi.setSystemTime(new Date('2026-10-10T00:00:14.600Z'));
    emit({ eventType: 'thinking_delta', text: '整段思考' }, 'run-a');
    emit({ eventType: 'text_delta', text: '回答' }, 'run-a');
    flushRaf();
    expect(
      useChatStore.getState().streaming[JID]?.thinkingDurationMs,
    ).toBeGreaterThanOrEqual(14_000);
  });

  it('clears the deep-thinking heartbeat once text starts', () => {
    emit({ eventType: 'status', statusText: '正在深入分析…' }, 'run-a');
    expect(useChatStore.getState().streaming[JID]?.systemStatus).toBe(
      '正在深入分析…',
    );
    emit({ eventType: 'text_delta', text: '开始回答' }, 'run-a');
    flushRaf();
    expect(useChatStore.getState().streaming[JID]?.systemStatus).toBeNull();
  });
});

describe('stop and interrupt', () => {
  it('shows a stop at once and clears it when the run ends', async () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    apiPostMock.mockResolvedValueOnce({ success: true, interrupted: true });
    const pending = useChatStore.getState().interruptQuery(JID);
    expect(useChatStore.getState().stopRequests[JID]).toBeTypeOf('number');
    await pending;
    expect(useChatStore.getState().stopRequests[JID]).toBeTypeOf('number');
    useChatStore.getState().handleRunFinished(JID, 'run-a');
    expect(useChatStore.getState().stopRequests[JID]).toBeUndefined();
  });

  it('withdraws the stop when the request fails', async () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    apiPostMock.mockRejectedValueOnce(new Error('offline'));
    await useChatStore.getState().interruptQuery(JID);
    expect(useChatStore.getState().stopRequests[JID]).toBeUndefined();
  });

  it('keeps a stopped session card frozen against late deltas', () => {
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    useChatStore.getState().handleRunStarted(AGENT_JID, 'run-a');
    emit({ eventType: 'text_delta', text: '已输出' }, 'run-a', AGENT);
    flushRaf();
    emit({ eventType: 'status', statusText: 'interrupted' }, 'run-a', AGENT);
    emit({ eventType: 'text_delta', text: '迟到' }, 'run-a', AGENT);
    flushRaf();
    emit(
      { eventType: 'tool_use_start', toolName: 'Bash', toolUseId: 'x' },
      'run-a',
      AGENT,
    );
    const card = useChatStore.getState().agentStreaming[AGENT]!;
    expect(card.interrupted).toBe(true);
    expect(card.partialText).toBe('已输出');
    expect(card.activeTools).toEqual([]);
  });
});

describe('dead streaming persistence', () => {
  it('no longer writes streaming state to sessionStorage', () => {
    const store = fs.readFileSync(
      path.join(process.cwd(), 'web/src/stores/chat.ts'),
      'utf8',
    );
    expect(store).not.toMatch(/hc_streaming|sessionStorage/);
  });
});

describe('session running state', () => {
  it('does not count a settled or stopped session card as running', async () => {
    const { isLiveStream } = await import('../web/src/stores/chat');
    useChatStore.setState({ agentWaiting: { [AGENT]: true } });
    useChatStore.getState().handleRunStarted(AGENT_JID, 'run-a');
    emit({ eventType: 'text_delta', text: '输出中' }, 'run-a', AGENT);
    flushRaf();
    expect(isLiveStream(useChatStore.getState().agentStreaming[AGENT])).toBe(
      true,
    );

    emit({ eventType: 'status', statusText: 'interrupted' }, 'run-a', AGENT);
    expect(isLiveStream(useChatStore.getState().agentStreaming[AGENT])).toBe(
      false,
    );

    useChatStore.getState().handleRunFinished(AGENT_JID, 'run-a');
    const state = useChatStore.getState();
    // The frozen card moved out of the live slot: no stop button, no spinner.
    expect(state.agentStreaming[AGENT]).toBeUndefined();
    expect(state.agentWaiting[AGENT]).toBe(false);
    expect(state.settledStreaming[AGENT_JID]?.interrupted).toBe(true);
  });
});

describe('streaming text cap', () => {
  it('cuts past the cap once with headroom instead of on every frame', () => {
    useChatStore.getState().handleRunStarted(JID, 'run-a');
    const paragraph = `${'长回复内容。'.repeat(80)}\n\n`;
    emit({ eventType: 'text_delta', text: paragraph.repeat(420) }, 'run-a');
    flushRaf();
    const cut = useChatStore.getState().streaming[JID]!.partialText;
    expect(cut.startsWith('…\n\n')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(200_000 * 0.9 + 3);

    // The next deltas append without another cut.
    emit({ eventType: 'text_delta', text: '继续' }, 'run-a');
    flushRaf();
    const next = useChatStore.getState().streaming[JID]!.partialText;
    expect(next).toBe(`${cut}继续`);
  });
});
