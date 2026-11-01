// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingDisplay } from '../src/components/chat/StreamingDisplay';
import { MessageBubble } from '../src/components/chat/MessageBubble';
import { forgetProcessOpenChoices } from '../src/lib/process-open-memory';
import { useChatStore, type StreamingState } from '../src/stores/chat';
import type { StreamingStep } from '../src/lib/stream-steps';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const JID = 'web:process-card';
const SESSION = 'session-1';
const SESSION_JID = `${JID}#agent:${SESSION}`;
const LAYOUT_KEY = 'happyclaw-stream-layout:guest';

let root: Root;
let container: HTMLDivElement;

const memory = new Map<string, string>();
const storage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
  clear: () => memory.clear(),
};

beforeEach(() => {
  memory.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useChatStore.setState({
    agentStreaming: {},
    settledStreaming: {},
    stopRequests: {},
    activeRuns: {},
    agentWaiting: {},
  });
});

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({ at: Date.now() - 20_000, status: 'done', ...over });

const steps: StreamingStep[] = [
  step({
    id: 'thinking-0',
    kind: 'thinking',
    endedAt: Date.now() - 15_000,
    durationMs: 5000,
    title: '确认订阅范围',
    text: '**确认订阅范围**\n\n先看 store。',
  }),
  step({
    id: 'tool-a',
    kind: 'tool',
    toolName: 'Bash',
    toolUseId: 'a',
    summary: 'command: npm test',
    endedAt: Date.now() - 10_000,
  }),
  step({
    id: 'tool-b',
    kind: 'tool',
    toolName: 'Bash',
    toolUseId: 'b',
    summary: 'command: npm run build',
    at: Date.now() - 5000,
    status: 'running',
  }),
  // The text after the last tool is the answer.
  step({
    id: 'text-0',
    kind: 'text',
    at: Date.now() - 1000,
    status: 'running',
    from: 0,
  }),
];

const state = (over: Partial<StreamingState> = {}): StreamingState => ({
  partialText: '最终答案正文',
  partialBase: 0,
  thinkingText: '**确认订阅范围**\n\n先看 store。',
  thinkingTitle: '确认订阅范围',
  isThinking: false,
  thinkingDurationMs: 5000,
  steps,
  activeTools: [
    {
      toolName: 'Bash',
      toolUseId: 'b',
      startTime: Date.now() - 5000,
      toolInputSummary: 'command: npm run build',
    },
  ],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [
    {
      id: 'tr1',
      timestamp: 1,
      kind: 'tool',
      title: '工具 Bash',
      summary: 'npm test',
      toolUseId: 'a',
    },
  ],
  taskStates: {},
  ...over,
});

const mount = async (
  streaming: StreamingState | undefined,
  props: {
    settled?: boolean;
    isWaiting?: boolean;
    /** The input whose turn already ended while the run closes. */
    answered?: string;
    proactive?: boolean;
    visibility?: 'hidden' | 'activity' | 'full';
  } = {},
) => {
  useChatStore.setState({
    agentStreaming: !props.settled && streaming ? { [SESSION]: streaming } : {},
    settledStreaming:
      props.settled && streaming ? { [SESSION_JID]: streaming } : {},
    activeRuns: props.settled
      ? {}
      : {
          [SESSION_JID]: {
            chatJid: SESSION_JID,
            runId: 'run-1',
            startedAt: new Date(Date.now() - 20_000).toISOString(),
            phase: 'running',
            ...(props.answered ? { answered: props.answered } : {}),
          },
        },
    groups: props.proactive
      ? {
          [JID]: {
            name: 'Proactive',
            folder: 'proactive',
            added_at: '2026-10-10T00:00:00.000Z',
            interaction_mode: 'proactive',
            process_visibility: props.visibility ?? 'activity',
          } as never,
        }
      : {},
  });
  await act(async () => {
    root.render(
      <StreamingDisplay
        groupJid={JID}
        agentId={SESSION}
        isWaiting={props.isWaiting ?? !props.settled}
        settled={props.settled}
        interactionMode={props.proactive ? 'proactive' : 'assistant'}
      />,
    );
  });
};

const card = () => container.querySelector('[data-hc-process-card]');
const text = () => container.textContent ?? '';

describe('StreamingDisplay, the step timeline layout', () => {
  it('shows the run as a live process card over its steps', async () => {
    await mount(state());
    expect(card()?.getAttribute('data-mode')).toBe('live');
    expect(card()?.querySelector('button')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(text()).toContain('npm run build');
    expect(container.querySelector('[data-hc-step-timeline]')).not.toBeNull();
    // The answer is the text below, not a step.
    expect(text()).toContain('最终答案正文');
    // The two rows of the classic layout are not there.
    expect(text()).not.toContain('执行详情');
    expect(text()).not.toContain('已思考 5 秒');
  });

  it('folds a settled card to the one-line summary, with the answer below', async () => {
    await mount(
      state({
        steps: steps.map((s) =>
          s.status === 'running'
            ? { ...s, status: 'done' as const, endedAt: Date.now() }
            : s,
        ),
        activeTools: [],
        settling: true,
      }),
      { settled: true },
    );
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    const header = card()?.querySelector('button');
    expect(header?.textContent).toMatch(/^已工作 \d+s$/);
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-hc-step-timeline]')).toBeNull();
    expect(text()).not.toContain('执行详情');
    expect(text()).toContain('最终答案正文');
  });

  it('keeps the permission denials, above the process', async () => {
    await mount(
      state({
        settling: true,
        traceEvents: [
          {
            id: 'p1',
            timestamp: 2,
            kind: 'permission',
            title: 'Bash',
            summary: 'rm -rf node_modules',
            detail: '被权限策略拒绝',
          },
        ],
      }),
      { settled: true },
    );
    expect(text()).toContain('权限被拒绝');
    expect(text().indexOf('权限被拒绝')).toBeLessThan(text().indexOf('已工作'));
  });

  it('still has the two folded rows for a frozen card with no steps', async () => {
    await mount(state({ steps: [], settling: true, activeTools: [] }), {
      settled: true,
    });
    expect(card()).toBeNull();
    expect(text()).toContain('已思考 5 秒');
    expect(text()).toContain('执行详情');
    expect(text()).toContain('最终答案正文');
  });

  it('keeps its answer element when the card stops being live', async () => {
    await mount(state());
    const answer = () =>
      [...container.querySelectorAll('[data-markdown-root]')].find((el) =>
        el.textContent?.includes('最终答案正文'),
      );
    const before = answer();
    expect(before).toBeTruthy();
    // A stop request ends the card's life as the one being written.
    await act(async () => {
      useChatStore.setState({ stopRequests: { [SESSION_JID]: Date.now() } });
    });
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(answer()).toBe(before);
  });
});

describe('StreamingDisplay, the classic layout', () => {
  beforeEach(() => {
    memory.set(LAYOUT_KEY, 'classic');
  });

  it('is the stack of cards it always was, with no process card', async () => {
    await mount(
      state({
        isThinking: true,
        steps: [
          step({
            id: 'thinking-0',
            kind: 'thinking',
            status: 'running',
            text: '想',
          }),
          steps[1],
          steps[2],
        ],
      }),
    );
    expect(card()).toBeNull();
    expect(container.querySelector('[data-hc-step-timeline]')).toBeNull();
    // The reasoning block, the tool rows and the execution details.
    expect(text()).toContain('思考中…');
    expect(text()).toContain('运行');
    expect(text()).toContain('npm run build');
    expect(text()).toContain('执行详情');
    expect(text()).toContain('最终答案正文');
  });

  it('has no summary row for a card the classic layout shows', async () => {
    await mount(state(), { isWaiting: false });
    expect(card()).toBeNull();
    expect(text()).not.toContain('已处理');
  });
});

describe('StreamingDisplay, a run whose turn already ended', () => {
  // The reply is in the list and the run is only closing: the live slot
  // shows nothing (the run status bar has nothing to say either).
  it('shows nothing once the turn ended, though the run still closes', async () => {
    await mount(undefined);
    // Getting ready: the row that marks where the reply will appear.
    expect(container.querySelector('[data-follow-sticky]')).not.toBeNull();
    await mount(undefined, { answered: 'input-1' });
    expect(container.innerHTML).toBe('');
  });

  it('shows the next turn of the same run as it streams', async () => {
    await mount(state({ inputTurnId: 'input-2' }), { answered: 'input-1' });
    expect(card()?.getAttribute('data-mode')).toBe('live');
  });

  it("keeps a proactive turn's panel away after its reply, until it works again", async () => {
    // Before its reply: the panel of the work (its state is the status bar's).
    await mount(state({ inputTurnId: 'input-1' }), { proactive: true });
    expect(container.querySelector('[data-hc-process-panel]')).not.toBeNull();
    expect(text()).not.toContain('正在处理');

    // The reply landed, and the turn only reasons: nothing in the list.
    const reasoning = state({
      inputTurnId: 'input-1',
      partialText: '',
      steps: [steps[0]],
      activeTools: [],
      traceEvents: [],
    });
    await mount(reasoning, { answered: 'input-1', proactive: true });
    expect(container.innerHTML).toBe('');

    // New work brings the panel back at once.
    await mount(state({ inputTurnId: 'input-1' }), {
      answered: 'input-1',
      proactive: true,
    });
    expect(container.querySelector('[data-hc-process-panel]')).not.toBeNull();
  });
});

describe('StreamingDisplay, a proactive turn at the hidden level', () => {
  const progress = {
    id: 'note-p',
    kind: 'text' as const,
    at: 1_000_000,
    endedAt: 1_000_000,
    status: 'done' as const,
    commentary: true,
    progress: true,
    text: '先跑一遍测试，稍等。',
  };
  const panel = () => container.querySelector('[data-hc-process-panel]');

  it('shows nothing of a turn that sent no progress', async () => {
    await mount(state({ inputTurnId: 'input-1' }), {
      proactive: true,
      visibility: 'hidden',
    });
    expect(container.innerHTML).toBe('');
  });

  it('lists the progress the Agent sent, and nothing else of the process', async () => {
    await mount(
      state({ inputTurnId: 'input-1', steps: [...steps, progress] }),
      {
        proactive: true,
        visibility: 'hidden',
      },
    );
    expect(panel()).not.toBeNull();
    expect(text()).toContain('先跑一遍测试，稍等。');
    expect(text()).toContain('正在处理');
    expect(text()).not.toContain('npm');
    expect(text()).not.toContain('最近');
  });

  it('gives the progress way to the reply, like the panel at any level', async () => {
    const reasoning = state({
      inputTurnId: 'input-1',
      partialText: '',
      steps: [progress],
      activeTools: [],
      traceEvents: [],
    });
    await mount(reasoning, {
      answered: 'input-1',
      proactive: true,
      visibility: 'hidden',
    });
    expect(container.innerHTML).toBe('');
  });
});

describe('StreamingDisplay, after cindy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** The answer goes on being written for `ms`. */
  const writeFor = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });
  const writing = () =>
    state({
      steps: steps.map((s) =>
        s.status === 'running' && s.kind !== 'text'
          ? { ...s, status: 'done' as const, endedAt: Date.now() }
          : s,
      ),
      activeTools: [],
    });

  it('leaves the finished reply’s card as the reader left the live one', async () => {
    forgetProcessOpenChoices();
    const live = writing();
    await mount({ ...live, inputTurnId: 'input-swap', turnId: 'p-swap' });
    await writeFor(800);
    // Folded while the answer is written; the reader opens it.
    expect(card()?.hasAttribute('data-folded')).toBe(true);
    await act(async () => {
      card()?.querySelector('button')?.click();
    });
    expect(card()?.querySelector('[data-hc-process-window]')).not.toBeNull();
    // The final takes its place: the reply's own card is open as well.
    await act(async () => {
      root.render(
        <MessageBubble
          message={{
            id: 'final-swap',
            chat_jid: SESSION_JID,
            sender: 'happyclaw-agent',
            sender_name: 'HappyClaw',
            content: '最终答案正文',
            timestamp: '2026-10-10T00:00:00.000Z',
            is_from_me: true,
            source_kind: 'sdk_final',
            turn_id: 'input-swap',
          }}
          showTime={false}
          replySteps={{ steps: live.steps!, dropped: 0 }}
        />,
      );
    });
    expect(card()?.getAttribute('data-mode')).toBe('settled');
    expect(card()?.querySelector('[data-hc-process-window]')).not.toBeNull();
  });

  it('marks no caret after the text being written', async () => {
    await mount(writing());
    expect(text()).toContain('最终答案正文');
    expect(container.querySelector('[data-streaming-caret]')).toBeNull();
  });

  it('folds the process into how long it worked once the answer is written', async () => {
    await mount(writing());
    expect(card()?.getAttribute('data-mode')).toBe('live');
    // A line of narration before the next tool call does not fold it.
    await writeFor(799);
    expect(card()?.hasAttribute('data-folded')).toBe(false);
    await writeFor(1);
    expect(card()?.hasAttribute('data-folded')).toBe(true);
    expect(card()?.querySelector('button')?.textContent).toMatch(
      /^已工作 \d+s$/,
    );
    // While a tool runs it is at work again, open on its rows.
    await mount(state());
    expect(card()?.hasAttribute('data-folded')).toBe(false);
  });

  it('carries no run status: that is the bar’s', async () => {
    await mount(state());
    expect(text()).not.toMatch(/正在|Esc 停止|tok\/s/);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('has no identity row on a phone, except a spawned agent’s', async () => {
    await mount(state());
    expect(
      container.querySelector('[data-follow-sticky]')?.className,
    ).toContain('phone:hidden');
    // A spawned agent streams beside the reply: its name tells them apart.
    useChatStore.setState({
      agents: {
        [JID]: [
          {
            id: 'spawn-1',
            name: '子任务',
            prompt: '',
            status: 'running',
            kind: 'spawn',
            created_at: '2026-10-10T00:00:00.000Z',
          },
        ],
      },
      agentStreaming: { 'spawn-1': state() },
    });
    await act(async () => {
      root.render(
        <StreamingDisplay groupJid={JID} agentId="spawn-1" isWaiting />,
      );
    });
    expect(
      container.querySelector('[data-follow-sticky]')?.className,
    ).not.toContain('phone:hidden');
    useChatStore.setState({ agents: {}, agentStreaming: {} });
  });
});
