// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStatusBar } from '../src/components/chat/RunStatusBar';
import { useChatStore, type StreamingState } from '../src/stores/chat';
import { useShellStore } from '../src/stores/shell';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const JID = 'web:reply-rate';
const AGENT = 'session-1';
const SESSION_JID = `${JID}#agent:${AGENT}`;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  useChatStore.setState({
    groups: {},
    agents: {},
    agentWaiting: {},
    agentStreaming: {},
    stopRequests: {},
    activeRuns: {},
  });
});

const base: StreamingState = {
  partialText: '',
  thinkingText: '',
  isThinking: false,
  activeTools: [],
  activeHook: null,
  systemStatus: null,
  recentEvents: [],
  traceEvents: [],
  taskStates: {},
};

/** The run's state, read and replaced where the bar looks for it. */
let target = { agentId: AGENT };
const current = (): StreamingState =>
  useChatStore.getState().agentStreaming[target.agentId] ?? base;
const update = (over: Partial<StreamingState>) => {
  const next = { ...current(), ...over };
  useChatStore.setState((s) => ({
    agentStreaming: { ...s.agentStreaming, [target.agentId]: next },
  }));
};

const proactive = (visibility: 'hidden' | 'activity' | 'full', owner = true) =>
  useChatStore.setState({
    groups: {
      [JID]: {
        name: 'Proactive',
        folder: 'proactive',
        added_at: '2026-10-10T00:00:00.000Z',
        interaction_mode: 'proactive',
        process_visibility: visibility,
        can_modify: owner,
      } as never,
    },
  });

const mount = async (
  over: Partial<StreamingState> = { partialText: '开头' },
  agentId: string = AGENT,
) => {
  target = { agentId };
  const runtimeJid = `${JID}#agent:${agentId}`;
  useChatStore.setState({
    activeRuns: {
      [runtimeJid]: {
        chatJid: runtimeJid,
        runId: 'run-1',
        startedAt: new Date(Date.now() - 12_000).toISOString(),
        phase: 'running',
      },
    },
    agentWaiting: { [agentId]: true },
  });
  update(over);
  await act(async () => {
    root.render(<RunStatusBar groupJid={JID} agentId={agentId} />);
  });
};

const CHUNK = '流式输出速度估算正文';

/** `chunk` more of `field` every 100 ms, for `ms`: ten characters are 100 tok/s. */
const write = async (
  ms: number,
  chunk = CHUNK,
  field: 'partialText' | 'thinkingText' = 'partialText',
) => {
  for (let t = 0; t < ms; t += 100) {
    await act(async () => {
      vi.advanceTimersByTime(100);
      update({ [field]: current()[field] + chunk });
    });
  }
};

const wait = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

const set = async (over: Partial<StreamingState>) => {
  await act(async () => update(over));
};

const bar = () => container.querySelector('[data-hc-run-status-bar]');
/** The phase pill's words. */
const phase = () =>
  bar()?.querySelector('[data-hc-run-phase]')?.textContent ?? undefined;
/** The right pill: "15s · 100 tok/s". */
const meta = () =>
  bar()?.querySelector('span.tabular-nums')?.textContent ?? undefined;
const rate = () => meta()?.match(/(\d+) tok\/s/)?.[1];

describe('the run status bar', () => {
  it('says nothing without a run', async () => {
    await act(async () => {
      root.render(<RunStatusBar groupJid={JID} agentId={AGENT} />);
    });
    expect(bar()).toBeNull();
  });

  it('names the phase, in the accent while the run works', async () => {
    await mount({ isThinking: true, thinkingText: '想' });
    expect(phase()).toBe('思考中');
    expect(bar()?.firstElementChild?.className).toContain('text-status-accent');
    await set({
      isThinking: false,
      activeTools: [{ toolName: 'Bash', toolUseId: 't1', startTime: 0 }],
    });
    expect(phase()).toBe('运行命令');
    await set({ activeTools: [], partialText: '答' });
    expect(phase()).toBe('正在回复');
  });

  it('waits before the run has said anything', async () => {
    await mount({});
    useChatStore.setState({ agentStreaming: {} });
    await wait(0);
    expect(phase()).toBe('等待中');
  });

  it('stops counting and leaves the accent once a stop is requested', async () => {
    await mount();
    await act(async () => {
      useChatStore.setState({ stopRequests: { [SESSION_JID]: Date.now() } });
    });
    expect(phase()).toBe('正在停止…');
    expect(bar()?.firstElementChild?.className).not.toContain(
      'text-status-accent',
    );
    const frozen = meta();
    await wait(3000);
    expect(meta()).toBe(frozen);
  });

  it('says nothing while the run only closes after its turn ended', async () => {
    await mount({ partialText: '答', inputTurnId: 'input-1' });
    expect(bar()).not.toBeNull();
    await act(async () => {
      useChatStore.setState((s) => ({
        agentStreaming: {},
        activeRuns: {
          [SESSION_JID]: { ...s.activeRuns[SESSION_JID], answered: 'input-1' },
        },
      }));
    });
    expect(bar()).toBeNull();
    // Another input of the same run streams: the bar follows it.
    await set({ partialText: '下一条', inputTurnId: 'input-2' });
    expect(phase()).toBe('正在回复');
  });
});

describe('a proactive workspace', () => {
  it('shows only that it is busy at hidden, with a way to change that for its owner', async () => {
    proactive('hidden');
    await mount({
      activeTools: [{ toolName: 'Bash', toolUseId: 't1', startTime: 0 }],
    });
    expect(phase()).toBe('处理中');
    expect(meta()).toBe('12s');
    const show = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '显示过程',
    );
    const request = vi.spyOn(
      useShellStore.getState(),
      'requestWorkspaceSettings',
    );
    await act(async () => show?.click());
    expect(request).toHaveBeenCalledWith(JID);
  });

  it('offers no way to change the level to a reader who cannot', async () => {
    proactive('hidden', false);
    await mount({});
    expect(container.textContent).not.toContain('显示过程');
  });

  it('names the phase at the levels that show the process', async () => {
    proactive('activity');
    await mount({
      activeTools: [{ toolName: 'Read', toolUseId: 't1', startTime: 0 }],
    });
    expect(phase()).toBe('读取文件');
    expect(container.textContent).not.toContain('显示过程');
  });

  it('is quiet after the reply, then shows it is busy if the turn goes on', async () => {
    proactive('activity');
    await mount({ inputTurnId: 'input-1', isThinking: true });
    await act(async () => {
      useChatStore.setState((s) => ({
        activeRuns: {
          [SESSION_JID]: { ...s.activeRuns[SESSION_JID], answered: 'input-1' },
        },
      }));
    });
    expect(bar()).toBeNull();
    await wait(2900);
    expect(bar()).toBeNull();
    await wait(200);
    expect(phase()).toBe('处理中');
    // New work: the phase again.
    await set({
      isThinking: false,
      activeTools: [{ toolName: 'Bash', toolUseId: 't2', startTime: 0 }],
    });
    expect(phase()).toBe('运行命令');
  });
});

describe('the progress the Agent sent, in a proactive workspace', () => {
  const progress = (id: string, text: string, at: number) => ({
    id,
    kind: 'text' as const,
    at,
    endedAt: at,
    status: 'done' as const,
    commentary: true,
    progress: true,
    text,
  });
  const shown = () =>
    bar()?.querySelector('[data-hc-run-progress]')?.textContent ?? undefined;

  it.each(['hidden', 'activity', 'full'] as const)(
    'follows the phase with the latest one at %s',
    async (level) => {
      proactive(level);
      await mount({
        steps: [
          progress('p1', '先看一下仓库', 1),
          {
            id: 'n1',
            kind: 'text',
            at: 2,
            endedAt: 2,
            status: 'done',
            commentary: true,
            text: '我先列一下目录',
          },
        ],
      });
      expect(phase()).toBe(level === 'hidden' ? '处理中' : '思考中');
      // Narration is not progress: the bar keeps the progress.
      expect(shown()).toBe('先看一下仓库');
      await set({
        steps: [
          progress('p1', '先看一下仓库', 1),
          progress('p2', '找到了 **两处** 调用，正在改', 3),
        ],
      });
      expect(shown()).toBe('找到了 两处 调用，正在改');
    },
  );

  it('is gone once the turn has replied', async () => {
    proactive('hidden');
    await mount({ inputTurnId: 'input-1', steps: [progress('p1', '在查', 1)] });
    expect(shown()).toBe('在查');
    await act(async () => {
      useChatStore.setState((s) => ({
        activeRuns: {
          [SESSION_JID]: { ...s.activeRuns[SESSION_JID], answered: 'input-1' },
        },
      }));
    });
    await wait(3100);
    expect(phase()).toBe('处理中');
    expect(shown()).toBeUndefined();
  });

  it('is never shown in an Assistant workspace', async () => {
    await mount({ partialText: '答', steps: [progress('p1', '在查', 1)] });
    expect(shown()).toBeUndefined();
  });
});

describe('the speed beside the timer, while the reply streams', () => {
  it('shows the estimated speed after the timer', async () => {
    await mount();
    expect(rate()).toBeUndefined();
    await write(3000);
    expect(meta()).toBe('15s · 100 tok/s');
  });

  it('keeps it out of what is announced', async () => {
    await mount();
    await write(3000);
    for (const live of container.querySelectorAll('[aria-live]')) {
      expect(live.textContent).not.toContain('tok/s');
    }
  });

  it('changes what it shows at most once a second', async () => {
    await mount();
    await write(3000);
    const shown = [rate()];
    // Twice as fast for three seconds, looked at every 100 ms.
    for (let i = 0; i < 30; i += 1) {
      await write(100, CHUNK.repeat(2));
      if (shown.at(-1) !== rate()) shown.push(rate());
    }
    expect(shown.length).toBeLessThanOrEqual(4);
    expect(shown.at(-1)).toBe('200');
  });

  it('hides it while a tool runs, and measures afresh after', async () => {
    await mount();
    await write(3000);
    expect(rate()).toBeDefined();
    await set({
      activeTools: [
        { toolName: 'Bash', toolUseId: 't1', startTime: Date.now() },
      ],
    });
    expect(rate()).toBeUndefined();
    await wait(5000);
    expect(rate()).toBeUndefined();
    // The tool returned: the model is at work before any text comes back.
    await set({ activeTools: [], awaitingModel: true });
    await wait(2000);
    expect(rate()).toBeUndefined();
    await set({ awaitingModel: false });
    await write(1000);
    expect(rate()).toBe('100');
  });

  it('hides it while the model reasons', async () => {
    await mount();
    await write(3000);
    expect(rate()).toBeDefined();
    await set({ isThinking: true, thinkingText: '先想一想' });
    expect(rate()).toBeUndefined();
    for (let t = 0; t < 2000; t += 100) {
      await write(100, '再想一想更多细节', 'thinkingText');
      expect(rate()).toBeUndefined();
    }
  });

  it('hides it once the text has stopped growing for about two seconds', async () => {
    await mount();
    await write(3000);
    expect(rate()).toBeDefined();
    await wait(1000);
    expect(rate()).toBeDefined();
    await wait(2000);
    expect(rate()).toBeUndefined();
  });

  it('hides it once a stop is requested', async () => {
    await mount();
    await write(3000);
    await act(async () => {
      useChatStore.setState({ stopRequests: { [SESSION_JID]: Date.now() } });
    });
    expect(rate()).toBeUndefined();
  });

  it("reads a session's own reply", async () => {
    await mount({ partialText: '开头' }, AGENT);
    // Another session's reply does not count.
    useChatStore.setState((s) => ({
      agentStreaming: {
        ...s.agentStreaming,
        'session-2': { ...base, partialText: '另一个会话' },
      },
    }));
    await write(3000);
    expect(rate()).toBe('100');
  });
});
