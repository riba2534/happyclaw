// @vitest-environment happy-dom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProcessCard,
  type ProcessCardProps,
} from '../src/components/chat/ProcessCard';
import { SubAgentCard } from '../src/components/chat/SubAgentCard';
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
const click = (el: Element | null | undefined) =>
  act(async () => {
    (el as HTMLElement).click();
  });

const tool = (
  id: string,
  toolName: string,
  over: Partial<StreamingStep> = {},
): StreamingStep => ({
  id: `tool-${id}`,
  kind: 'tool',
  at: 1000,
  endedAt: 2000,
  status: 'done',
  toolName,
  toolUseId: id,
  ...over,
});

const props = (over: Partial<ProcessCardProps> = {}): ProcessCardProps => ({
  mode: 'settled',
  steps: [],
  groupJid: 'web:test',
  defaultOpen: true,
  ...over,
});

const rows = () => [...container.querySelectorAll('[role="listitem"]')];
const rowButton = (index: number) => rows()[index].querySelector('button');
const output = () => container.querySelector('pre');
const text = () => container.textContent ?? '';

const edit = tool('e', 'Edit', {
  summary: '{"file_path":"/repo/src/foo.ts"}',
  resultFacts: { added: 12, removed: 3 },
});

describe('a tool row says what the call did', () => {
  it('puts the facts after what the call was given and before how long it took', async () => {
    await render(<ProcessCard {...props({ steps: [edit] })} />);
    const row = rows()[0].textContent ?? '';
    expect(row).toMatch(/编辑.*\/repo\/src\/foo\.ts.*\+12 −3.*1\.0s/);
  });

  it('colours the lines added as success and the lines removed as error', async () => {
    await render(<ProcessCard {...props({ steps: [edit] })} />);
    const added = rows()[0].querySelector('.text-success');
    const removed = rows()[0].querySelector('.text-error');
    expect(added?.textContent).toBe('+12');
    expect(removed?.textContent).toBe('−3');
  });

  it('writes the facts of each kind of tool', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('r', 'Read', {
              summary: '/repo/a.ts',
              resultFacts: { lines: 120, totalLines: 430 },
            }),
            tool('w', 'Write', {
              summary: '/repo/new.ts',
              resultFacts: { created: true, added: 24 },
            }),
            tool('f', 'WebFetch', {
              summary: 'https://example.com',
              resultFacts: { httpCode: 200, bytes: 14 * 1024 },
            }),
          ],
        })}
      />,
    );
    expect(rows()[0].textContent).toContain('120/430 行');
    expect(rows()[1].textContent).toContain('新建 · +24');
    expect(rows()[2].textContent).toContain('HTTP 200 · 14 KB');
  });

  it('says nothing more of a call that has no facts', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [tool('e', 'Edit', { summary: '/repo/src/foo.ts' })],
        })}
      />,
    );
    expect(rows()[0].textContent).toBe('编辑/repo/src/foo.ts1.0s，已完成');
    expect(rows()[0].querySelector('.text-success')).toBeNull();
    expect(rows()[0].querySelector('button')).toBeNull();
  });

  it('keeps the facts out of a call that is still running', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [
            tool('e', 'Edit', {
              status: 'running',
              endedAt: undefined,
              summary: '/repo/src/foo.ts',
              resultFacts: { added: 12, removed: 3 },
            }),
          ],
        })}
      />,
    );
    expect(rows()[0].textContent).not.toContain('+12');
  });
});

describe('a failed tool row', () => {
  const failedBash = tool('b', 'Bash', {
    status: 'error',
    summary: 'command: npm run missing',
    resultPreview: 'npm ERR! Missing script: "missing"\nnpm ERR! Did you mean?',
    resultFacts: { exitCode: 1 },
  });

  it('shows the exit code first, then the first line of the output, in the error colour', async () => {
    await render(<ProcessCard {...props({ steps: [failedBash] })} />);
    const detail = rows()[0].querySelector('button > span.truncate.text-error');
    expect(detail?.textContent).toBe(
      '退出码 1 · npm ERR! Missing script: "missing"',
    );
    // Not the command: that is under the row, with the output.
    expect(rows()[0].textContent).toContain('npm run missing');
  });

  it('shows the first line of the output when there is no exit code', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('b', 'Bash', {
              status: 'error',
              resultPreview: '\n  被权限策略拒绝\n第二行',
            }),
          ],
        })}
      />,
    );
    const detail = rows()[0].querySelector('button > span.truncate.text-error');
    expect(detail?.textContent).toBe('被权限策略拒绝');
  });

  it('is open to the whole output without being asked', async () => {
    await render(<ProcessCard {...props({ steps: [failedBash] })} />);
    const button = rowButton(0)!;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(output()?.textContent).toBe(
      'npm ERR! Missing script: "missing"\nnpm ERR! Did you mean?',
    );
    expect(output()?.className).toContain('text-error');
    expect(output()?.closest('[id]')?.id).toBe(
      button.getAttribute('aria-controls'),
    );
  });

  it('has nothing to open when it left no output', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('b', 'Bash', {
              status: 'error',
              summary: 'command: false',
              resultFacts: { exitCode: 1 },
            }),
          ],
        })}
      />,
    );
    expect(rows()[0].textContent).toContain('退出码 1');
    expect(rowButton(0)).toBeNull();
    expect(output()).toBeNull();
  });

  it('does not colour lines added or removed in a row that is all error', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('e', 'Agent', {
              kind: 'task',
              status: 'error',
              taskId: 'a1',
              resultFacts: { agent: { added: 4, removed: 1 } },
            }),
          ],
        })}
      />,
    );
    expect(rows()[0].querySelector('.text-success')).toBeNull();
    expect(rows()[0].textContent).toContain('+4 −1');
  });
});

describe('a failed command whose output starts with its exit code', () => {
  const failed = tool('b', 'Bash', {
    status: 'error',
    summary: 'command: npm test',
    resultPreview: 'Exit code 3\nnpm ERR! 3 tests failed',
    resultFacts: { exitCode: 3 },
  });

  it('says the code once, in the row, and then what the program said', async () => {
    await render(<ProcessCard {...props({ steps: [failed] })} />);
    const detail = rows()[0].querySelector('button > span.truncate.text-error');
    expect(detail?.textContent).toBe('退出码 3 · npm ERR! 3 tests failed');
    expect(text().match(/Exit code 3/g)).toBeNull();
    expect(output()?.textContent).toBe('npm ERR! 3 tests failed');
  });

  it('has nothing to open when the code was all the output said', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [{ ...failed, resultPreview: 'Exit code 3' }],
        })}
      />,
    );
    expect(rows()[0].textContent).toContain('退出码 3');
    expect(text()).not.toContain('Exit code');
    expect(rowButton(0)).toBeNull();
  });

  it('keeps the words of a command that says a code the facts do not', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            { ...failed, resultFacts: undefined, resultPreview: 'Exit code 3' },
          ],
        })}
      />,
    );
    expect(text()).toContain('Exit code 3');
  });
});

describe('a finished tool row opens to its output', () => {
  const ok = tool('b', 'Bash', {
    summary: 'command: npm test',
    resultPreview: 'PASS  a.test.ts\nPASS  b.test.ts\nTests: 12 passed',
  });

  it('is a closed button with the output behind it', async () => {
    await render(<ProcessCard {...props({ steps: [ok] })} />);
    const button = rowButton(0)!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(button.className).toContain('pointer-coarse:min-h-10');
    expect(output()).toBeNull();

    await click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(output()?.textContent).toBe(
      'PASS  a.test.ts\nPASS  b.test.ts\nTests: 12 passed',
    );
    expect(output()?.closest('[id]')?.id).toBe(
      button.getAttribute('aria-controls'),
    );
    await click(button);
    expect(output()).toBeNull();
  });

  it('shows the output as preformatted text that scrolls within 160px', async () => {
    await render(<ProcessCard {...props({ steps: [ok] })} />);
    await click(rowButton(0));
    const className = output()?.className ?? '';
    for (const token of [
      'font-mono',
      'whitespace-pre-wrap',
      'max-h-40',
      'overflow-y-auto',
      'text-label',
      'text-muted-foreground',
    ]) {
      expect(className).toContain(token);
    }
    expect(className).not.toContain('text-error');
    // A scroller the keyboard can reach.
    expect(output()?.tabIndex).toBe(0);
  });

  it('does not repeat a short command that the row already shows', async () => {
    await render(<ProcessCard {...props({ steps: [ok] })} />);
    await click(rowButton(0));
    expect(text().match(/npm test/g)).toHaveLength(1);
  });

  it('is not a button when the call returned nothing to read', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('r', 'Read', {
              summary: '/repo/a.ts',
              resultFacts: { lines: 120 },
            }),
            tool('b', 'Bash', {
              summary: 'command: true',
              resultPreview: ' \n',
            }),
          ],
        })}
      />,
    );
    expect(rows()[0].textContent).toContain('120 行');
    expect(rowButton(0)).toBeNull();
    expect(rowButton(1)).toBeNull();
    expect(output()).toBeNull();
  });

  it('is not a button for a speech tool, whatever it carries', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('s', 'mcp__happyclaw__send_message', {
              resultPreview: '已发送',
            }),
          ],
        })}
      />,
    );
    expect(rowButton(0)).toBeNull();
    expect(output()).toBeNull();
  });

  it('still opens a long command to be read in full, above the output', async () => {
    const command = `command: ${'x'.repeat(120)}`;
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('b', 'Bash', { summary: command, resultPreview: '第一行' }),
          ],
        })}
      />,
    );
    await click(rowButton(0));
    const panel = output()?.parentElement;
    expect(panel?.firstElementChild?.textContent).toBe('x'.repeat(120));
    expect(panel?.lastElementChild).toBe(output());
  });
});

describe('the reader’s own opening comes first', () => {
  const failed = tool('b', 'Bash', {
    status: 'error',
    summary: 'command: npm test',
    resultPreview: '测试失败',
  });

  it('keeps a failed row shut once the reader shut it', async () => {
    await render(<ProcessCard {...props({ mode: 'live', steps: [failed] })} />);
    expect(output()).not.toBeNull();
    await click(rowButton(0));
    expect(output()).toBeNull();
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [failed, tool('c', 'Bash', { summary: 'command: ls' })],
        })}
      />,
    );
    expect(output()).toBeNull();
    expect(rowButton(0)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps a good row open once the reader opened it', async () => {
    const ok = tool('b', 'Bash', {
      summary: 'command: ls',
      resultPreview: 'a.ts',
    });
    await render(<ProcessCard {...props({ mode: 'live', steps: [ok] })} />);
    await click(rowButton(0));
    expect(output()).not.toBeNull();
    await render(
      <ProcessCard
        {...props({ mode: 'live', steps: [ok, tool('c', 'Bash')] })}
      />,
    );
    expect(output()?.textContent).toBe('a.ts');
  });
});

describe('the members of a merged row', () => {
  const steps = [
    tool('a', 'Read', {
      summary: '/repo/a.ts',
      resultFacts: { lines: 120 },
      resultPreview: 'import a',
    }),
    tool('b', 'Grep', {
      summary: 'pattern: useChatStore',
      resultFacts: { matches: 24, files: 8 },
    }),
    tool('c', 'Read', {
      status: 'error',
      summary: '/repo/missing.ts',
      resultPreview: '文件不存在',
    }),
  ];

  it('give their facts and open to their output like a row of their own', async () => {
    await render(<ProcessCard {...props({ steps })} />);
    expect(rows()).toHaveLength(1);
    await click(rowButton(0));
    const members = [...rows()[0].querySelectorAll('[role="listitem"]')];
    expect(members).toHaveLength(3);
    expect(members[0].textContent).toContain('120 行');
    expect(members[1].textContent).toContain('24 处匹配 · 8 个文件');
    // Only the one with output opens.
    expect(members[0].querySelector('button')).not.toBeNull();
    expect(members[1].querySelector('button')).toBeNull();
    expect(members[0].querySelector('pre')).toBeNull();
    await click(members[0].querySelector('button'));
    expect(members[0].querySelector('pre')?.textContent).toBe('import a');
  });

  it('open a failed member without being asked', async () => {
    await render(<ProcessCard {...props({ steps })} />);
    await click(rowButton(0));
    const failed = rows()[0].querySelectorAll('[role="listitem"]')[2];
    expect(failed.querySelector('pre')?.textContent).toBe('文件不存在');
  });
});

describe('a sub-agent row says what it cost', () => {
  const task: StreamingTaskRuntimeState = {
    id: 'task-1',
    title: '检查移动端滚动',
    status: 'running',
    subagentType: 'general-purpose',
    usage: { totalTokens: 12_345, toolUses: 14, durationMs: 46_000 },
    thinkingTail: '',
    textTail: '',
    activeTools: [],
    recentTools: [],
    updatedAt: 1,
  };
  const taskStep: StreamingStep = {
    id: 'task-task-1',
    kind: 'task',
    at: 1000,
    status: 'running',
    taskId: 'task-1',
    toolUseId: 'task-1',
    toolName: 'Task',
  };

  it('shows the usage of a running one beside what it is doing', async () => {
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [taskStep],
          taskStates: { 'task-1': { ...task, lastToolName: 'Grep' } },
        })}
      />,
    );
    const row = rows()[0].textContent ?? '';
    expect(row).toContain('检查移动端滚动');
    expect(row).toContain('general-purpose · Grep');
    expect(row).toContain('14 个工具 · 1.2 万 token · 46 秒');
  });

  it('shows what the step itself reported when there is no card for it', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            {
              ...taskStep,
              status: 'done',
              endedAt: 5000,
              title: '检查移动端滚动',
              resultFacts: {
                agent: {
                  reads: 3,
                  searches: 2,
                  edits: 1,
                  commands: 4,
                  added: 12,
                  removed: 3,
                  tokens: 12_345,
                  durationMs: 46_000,
                },
              },
            },
          ],
        })}
      />,
    );
    expect(rows()[0].textContent).toContain(
      '读 3 · 搜 2 · 改 1 · 命令 4 · +12 −3 · 1.2 万 token · 46 秒',
    );
    expect(rows()[0].querySelector('.text-success')?.textContent).toBe('+12');
    // A narrow row cuts the facts short: the whole of them is its tooltip.
    expect(rows()[0].querySelector('div')?.getAttribute('title')).toBe(
      '读 3 · 搜 2 · 改 1 · 命令 4 · +12 −3 · 1.2 万 token · 46 秒',
    );
    // Nothing behind the row to open.
    expect(rowButton(0)).toBeNull();
  });

  it('prefers the final totals of the call to the usage seen on the way', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            {
              ...taskStep,
              status: 'done',
              endedAt: 5000,
              resultFacts: { agent: { reads: 7 } },
            },
          ],
          taskStates: { 'task-1': { ...task, status: 'completed' } },
        })}
      />,
    );
    expect(rows()[0].textContent).toContain('读 7');
    expect(rows()[0].textContent).not.toContain('14 个工具');
  });

  it('says nothing of cost when neither the card nor the step has any', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            { ...taskStep, status: 'done', endedAt: 5000, title: '子任务' },
          ],
        })}
      />,
    );
    expect(rows()[0].textContent).toBe('子任务4.0s，子 Agent，已完成');
    await render(
      <ProcessCard
        {...props({
          mode: 'live',
          steps: [taskStep],
          taskStates: { 'task-1': { ...task, usage: undefined } },
        })}
      />,
    );
    expect(rows()[0].textContent).not.toContain('token');
  });

  it('leaves the classic card as it was: its title row has no usage', async () => {
    await render(<SubAgentCard task={task} groupJid="web:test" />);
    expect(text()).toContain('运行中');
    expect(text()).not.toContain('token');
    expect(text()).not.toContain('14 个工具');
  });
});

describe('a workspace that withholds tool results', () => {
  it('draws a row with no facts and no output as the plain row it was', async () => {
    await render(
      <ProcessCard
        {...props({
          steps: [
            tool('e', 'Edit', { summary: '/repo/src/foo.ts' }),
            tool('b', 'Bash', { summary: 'command: npm test' }),
            tool('x', 'Bash', { status: 'error', summary: 'command: false' }),
          ],
        })}
      />,
    );
    expect(container.querySelector('pre')).toBeNull();
    expect(
      container.querySelector('[role="list"] button[aria-expanded]'),
    ).toBeNull();
    expect(container.querySelector('.text-success')).toBeNull();
    expect(rows().map((row) => row.textContent)).toEqual([
      '编辑/repo/src/foo.ts1.0s，已完成',
      '运行npm test1.0s，已完成',
      '运行false1.0s，失败',
    ]);
  });
});
