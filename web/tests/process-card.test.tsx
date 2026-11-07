// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessCard,
  hasProcess,
  type ProcessCardProps,
} from '../src/components/chat/ProcessCard';
import type { StreamingStep } from '../src/lib/stream-steps';
import type { StreamingTaskRuntimeState } from '../src/stores/chat';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
});

const render = (ui: ReactNode) =>
  act(async () => {
    root.render(ui);
  });
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
): StreamingStep => ({ at: 1000, status: 'done', ...over });
const tool = (
  id: string,
  toolName: string,
  over: Partial<StreamingStep> = {},
) =>
  step({
    id: `tool-${id}`,
    kind: 'tool',
    toolName,
    toolUseId: id,
    endedAt: 2000,
    ...over,
  });
const thinking = (over: Partial<StreamingStep> = {}) =>
  step({
    id: 'thinking-0',
    kind: 'thinking',
    endedAt: 6000,
    durationMs: 5000,
    ...over,
  });

const task: StreamingTaskRuntimeState = {
  id: 'task-1',
  title: '检查移动端滚动',
  status: 'completed',
  subagentType: 'general-purpose',
  latestSummary: '已读完 3 个文件',
  lastToolName: 'Read',
  thinkingTail: '',
  textTail: '子 Agent 的最后一段话',
  activeTools: [],
  recentTools: [],
  updatedAt: 1,
};
const taskStep = step({
  id: 'task-task-1',
  kind: 'task',
  taskId: 'task-1',
  toolUseId: 'task-1',
  toolName: 'Task',
  at: 3000,
  endedAt: 9000,
});

const props = (over: Partial<ProcessCardProps> = {}): ProcessCardProps => ({
  mode: 'settled',
  steps: [],
  groupJid: 'web:test',
  ...over,
});

const card = () => container.querySelector('[data-hc-process-card]');
const header = () => container.querySelector('[data-hc-process-card] > button');
const windowEl = () => container.querySelector('[data-hc-process-window]');
const rows = () => [...container.querySelectorAll('[role="listitem"]')];
/** What an opened, folded process says it used. */
const counts = () =>
  container.querySelector('[data-hc-work-counts]')?.textContent;
const text = () => container.textContent ?? '';

describe('hasProcess', () => {
  it('has something to show when the timeline would list a step', () => {
    expect(hasProcess([])).toBe(false);
    expect(hasProcess([tool('a', 'Read')])).toBe(true);
    // The answer alone is the text below the card.
    expect(
      hasProcess([
        step({ id: 'ans', kind: 'text', status: 'running', text: '答案' }),
      ]),
    ).toBe(false);
  });
});

describe('ProcessCard, nothing to show', () => {
  it('renders nothing for no steps, live or settled', async () => {
    await render(<ProcessCard {...props({ mode: 'live' })} />);
    expect(container.innerHTML).toBe('');
    await render(<ProcessCard {...props()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for the answer alone', async () => {
    const answer = step({ id: 'ans', kind: 'text', status: 'running' });
    await render(<ProcessCard {...props({ mode: 'live', steps: [answer] })} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for a wait on a settled card', async () => {
    await render(<ProcessCard {...props({ waiting: true })} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the wait for the model on a live card with no steps yet', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          waiting: true,
          waitingSince: Date.now() - 2000,
        })}
      />,
    );
    expect(card()?.hasAttribute('data-hc-model-wait')).toBe(true);
    expect(header()?.textContent).toContain('正在思考…');
    expect(header()?.textContent).toMatch(/2s/);
    // Skeleton lines where the words will be, hidden from assistive tech.
    expect(
      container.querySelectorAll('[aria-hidden="true"] .animate-pulse'),
    ).toHaveLength(2);
  });

  it('waits a moment before it shows a short wait between tools', async () => {
    const steps = [tool('a', 'Read')];
    await render(
      <ProcessCard
        {...props({ mode: 'live', steps, waiting: true, hasContent: true })}
      />,
    );
    expect(header()?.textContent).not.toContain('正在思考…');
    expect(container.querySelector('[aria-hidden="true"] .animate-pulse')).toBe(
      null,
    );
    await advance(800);
    // The header's own line follows the wait once it settles.
    await advance(300);
    expect(header()?.textContent).toContain('正在思考…');
  });
});

describe('ProcessCard, live', () => {
  it('says what the run is doing now, and keeps up with it', async () => {
    const reading = tool('a', 'Read', {
      status: 'running',
      endedAt: undefined,
      summary: '{"file_path":"/repo/a.ts"}',
    });
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [
            thinking({
              status: 'running',
              endedAt: undefined,
              title: '核对行高估算',
            }),
          ],
        })}
      />,
    );
    expect(header()?.textContent).toContain('核对行高估算');

    // A change is let settle for a moment first: the line does not flicker.
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [thinking({ title: '核对行高估算' }), reading],
        })}
      />,
    );
    expect(header()?.textContent).toContain('核对行高估算');
    await advance(299);
    expect(header()?.textContent).toContain('核对行高估算');
    await advance(1);
    expect(header()?.textContent).toContain('读取文件 · /repo/a.ts');
    expect(header()?.textContent).not.toContain('核对行高估算');
  });

  it('is open on a window of its steps, named for assistive tech', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [tool('a', 'Bash', { summary: 'command: npm test' })],
        })}
      />,
    );
    expect(header()?.getAttribute('aria-expanded')).toBe('true');
    const id = header()?.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(windowEl()?.id).toBe(id);
    const list = windowEl()?.querySelector('[role="list"]');
    expect(list?.getAttribute('aria-label')).toBe('处理步骤');
    expect(list?.hasAttribute('data-hc-step-timeline')).toBe(true);
    expect(text()).toContain('npm test');
  });

  it('leaves the telling of what the run does to the run status line', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [
            thinking({ status: 'running', endedAt: undefined, title: '核对' }),
          ],
        })}
      />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('opens the reasoning being written, with its text, and folds it when it is over', async () => {
    const live = thinking({
      status: 'running',
      endedAt: undefined,
      title: '核对行高',
      text: '**核对行高**\n\n估算与实测。',
    });
    await render(<ProcessCard {...props({ mode: 'live', steps: [live] })} />);
    expect(container.querySelector('[data-hc-thinking-body]')).not.toBeNull();
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [{ ...live, status: 'done', endedAt: 5000 }],
        })}
      />,
    );
    expect(container.querySelector('[data-hc-thinking-body]')).toBeNull();
  });

  it('keeps the reader’s own opening of a row against what follows', async () => {
    const done = thinking({
      title: '确认范围',
      text: '先看订阅层级。',
    });
    await render(<ProcessCard {...props({ mode: 'live', steps: [done] })} />);
    expect(container.querySelector('[data-hc-thinking-body]')).toBeNull();
    const row = windowEl()?.querySelector('button');
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    await click(row);
    expect(container.querySelector('[data-hc-thinking-body]')).not.toBeNull();
    // More steps arrive: the row the reader opened stays open.
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [done, tool('a', 'Bash', { summary: 'command: ls' })],
        })}
      />,
    );
    expect(container.querySelector('[data-hc-thinking-body]')).not.toBeNull();
  });

  it('puts a question for the reader outside the window, where it cannot fold shut', async () => {
    const question = tool('q', 'AskUserQuestion', {
      status: 'running',
      endedAt: undefined,
    });
    const activeTools = [
      {
        toolName: 'AskUserQuestion',
        toolUseId: 'q',
        startTime: 1,
        toolInput: {
          question: '用哪个方案？',
          options: [{ value: '窄 selector' }],
        },
      },
    ];
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [tool('a', 'Read'), question],
          activeTools,
        })}
      />,
    );
    await click(header());
    expect(windowEl()).toBeNull();
    expect(text()).toContain('用哪个方案？');
    expect(text()).toContain('窄 selector');

    // A card of nothing but the question has no window to hold no rows.
    await render(null);
    await render(
      <ProcessCard
        {...props({ mode: 'live', steps: [question], activeTools })}
      />,
    );
    expect(header()).toBeNull();
    expect(windowEl()).toBeNull();
    expect(text()).toContain('用哪个方案？');
  });

  it('keeps the question with the settled reply, after its call returned', async () => {
    const asked = tool('q', 'AskUserQuestion', {
      status: 'done',
      questions: [{ question: '周末去哪？', options: ['爬山', '看展'] }],
    });
    await render(
      <ProcessCard
        {...props({ mode: 'settled', steps: [tool('a', 'Read'), asked] })}
      />,
    );
    expect(text()).toContain('周末去哪？');
    expect(text()).toContain('爬山');
    expect(text()).toContain('看展');

    // With nothing else to show, the question is still there.
    await render(null);
    await render(
      <ProcessCard {...props({ mode: 'settled', steps: [asked] })} />,
    );
    expect(header()).toBeNull();
    expect(text()).toContain('周末去哪？');
  });
});

describe('ProcessCard, after cindy', () => {
  const working = [
    thinking({ at: 1000, endedAt: 3000, title: '确认范围', text: '先看。' }),
    ...Array.from({ length: 7 }, (_, i) =>
      tool(`w${i}`, 'Bash', {
        at: 3000 + i * 1000,
        endedAt: 3500 + i * 1000,
        summary: `command: echo w${i}`,
      }),
    ),
  ];

  it('lists the latest five rows while it works, all of them once the reader asks', async () => {
    await render(<ProcessCard {...props({ mode: 'live', steps: working })} />);
    // The older ones fold into one row above the five.
    expect(rows()).toHaveLength(6);
    expect(text()).not.toContain('echo w1');
    await click(header());
    expect(windowEl()).toBeNull();
    await click(header());
    expect(rows()).toHaveLength(8);
    expect(text()).toContain('echo w1');
  });

  it('times the process from its first step, in a monospace timer', async () => {
    vi.setSystemTime(10_000);
    await render(<ProcessCard {...props({ mode: 'live', steps: working })} />);
    const timer = header()?.querySelector('.font-mono');
    expect(timer?.textContent).toBe('9s');
    await advance(3000);
    expect(header()?.querySelector('.font-mono')?.textContent).toBe('12s');
    expect(header()?.querySelector('svg.lucide-loader-circle')).not.toBeNull();
  });

  it('folds into how long it worked once the answer is being written', async () => {
    await render(
      <ProcessCard
        {...props({ mode: 'live', steps: working, answering: true })}
      />,
    );
    expect(header()?.textContent).toBe('已工作 9s');
    expect(header()?.getAttribute('aria-expanded')).toBe('false');
    expect(windowEl()).toBeNull();
    expect(card()?.getAttribute('data-mode')).toBe('live');
    expect(card()?.hasAttribute('data-folded')).toBe(true);
    expect(header()?.querySelector('.font-mono')).toBeNull();
    // Another tool after the text: at work again, open on its latest rows.
    await render(<ProcessCard {...props({ mode: 'live', steps: working })} />);
    expect(windowEl()).not.toBeNull();
    expect(rows()).toHaveLength(6);
  });

  it('opens to all of it while the answer is being written, if the reader asks', async () => {
    await render(
      <ProcessCard
        {...props({ mode: 'live', steps: working, answering: true })}
      />,
    );
    await click(header());
    expect(rows()).toHaveLength(8);
    expect(counts()).toBe('7 个工具 · 1 段思考');
  });

  it('keeps the reader’s choice for the reply that takes its place', async () => {
    // Opened while the answer was written: the finished reply's card is open.
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: working,
          answering: true,
          memoryKey: 'turn-opened',
        })}
      />,
    );
    await click(header());
    await render(<div />);
    await render(
      <ProcessCard {...props({ steps: working, memoryKey: 'turn-opened' })} />,
    );
    expect(windowEl()).not.toBeNull();
    // Closed while it worked: the finished reply's card stays closed, even
    // when asked to open.
    await render(
      <ProcessCard
        {...props({ mode: 'live', steps: working, memoryKey: 'turn-closed' })}
      />,
    );
    await click(header());
    await render(<div />);
    await render(
      <ProcessCard
        {...props({
          steps: working,
          memoryKey: 'turn-closed',
          defaultOpen: true,
        })}
      />,
    );
    expect(windowEl()).toBeNull();
    // A reply nobody chose for follows its own state.
    await render(<div />);
    await render(
      <ProcessCard
        {...props({ steps: working, memoryKey: 'turn-untouched' })}
      />,
    );
    expect(windowEl()).toBeNull();
  });
});

describe('ProcessCard, manual open comes first', () => {
  const steps = [tool('a', 'Bash', { summary: 'command: ls' })];

  it('stays folded after the reader folded it, whatever the run does next', async () => {
    await render(<ProcessCard {...props({ mode: 'live', steps })} />);
    expect(windowEl()).not.toBeNull();
    await click(header());
    expect(header()?.getAttribute('aria-expanded')).toBe('false');
    expect(windowEl()).toBeNull();

    await render(
      <ProcessCard
        {...props({ mode: 'live', steps: [...steps, tool('b', 'Bash')] })}
      />,
    );
    expect(windowEl()).toBeNull();
    // It settles with the reader's choice, even when asked to open.
    await render(
      <ProcessCard
        {...props({ mode: 'settled', steps: [...steps], defaultOpen: true })}
      />,
    );
    expect(windowEl()).toBeNull();
  });

  it('stays open after the reader opened it, when the run settles', async () => {
    await render(<ProcessCard {...props({ mode: 'settled', steps })} />);
    expect(windowEl()).toBeNull();
    await click(header());
    expect(windowEl()).not.toBeNull();
    await render(<ProcessCard {...props({ mode: 'live', steps })} />);
    await render(<ProcessCard {...props({ mode: 'settled', steps })} />);
    expect(windowEl()).not.toBeNull();
  });

  it('follows its own state until the reader has chosen', async () => {
    await render(<ProcessCard {...props({ mode: 'live', steps })} />);
    expect(windowEl()).not.toBeNull();
    // Settled, with nobody having touched it: folded to its summary.
    await render(<ProcessCard {...props({ mode: 'settled', steps })} />);
    expect(windowEl()).toBeNull();
  });
});

describe('ProcessCard, settled', () => {
  const steps = [
    thinking({ at: 1000, endedAt: 5000, title: '确认范围', text: '先看。' }),
    tool('a', 'Read', { at: 5000, endedAt: 6000, summary: 'a.ts' }),
    thinking({
      id: 'thinking-1',
      at: 6000,
      endedAt: 8000,
      durationMs: 2000,
      title: '比较方案',
      text: '再比较。',
    }),
    tool('b', 'Bash', {
      at: 8000,
      endedAt: 15_000,
      summary: 'command: npm test',
    }),
  ];

  it('is one line that says how long the process took, folded by a Layers icon', async () => {
    await render(<ProcessCard {...props({ steps })} />);
    expect(header()?.textContent).toBe('已工作 14s');
    expect(header()?.querySelector('svg.lucide-layers')).not.toBeNull();
    expect(card()?.hasAttribute('data-folded')).toBe(true);
    expect(header()?.getAttribute('aria-expanded')).toBe('false');
    expect(header()?.hasAttribute('aria-controls')).toBe(false);
    expect(windowEl()).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('opens to the same steps as the live card, in a window that scrolls', async () => {
    const onOpenChange = vi.fn();
    await render(<ProcessCard {...props({ steps, onOpenChange })} />);
    await click(header());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(header()?.getAttribute('aria-expanded')).toBe('true');
    const win = windowEl();
    expect(win?.id).toBe(header()?.getAttribute('aria-controls'));
    expect(win?.className).toContain('max-h-[60vh]');
    expect(win?.className).toContain('overflow-y-auto');
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('确认范围'),
      expect.stringContaining('读取'),
      expect.stringContaining('比较方案'),
      expect.stringContaining('运行'),
    ]);
    await click(header());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(windowEl()).toBeNull();
  });

  it('opens at once when asked to, and follows a change of that ask', async () => {
    await render(<ProcessCard {...props({ steps, defaultOpen: true })} />);
    expect(windowEl()).not.toBeNull();
    await render(<ProcessCard {...props({ steps, defaultOpen: false })} />);
    expect(windowEl()).toBeNull();
  });

  it('opens each reasoning step on its own', async () => {
    await render(<ProcessCard {...props({ steps, defaultOpen: true })} />);
    expect(container.querySelector('[data-hc-thinking-body]')).toBeNull();
    const first = rows()[0].querySelector('button');
    await click(first);
    expect(container.querySelectorAll('[data-hc-thinking-body]')).toHaveLength(
      1,
    );
    expect(text()).toContain('先看。');
    expect(text()).not.toContain('再比较。');
    expect(first?.getAttribute('aria-expanded')).toBe('true');
    expect(first?.getAttribute('aria-controls')).toBeTruthy();
  });

  it('takes the total it was given when the steps carry no times', async () => {
    const bare = [
      step({ id: 'thinking-0', kind: 'thinking', status: 'done' }),
      step({ id: 'tool-a', kind: 'tool', toolName: 'Read', status: 'done' }),
    ];
    await render(
      <ProcessCard {...props({ steps: bare, durationMs: 21_000 })} />,
    );
    expect(header()?.textContent).toBe('已工作 21s');
  });

  it('says what it used inside, once opened', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [thinking({ at: 0, endedAt: 12_000, title: 'x', text: 'y' })],
        })}
      />,
    );
    expect(header()?.textContent).toBe('已工作 12s');
    expect(text()).not.toContain('段思考');
    await click(header());
    expect(counts()).toBe('1 段思考');
    await render(
      <ProcessCard
        {...props({ steps: [tool('a', 'Read'), tool('b', 'Bash')] })}
      />,
    );
    expect(counts()).toBe('2 个工具');
  });

  it('counts the failures, and shows what failed when opened', async () => {
    await render(
      <ProcessCard
        {...props({
          defaultOpen: true,
          steps: [
            tool('a', 'Bash', {
              status: 'error',
              summary: 'command: rm -rf x',
              resultPreview: '被权限策略拒绝',
            }),
          ],
        })}
      />,
    );
    expect(counts()).toBe('1 个工具 · 1 个失败');
    expect(text()).toContain('被权限策略拒绝');
  });

  it('says, folded, what went wrong and out of how many calls', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('a', 'Read'),
            tool('b', 'Bash', { status: 'error', resultPreview: 'exit 1' }),
            tool('c', 'Bash', {
              status: 'error',
              resultPreview: '被权限策略拒绝',
              outcome: 'denied',
            }),
          ],
        })}
      />,
    );
    expect(header()?.textContent).toBe(
      '已工作 1s · 3 个工具 · 1 个失败 · 1 个被拒绝',
    );
    const problems = header()?.querySelector('[data-hc-work-problems]');
    expect(problems?.className).toContain('text-error');
    expect(header()?.querySelector('svg.lucide-layers')).toBeNull();
    expect(header()?.querySelector('[data-tool-state="error"]')).not.toBeNull();
    // Opened, the counts under the line say it, and the line does not.
    await click(header());
    expect(header()?.textContent).toBe('已工作 1s');
    expect(counts()).toBe('3 个工具 · 1 个失败 · 1 个被拒绝');
  });

  it('says a stop apart from a failure, in the warning colour', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('a', 'Read'),
            // Stored before the outcome was kept: only the stop's word.
            tool('b', 'Bash', { status: 'error', resultPreview: '已停止' }),
          ],
        })}
      />,
    );
    expect(header()?.textContent).toBe('已工作 1s · 2 个工具 · 1 个已中断');
    expect(
      header()?.querySelector('[data-hc-work-problems]')?.className,
    ).toContain('text-warning');
    await click(header());
    const spoken = rows()[1].querySelector('.sr-only')?.textContent ?? '';
    expect(spoken).toContain('已中断');
    expect(
      rows()[1].querySelector('[data-tool-state="stopped"]'),
    ).not.toBeNull();
  });

  it('says a sub-agent a stop killed is stopped, not failed', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [{ ...taskStep, status: 'error', outcome: 'stopped' }],
          taskStates: { 'task-1': { ...task, status: 'stopped' } },
        })}
      />,
    );
    expect(header()?.textContent).not.toContain('失败');
    expect(header()?.textContent).toContain('1 个已中断');
    await click(header());
    expect(
      rows()[0].querySelector('[data-tool-state="stopped"]'),
    ).not.toBeNull();
    expect(rows()[0].querySelector('[data-tool-state="error"]')).toBeNull();
  });

  it('adds nothing to the folded line when nothing went wrong', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('a', 'Read'),
            // Never closed: not a failure.
            tool('b', 'Bash', { status: 'running', endedAt: undefined }),
          ],
        })}
      />,
    );
    expect(header()?.textContent).toMatch(/^已工作[^·]*$/);
    expect(header()?.querySelector('svg.lucide-layers')).not.toBeNull();
  });

  it('draws nothing that runs, even for a step the stop caught in flight', async () => {
    await render(
      <ProcessCard
        {...props({
          defaultOpen: true,
          steps: [tool('a', 'Bash', { status: 'running', endedAt: undefined })],
        })}
      />,
    );
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.shimmer')).toBeNull();
  });
});

describe('ProcessCard, what the reader may see', () => {
  const steps = [
    thinking({ title: '私密的标题', text: '私密的思考', endedAt: 5000 }),
    step({
      id: 'note-0',
      kind: 'text',
      at: 5000,
      endedAt: 5500,
      text: '我先改渲染循环。',
    }),
    tool('a', 'Read', { at: 5500, endedAt: 6000, summary: 'a.ts' }),
  ];

  it('says only that it thought, and for how long, without the reasoning text', async () => {
    await render(
      <ProcessCard
        {...props({ steps, thinkingText: false, defaultOpen: true })}
      />,
    );
    expect(text()).not.toContain('私密的标题');
    expect(text()).not.toContain('私密的思考');
    const row = rows()[0];
    expect(row.textContent).toContain('思考');
    expect(row.textContent).toContain('5.0s');
    // Nothing to open, and no claim that the model gave nothing.
    expect(row.querySelector('button')).toBeNull();
    expect(text()).not.toContain('模型未返回思考内容');
  });

  it('shows no reasoning text on a live card either', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          thinkingText: false,
          steps: [
            thinking({
              status: 'running',
              endedAt: undefined,
              title: '私密的标题',
              text: '私密的思考',
            }),
          ],
        })}
      />,
    );
    expect(text()).not.toContain('私密');
    expect(header()?.textContent).toContain('思考中…');
    expect(container.querySelector('[data-hc-thinking-body]')).toBeNull();
  });

  it('leaves the commentary out when it is not asked for', async () => {
    await render(
      <ProcessCard
        {...props({ steps, commentary: false, defaultOpen: true })}
      />,
    );
    expect(text()).not.toContain('我先改渲染循环');
    expect(rows()).toHaveLength(2);
    // And it is not counted either.
    expect(counts()).toBe('1 个工具 · 1 段思考');
  });

  it('shows the commentary as a row that opens to its whole text', async () => {
    await render(<ProcessCard {...props({ steps, defaultOpen: true })} />);
    const note = rows()[1].querySelector('button');
    expect(note?.textContent).toContain('我先改渲染循环。');
    await click(note);
    expect(note?.textContent).toContain('过程说明');
    expect(rows()[1].textContent).toContain('我先改渲染循环。');
  });

  it('has no row for a card of only commentary when that is not asked for', async () => {
    await render(
      <ProcessCard
        {...props({
          commentary: false,
          steps: [
            step({
              id: 'note-0',
              kind: 'text',
              text: '一句说明',
              endedAt: 2,
              commentary: true,
            }),
          ],
        })}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});

describe('ProcessCard, the rows', () => {
  it('merges a run of read-only calls into one row that opens to its members', async () => {
    const steps = [
      tool('a', 'Read', { summary: 'a.ts' }),
      tool('b', 'Read', { summary: 'b.ts' }),
      tool('c', 'Grep', { summary: 'pattern: useChatStore' }),
      tool('d', 'Bash', { summary: 'command: npm test' }),
    ];
    await render(<ProcessCard {...props({ steps, defaultOpen: true })} />);
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('已浏览 2 个文件 · 搜索 1 次'),
      expect.stringContaining('npm test'),
    ]);
    expect(text()).not.toContain('b.ts');
    await click(rows()[0].querySelector('button'));
    expect(text()).toContain('b.ts');
    expect(text()).toContain('useChatStore');
  });

  it('shows a group that holds a failure, and one that is still running', async () => {
    const failing = [
      tool('a', 'Read', { status: 'error', resultPreview: '文件不存在' }),
      tool('b', 'Read'),
    ];
    await render(
      <ProcessCard {...props({ steps: failing, defaultOpen: true })} />,
    );
    expect(rows()[0].textContent).toContain('1 个失败');
    expect(rows()[0].innerHTML).toContain('text-error');

    const running = [
      tool('a', 'Read'),
      tool('b', 'Read', { status: 'running', endedAt: undefined }),
    ];
    await render(<ProcessCard {...props({ mode: 'live', steps: running })} />);
    expect(rows()[0].textContent).toContain('正在浏览 2 个文件');
    expect(rows()[0].innerHTML).toContain('animate-spin');
  });

  it('shows a sub-agent as a row that opens to what it did, and a plain row without its details', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [taskStep],
          taskStates: { 'task-1': task },
          defaultOpen: true,
        })}
      />,
    );
    const row = rows()[0];
    expect(row.textContent).toContain('检查移动端滚动');
    expect(row.textContent).toContain('已读完 3 个文件');
    expect(row.textContent).not.toContain('子 Agent 的最后一段话');
    await click(row.querySelector('button'));
    expect(row.textContent).toContain('子 Agent 的最后一段话');

    await render(
      <ProcessCard
        {...props({
          steps: [{ ...taskStep, title: '检查移动端滚动' }],
          defaultOpen: true,
        })}
      />,
    );
    expect(rows()[0].textContent).toContain('检查移动端滚动');
    expect(rows()[0].querySelector('button')).toBeNull();
  });

  it('folds the steps before the latest five into one row that opens', async () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      tool(`t${i}`, 'Bash', { summary: `command: echo n${i}` }),
    );
    await render(<ProcessCard {...props({ mode: 'live', steps: many })} />);
    const folded = rows()[0].querySelector('button');
    expect(folded?.textContent).toContain('较早 4 步 · 4 个工具');
    expect(text()).not.toContain('echo n3');
    expect(text()).toContain('echo n4');
    await click(folded);
    expect(text()).toContain('echo n3');
    expect(folded?.getAttribute('aria-expanded')).toBe('true');
  });

  it('names the steps dropped at the cap in the folded row', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [tool('a', 'Bash')],
          stepsDropped: 12,
          defaultOpen: true,
        })}
      />,
    );
    expect(text()).toContain('较早 12 步');
  });

  it('has a button for a row only when there is something to open', async () => {
    await render(
      <ProcessCard
        {...props({
          defaultOpen: true,
          steps: [
            tool('a', 'Read', { summary: 'a.ts' }),
            tool('b', 'Bash', { summary: `command: ${'x'.repeat(120)}` }),
          ],
        })}
      />,
    );
    expect(rows()[0].querySelector('button')).toBeNull();
    const long = rows()[1].querySelector('button');
    expect(long).not.toBeNull();
    await click(long);
    expect(rows()[1].textContent).toContain('x'.repeat(120));
  });
});
