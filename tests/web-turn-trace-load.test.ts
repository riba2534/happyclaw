import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInfo, GroupInfo, Message } from '../web/src/stores/chat';
import type { StreamingStep } from '../web/src/lib/stream-steps';
import { countTraceTools } from '../web/src/components/chat/ExecutionTrace';

const { apiGetMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../web/src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
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

const { useChatStore, mergeMessagesChronologically, MAX_STEPS_CACHE_CHARS } =
  await import('../web/src/stores/chat');
const initialState = useChatStore.getState();

const JID = 'web:trace';
const SESSION = 'session-1';
const SESSION_JID = `${JID}#agent:${SESSION}`;
const message = (id = 'm1', over: Partial<Message> = {}): Message => ({
  id,
  chat_jid: SESSION_JID,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '最终答案。',
  timestamp: '2026-10-10T00:00:00.000Z',
  is_from_me: true,
  source_kind: 'sdk_final',
  turn_id: 'turn-1',
  has_trace: true,
  ...over,
});

const row = (
  id: string,
  title: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  timestamp: 1,
  kind: 'tool',
  title,
  ...over,
});

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({
  at: 1_000_000,
  endedAt: 1_002_000,
  status: 'done',
  ...over,
});

const thinking = (id: string, over: Partial<StreamingStep> = {}) =>
  step({ id, kind: 'thinking', text: '想一想。', title: '确认范围', ...over });
const toolStep = (id: string, toolName: string, over = {}) =>
  step({ id, kind: 'tool', toolName, toolUseId: id, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState(
    {
      ...initialState,
      groups: {},
      agentMessages: { [SESSION]: [] },
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stepsCache: {},
      turnTraceStatus: {},
    },
    true,
  );
});

describe('loading the reasoning and trace the server kept', () => {
  it('asks for the turn of the message and fills the caches it renders from', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '**确认范围**\n\n先看目录。',
      thinking_duration_ms: 6400,
      trace: [row('a', '工具 Read', { summary: 'a.ts', toolUseId: 't1' })],
      created_at: '2026-10-10T00:00:00.000Z',
    });
    const loaded = await useChatStore.getState().loadTurnTrace(message());
    expect(loaded).toBe(true);
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(SESSION_JID)}/turn-traces/turn-1`,
    );
    const state = useChatStore.getState();
    expect(state.thinkingCache.m1).toBe('**确认范围**\n\n先看目录。');
    expect(state.thinkingDurationCache.m1).toBe(6400);
    expect(state.traceCache.m1).toHaveLength(1);
    expect(state.turnTraceStatus.m1).toBeUndefined();
  });

  it('asks a session by its whole jid', async () => {
    apiGetMock.mockResolvedValueOnce({ turn_id: 't', thinking: '想' });
    await useChatStore
      .getState()
      .loadTurnTrace(message('m2', { chat_jid: `${JID}#agent:s1` }));
    expect(apiGetMock).toHaveBeenCalledWith(
      `/api/groups/${encodeURIComponent(`${JID}#agent:s1`)}/turn-traces/turn-1`,
    );
  });

  it('keeps duration alone when the model gave no text', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      thinking_duration_ms: 3000,
      trace: [],
    });
    await useChatStore.getState().loadTurnTrace(message());
    const state = useChatStore.getState();
    expect(state.thinkingCache.m1).toBeUndefined();
    expect(state.thinkingDurationCache.m1).toBe(3000);
  });

  it('keeps the trace alone at the activity level (no reasoning text)', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      thinking_duration_ms: null,
      trace: [row('a', '工具 Bash')],
    });
    await useChatStore.getState().loadTurnTrace(message());
    const state = useChatStore.getState();
    expect(state.thinkingCache.m1).toBeUndefined();
    expect(state.thinkingDurationCache.m1).toBeUndefined();
    expect(state.traceCache.m1).toHaveLength(1);
  });

  it('marks a turn with nothing kept as empty, and does not ask again', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
    });
    await useChatStore.getState().loadTurnTrace(message());
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('empty');
  });

  it('treats a turn the server no longer shows as empty', async () => {
    apiGetMock.mockRejectedValueOnce({ status: 404, message: 'Not found' });
    const loaded = await useChatStore.getState().loadTurnTrace(message());
    expect(loaded).toBe(false);
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('empty');
  });

  it('fails quietly and lets the next ask try again', async () => {
    apiGetMock.mockRejectedValueOnce({ status: 0, message: 'Network error' });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(false);
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('failed');
    expect(useChatStore.getState().error).toBeNull();

    apiGetMock.mockResolvedValueOnce({ turn_id: 'turn-1', thinking: '想了。' });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
    expect(useChatStore.getState().thinkingCache.m1).toBe('想了。');
    expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
  });

  it('asks once while a load is in flight', async () => {
    let resolve!: (value: unknown) => void;
    apiGetMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const first = useChatStore.getState().loadTurnTrace(message());
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(false);
    resolve({ turn_id: 'turn-1', thinking: '想' });
    await first;
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it('does not ask for what this tab already has', async () => {
    useChatStore.setState({ thinkingCache: { m1: '已有的思考' } });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('cannot ask for a message with no turn', async () => {
    expect(
      await useChatStore
        .getState()
        .loadTurnTrace(message('m3', { turn_id: null })),
    ).toBe(false);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  describe('the speech tool of a proactive turn', () => {
    const SAY = 'mcp__happyclaw__send_message';
    const turn = () => ({
      turn_id: 'turn-1',
      thinking: '',
      trace: [
        row('a', '工具 Grep', { toolUseId: 't1' }),
        row('b', '工具结果', { toolUseId: 't1' }),
        row('c', `工具 ${SAY}`, { toolUseId: 'say-1' }),
        row('d', '工具结果', { toolUseId: 'say-1' }),
        row('e', `工具完成 ${SAY}`, { toolUseId: 'say-1' }),
      ],
    });
    const proactive = () =>
      useChatStore.setState({
        groups: {
          [JID]: {
            name: 'w',
            folder: 'trace',
            added_at: '2026-01-01T00:00:00.000Z',
            interaction_mode: 'proactive',
            process_visibility: 'activity',
          } as GroupInfo,
        },
      });

    it('is left out of the trace a proactive workspace loads', async () => {
      proactive();
      apiGetMock.mockResolvedValueOnce(turn());
      await useChatStore.getState().loadTurnTrace(message('m5'));
      const rows = useChatStore.getState().traceCache.m5;
      expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
      expect(countTraceTools(rows)).toBe(1);
    });

    it('leaves a turn that only spoke with nothing to open', async () => {
      proactive();
      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        thinking: '',
        trace: turn().trace.slice(2),
      });
      await useChatStore.getState().loadTurnTrace(message('m6'));
      expect(useChatStore.getState().turnTraceStatus.m6).toBe('empty');
      expect(useChatStore.getState().traceCache.m6).toBeUndefined();
    });

    it('is one tool like any other in an Assistant workspace', async () => {
      apiGetMock.mockResolvedValueOnce(turn());
      await useChatStore.getState().loadTurnTrace(message('m7'));
      expect(useChatStore.getState().traceCache.m7).toHaveLength(5);
      expect(countTraceTools(useChatStore.getState().traceCache.m7)).toBe(2);
    });
  });

  it('shows a proactive reply of a visible workspace the same way', async () => {
    useChatStore.setState({
      groups: {
        [JID]: {
          name: 'w',
          folder: 'trace',
          added_at: '2026-01-01T00:00:00.000Z',
          interaction_mode: 'proactive',
          process_visibility: 'activity',
        } as GroupInfo,
      },
    });
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: [row('a', '工具 Grep')],
    });
    await useChatStore
      .getState()
      .loadTurnTrace(message('m4', { source_kind: 'sdk_send_message' }));
    expect(useChatStore.getState().traceCache.m4).toHaveLength(1);
  });
});

describe('the ordered steps the server kept', () => {
  const SAY = 'mcp__happyclaw__send_message';
  const proactive = (level: 'activity' | 'full' = 'full') =>
    useChatStore.setState({
      groups: {
        [JID]: {
          name: 'w',
          folder: 'trace',
          added_at: '2026-01-01T00:00:00.000Z',
          interaction_mode: 'proactive',
          process_visibility: level,
        } as GroupInfo,
      },
    });

  it('fills the cache the settled card renders from, with what was dropped', async () => {
    const steps = [thinking('t0'), toolStep('a', 'Read'), thinking('t1')];
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '想一想。',
      thinking_duration_ms: 4000,
      trace: [row('a', '工具 Read', { toolUseId: 'a' })],
      steps,
      steps_dropped: 7,
    });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
    const state = useChatStore.getState();
    expect(state.stepsCache.m1).toEqual({ steps, dropped: 7 });
    expect(state.turnTraceStatus.m1).toBeUndefined();
    // The older caches are filled as ever: the classic layout reads them.
    expect(state.thinkingCache.m1).toBe('想一想。');
    expect(state.traceCache.m1).toHaveLength(1);
  });

  it('counts steps as content: a turn with nothing else is not empty', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      thinking_duration_ms: null,
      trace: [],
      // The activity level: reasoning without its text.
      steps: [thinking('t0', { text: undefined, title: undefined })],
      steps_dropped: 0,
    });
    await useChatStore.getState().loadTurnTrace(message());
    const state = useChatStore.getState();
    expect(state.turnTraceStatus.m1).toBeUndefined();
    expect(state.stepsCache.m1?.steps).toHaveLength(1);
  });

  it('keeps no steps for a turn recorded before steps were kept', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '老回合的思考。',
      trace: [row('a', '工具 Read')],
      steps: [],
      steps_dropped: 0,
    });
    await useChatStore.getState().loadTurnTrace(message());
    const state = useChatStore.getState();
    expect(state.stepsCache.m1).toBeUndefined();
    expect(state.thinkingCache.m1).toBe('老回合的思考。');
    expect(state.traceCache.m1).toHaveLength(1);
  });

  it('keeps no steps from a server that sends none', async () => {
    apiGetMock.mockResolvedValueOnce({ turn_id: 'turn-1', thinking: '想。' });
    await useChatStore.getState().loadTurnTrace(message());
    expect(useChatStore.getState().stepsCache.m1).toBeUndefined();
  });

  it('does not count the answer, which the timeline never lists, as content', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
      steps: [step({ id: 'x0', kind: 'text', text: '最终答案。' })],
      steps_dropped: 0,
    });
    await useChatStore.getState().loadTurnTrace(message());
    const state = useChatStore.getState();
    expect(state.turnTraceStatus.m1).toBe('empty');
    expect(state.stepsCache.m1).toBeUndefined();
  });

  it('treats a bad dropped count as none', async () => {
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      steps: [toolStep('a', 'Read')],
      steps_dropped: null,
    });
    await useChatStore.getState().loadTurnTrace(message());
    expect(useChatStore.getState().stepsCache.m1?.dropped).toBe(0);
  });

  it('does not ask for what the steps cache already holds', async () => {
    useChatStore.setState({
      stepsCache: { m1: { steps: [toolStep('a', 'Read')], dropped: 0 } },
    });
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('is kept to the newest entries when the cache is full', async () => {
    const full = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `old-${i}`,
        { steps: [toolStep('a', 'Read')], dropped: 0 },
      ]),
    );
    useChatStore.setState({ stepsCache: full });
    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      steps: [toolStep('b', 'Grep')],
    });
    await useChatStore.getState().loadTurnTrace(message('new'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).toHaveLength(500);
    expect(keys).not.toContain('old-0');
    expect(keys.at(-1)).toBe('new');
  });

  describe('the speech tool of a proactive turn', () => {
    const turn = () => ({
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
      steps: [
        toolStep('t1', 'Grep'),
        toolStep('say-1', SAY),
        toolStep('t2', 'Read'),
      ],
      steps_dropped: 0,
    });

    it('is left out of the steps a proactive workspace loads', async () => {
      proactive();
      apiGetMock.mockResolvedValueOnce(turn());
      await useChatStore.getState().loadTurnTrace(message('m5'));
      expect(
        useChatStore.getState().stepsCache.m5.steps.map((s) => s.toolName),
      ).toEqual(['Grep', 'Read']);
    });

    it('leaves a turn that only spoke with nothing to open', async () => {
      proactive();
      apiGetMock.mockResolvedValueOnce({
        ...turn(),
        steps: [toolStep('say-1', SAY)],
      });
      await useChatStore.getState().loadTurnTrace(message('m6'));
      expect(useChatStore.getState().turnTraceStatus.m6).toBe('empty');
      expect(useChatStore.getState().stepsCache.m6).toBeUndefined();
    });

    it('is one tool like any other in an Assistant workspace', async () => {
      apiGetMock.mockResolvedValueOnce(turn());
      await useChatStore.getState().loadTurnTrace(message('m7'));
      expect(useChatStore.getState().stepsCache.m7.steps).toHaveLength(3);
    });
  });

  describe('what a tool returned, in a proactive workspace', () => {
    const turn = () => ({
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
      steps: [
        toolStep('t1', 'Bash', {
          status: 'error',
          summary: 'command: npm test',
          resultPreview: 'FAIL tests/a.test.ts: secret output',
          resultFacts: { exitCode: 1 },
        }),
        step({
          id: 'task-1',
          kind: 'task',
          taskId: 'task-1',
          toolUseId: 'task-1',
          toolName: 'Task',
          title: '检查移动端',
          summary: '已用 Playwright 录制',
          resultPreview: '子代理的结论',
          resultFacts: { agent: { toolUses: 3, tokens: 1200 } },
        }),
        thinking('t0'),
      ],
      steps_dropped: 0,
    });

    it.each(['activity', 'full'] as const)(
      'is kept out of the steps at the %s level',
      async (level) => {
        proactive(level);
        apiGetMock.mockResolvedValueOnce(turn());
        await useChatStore.getState().loadTurnTrace(message('m8'));
        const cached = useChatStore.getState().stepsCache.m8.steps;
        for (const step of cached) {
          expect(step.resultPreview).toBeUndefined();
          expect(step.resultFacts).toBeUndefined();
        }
        // What is only a flag or a name stays, so a failed call reads as failed.
        expect(cached[0]).toMatchObject({
          status: 'error',
          summary: 'command: npm test',
          toolName: 'Bash',
        });
        expect(cached[1]).toMatchObject({
          title: '检查移动端',
          summary: '已用 Playwright 录制',
        });
        expect(cached[2]).toMatchObject({ kind: 'thinking', text: '想一想。' });
      },
    );

    it('is kept in an Assistant workspace', async () => {
      apiGetMock.mockResolvedValueOnce(turn());
      await useChatStore.getState().loadTurnTrace(message('m9'));
      const cached = useChatStore.getState().stepsCache.m9.steps;
      expect(cached[0].resultPreview).toBe(
        'FAIL tests/a.test.ts: secret output',
      );
      expect(cached[0].resultFacts).toEqual({ exitCode: 1 });
      expect(cached[1].resultFacts).toEqual({
        agent: { toolUses: 3, tokens: 1200 },
      });
    });
  });

  describe('a trace longer than the cache keeps its denied permissions', () => {
    const rows = (count: number, prefix = 'r', from = 0) =>
      Array.from({ length: count }, (_, i) =>
        row(`${prefix}${i}`, `工具 Read ${i}`, { timestamp: from + i }),
      );
    const denial = (id: string, timestamp: number) =>
      row(id, '权限被拒：Write', { kind: 'permission', timestamp });

    it('keeps the denial from early on, and fills up with the newest rows', async () => {
      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        trace: [denial('p1', -1), ...rows(100)],
      });
      await useChatStore.getState().loadTurnTrace(message());
      const kept = useChatStore.getState().traceCache.m1;
      expect(kept).toHaveLength(60);
      expect(kept[0].id).toBe('p1');
      expect(kept.at(-1)?.id).toBe('r99');
      // In the order the run had them.
      expect(kept.map((r) => r.timestamp)).toEqual(
        [...kept.map((r) => r.timestamp)].sort((a, b) => a - b),
      );
    });

    it('keeps every denial, and the newest of the rest for the room left', async () => {
      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        trace: [
          denial('p1', -3),
          ...rows(30),
          denial('p2', 40),
          ...rows(70, 's', 50),
        ],
      });
      await useChatStore.getState().loadTurnTrace(message());
      const kept = useChatStore.getState().traceCache.m1;
      expect(kept).toHaveLength(60);
      expect(
        kept.filter((r) => r.kind === 'permission').map((r) => r.id),
      ).toEqual(['p1', 'p2']);
      expect(kept.at(-1)?.id).toBe('s69');
    });

    it('leaves a trace within the cap as it is', async () => {
      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        trace: [denial('p1', -1), ...rows(10)],
      });
      await useChatStore.getState().loadTurnTrace(message());
      expect(useChatStore.getState().traceCache.m1).toHaveLength(11);
    });
  });

  describe('steps a tab rebuilt from a snapshot', () => {
    const rebuilt = [thinking('thinking-restored'), toolStep('a', 'Bash')];
    const exact = [
      thinking('thinking-0'),
      toolStep('a', 'Bash', {
        resultPreview: '12 passed',
        resultFacts: { exitCode: 0 },
      }),
      thinking('thinking-1', { title: '整理结论', text: '可以回答了。' }),
    ];
    const seedProvisional = () =>
      useChatStore.setState({
        stepsCache: { m1: { steps: rebuilt, dropped: 0, provisional: true } },
        thinkingCache: { m1: '先想一想。' },
        traceCache: { m1: [row('a', '工具 Bash', { toolUseId: 'a' })] },
      });

    it('are replaced by the server version when it is asked for', async () => {
      seedProvisional();
      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        thinking: '先想一想。\n\n可以回答了。',
        trace: [row('a', '工具 Bash', { toolUseId: 'a' })],
        steps: exact,
        steps_dropped: 2,
      });
      expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
      expect(apiGetMock).toHaveBeenCalledTimes(1);
      const state = useChatStore.getState();
      expect(state.stepsCache.m1).toEqual({ steps: exact, dropped: 2 });
      expect(state.stepsCache.m1.provisional).toBeUndefined();
      expect(state.turnTraceStatus.m1).toBeUndefined();
    });

    it('stay as they are, and are not asked for again, when the server has none', async () => {
      seedProvisional();
      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        thinking: '',
        trace: [],
        steps: [],
        steps_dropped: 0,
      });
      await useChatStore.getState().loadTurnTrace(message());
      const state = useChatStore.getState();
      expect(state.stepsCache.m1.steps).toEqual(rebuilt);
      expect(state.stepsCache.m1.provisional).toBeFalsy();
      // Nothing is hidden or marked empty for it: the card is still there.
      expect(state.turnTraceStatus.m1).toBeUndefined();

      expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
      expect(apiGetMock).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().stepsCache.m1.steps).toEqual(rebuilt);
    });

    it('stay as they are when the server no longer shows the turn', async () => {
      seedProvisional();
      apiGetMock.mockRejectedValueOnce({ status: 404, message: 'Not found' });
      expect(await useChatStore.getState().loadTurnTrace(message())).toBe(
        false,
      );
      const state = useChatStore.getState();
      expect(state.stepsCache.m1.steps).toEqual(rebuilt);
      expect(state.stepsCache.m1.provisional).toBeFalsy();
      expect(state.turnTraceStatus.m1).toBeUndefined();
      expect(state.error).toBeNull();
    });

    it('stay as they are and are asked for again after a failure', async () => {
      seedProvisional();
      apiGetMock.mockRejectedValueOnce({ status: 0, message: 'Network error' });
      expect(await useChatStore.getState().loadTurnTrace(message())).toBe(
        false,
      );
      let state = useChatStore.getState();
      expect(state.stepsCache.m1).toEqual({
        steps: rebuilt,
        dropped: 0,
        provisional: true,
      });
      expect(state.turnTraceStatus.m1).toBeUndefined();
      expect(state.error).toBeNull();

      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        steps: exact,
        steps_dropped: 0,
      });
      await useChatStore.getState().loadTurnTrace(message());
      expect(apiGetMock).toHaveBeenCalledTimes(2);
      state = useChatStore.getState();
      expect(state.stepsCache.m1.steps).toEqual(exact);
    });

    it('are asked for once while a load is in flight', async () => {
      seedProvisional();
      let resolve!: (value: unknown) => void;
      apiGetMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      const first = useChatStore.getState().loadTurnTrace(message());
      expect(await useChatStore.getState().loadTurnTrace(message())).toBe(
        false,
      );
      resolve({ turn_id: 'turn-1', steps: exact, steps_dropped: 0 });
      await first;
      expect(apiGetMock).toHaveBeenCalledTimes(1);
    });

    it('are left out of a proactive workspace the way any server steps are', async () => {
      proactive();
      seedProvisional();
      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        steps: [...exact, toolStep('say-1', SAY)],
        steps_dropped: 0,
      });
      await useChatStore.getState().loadTurnTrace(message());
      const cached = useChatStore.getState().stepsCache.m1.steps;
      expect(cached.map((s) => s.toolName)).not.toContain(SAY);
      expect(cached.every((s) => s.resultPreview === undefined)).toBe(true);
    });

    it('are not asked for when they are exact', async () => {
      useChatStore.setState({
        stepsCache: { m1: { steps: exact, dropped: 0 } },
        thinkingCache: { m1: '先想一想。' },
      });
      expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
      expect(apiGetMock).not.toHaveBeenCalled();
    });
  });

  describe('follow the messages the store holds', () => {
    const cached = { steps: [toolStep('a', 'Read')], dropped: 0 };
    const seed = () =>
      useChatStore.setState({
        agents: {
          [JID]: [
            { id: SESSION, kind: 'conversation' } as unknown as AgentInfo,
          ],
        },
        agentMessages: {
          [SESSION]: [message('gone')],
          'session-other': [
            message('kept', { chat_jid: 'web:other#agent:session-other' }),
          ],
        },
        stepsCache: { gone: cached, kept: cached, orphan: cached },
      });

    it('lets go of a cleared history, and of what has no message', async () => {
      seed();
      await useChatStore.getState().clearHistory(JID);
      expect(Object.keys(useChatStore.getState().stepsCache)).toEqual(['kept']);
    });

    it('lets go of a deleted workspace, and of what has no message', async () => {
      seed();
      await useChatStore.getState().deleteFlow(JID);
      expect(Object.keys(useChatStore.getState().stepsCache)).toEqual(['kept']);
    });
  });
});

describe('what the caches hold when the level of the process changes', () => {
  const OTHER = 'web:other';
  const group = (over: Partial<GroupInfo> = {}): GroupInfo =>
    ({
      name: 'w',
      folder: 'trace',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'proactive',
      process_visibility: 'full',
      ...over,
    }) as GroupInfo;
  const held = { steps: [toolStep('a', 'Read')], dropped: 0 };
  /** Replies of the workspace, one of its sessions and another workspace. */
  const seed = (over: Partial<GroupInfo> = {}) => {
    useChatStore.setState({
      groups: { [JID]: group(over), [OTHER]: group({ folder: 'other' }) },
    });
    // Apart from the groups: changing a workspace's view lets go of its
    // caches, and these are the ones read at the view it has now.
    useChatStore.setState({
      agents: {
        [JID]: [
          { id: SESSION, kind: 'conversation' },
          { id: 's1', kind: 'conversation' },
        ] as unknown as AgentInfo[],
      },
      agentMessages: {
        [SESSION]: [message('m1')],
        'other-session': [
          message('o1', { chat_jid: `${OTHER}#agent:other-session` }),
        ],
        s1: [message('a1', { chat_jid: `${JID}#agent:s1` })],
      },
      thinkingCache: { m1: '想', a1: '想', o1: '想' },
      thinkingDurationCache: { m1: 3000, a1: 3000, o1: 3000 },
      traceCache: {
        m1: [row('a', '工具 Read')],
        a1: [row('a', '工具 Read')],
        o1: [row('a', '工具 Read')],
      },
      stepsCache: { m1: held, a1: held, o1: held },
      turnTraceStatus: { m1: 'empty', a1: 'empty', o1: 'empty' },
    });
  };
  const caches = (id: string) => {
    const s = useChatStore.getState();
    return [
      s.thinkingCache[id],
      s.thinkingDurationCache[id],
      s.traceCache[id],
      s.stepsCache[id],
      s.turnTraceStatus[id],
    ];
  };
  const none = [undefined, undefined, undefined, undefined, undefined];
  const change = async (level: string) => {
    apiPatchMock.mockResolvedValueOnce({
      success: true,
      process_visibility: level,
    });
    await useChatStore.getState().updateProcessVisibility(JID, level as never);
  };

  it.each([
    ['full', 'hidden'],
    ['full', 'activity'],
    ['activity', 'full'],
    ['hidden', 'full'],
    ['activity', 'hidden'],
  ] as const)(
    'lets go of what %s showed once the level is %s, for the workspace and its sessions',
    async (from, to) => {
      seed({ process_visibility: from });
      await change(to);
      expect(caches('m1')).toEqual(none);
      expect(caches('a1')).toEqual(none);
      // Another workspace is not this one's business.
      expect(caches('o1')).toEqual([
        '想',
        3000,
        [expect.objectContaining({ id: 'a' })],
        held,
        'empty',
      ]);
      expect(useChatStore.getState().groups[JID].process_visibility).toBe(to);
    },
  );

  it('keeps them when the level is the one they were read at', async () => {
    seed({ process_visibility: 'activity' });
    await change('activity');
    expect(caches('m1')[3]).toBe(held);
    expect(caches('m1')[4]).toBe('empty');
  });

  it('keeps them in an Assistant workspace, which shows everything at any level', async () => {
    seed({ interaction_mode: 'assistant', process_visibility: 'hidden' });
    await change('full');
    expect(caches('m1')[3]).toBe(held);
  });

  it('lets go of them when the mode itself changes what is shown', async () => {
    seed({ process_visibility: 'hidden' });
    apiPatchMock.mockResolvedValueOnce({ success: true });
    await useChatStore.getState().updateInteractionMode(JID, 'assistant');
    expect(caches('m1')).toEqual(none);

    seed({ interaction_mode: 'assistant', process_visibility: 'activity' });
    apiPatchMock.mockResolvedValueOnce({ success: true });
    await useChatStore.getState().updateInteractionMode(JID, 'proactive');
    expect(caches('a1')).toEqual(none);
  });

  it('lets go of them when a proactive workspace at full becomes an Assistant one', async () => {
    // Same level of detail, but an Assistant workspace also shows what the
    // tools returned, which a proactive one's steps were read without.
    seed({ process_visibility: 'full' });
    apiPatchMock.mockResolvedValueOnce({ success: true });
    await useChatStore.getState().updateInteractionMode(JID, 'assistant');
    expect(caches('m1')).toEqual(none);
  });

  it('lets go of them when an Assistant workspace becomes a proactive one at full', async () => {
    seed({ interaction_mode: 'assistant', process_visibility: 'full' });
    apiPatchMock.mockResolvedValueOnce({ success: true });
    await useChatStore.getState().updateInteractionMode(JID, 'proactive');
    expect(caches('m1')).toEqual(none);
  });

  it('keeps them when the server refuses the change', async () => {
    seed({ process_visibility: 'full' });
    apiPatchMock.mockRejectedValueOnce(new Error('nope'));
    expect(
      await useChatStore.getState().updateProcessVisibility(JID, 'hidden'),
    ).toBe(false);
    expect(caches('m1')[3]).toBe(held);
  });
});

describe('what the caches hold when another tab or page changes the level', () => {
  const OTHER = 'web:other';
  const held = { steps: [toolStep('a', 'Read')], dropped: 0 };
  const group = (over: Partial<GroupInfo> = {}): GroupInfo =>
    ({
      name: 'w',
      folder: 'trace',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'proactive',
      process_visibility: 'full',
      ...over,
    }) as GroupInfo;
  const seed = (over: Partial<GroupInfo> = {}) => {
    useChatStore.setState({
      groups: { [JID]: group(over), [OTHER]: group({ folder: 'other' }) },
    });
    // Apart from the groups: changing a workspace's view lets go of its
    // caches, and these are the ones read at the view it has now.
    useChatStore.setState({
      agents: {
        [JID]: [
          { id: SESSION, kind: 'conversation' },
          { id: 's1', kind: 'conversation' },
        ] as unknown as AgentInfo[],
      },
      agentMessages: {
        [SESSION]: [message('m1')],
        'other-session': [
          message('o1', { chat_jid: `${OTHER}#agent:other-session` }),
        ],
        s1: [message('a1', { chat_jid: `${JID}#agent:s1` })],
      },
      thinkingCache: { m1: '想', a1: '想', o1: '想' },
      thinkingDurationCache: { m1: 3000, a1: 3000, o1: 3000 },
      traceCache: {
        m1: [row('a', '工具 Read')],
        a1: [row('a', '工具 Read')],
        o1: [row('a', '工具 Read')],
      },
      stepsCache: { m1: held, a1: held, o1: held },
      turnTraceStatus: { m1: 'empty', a1: 'empty', o1: 'empty' },
    });
  };
  const caches = (id: string) => {
    const s = useChatStore.getState();
    return [
      s.thinkingCache[id],
      s.thinkingDurationCache[id],
      s.traceCache[id],
      s.stepsCache[id],
      s.turnTraceStatus[id],
    ];
  };
  const none = [undefined, undefined, undefined, undefined, undefined];
  /** What another tab did is only known from the groups the next load brings. */
  const loadGroupsAs = async (over: Partial<GroupInfo>) => {
    apiGetMock.mockResolvedValueOnce({
      groups: { [JID]: group(over), [OTHER]: group({ folder: 'other' }) },
    });
    await useChatStore.getState().loadGroups();
  };

  it.each([
    ['full', 'hidden'],
    ['full', 'activity'],
    ['activity', 'full'],
    ['hidden', 'full'],
  ] as const)(
    'lets go of what %s showed when a load finds the level %s',
    async (from, to) => {
      seed({ process_visibility: from });
      await loadGroupsAs({ process_visibility: to });
      expect(caches('m1')).toEqual(none);
      expect(caches('a1')).toEqual(none);
      // Another workspace did not change.
      expect(caches('o1')[3]).toBe(held);
      expect(useChatStore.getState().groups[JID].process_visibility).toBe(to);
    },
  );

  it.each([
    ['assistant', 'proactive'],
    ['proactive', 'assistant'],
  ] as const)(
    'lets go of what an %s workspace showed when a load finds it %s, at the same level',
    async (from, to) => {
      seed({ interaction_mode: from, process_visibility: 'full' });
      await loadGroupsAs({ interaction_mode: to, process_visibility: 'full' });
      expect(caches('m1')).toEqual(none);
    },
  );

  it('lets go of them when the groups are replaced some other way', async () => {
    seed({ process_visibility: 'full' });
    useChatStore.setState((s) => ({
      groups: { ...s.groups, [JID]: group({ process_visibility: 'hidden' }) },
    }));
    expect(caches('m1')).toEqual(none);
    expect(caches('o1')[3]).toBe(held);
  });

  it('keeps them when a load finds the workspace as it was', async () => {
    seed({ process_visibility: 'activity' });
    await loadGroupsAs({ process_visibility: 'activity' });
    expect(caches('m1')[3]).toBe(held);
    expect(caches('m1')[4]).toBe('empty');
  });

  it('keeps them when a load finds only the name, the pin or the profile changed', async () => {
    seed({ process_visibility: 'full' });
    await loadGroupsAs({
      name: '改了名',
      pinned_at: '2026-10-10T00:00:00.000Z',
      agent_profile_name: '另一个',
    } as Partial<GroupInfo>);
    expect(caches('m1')[3]).toBe(held);
  });

  it('keeps an Assistant workspace, which shows everything whatever level it carries', async () => {
    seed({ interaction_mode: 'assistant', process_visibility: 'hidden' });
    await loadGroupsAs({
      interaction_mode: 'assistant',
      process_visibility: 'full',
    });
    expect(caches('m1')[3]).toBe(held);
  });

  it('has nothing to let go of the first time the workspaces load', async () => {
    useChatStore.setState({
      groups: {},
      agentMessages: { [SESSION]: [message('m1')] },
      stepsCache: { m1: held },
    });
    await loadGroupsAs({ process_visibility: 'hidden' });
    expect(caches('m1')[3]).toBe(held);
  });

  it('keeps what is held for a workspace that has gone from the list', async () => {
    seed({ process_visibility: 'full' });
    apiGetMock.mockResolvedValueOnce({
      groups: { [OTHER]: group({ folder: 'other' }) },
    });
    await useChatStore.getState().loadGroups();
    // Not a level change: what the deletion does with it is its own business.
    expect(caches('m1')[3]).toBe(held);
  });
});

describe('what the steps cache may hold in all', () => {
  const chars = 900_000;
  const big = (label: string, size = chars) => ({
    steps: [
      step({
        id: `thinking-${label}`,
        kind: 'thinking',
        title: label,
        text: 'x'.repeat(size),
      }),
    ],
    dropped: 0,
  });
  const held = (...ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, big(id)]));
  const turn = (size = 1000) => ({
    turn_id: 'turn-1',
    thinking: '',
    trace: [],
    steps: big('new', size).steps,
    steps_dropped: 0,
  });
  const room = Math.floor(MAX_STEPS_CACHE_CHARS / chars);

  it('lets go of the oldest entries first when a load takes it past the limit', async () => {
    const ids = Array.from({ length: room }, (_, i) => `old-${i}`);
    useChatStore.setState({ stepsCache: held(...ids) });
    apiGetMock.mockResolvedValueOnce(turn(chars));
    await useChatStore.getState().loadTurnTrace(message('new'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).not.toContain('old-0');
    expect(keys).toContain('old-1');
    expect(keys.at(-1)).toBe('new');
    expect(keys).toHaveLength(room);
  });

  it('keeps what is on screen, and lets go of the oldest that is not', async () => {
    const ids = Array.from({ length: room }, (_, i) => `old-${i}`);
    useChatStore.setState({
      stepsCache: held(...ids),
      currentGroup: JID,
      activeAgentTab: { [JID]: SESSION },
      agentMessages: {
        [SESSION]: [message('old-0'), message('old-1')],
        elsewhere: [
          message('old-2', { chat_jid: 'web:elsewhere#agent:elsewhere' }),
        ],
      },
    });
    apiGetMock.mockResolvedValueOnce(turn(chars));
    await useChatStore.getState().loadTurnTrace(message('new'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    // The two the reader sees stay; the oldest of the rest goes.
    expect(keys).toContain('old-0');
    expect(keys).toContain('old-1');
    expect(keys).not.toContain('old-2');
    expect(keys).toContain('new');
  });

  it('keeps what is on screen in the session tab that is open', async () => {
    const ids = Array.from({ length: room }, (_, i) => `old-${i}`);
    useChatStore.setState({
      stepsCache: held(...ids),
      currentGroup: JID,
      activeAgentTab: { [JID]: 's1' },
      agentMessages: { [SESSION]: [] },
      agentMessages: {
        s1: [message('old-0', { chat_jid: `${JID}#agent:s1` })],
      },
    });
    apiGetMock.mockResolvedValueOnce(turn(chars));
    await useChatStore.getState().loadTurnTrace(message('new'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).toContain('old-0');
    expect(keys).not.toContain('old-1');
  });

  it('lets go of the oldest on screen only when the screen alone is past the limit', async () => {
    const ids = Array.from({ length: room }, (_, i) => `old-${i}`);
    useChatStore.setState({
      stepsCache: held(...ids),
      currentGroup: JID,
      agentMessages: { [SESSION]: ids.map((id) => message(id)) },
    });
    apiGetMock.mockResolvedValueOnce(turn(chars));
    await useChatStore.getState().loadTurnTrace(message('new'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).not.toContain('old-0');
    expect(keys).toContain('new');
    expect(keys).toHaveLength(room);
  });

  it('counts the text a step carries, not how many steps there are', async () => {
    const ids = Array.from({ length: room - 1 }, (_, i) => `old-${i}`);
    useChatStore.setState({ stepsCache: held(...ids) });
    // The text is spread over four fields of one step: all of it counts.
    const quarter = chars / 4;
    const spread = {
      turn_id: 'turn-1',
      steps: [
        toolStep('a', 'Bash', {
          title: 't'.repeat(quarter),
          summary: 's'.repeat(quarter),
          resultPreview: 'r'.repeat(quarter),
          text: 'x'.repeat(quarter),
        }),
        toolStep('b', 'Bash', { summary: 's'.repeat(chars * 0.6) }),
      ],
      steps_dropped: 0,
    };
    apiGetMock.mockResolvedValueOnce(spread);
    await useChatStore.getState().loadTurnTrace(message('new'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).not.toContain('old-0');
    expect(keys).toContain('new');
  });

  it('counts an entry written again as the newest, so it is the last to go', async () => {
    const ids = Array.from({ length: room }, (_, i) => `old-${i}`);
    useChatStore.setState({
      stepsCache: {
        ...held(...ids),
        'old-0': { ...big('old-0'), provisional: true },
      },
    });
    apiGetMock.mockResolvedValueOnce(turn(chars * 1.5));
    await useChatStore.getState().loadTurnTrace(message('old-0'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys.at(-1)).toBe('old-0');
    expect(keys).not.toContain('old-1');
    expect(keys).toContain('old-2');
  });

  it('leaves the cache alone while it is within the limit', async () => {
    const ids = Array.from({ length: room - 1 }, (_, i) => `old-${i}`);
    useChatStore.setState({ stepsCache: held(...ids) });
    apiGetMock.mockResolvedValueOnce(turn(10));
    await useChatStore.getState().loadTurnTrace(message('new'));
    const keys = Object.keys(useChatStore.getState().stepsCache);
    expect(keys).toEqual([...ids, 'new']);
  });

  it('keeps the newest entry even when it alone is large', async () => {
    useChatStore.setState({ stepsCache: held('old-0') });
    apiGetMock.mockResolvedValueOnce(turn(MAX_STEPS_CACHE_CHARS + 1000));
    await useChatStore.getState().loadTurnTrace(message('new'));
    expect(Object.keys(useChatStore.getState().stepsCache)).toEqual(['new']);
  });
});

describe('a turn trace that is answered after the view of its workspace changed', () => {
  const group = (over: Partial<GroupInfo> = {}): GroupInfo =>
    ({
      name: 'w',
      folder: 'trace',
      added_at: '2026-01-01T00:00:00.000Z',
      interaction_mode: 'proactive',
      process_visibility: 'hidden',
      ...over,
    }) as GroupInfo;
  const viewIs = (over: Partial<GroupInfo>, jid = JID) =>
    useChatStore.setState((s) => ({
      groups: { ...s.groups, [jid]: group(over) },
    }));
  const SECRET = '不该留在内存里的推理全文';
  const full = () => ({
    turn_id: 'turn-1',
    thinking: SECRET,
    thinking_duration_ms: 5000,
    trace: [row('a', '工具 Read', { toolUseId: 'a' })],
    steps: [
      thinking('t0', { text: SECRET }),
      toolStep('a', 'Read', { resultPreview: '文件内容' }),
    ],
    steps_dropped: 0,
  });
  /** A request the test answers when it chooses. */
  const inFlight = () => {
    let answer!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    apiGetMock.mockReturnValueOnce(
      new Promise((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
    );
    return { answer, fail };
  };
  const held = (id = 'm1') => {
    const s = useChatStore.getState();
    return [
      s.thinkingCache[id],
      s.thinkingDurationCache[id],
      s.traceCache[id],
      s.stepsCache[id],
    ];
  };

  beforeEach(() => {
    viewIs({ process_visibility: 'hidden' });
    // The reply is on screen: a change of view lets go of what is held for it.
    useChatStore.setState({ agentMessages: { [SESSION]: [message()] } });
  });

  it('does not mark the reply empty when the level is raised after it was asked for (404)', async () => {
    const request = inFlight();
    const loading = useChatStore.getState().loadTurnTrace(message());
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');

    viewIs({ process_visibility: 'full' });
    request.fail({ status: 404, message: 'Not found' });
    expect(await loading).toBe(false);

    // Not 'empty', which would hide its row for good, and not stuck loading.
    expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
    expect(held()).toEqual([undefined, undefined, undefined, undefined]);

    // It can be asked for again, and now it is shown.
    apiGetMock.mockResolvedValueOnce(full());
    expect(await useChatStore.getState().loadTurnTrace(message())).toBe(true);
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().stepsCache.m1?.steps).toHaveLength(2);
  });

  it('does not mark the reply empty when an answer with nothing in it comes after the level was raised', async () => {
    const request = inFlight();
    const loading = useChatStore.getState().loadTurnTrace(message());
    viewIs({ process_visibility: 'full' });
    request.answer({ turn_id: 'turn-1', thinking: '', trace: [], steps: [] });
    await loading;
    expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
  });

  it('does not mark the reply failed when the request fails after the view changed', async () => {
    const request = inFlight();
    const loading = useChatStore.getState().loadTurnTrace(message());
    viewIs({ process_visibility: 'full' });
    request.fail({ status: 0, message: 'Network error' });
    await loading;
    expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
    expect(useChatStore.getState().error).toBeNull();
  });

  it('does not keep what the old level showed when the level is lowered after it was asked for', async () => {
    viewIs({ process_visibility: 'full' });
    const request = inFlight();
    const loading = useChatStore.getState().loadTurnTrace(message());

    viewIs({ process_visibility: 'activity' });
    request.answer(full());
    expect(await loading).toBe(false);

    expect(held()).toEqual([undefined, undefined, undefined, undefined]);
    expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
    expect(JSON.stringify(useChatStore.getState())).not.toContain(SECRET);
  });

  it.each([
    ['full', 'hidden'],
    ['activity', 'hidden'],
    ['hidden', 'activity'],
  ] as const)(
    'drops an answer asked for at %s when the level has become %s',
    async (from, to) => {
      viewIs({ process_visibility: from });
      const request = inFlight();
      const loading = useChatStore.getState().loadTurnTrace(message());
      viewIs({ process_visibility: to });
      request.answer(full());
      await loading;
      expect(held()).toEqual([undefined, undefined, undefined, undefined]);
      expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
    },
  );

  it('drops an answer asked for in an Assistant workspace that has become a proactive one', async () => {
    viewIs({ interaction_mode: 'assistant', process_visibility: 'full' });
    const request = inFlight();
    const loading = useChatStore.getState().loadTurnTrace(message());
    viewIs({ interaction_mode: 'proactive', process_visibility: 'full' });
    request.answer(full());
    await loading;
    expect(held()).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('follows the workspace of a session reply', async () => {
    const reply = message('a1', { chat_jid: `${JID}#agent:s1` });
    viewIs({ process_visibility: 'full' });
    const request = inFlight();
    const loading = useChatStore.getState().loadTurnTrace(reply);
    viewIs({ process_visibility: 'activity' });
    request.answer(full());
    await loading;
    expect(held('a1')).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('is not left loading when the workspace was not known yet and has now arrived as a hidden one', async () => {
    useChatStore.setState({ groups: {} });
    const request = inFlight();
    const loading = useChatStore.getState().loadTurnTrace(message());
    // Not a change the store lets go of caches for: nothing was held yet.
    viewIs({ process_visibility: 'hidden' });
    expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');
    request.answer(full());
    await loading;
    expect(held()).toEqual([undefined, undefined, undefined, undefined]);
    expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
  });

  describe('when the view is the same as when it was asked for', () => {
    it('writes what the server answered', async () => {
      viewIs({ process_visibility: 'full' });
      const request = inFlight();
      const loading = useChatStore.getState().loadTurnTrace(message());
      request.answer({
        ...full(),
        steps: [thinking('t0', { text: SECRET })],
      });
      expect(await loading).toBe(true);
      const state = useChatStore.getState();
      expect(state.thinkingCache.m1).toBe(SECRET);
      expect(state.stepsCache.m1?.steps).toHaveLength(1);
      expect(state.turnTraceStatus.m1).toBeUndefined();
    });

    it('marks a turn the server no longer shows as empty (404)', async () => {
      const request = inFlight();
      const loading = useChatStore.getState().loadTurnTrace(message());
      request.fail({ status: 404, message: 'Not found' });
      await loading;
      expect(useChatStore.getState().turnTraceStatus.m1).toBe('empty');
    });

    it('marks a failure as failed, to be asked for again', async () => {
      const request = inFlight();
      const loading = useChatStore.getState().loadTurnTrace(message());
      request.fail({ status: 0, message: 'Network error' });
      await loading;
      expect(useChatStore.getState().turnTraceStatus.m1).toBe('failed');
    });

    it('writes when only the name or the pin of the workspace changed meanwhile', async () => {
      viewIs({ process_visibility: 'full' });
      const request = inFlight();
      const loading = useChatStore.getState().loadTurnTrace(message());
      viewIs({
        process_visibility: 'full',
        name: '改了名',
        pinned_at: '2026-10-10T00:00:00.000Z',
      });
      request.answer(full());
      await loading;
      expect(useChatStore.getState().thinkingCache.m1).toBe(SECRET);
    });

    it('writes when the view went away and came back', async () => {
      viewIs({ process_visibility: 'full' });
      const request = inFlight();
      const loading = useChatStore.getState().loadTurnTrace(message());
      viewIs({ process_visibility: 'hidden' });
      viewIs({ process_visibility: 'full' });
      request.answer(full());
      await loading;
      expect(useChatStore.getState().thinkingCache.m1).toBe(SECRET);
      expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
    });

    it('writes in an Assistant workspace whatever level it carries meanwhile', async () => {
      viewIs({ interaction_mode: 'assistant', process_visibility: 'hidden' });
      const request = inFlight();
      const loading = useChatStore.getState().loadTurnTrace(message());
      viewIs({ interaction_mode: 'assistant', process_visibility: 'full' });
      request.answer(full());
      await loading;
      expect(useChatStore.getState().thinkingCache.m1).toBe(SECRET);
    });
  });

  describe('when the reply is asked for again under the new view', () => {
    it('keeps the later request loading while the earlier one is dropped', async () => {
      viewIs({ process_visibility: 'hidden' });
      const first = inFlight();
      const firstLoad = useChatStore.getState().loadTurnTrace(message());

      viewIs({ process_visibility: 'full' });
      const second = inFlight();
      const secondLoad = useChatStore.getState().loadTurnTrace(message());
      expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');

      // The old answer comes first: it is dropped, the new request still loads.
      first.fail({ status: 404, message: 'Not found' });
      expect(await firstLoad).toBe(false);
      expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');
      expect(held()).toEqual([undefined, undefined, undefined, undefined]);

      second.answer(full());
      expect(await secondLoad).toBe(true);
      expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
      expect(useChatStore.getState().thinkingCache.m1).toBe(SECRET);
    });

    it('leaves the later request its loading when an earlier one of the same view answers first', async () => {
      viewIs({ process_visibility: 'full' });
      const first = inFlight();
      const firstLoad = useChatStore.getState().loadTurnTrace(message());

      // The view goes away and comes back, which lets go of the loading, and
      // the reply is asked for again.
      viewIs({ process_visibility: 'hidden' });
      viewIs({ process_visibility: 'full' });
      const second = inFlight();
      const secondLoad = useChatStore.getState().loadTurnTrace(message());
      expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');

      first.answer(full());
      expect(await firstLoad).toBe(false);
      expect(useChatStore.getState().turnTraceStatus.m1).toBe('loading');

      second.answer(full());
      expect(await secondLoad).toBe(true);
      expect(useChatStore.getState().turnTraceStatus.m1).toBeUndefined();
      expect(useChatStore.getState().thinkingCache.m1).toBe(SECRET);
    });

    it('does not let the earlier answer overwrite the later one', async () => {
      viewIs({ process_visibility: 'full' });
      const first = inFlight();
      const firstLoad = useChatStore.getState().loadTurnTrace(message());

      viewIs({ process_visibility: 'activity' });
      const second = inFlight();
      const secondLoad = useChatStore.getState().loadTurnTrace(message());
      second.answer({
        turn_id: 'turn-1',
        thinking: '',
        trace: [row('a', '工具 Read', { toolUseId: 'a' })],
        steps: [toolStep('a', 'Read')],
        steps_dropped: 0,
      });
      await secondLoad;

      first.answer(full());
      await firstLoad;
      const state = useChatStore.getState();
      expect(state.thinkingCache.m1).toBeUndefined();
      expect(state.stepsCache.m1?.steps).toHaveLength(1);
      expect(JSON.stringify(state)).not.toContain(SECRET);
    });
  });
});

describe('has_trace on a message', () => {
  it('is kept from a message the WebSocket delivers', () => {
    useChatStore.getState().handleWsNewMessage(
      JID,
      {
        id: 'ws-1',
        chat_jid: SESSION_JID,
        sender: 'happyclaw-agent',
        sender_name: 'HappyClaw',
        content: '终稿',
        timestamp: '2026-10-10T00:00:00.000Z',
        is_from_me: true,
        source_kind: 'sdk_final',
        turn_id: 'turn-ws',
        has_trace: true,
      },
      SESSION,
    );
    const [stored] = useChatStore.getState().agentMessages[SESSION];
    expect(stored).toMatchObject({ id: 'ws-1', turn_id: 'turn-ws' });
    expect(stored.has_trace).toBe(true);
  });

  it('is left out when the server did not say so', () => {
    useChatStore.getState().handleWsNewMessage(
      JID,
      {
        id: 'ws-2',
        chat_jid: SESSION_JID,
        sender: 'happyclaw-agent',
        sender_name: 'HappyClaw',
        content: '没有轨迹的回复',
        timestamp: '2026-10-10T00:00:00.000Z',
        is_from_me: true,
        source_kind: 'sdk_final',
        turn_id: 'turn-ws-2',
      },
      SESSION,
    );
    expect(
      useChatStore.getState().agentMessages[SESSION][0].has_trace,
    ).toBeUndefined();
  });

  it('reaches the stored message when the server adds it later', () => {
    const before = [message('m1', { has_trace: undefined })];
    const after = mergeMessagesChronologically(before, [message('m1')]);
    expect(after[0].has_trace).toBe(true);
  });
});
