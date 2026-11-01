// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupInfo, Message } from '../src/stores/chat';
import type { StreamingStep } from '../src/lib/stream-steps';

const { apiGetMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../src/api/client', () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: apiPatchMock,
    delete: vi.fn(),
  },
  computeUploadTimeoutMs: vi.fn(() => 8000),
}));

vi.mock('../src/api/ws', () => ({
  wsManager: {
    send: vi.fn(() => true),
    on: vi.fn(() => vi.fn()),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  },
}));

vi.mock('../src/utils/messageSnapshotCache', () => ({
  deleteAgentMessageSnapshot: vi.fn(async () => undefined),
  deleteGroupMessageSnapshots: vi.fn(async () => undefined),
  loadAgentMessageSnapshot: vi.fn(async () => null),
  saveAgentMessageSnapshot: vi.fn(async () => undefined),
}));

const { MessageBubble } = await import('../src/components/chat/MessageBubble');
const { forgetProcessOpenChoices } =
  await import('../src/lib/process-open-memory');
const { useChatStore } = await import('../src/stores/chat');
const initialState = useChatStore.getState();

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LAYOUT_KEY = 'happyclaw-stream-layout:guest';
const DISPLAY_KEY = 'happyclaw-display-mode:guest';
const memory = new Map<string, string>();

const JID = 'web:bubble-process';
const SESSION = 'session-1';
const SESSION_JID = `${JID}#agent:${SESSION}`;

const reply = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  chat_jid: SESSION_JID,
  sender: 'happyclaw-agent',
  sender_name: 'HappyClaw',
  content: '最终答案在这里。',
  timestamp: '2026-10-10T00:00:00.000Z',
  is_from_me: true,
  source_kind: 'sdk_final',
  turn_id: 'turn-1',
  has_trace: true,
  ...over,
});

const group = (over: Partial<GroupInfo> = {}) =>
  ({
    name: 'w',
    folder: 'bubble-process',
    added_at: '2026-01-01T00:00:00.000Z',
    interaction_mode: 'assistant',
    ...over,
  }) as GroupInfo;

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({
  at: 1_000_000,
  endedAt: 1_004_000,
  status: 'done',
  ...over,
});

/** Two reasoning bursts around two tool calls, with commentary between. */
const STEPS: StreamingStep[] = [
  step({
    id: 'thinking-0',
    kind: 'thinking',
    durationMs: 3000,
    title: '确认范围',
    text: '**确认范围**\n\n先看项目结构。',
  }),
  step({
    id: 'tool-a',
    kind: 'tool',
    at: 1_004_000,
    endedAt: 1_006_000,
    toolName: 'Bash',
    toolUseId: 'a',
    summary: 'command: npm test',
  }),
  step({
    id: 'text-0',
    kind: 'text',
    at: 1_006_000,
    endedAt: 1_007_000,
    text: '测试通过，再看一眼构建。',
  }),
  step({
    id: 'tool-b',
    kind: 'tool',
    at: 1_007_000,
    endedAt: 1_009_000,
    toolName: 'Bash',
    toolUseId: 'b',
    summary: 'command: npm run build',
  }),
  step({
    id: 'thinking-1',
    kind: 'thinking',
    at: 1_009_000,
    endedAt: 1_011_000,
    durationMs: 2000,
    title: '整理结论',
    text: '**整理结论**\n\n可以回答了。',
  }),
  step({
    id: 'answer',
    kind: 'text',
    at: 1_011_000,
    endedAt: 1_012_000,
    text: '最终答案在这里。',
  }),
];

const TRACE = [
  {
    id: 'r1',
    timestamp: 1,
    kind: 'tool' as const,
    title: '工具 Bash',
    summary: 'npm test',
    toolUseId: 'a',
  },
];

/** The way MessageList feeds a bubble: from the messages and caches of the store. */
function Row({ message: given }: { message: Message }) {
  const message =
    useChatStore((s) =>
      s.agentMessages[SESSION]?.find((m) => m.id === given.id),
    ) ?? given;
  const thinking = useChatStore((s) => s.thinkingCache[message.id]);
  const duration = useChatStore((s) => s.thinkingDurationCache[message.id]);
  const trace = useChatStore((s) => s.traceCache[message.id]);
  const steps = useChatStore((s) => s.stepsCache[message.id]);
  return (
    <MessageBubble
      message={message}
      showTime={false}
      thinkingContent={thinking}
      thinkingDurationMs={duration}
      traceEvents={trace}
      replySteps={steps}
    />
  );
}

let root: Root;
let container: HTMLDivElement;

function seed(
  caches: {
    steps?: StreamingStep[];
    dropped?: number;
    provisional?: boolean;
    thinking?: string;
    duration?: number;
    trace?: typeof TRACE;
  } = {},
) {
  useChatStore.setState({
    ...(caches.steps
      ? {
          stepsCache: {
            m1: {
              steps: caches.steps,
              dropped: caches.dropped ?? 0,
              ...(caches.provisional ? { provisional: true } : {}),
            },
          },
        }
      : {}),
    ...(caches.thinking ? { thinkingCache: { m1: caches.thinking } } : {}),
    ...(caches.duration
      ? { thinkingDurationCache: { m1: caches.duration } }
      : {}),
    ...(caches.trace ? { traceCache: { m1: caches.trace } } : {}),
  });
}

const mount = (message: Message = reply()) =>
  act(async () => {
    root.render(<Row message={message} />);
  });
const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });

const card = () =>
  container.querySelector<HTMLElement>('[data-hc-process-card]');
const summaryRow = () => card()?.querySelector('button') ?? null;
/** What an opened card says it used. */
const counts = () =>
  container.querySelector('[data-hc-work-counts]')?.textContent ?? '';
const text = () => container.textContent ?? '';
const timeline = () =>
  container.querySelector('[role="list"][aria-label="处理步骤"]');

beforeEach(() => {
  apiGetMock.mockReset();
  apiPatchMock.mockReset();
  memory.clear();
  // Every reply here is turn-1: what one test opened must not carry over.
  forgetProcessOpenChoices();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
      clear: () => memory.clear(),
    },
  });
  useChatStore.setState(
    {
      ...initialState,
      groups: { [JID]: group() },
      agentMessages: { [SESSION]: [] },
      thinkingCache: {},
      thinkingDurationCache: {},
      traceCache: {},
      stepsCache: {},
      turnTraceStatus: {},
    },
    true,
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('a finished reply that has its steps', () => {
  it('sums them up in one settled row instead of the reasoning and the trace', async () => {
    seed({
      steps: STEPS,
      thinking: '**确认范围**\n\n先看项目结构。',
      duration: 5000,
      trace: TRACE,
    });
    await mount();

    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(summaryRow()?.textContent).toBe('已工作 11s');
    expect(summaryRow()?.getAttribute('aria-expanded')).toBe('false');
    // Collapsed: the steps are not listed, and the two old rows are not there.
    expect(timeline()).toBeNull();
    expect(text()).not.toContain('执行详情');
    expect(text()).not.toMatch(/已思考 \d/);
    expect(text()).toContain('最终答案在这里。');
  });

  it('offers no row to load what the cache already holds', async () => {
    // Only the steps are cached: nothing is left on the server to ask for.
    seed({ steps: STEPS });
    await mount();
    expect(text()).not.toContain('处理过程');
    expect(card()).toBeTruthy();
  });

  it('does the same in the compact display mode', async () => {
    memory.set(DISPLAY_KEY, 'compact');
    seed({
      steps: STEPS,
      thinking: '**确认范围**\n\n先看项目结构。',
      duration: 5000,
      trace: TRACE,
    });
    await mount();
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(summaryRow()?.textContent).toBe('已工作 11s');
    expect(text()).not.toContain('执行详情');
    expect(text()).not.toMatch(/已思考 \d/);
  });

  it('keeps the two rows in the compact display mode without steps', async () => {
    memory.set(DISPLAY_KEY, 'compact');
    seed({ thinking: '**确认范围**\n\n先看。', duration: 5000, trace: TRACE });
    await mount();
    expect(card()).toBeNull();
    expect(text()).toContain('执行详情');
  });

  it('opens to the steps in the order they happened', async () => {
    seed({ steps: STEPS });
    await mount();
    await click(summaryRow());

    expect(summaryRow()?.getAttribute('aria-expanded')).toBe('true');
    const rows = [...(timeline()?.querySelectorAll('[role="listitem"]') ?? [])];
    const order = [
      '确认范围',
      'npm test',
      '测试通过，再看一眼构建。',
      'npm run build',
      '整理结论',
    ].map((needle) =>
      rows.findIndex((row) => row.textContent?.includes(needle)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The answer is the message, not a row of the card.
    expect(timeline()?.textContent).not.toContain('最终答案在这里。');
  });

  it('keeps the card above the answer, where the streaming card left it', async () => {
    seed({ steps: STEPS });
    await mount();
    const answer = [...container.querySelectorAll('p')].find((p) =>
      p.textContent?.includes('最终答案在这里。'),
    );
    expect(answer).toBeTruthy();
    expect(
      card()!.compareDocumentPosition(answer!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps a denied permission above the card and a Workflow below it', async () => {
    seed({
      steps: STEPS,
      trace: [
        ...TRACE,
        {
          id: 'p1',
          timestamp: 2,
          kind: 'permission' as never,
          title: '权限被拒：Write',
          summary: 'a.ts',
        },
      ],
    });
    await mount(
      reply({
        workflow_runs: [
          {
            taskId: 'wf-1',
            workflowName: '审查流程',
            summary: '审查完成',
            status: 'completed',
            phases: [],
            agents: [],
          },
        ],
      }),
    );

    const alert = [...container.querySelectorAll('div')].find((el) =>
      el.textContent?.startsWith('权限被拒绝 (1)'),
    );
    const workflow = container.querySelector(
      'section[aria-label^="动态工作流"]',
    );
    expect(alert).toBeTruthy();
    expect(workflow).toBeTruthy();
    const after = (a: Node, b: Node) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(alert!, card()!)).toBe(true);
    expect(after(card()!, workflow!)).toBe(true);
    // The trace panel the card replaces is not there.
    expect(text()).not.toContain('执行详情');
  });

  it('takes the total time from the reply when the steps carry none', async () => {
    seed({
      steps: [
        step({
          id: 'thinking-0',
          kind: 'thinking',
          at: 0,
          endedAt: undefined,
          status: 'done',
        }),
        step({
          id: 'tool-a',
          kind: 'tool',
          at: 0,
          endedAt: undefined,
          toolName: 'Bash',
          toolUseId: 'a',
          summary: 'command: npm run lint',
        }),
      ],
      duration: 9000,
    });
    await mount();
    expect(summaryRow()?.textContent).toBe('已工作 9s');
  });

  it('says how many steps were dropped from the front when it is opened', async () => {
    seed({ steps: STEPS, dropped: 12 });
    await mount();
    await click(summaryRow());
    expect(text()).toContain('较早 12 步');
  });

  it('lists the commentary and the reasoning text of an assistant workspace', async () => {
    seed({ steps: STEPS });
    await mount();
    await click(summaryRow());
    expect(text()).toContain('测试通过，再看一眼构建。');
    expect(text()).toContain('确认范围');
  });
});

describe('a finished reply the card does not take', () => {
  const OLD = {
    thinking: '**确认范围**\n\n先看项目结构。',
    duration: 5000,
    trace: TRACE,
  };
  const twoRows = () => {
    expect(text()).toMatch(/已思考 \d/);
    expect(text()).toContain('执行详情');
    expect(card()).toBeNull();
  };

  it('keeps the two rows in the classic layout', async () => {
    memory.set(LAYOUT_KEY, 'classic');
    seed({ steps: STEPS, ...OLD });
    await mount();
    twoRows();
  });

  it('keeps the two rows of a reply with no steps (an older turn)', async () => {
    seed(OLD);
    await mount();
    twoRows();
  });

  it('keeps the two rows when the steps hold nothing to list', async () => {
    seed({
      steps: [step({ id: 'answer', kind: 'text', text: '最终答案在这里。' })],
      ...OLD,
    });
    await mount();
    twoRows();
  });

  it('keeps a reply of the classic layout open when asked, as it was', async () => {
    memory.set(LAYOUT_KEY, 'classic');
    seed({ steps: STEPS, ...OLD });
    await mount();
    const thinkingRow = [...container.querySelectorAll('button')].find((b) =>
      /已思考/.test(b.textContent ?? ''),
    );
    expect(thinkingRow?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('what a proactive workspace lets its owner see', () => {
  const secretSteps = [
    step({
      id: 'thinking-0',
      kind: 'thinking',
      durationMs: 3000,
      title: '内部推理标题',
      text: '**内部推理标题**\n\n不该出现的推理。',
    }),
    step({
      id: 'text-0',
      kind: 'text',
      at: 1_004_000,
      endedAt: 1_005_000,
      text: '不该出现的过程说明。',
      commentary: true,
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_005_000,
      endedAt: 1_006_000,
      toolName: 'Bash',
      toolUseId: 'a',
      summary: 'command: npm test',
    }),
  ];
  const proactive = (level: 'activity' | 'full') =>
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: level,
        }),
      },
    });

  it('shows the reasoning text and the commentary at the full level', async () => {
    proactive('full');
    seed({ steps: secretSteps });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    await click(summaryRow());
    expect(text()).toContain('内部推理标题');
    expect(text()).toContain('不该出现的过程说明。');
  });

  it('shows neither at the activity level, only that the model reasoned', async () => {
    proactive('activity');
    seed({ steps: secretSteps });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    await click(summaryRow());
    expect(counts()).toContain('1 个工具');
    expect(text()).not.toContain('内部推理标题');
    expect(text()).not.toContain('不该出现的推理');
    expect(text()).not.toContain('不该出现的过程说明');
    expect(text()).toContain('npm test');
  });

  it('keeps the two rows when the level leaves no step to list', async () => {
    proactive('activity');
    seed({
      steps: [secretSteps[1]],
      thinking: '推理',
      duration: 4000,
    });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    expect(card()).toBeNull();
    expect(text()).toMatch(/已思考 \d/);
  });
});

describe('a reply that is replaced', () => {
  it('follows the steps that arrive for it', async () => {
    await mount(reply({ has_trace: undefined }));
    expect(card()).toBeNull();
    act(() => seed({ steps: STEPS }));
    await act(async () => {});
    expect(card()?.getAttribute('data-mode')).toBe('settled');
  });
});

describe('a proactive workspace at the hidden level', () => {
  beforeEach(() => {
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: 'hidden',
        }),
      },
    });
  });

  it('shows none of the process it still holds in memory', async () => {
    seed({
      steps: STEPS,
      thinking: '**确认范围**\n\n先看项目结构。',
      duration: 5000,
      trace: [
        ...TRACE,
        {
          id: 'p1',
          timestamp: 2,
          kind: 'permission' as never,
          title: '权限被拒：Write',
          summary: 'a.ts',
        },
      ],
    });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    expect(card()).toBeNull();
    expect(text()).not.toContain('npm test');
    expect(text()).not.toContain('已思考');
    expect(text()).not.toContain('执行详情');
    expect(text()).not.toContain('权限被拒');
    expect(text()).not.toContain('处理过程');
    expect(text()).toContain('最终答案在这里。');
  });

  it('shows the same steps once the level lets them through', async () => {
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: 'activity',
        }),
      },
    });
    seed({ steps: STEPS });
    await mount(reply({ source_kind: 'sdk_send_message' }));
    expect(card()).toBeTruthy();
  });
});

describe('when the owner changes the level of the process', () => {
  const FULL_STEPS = [
    step({
      id: 'thinking-0',
      kind: 'thinking',
      durationMs: 3000,
      title: '内部推理标题',
      text: '**内部推理标题**\n\n不该留下的推理。',
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_004_000,
      endedAt: 1_005_000,
      toolName: 'Bash',
      toolUseId: 'a',
      summary: 'command: npm test',
      resultPreview: '12 passed',
    }),
  ];
  const at = (level: 'hidden' | 'activity' | 'full') =>
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: level,
        }),
      },
    });
  const change = (level: 'hidden' | 'activity' | 'full') =>
    act(async () => {
      apiPatchMock.mockResolvedValueOnce({
        success: true,
        process_visibility: level,
      });
      await useChatStore.getState().updateProcessVisibility(JID, level);
    });
  const seedFull = () => {
    at('full');
    useChatStore.setState({ agentMessages: { [SESSION]: [reply()] } });
    seed({
      steps: FULL_STEPS,
      thinking: '**内部推理标题**\n\n不该留下的推理。',
      duration: 3000,
      trace: TRACE,
    });
  };

  it('takes the card away, and what it listed from memory, at the hidden level', async () => {
    seedFull();
    await mount();
    await click(summaryRow());
    expect(text()).toContain('npm test');
    expect(text()).toContain('内部推理标题');

    await change('hidden');
    expect(card()).toBeNull();
    expect(text()).not.toContain('npm test');
    expect(text()).not.toContain('内部推理标题');
    expect(text()).not.toContain('处理过程');
    const state = useChatStore.getState();
    expect(state.stepsCache.m1).toBeUndefined();
    expect(state.thinkingCache.m1).toBeUndefined();
    expect(state.traceCache.m1).toBeUndefined();
  });

  it('shows no reasoning text at the activity level that was read at full', async () => {
    seedFull();
    await mount();
    await click(summaryRow());
    expect(text()).toContain('内部推理标题');

    await change('activity');
    // What was loaded at full is gone; the reply offers its process again.
    expect(text()).not.toContain('内部推理标题');
    expect(useChatStore.getState().stepsCache.m1).toBeUndefined();
    expect(useChatStore.getState().thinkingCache.m1).toBeUndefined();

    apiGetMock.mockResolvedValueOnce({
      turn_id: 'turn-1',
      thinking: '',
      trace: [],
      steps: [
        { ...FULL_STEPS[0], text: undefined, title: undefined },
        { ...FULL_STEPS[1], resultPreview: undefined },
      ],
      steps_dropped: 0,
    });
    await click(
      [...container.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('处理过程'),
      ),
    );
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(text()).toContain('npm test');
    expect(text()).not.toContain('内部推理标题');
    expect(text()).not.toContain('不该留下的推理');
    expect(text()).not.toContain('12 passed');
  });

  it.each(['hidden', 'activity'] as const)(
    'offers the process to load again once the level goes from %s to full',
    async (from) => {
      at(from);
      useChatStore.setState({
        agentMessages: { [SESSION]: [reply()] },
        // The ask at the lower level found nothing to show.
        turnTraceStatus: { m1: 'empty' },
      });
      await mount();
      expect(text()).not.toContain('处理过程');

      await change('full');
      const row = [...container.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('处理过程'),
      );
      expect(row).toBeTruthy();

      apiGetMock.mockResolvedValueOnce({
        turn_id: 'turn-1',
        thinking: '**内部推理标题**\n\n推理。',
        trace: TRACE,
        steps: FULL_STEPS,
        steps_dropped: 0,
      });
      await click(row);
      expect(apiGetMock).toHaveBeenCalledTimes(1);
      expect(card()?.getAttribute('data-mode')).toBe('settled');
      expect(text()).toContain('内部推理标题');
    },
  );

  it('does not touch a reply when the level stays as it was', async () => {
    seedFull();
    await mount();
    await change('full');
    expect(card()).toBeTruthy();
    expect(useChatStore.getState().stepsCache.m1).toBeDefined();
  });
});

describe('steps this tab rebuilt after joining the run part-way', () => {
  const REBUILT = [
    step({
      id: 'thinking-restored',
      kind: 'thinking',
      title: '重建的思考',
      text: '**重建的思考**\n\n合并成一段。',
      endedAt: undefined,
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_004_000,
      endedAt: undefined,
      toolName: 'Bash',
      toolUseId: 'a',
      summary: 'command: npm run lint',
    }),
  ];
  const SERVER = [
    step({
      id: 'thinking-0',
      kind: 'thinking',
      durationMs: 3000,
      title: '服务端的第一段',
      text: '**服务端的第一段**\n\n先看。',
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_004_000,
      endedAt: 1_005_000,
      toolName: 'Bash',
      toolUseId: 'a',
      summary: 'command: npm run lint',
    }),
    step({
      id: 'thinking-1',
      kind: 'thinking',
      at: 1_005_000,
      endedAt: 1_007_000,
      durationMs: 2000,
      title: '服务端的第二段',
      text: '**服务端的第二段**\n\n再看。',
    }),
  ];
  const turn = (steps: StreamingStep[]) => ({
    turn_id: 'turn-1',
    thinking: '',
    trace: [],
    steps,
    steps_dropped: 0,
  });
  const url = `/api/groups/${encodeURIComponent(SESSION_JID)}/turn-traces/turn-1`;

  it('are shown as they are, and nothing is asked for until the card is opened', async () => {
    seed({ steps: REBUILT, provisional: true });
    await mount();
    expect(summaryRow()?.textContent).toMatch(/^已工作/);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('are replaced by the server version when the reader opens them', async () => {
    seed({ steps: REBUILT, provisional: true });
    apiGetMock.mockResolvedValueOnce(turn(SERVER));
    await mount();
    await click(summaryRow());

    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(apiGetMock).toHaveBeenCalledWith(url);
    // Still open, and now the server's: two reasoning blocks, not one.
    expect(summaryRow()?.getAttribute('aria-expanded')).toBe('true');
    expect(counts()).toContain('2 段思考');
    expect(text()).toContain('服务端的第二段');
    expect(text()).not.toContain('重建的思考');
    expect(useChatStore.getState().stepsCache.m1.provisional).toBeUndefined();

    // Folding and opening it again asks for nothing more.
    await click(summaryRow());
    await click(summaryRow());
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it('are kept, without an error, when the server has none', async () => {
    seed({ steps: REBUILT, provisional: true });
    apiGetMock.mockResolvedValueOnce(turn([]));
    await mount();
    await click(summaryRow());
    expect(summaryRow()?.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('npm run lint');
    expect(text()).not.toContain('处理过程');

    await click(summaryRow());
    await click(summaryRow());
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(card()).toBeTruthy();
  });

  it('are kept when the server no longer shows the turn', async () => {
    seed({ steps: REBUILT, provisional: true });
    apiGetMock.mockRejectedValueOnce({ status: 404, message: 'Not found' });
    await mount();
    await click(summaryRow());
    expect(text()).toContain('npm run lint');
    await click(summaryRow());
    await click(summaryRow());
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(card()).toBeTruthy();
  });

  it('are asked for again the next time they are opened after a failure', async () => {
    seed({ steps: REBUILT, provisional: true });
    apiGetMock.mockRejectedValueOnce({ status: 0, message: 'Network error' });
    apiGetMock.mockResolvedValueOnce(turn(SERVER));
    await mount();
    await click(summaryRow());
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    expect(text()).toContain('npm run lint');
    expect(text()).not.toContain('服务端的第二段');

    // Folding it asks for nothing; opening it again does.
    await click(summaryRow());
    expect(apiGetMock).toHaveBeenCalledTimes(1);
    await click(summaryRow());
    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(text()).toContain('服务端的第二段');
  });

  it('are not asked for when they are exact', async () => {
    seed({ steps: SERVER });
    await mount();
    await click(summaryRow());
    expect(apiGetMock).not.toHaveBeenCalled();
    expect(text()).toContain('服务端的第二段');
  });
});

describe('what a tool returned, once the workspace is a proactive one', () => {
  const FAILED = [
    step({
      id: 'thinking-0',
      kind: 'thinking',
      durationMs: 3000,
      title: '确认范围',
      text: '**确认范围**\n\n先跑测试。',
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_004_000,
      endedAt: 1_005_000,
      status: 'error',
      toolName: 'Bash',
      toolUseId: 'a',
      summary: 'command: npm run unique-check',
      resultPreview: 'FAIL secret-output-line',
      resultFacts: { exitCode: 7 },
    }),
    step({
      id: 'task-1',
      kind: 'task',
      at: 1_005_000,
      endedAt: 1_006_000,
      taskId: 'task-1',
      toolUseId: 'task-1',
      toolName: 'Task',
      title: '核对子任务',
      summary: '子任务进度',
      resultPreview: '子代理的结论内容',
      resultFacts: { agent: { toolUses: 5, tokens: 4321 } },
    }),
  ];
  const mode = (
    interaction_mode: 'assistant' | 'proactive',
    process_visibility?: 'hidden' | 'activity' | 'full',
  ) =>
    useChatStore.setState({
      groups: { [JID]: group({ interaction_mode, process_visibility }) },
    });
  const view = async () => {
    await mount(reply({ source_kind: 'sdk_send_message' }));
    await click(summaryRow());
  };
  /** What another tab did is only known from the groups the next load brings. */
  const loadGroupsAs = async (over: Partial<GroupInfo>) => {
    apiGetMock.mockResolvedValueOnce({ groups: { [JID]: group(over) } });
    await act(async () => {
      await useChatStore.getState().loadGroups();
    });
  };

  it('are shown in an Assistant workspace: the output of a failed call and its facts', async () => {
    mode('assistant');
    seed({ steps: FAILED });
    await view();
    expect(text()).toContain('npm run unique-check');
    expect(text()).toContain('secret-output-line');
    expect(text()).toContain('退出码 7');
  });

  it.each(['activity', 'full'] as const)(
    'are not shown at the %s level, whatever the cache still holds',
    async (level) => {
      // The cache was read before the workspace became proactive.
      mode('proactive', level);
      seed({ steps: FAILED });
      await view();
      expect(card()).toBeTruthy();
      // What the call was and that it failed stay; what it returned does not.
      expect(text()).toContain('npm run unique-check');
      expect(text()).not.toContain('secret-output-line');
      expect(text()).not.toContain('退出码');
      expect(text()).not.toContain('子代理的结论内容');
      expect(text()).not.toContain('4321');
    },
  );

  it('are not shown in a session of a proactive workspace', async () => {
    mode('proactive', 'full');
    seed({ steps: FAILED });
    await mount(
      reply({ chat_jid: `${JID}#agent:s1`, source_kind: 'sdk_send_message' }),
    );
    await click(summaryRow());
    expect(text()).not.toContain('secret-output-line');
  });

  it('are let go with the process when another tab makes the workspace proactive', async () => {
    mode('assistant');
    useChatStore.setState({ agentMessages: { [SESSION]: [reply()] } });
    seed({
      steps: FAILED,
      thinking: '**确认范围**\n\n先跑测试。',
      duration: 3000,
      trace: TRACE,
    });
    await mount(reply());
    await click(summaryRow());
    expect(text()).toContain('secret-output-line');

    await loadGroupsAs({
      interaction_mode: 'proactive',
      process_visibility: 'full',
    });
    expect(text()).not.toContain('secret-output-line');
    expect(text()).not.toContain('退出码');
    expect(useChatStore.getState().stepsCache.m1).toBeUndefined();
    expect(useChatStore.getState().thinkingCache.m1).toBeUndefined();
    expect(useChatStore.getState().traceCache.m1).toBeUndefined();
    // The reply offers its process again, to be loaded for the new view.
    expect(text()).toContain('处理过程');
    expect(text()).toContain('最终答案在这里。');
  });

  it('are let go when another tab lowers the level to hidden', async () => {
    mode('proactive', 'full');
    useChatStore.setState({ agentMessages: { [SESSION]: [reply()] } });
    seed({ steps: STEPS, thinking: '想', duration: 3000, trace: TRACE });
    await mount(reply());
    expect(card()).toBeTruthy();

    await loadGroupsAs({
      interaction_mode: 'proactive',
      process_visibility: 'hidden',
    });
    expect(card()).toBeNull();
    expect(text()).not.toContain('处理过程');
    expect(useChatStore.getState().stepsCache.m1).toBeUndefined();
  });

  it('are kept in an Assistant workspace when another tab only renames it', async () => {
    mode('assistant');
    useChatStore.setState({ agentMessages: { [SESSION]: [reply()] } });
    seed({ steps: FAILED });
    await mount(reply());
    await loadGroupsAs({ name: '改了名', interaction_mode: 'assistant' });
    expect(card()).toBeTruthy();
    expect(useChatStore.getState().stepsCache.m1).toBeDefined();
  });
});

describe('a reply on a phone', () => {
  // `phone:` is a media query: these pin what each layout is given.
  const identityRow = () =>
    container.querySelector<HTMLElement>('.group > div.h-6');

  it('has no identity row in an Assistant workspace, and the time in its action row', async () => {
    await act(async () => {
      root.render(
        <MessageBubble message={reply({ has_trace: false })} showTime />,
      );
    });
    expect(identityRow()?.className).toContain('phone:hidden');
    const actionTime = [...container.querySelectorAll('span')].find((el) =>
      el.className.includes('phone:inline'),
    );
    expect(actionTime).toBeTruthy();
  });

  it("keeps a proactive workspace's identity row, with its time", async () => {
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: 'activity',
        }),
      },
    });
    await mount(reply({ source_kind: 'sdk_send_message', has_trace: false }));
    expect(identityRow()?.className).not.toContain('phone:hidden');
  });

  it('keeps the usage behind 详情 on a phone, inline elsewhere', async () => {
    await mount(
      reply({
        has_trace: false,
        token_usage: JSON.stringify({
          inputTokens: 1200,
          outputTokens: 300,
          durationMs: 4200,
        }),
      }),
    );
    const inline = [...container.querySelectorAll('span')].find((el) =>
      /tokens/.test(el.textContent ?? ''),
    );
    expect(inline?.className).toContain('phone:hidden');
    const details = [...container.querySelectorAll('button')].find(
      (el) => el.textContent === '详情',
    );
    expect(details?.className).toContain('phone:inline-flex');
    expect(details?.className).toContain('hidden');
  });

  it('gives the user a raised bubble, and 「⋯」 below it', async () => {
    await mount(
      reply({
        id: 'u1',
        is_from_me: false,
        sender: 'user-1',
        source_kind: null,
        content: '帮我看看',
      }),
    );
    const bubble = container.querySelector('p')?.parentElement;
    expect(bubble?.className).toContain('phone:bg-surface-raised');
    expect(bubble?.className).toContain('phone:rounded-xl');
    expect(bubble?.className).toContain('phone:p-3');
    // Beside the bubble, off a phone: one menu.
    const menus = container.querySelectorAll('[aria-label="消息菜单"]');
    expect(menus).toHaveLength(1);
    expect(menus[0].closest('.absolute')).not.toBeNull();
  });

  describe('on a phone', () => {
    beforeEach(() => {
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query.includes('pointer: coarse'),
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      );
    });
    afterEach(() => vi.restoreAllMocks());

    const userMessage = (content: string) =>
      reply({
        id: 'u1',
        is_from_me: false,
        sender: 'user-1',
        source_kind: null,
        content,
      });

    it('puts 「⋯」 below the bubble, once, and sets the text at the reply size', async () => {
      await mount(userMessage('帮我看看'));
      const menus = container.querySelectorAll('[aria-label="消息菜单"]');
      expect(menus).toHaveLength(1);
      expect(menus[0].closest('.absolute')).toBeNull();
      expect(container.querySelector('p')?.className).toContain(
        'phone:text-reply',
      );
    });

    it('opens the message menu on a long press of the bubble', async () => {
      vi.useFakeTimers();
      try {
        await mount(userMessage('帮我看看'));
        const bubble = container.querySelector('p')!.parentElement!;
        act(() => {
          bubble.dispatchEvent(
            new PointerEvent('pointerdown', {
              bubbles: true,
              pointerType: 'touch',
              isPrimary: true,
              clientX: 10,
              clientY: 10,
            }),
          );
        });
        expect(document.body.textContent).not.toContain('选择文本');
        act(() => {
          vi.advanceTimersByTime(600);
        });
        expect(document.body.textContent).toContain('复制文本');
        // A held finger is the menu, not the system selection: the menu
        // offers the selection instead.
        expect(document.body.textContent).toContain('选择文本');
      } finally {
        vi.useRealTimers();
      }
    });

    it('folds a long message to ten lines, with 展开', async () => {
      const lineHeight = vi
        .spyOn(window, 'getComputedStyle')
        .mockImplementation(
          () => ({ lineHeight: '26px' }) as unknown as CSSStyleDeclaration,
        );
      const height = vi
        .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.tagName === 'P'
            ? (this.textContent ?? '').split('\n').length * 26
            : 0;
        });
      try {
        await mount(
          userMessage(
            Array.from({ length: 20 }, (_, i) => `第 ${i} 行`).join('\n'),
          ),
        );
        const text = container.querySelector('p')!;
        expect(text.className).toContain('line-clamp-10');
        const toggle = [...container.querySelectorAll('button')].find(
          (button) => button.textContent === '展开',
        );
        expect(toggle).toBeDefined();
        act(() => toggle!.click());
        expect(container.querySelector('p')!.className).not.toContain(
          'line-clamp-10',
        );
      } finally {
        lineHeight.mockRestore();
        height.mockRestore();
      }
    });

    it('leaves a short message whole', async () => {
      await mount(userMessage('一行'));
      expect(container.querySelector('p')!.className).not.toContain(
        'line-clamp',
      );
      expect(container.textContent).not.toContain('展开');
    });
  });
});

describe('the progress a proactive turn sent, folded into its reply', () => {
  const PROGRESS_STEPS: StreamingStep[] = [
    step({
      id: 'note-p',
      kind: 'text',
      commentary: true,
      progress: true,
      text: '先跑一遍测试，稍等。',
    }),
    step({
      id: 'note-n',
      kind: 'text',
      commentary: true,
      at: 1_001_000,
      text: '我先运行 npm test。',
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      at: 1_002_000,
      endedAt: 1_004_000,
      toolName: 'Bash',
      toolUseId: 'a',
      summary: 'command: npm test',
      resultPreview: '12 passed',
    }),
  ];
  const at = (level: 'hidden' | 'activity' | 'full') => {
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: level,
        }),
      },
      agentMessages: {
        [SESSION]: [reply({ source_kind: 'sdk_send_message' })],
      },
    });
    seed({ steps: PROGRESS_STEPS });
  };
  const open = async () => {
    await mount(reply({ source_kind: 'sdk_send_message' }));
    // Folded until the reader opens it.
    expect(text()).not.toContain('先跑一遍测试');
    await click(summaryRow());
  };

  it('at hidden lists the progress alone', async () => {
    at('hidden');
    await open();
    expect(text()).toContain('先跑一遍测试，稍等。');
    expect(text()).not.toContain('npm test');
    expect(text()).not.toContain('我先运行');
  });

  it('at activity lists it with the work, without the narration', async () => {
    at('activity');
    await open();
    expect(text()).toContain('先跑一遍测试，稍等。');
    expect(text()).toContain('npm test');
    expect(text()).not.toContain('我先运行');
    expect(text()).not.toContain('12 passed');
  });

  it('at full lists both', async () => {
    at('full');
    await open();
    expect(text()).toContain('先跑一遍测试，稍等。');
    expect(text()).toContain('我先运行 npm test。');
  });

  it('is in the card in the classic layout too, where no other row holds it', async () => {
    memory.set(LAYOUT_KEY, 'classic');
    at('activity');
    await open();
    expect(text()).toContain('先跑一遍测试，稍等。');
  });
});

describe("a proactive reply whose turn's trace is on its way", () => {
  const awaited = () =>
    useChatStore.setState({
      groups: {
        [JID]: group({
          interaction_mode: 'proactive',
          process_visibility: 'activity',
        }),
      },
      traceAwaited: { [SESSION_JID]: 'm1' },
    });
  const row = () =>
    [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('处理过程'),
    );

  it('holds the row it will have, not yet to open', async () => {
    awaited();
    await mount(reply({ source_kind: 'sdk_send_message', has_trace: false }));
    expect(row()).toBeTruthy();
    expect(row()?.disabled).toBe(true);
  });

  it('opens the same row once the trace is stored', async () => {
    awaited();
    await mount(reply({ source_kind: 'sdk_send_message', has_trace: false }));
    const held = row();
    await mount(reply({ source_kind: 'sdk_send_message', has_trace: true }));
    expect(row()).toBe(held);
    expect(row()?.disabled).toBe(false);
  });

  it('holds nothing for another reply', async () => {
    awaited();
    await mount(
      reply({ id: 'm2', source_kind: 'sdk_send_message', has_trace: false }),
    );
    expect(row()).toBeUndefined();
  });

  // The store holds it only for such a turn: its progress is what the trace
  // keeps there. In either layout it is the card's one row.
  it.each(['timeline', 'classic'] as const)(
    'at the hidden level, holds the one row of a turn that sent progress (%s)',
    async (layout) => {
      memory.set(LAYOUT_KEY, layout);
      useChatStore.setState({
        groups: {
          [JID]: group({
            interaction_mode: 'proactive',
            process_visibility: 'hidden',
          }),
        },
        traceAwaited: { [SESSION_JID]: 'm1' },
      });
      await mount(reply({ source_kind: 'sdk_send_message', has_trace: false }));
      const rows = [...container.querySelectorAll('button')].filter((el) =>
        /处理过程|思考过程|执行详情/.test(el.textContent ?? ''),
      );
      expect(rows.map((el) => el.textContent?.trim())).toEqual(['处理过程']);
    },
  );
});
