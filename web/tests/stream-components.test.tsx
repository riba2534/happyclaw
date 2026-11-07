import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThinkingBlock } from '../src/components/chat/ThinkingBlock';
import { ToolRow } from '../src/components/chat/ToolActivityCard';
import { ProcessSteps } from '../src/components/chat/ProcessRows';
import { SubAgentCard } from '../src/components/chat/SubAgentCard';
import { TracePanel } from '../src/components/chat/ExecutionTrace';
import {
  MODEL_WAIT_SKELETON_SECONDS,
  ModelWaitRow,
} from '../src/components/chat/ModelWaitRow';
import {
  ProcessPanel,
  summarizeProcess,
} from '../src/components/chat/ProcessPanel';
import { ProcessVisibilitySelector } from '../src/components/chat/ProcessVisibilitySelector';
import type { StreamingState } from '../src/stores/chat';
import type { StreamingStep } from '../src/lib/stream-steps';
import type { StreamingTaskRuntimeState } from '../src/stores/chat';
import { describeRunPhase } from '../src/lib/run-phase';
import { formatElapsedMs } from '../src/utils/format-elapsed';

const step = (
  over: Partial<StreamingStep> & Pick<StreamingStep, 'id' | 'kind'>,
) => ({ at: 1000, status: 'done', ...over }) as StreamingStep;

const task: StreamingTaskRuntimeState = {
  id: 'task-1',
  title: '检查移动端滚动',
  status: 'running',
  subagentType: 'general-purpose',
  latestSummary: '已读完 3 个文件',
  lastToolName: 'Read',
  thinkingTail: '',
  textTail: '',
  activeTools: [],
  recentTools: [],
  updatedAt: 1,
};

const timeline = (
  steps: StreamingStep[],
  over: Partial<Parameters<typeof ProcessSteps>[0]> = {},
) =>
  renderToStaticMarkup(
    <ProcessSteps
      steps={steps}
      taskStates={{ 'task-1': task }}
      activeTools={[]}
      waiting={false}
      hasContent
      groupJid="web:test"
      live
      {...over}
    />,
  );

describe('ThinkingBlock', () => {
  it('says how long it thought, with the latest title', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock
        text="**比较方案**\n\n两种做法"
        title="比较方案"
        durationMs={12_400}
      />,
    );
    expect(html).toContain('已思考 12 秒');
    expect(html).toContain('比较方案');
    expect(html).toContain('aria-expanded="false"');
  });

  it('is a plain label when there is no text to open', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock text="" durationMs={3400} />,
    );
    expect(html).toContain('已思考 3.4 秒');
    // The row does not open; its one button explains the missing text.
    expect(html).not.toContain('aria-expanded');
  });

  it('says the model returned no reasoning text when it thought for a while', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock text="" durationMs={12_700} />,
    );
    expect(html).toContain('已思考 13 秒');
    expect(html).toContain('模型未返回思考内容');
    expect(html).toContain('data-hc-no-summary');
    expect(html).not.toContain('aria-expanded');
  });

  it('claims nothing about the model when the text is only withheld', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock text="" durationMs={12_700} withheld />,
    );
    expect(html).toContain('已思考 13 秒');
    expect(html).not.toContain('模型未返回思考内容');
  });

  it('says nothing about a thought too short to count, or one in progress', () => {
    for (const html of [
      renderToStaticMarkup(<ThinkingBlock text="" durationMs={400} />),
      renderToStaticMarkup(<ThinkingBlock text="" running durationMs={9000} />),
      renderToStaticMarkup(<ThinkingBlock text="想" durationMs={9000} />),
    ]) {
      expect(html).not.toContain('模型未返回思考内容');
    }
  });

  it('shimmers while the model is thinking', () => {
    const html = renderToStaticMarkup(<ThinkingBlock text="" running />);
    expect(html).toContain('思考中…');
    expect(html).toContain('shimmer');
  });

  it('renders the reasoning as Markdown when opened', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock
        text={'**确认订阅范围**\n\n- 窄 selector\n- 拆分 store'}
        durationMs={5000}
        defaultExpanded
      />,
    );
    expect(html).toContain('<strong>确认订阅范围</strong>');
    expect(html).toMatch(/<li[^>]*>窄 selector<\/li>/);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/aria-controls="[^"]+"/);
    expect(html).toContain('overscroll-contain');
  });

  it('enlarges its button for touch', () => {
    const html = renderToStaticMarkup(
      <ThinkingBlock text="想" durationMs={2000} />,
    );
    expect(html).toContain('pointer-coarse:h-10');
  });
});

describe('ToolRow', () => {
  it('spins while running and keeps a mark and the time once done', () => {
    const running = renderToStaticMarkup(
      <ToolRow toolName="Bash" summary="npm test" elapsedSeconds={12.4} />,
    );
    expect(running).toContain('animate-spin');
    expect(running).toContain('12s');
    expect(running).toContain('运行中');

    const done = renderToStaticMarkup(
      <ToolRow
        toolName="Read"
        summary="a.ts"
        status="done"
        durationMs={1250}
      />,
    );
    expect(done).not.toContain('animate-spin');
    expect(done).toContain('1.3s');
    expect(done).toContain('已完成');
  });

  it('shows what a failed call said, in the error color', () => {
    const html = renderToStaticMarkup(
      <ToolRow
        toolName="Bash"
        summary="rm -rf x"
        status="error"
        durationMs={300}
        resultPreview="被权限策略拒绝"
      />,
    );
    expect(html).toContain('text-error');
    expect(html).toContain('被权限策略拒绝');
    expect(html).toContain('失败');
  });

  it('keeps the result of a finished call hidden unless asked', () => {
    const quiet = renderToStaticMarkup(
      <ToolRow toolName="Read" status="done" resultPreview="file text" />,
    );
    expect(quiet).not.toContain('file text');
    const shown = renderToStaticMarkup(
      <ToolRow
        toolName="Read"
        status="done"
        resultPreview="file text"
        showResult
      />,
    );
    expect(shown).toContain('file text');
  });
});

describe('formatElapsedMs', () => {
  it('reads as a short duration', () => {
    expect(formatElapsedMs(20)).toBe('0.1s');
    expect(formatElapsedMs(1250)).toBe('1.3s');
    expect(formatElapsedMs(14_400)).toBe('14s');
    expect(formatElapsedMs(65_000)).toBe('1m 05s');
    expect(formatElapsedMs(-1)).toBe('');
  });
});

describe('SubAgentCard', () => {
  const withTools = {
    ...task,
    recentTools: [{ id: 'r1', timestamp: 1, kind: 'tool', text: '读取 a.ts' }],
  } as StreamingTaskRuntimeState;

  it('carries the latest progress summary on its title row', () => {
    const html = renderToStaticMarkup(
      <SubAgentCard
        task={withTools}
        groupJid="web:test"
        defaultExpanded={false}
      />,
    );
    expect(html).toContain('检查移动端滚动');
    expect(html).toContain('已读完 3 个文件');
    expect(html).toContain('运行中');
    expect(html).toContain('子 Agent：');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('读取 a.ts');
  });

  it('opens to its tools and text', () => {
    const html = renderToStaticMarkup(
      <SubAgentCard task={withTools} groupJid="web:test" defaultExpanded />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('读取 a.ts');
  });

  it('is a plain row, with no empty body, when it has nothing to open', () => {
    const html = renderToStaticMarkup(
      <SubAgentCard task={task} groupJid="web:test" defaultExpanded />,
    );
    expect(html).toContain('检查移动端滚动');
    expect(html).toContain('已读完 3 个文件');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('aria-controls');
    expect(html).not.toContain('border-t');
  });
});

describe('ProcessSteps', () => {
  const steps: StreamingStep[] = [
    step({
      id: 'thinking-0',
      kind: 'thinking',
      at: 1000,
      endedAt: 6000,
      durationMs: 5000,
      title: '确认订阅范围',
      text: '**确认订阅范围**\n\n先看 store。',
    }),
    step({
      id: 'tool-a',
      kind: 'tool',
      toolName: 'Read',
      toolUseId: 'a',
      summary: 'a.ts',
      endedAt: 7000,
    }),
    step({
      id: 'text-0',
      kind: 'text',
      text: '我先改渲染循环。',
      endedAt: 7500,
    }),
    step({
      id: 'tool-b',
      kind: 'tool',
      toolName: 'Bash',
      toolUseId: 'b',
      summary: 'npm test',
      status: 'running',
      at: 8000,
    }),
    step({
      id: 'task-1',
      kind: 'task',
      taskId: 'task-1',
      toolUseId: 'task-1',
      status: 'running',
      at: 9000,
    }),
    step({
      id: 'text-1',
      kind: 'text',
      status: 'running',
      at: 9500,
      from: 8,
    }),
  ];

  it('lists the steps in order and leaves the answer to the text below', () => {
    const html = timeline(steps);
    const order = [
      '确认订阅范围',
      '读取',
      '我先改渲染循环',
      '运行',
      '检查移动端滚动',
    ].map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('role="list"');
    expect(html).toContain('aria-label="处理步骤"');
    expect(html).toContain('data-hc-step-timeline');
    // The running answer step is the text below, not a row.
    expect(html.match(/role="listitem"/g)).toHaveLength(5);
  });

  it('draws the one line down the left, and no second one inside a row', () => {
    const html = timeline(steps);
    expect(html.match(/border-l-2/g)).toHaveLength(1);
    const open = timeline([
      step({
        id: 'thinking-0',
        kind: 'thinking',
        status: 'running',
        title: '核对行高',
        text: '**核对行高**\n\n估算与实测。',
      }),
    ]);
    expect(open.match(/border-l-2/g)).toHaveLength(1);
  });

  it('folds the steps before the latest six into one line', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      step({
        id: `tool-${i}`,
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: `t${i}`,
        summary: `command: echo file-${i}`,
        at: i * 1000,
        endedAt: i * 1000 + 500,
      }),
    );
    const html = timeline(many);
    expect(html).toContain('较早 4 步');
    expect(html).toContain('4 个工具');
    expect(html).not.toContain('file-3');
    expect(html).toContain('file-4');
    expect(html).toContain('file-9');
  });

  it('merges a run of read-only calls into one row, and never a command', () => {
    const calls = (names: string[]) =>
      names.map((toolName, i) =>
        step({
          id: `tool-${i}`,
          kind: 'tool',
          toolName,
          toolUseId: `t${i}`,
          summary: `target-${i}`,
          at: i * 1000,
          endedAt: i * 1000 + 400,
        }),
      );
    const merged = timeline(calls(['Read', 'Read', 'Grep', 'Glob']));
    expect(merged).toContain('已浏览 2 个文件 · 搜索 2 次');
    expect(merged.match(/role="listitem"/g)).toHaveLength(1);
    // The members are there to be opened, not shown.
    expect(merged).not.toContain('target-0');

    const split = timeline(calls(['Read', 'Bash', 'Read']));
    expect(split).not.toContain('已浏览');
    expect(split.match(/role="listitem"/g)).toHaveLength(3);
    const writes = timeline(calls(['Edit', 'Write', 'Edit']));
    expect(writes).not.toContain('已浏览');
  });

  it('opens only the reasoning being written, with its text', () => {
    const html = timeline([
      step({
        id: 'thinking-0',
        kind: 'thinking',
        status: 'running',
        title: '核对行高',
        text: '**核对行高**\n\n估算与实测。',
      }),
    ]);
    expect(html).toContain('<strong>核对行高</strong>');
    expect(html).toContain('aria-expanded="true"');
    // Reasoning that is over is a row until the reader opens it.
    const done = timeline(steps);
    expect(done).not.toContain('<strong>确认订阅范围</strong>');
  });

  it('leaves the commentary and the reasoning text out of a process panel', () => {
    const html = timeline(steps, { commentary: false, thinkingText: false });
    expect(html).not.toContain('我先改渲染循环');
    expect(html).not.toContain('确认订阅范围');
    // Only that it reasoned, and for how long, and it cannot be opened.
    expect(html).toContain('思考');
    expect(html).toContain('5.0s');
    // The text is withheld here, not missing: no word about the model.
    expect(html).not.toContain('模型未返回思考内容');
  });

  it('shows narration the host handed over whole, as commentary', () => {
    const html = timeline(
      [
        step({
          id: 'note-0',
          kind: 'text',
          text: '先查一下记忆再回答。',
          commentary: true,
        }),
        step({
          id: 'tool-m',
          kind: 'tool',
          toolName: 'Read',
          toolUseId: 'm',
          summary: 'memory.md',
        }),
      ],
      { commentary: true },
    );
    expect(html).toContain('先查一下记忆再回答。');
    expect(html).toContain('memory.md');
  });

  it('says a reasoning step ended without any text when text is allowed', () => {
    const html = timeline(
      [
        step({
          id: 'thinking-0',
          kind: 'thinking',
          text: '',
          durationMs: 22_900,
        }),
      ],
      { thinkingText: true },
    );
    expect(html).toContain('23s');
    expect(html).toContain('模型未返回思考内容');
    // The row does not open; its one button explains the missing text.
    expect(html).not.toContain('aria-expanded');
    expect(html).toContain('data-hc-no-summary');
  });

  it('shows a failed tool with its reason, in the error color', () => {
    const html = timeline([
      step({
        id: 'tool-x',
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: 'x',
        status: 'error',
        summary: 'command: rm -rf x',
        resultPreview: '被权限策略拒绝',
      }),
    ]);
    expect(html).toContain('被权限策略拒绝');
    expect(html).toContain('text-error');
    expect(html).toContain('失败');
  });

  it('shows the wait for the model at once on a first wait', () => {
    const html = timeline([], { waiting: true, hasContent: false });
    expect(html).toContain('data-hc-model-wait');
    expect(html).toContain('正在思考…');
  });

  it('shows nothing for no steps and no wait', () => {
    expect(timeline([])).toBe('');
  });
});

describe('ModelWaitRow', () => {
  it('has decorative skeleton lines hidden from assistive tech', () => {
    const html = renderToStaticMarkup(
      <ModelWaitRow active since={Date.now()} />,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('animate-pulse');
  });

  it('is not shown when the wait is over', () => {
    expect(renderToStaticMarkup(<ModelWaitRow active={false} />)).toBe('');
  });

  it('stops promising words once the wait is long, and says why', () => {
    const quick = renderToStaticMarkup(
      <ModelWaitRow active since={Date.now() - 2000} />,
    );
    expect(quick).toContain('animate-pulse');
    expect(quick).not.toContain('data-hc-model-silent');

    const long = renderToStaticMarkup(
      <ModelWaitRow
        active
        since={Date.now() - (MODEL_WAIT_SKELETON_SECONDS + 1) * 1000}
      />,
    );
    expect(long).toContain('data-hc-model-silent');
    expect(long).toContain('不提供思考摘要');
    expect(long).not.toContain('animate-pulse');
    // The timer and the label stay.
    expect(long).toContain('正在思考…');
  });
});

describe('TracePanel', () => {
  const row = (id: string, toolUseId: string) => ({
    id,
    timestamp: 1,
    kind: 'tool' as const,
    title: '工具 Read',
    summary: 'same.ts',
    toolUseId,
  });

  it('counts two calls with the same input as two tools', () => {
    const html = renderToStaticMarkup(
      <TracePanel
        traceEvents={[row('a', 't1'), row('b', 't2')]}
        taskCount={0}
      />,
    );
    expect(html).toContain('已使用 2 个工具');
  });

  it('can start open, with its panel named for assistive tech', () => {
    const html = renderToStaticMarkup(
      <TracePanel
        traceEvents={[row('a', 't1')]}
        taskCount={0}
        defaultExpanded
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/aria-controls="[^"]+"/);
    expect(html).toContain('overscroll-contain');
  });
});

describe('describeRunPhase', () => {
  const base = {
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

  it('never settles for a bare "processing"', () => {
    expect(describeRunPhase(base, false)).toBe('正在思考');
    expect(describeRunPhase({ ...base, awaitingModel: true }, false)).toBe(
      '正在思考',
    );
    expect(describeRunPhase(undefined, false)).toBe('正在准备回复');
    expect(
      describeRunPhase(
        { ...base, activeHook: { hookName: 'h', hookEvent: 'e' } },
        false,
      ),
    ).toBe('正在执行 Hook');
    expect(describeRunPhase({ ...base, partialText: '答' }, false)).toBe(
      '正在回复',
    );
  });

  it('says it is waiting on a running sub-agent', () => {
    expect(
      describeRunPhase({ ...base, taskStates: { 'task-1': task } }, false),
    ).toBe('正在等待子 Agent');
  });
});

describe('ProcessPanel', () => {
  const streaming: StreamingState = {
    partialText: '内部的回复文字不能出现',
    thinkingText: '**不该出现的思考**\n\n细节',
    isThinking: false,
    activeTools: [],
    activeHook: null,
    systemStatus: null,
    recentEvents: [],
    traceEvents: [],
    taskStates: {},
    steps: [
      step({
        id: 'tool-a',
        kind: 'tool',
        toolName: 'Grep',
        toolUseId: 'a',
        summary: 'useVirtualizer',
      }),
      step({
        id: 'tool-b',
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: 'b',
        summary: 'npm test',
        status: 'running',
      }),
      step({
        id: 'task-1',
        kind: 'task',
        taskId: 'task-1',
        status: 'running',
      }),
    ],
    activeTools: [
      {
        toolName: 'Bash',
        toolUseId: 'b',
        startTime: 1,
        toolInputSummary: 'npm test',
      },
    ],
  };

  it('is one folded line with the phase, the latest tool, the sub-agents and the time', () => {
    expect(summarizeProcess(streaming, 47)).toEqual({
      headline: '正在运行命令 · 1 个子 Agent 运行中 · 47s',
      recent: '运行 npm test',
    });
    const html = renderToStaticMarkup(
      <ProcessPanel
        streaming={streaming}
        groupJid="web:test"
        runtimeJid="web:test"
        visibility="activity"
      />,
    );
    expect(html).toContain('处理过程');
    expect(html).toContain('正在运行命令 · 1 个子 Agent 运行中');
    expect(html).toContain('最近：运行 npm test');
  });

  it('is open while the turn runs: a workspace that shows its process is meant to be watched', () => {
    const html = renderToStaticMarkup(
      <ProcessPanel
        streaming={streaming}
        groupJid="web:test"
        runtimeJid="web:test"
        visibility="activity"
      />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-hc-step-timeline');
    expect(html).toContain('npm test');
  });

  it('shows the narration before a tool call only at the full level', () => {
    const noted: StreamingState = {
      ...streaming,
      steps: [
        step({
          id: 'note-0',
          kind: 'text',
          text: '先跑一遍测试。',
          commentary: true,
        }),
        ...(streaming.steps ?? []),
      ],
    };
    const html = (visibility: 'activity' | 'full') =>
      renderToStaticMarkup(
        <ProcessPanel
          streaming={noted}
          groupJid="web:test"
          runtimeJid="web:test"
          visibility={visibility}
        />,
      );
    expect(html('full')).toContain('先跑一遍测试。');
    expect(html('activity')).not.toContain('先跑一遍测试。');
  });

  it('does not call a shell command, a monitor or an MCP call a sub-agent', () => {
    // The SDK registers a long-running Bash command as a task of its own; the
    // phase already says "正在运行命令", so it must not also count as an agent.
    const runningTask = (id: string) =>
      step({ id: `task-${id}`, kind: 'task', taskId: id, status: 'running' });
    const nonAgents: Record<string, StreamingTaskRuntimeState> = {
      'sh-1': { ...task, id: 'sh-1', taskType: 'local_bash' },
      'mon-1': { ...task, id: 'mon-1', taskType: 'monitor' },
      'mcp-1': { ...task, id: 'mcp-1', taskType: 'mcp_task' },
    };
    const baseSteps = (streaming.steps ?? []).filter(
      (item) => item.kind !== 'task',
    );
    const onlyShell: StreamingState = {
      ...streaming,
      steps: [...baseSteps, ...Object.keys(nonAgents).map(runningTask)],
      taskStates: nonAgents,
    };
    expect(summarizeProcess(onlyShell, 12).headline).toBe('正在运行命令 · 12s');

    // A real sub-agent beside them is still counted, once.
    const withAgent: StreamingState = {
      ...onlyShell,
      steps: [...(onlyShell.steps ?? []), runningTask('task-1')],
      taskStates: {
        ...nonAgents,
        'task-1': { ...task, taskType: 'local_agent' },
      },
    };
    expect(summarizeProcess(withAgent, 12).headline).toBe(
      '正在运行命令 · 1 个子 Agent 运行中 · 12s',
    );
  });

  it('never shows the reply text or the reasoning text of the state it is given', () => {
    for (const visibility of ['activity', 'full'] as const) {
      const html = renderToStaticMarkup(
        <ProcessPanel
          streaming={streaming}
          groupJid="web:test"
          runtimeJid="web:test"
          visibility={visibility}
        />,
      );
      expect(html).not.toContain('内部的回复文字不能出现');
      expect(html).not.toContain('不该出现的思考');
    }
  });

  it('says it is waiting on a run that has not started anything yet', () => {
    expect(
      summarizeProcess(
        { ...streaming, steps: [], activeTools: [], awaitingModel: true },
        null,
      ),
    ).toEqual({ headline: '正在思考', recent: undefined });
  });

  it('keeps a long command short so the count and the time stay in view', () => {
    const long = {
      ...streaming,
      steps: [
        step({
          id: 'tool-x',
          kind: 'tool',
          toolName: 'Bash',
          toolUseId: 'x',
          summary: `npx vitest run ${'tests/frontend-session-sidebar-copy.test.ts '.repeat(3)}`,
          status: 'running',
        }),
      ],
    };
    const { recent } = summarizeProcess(long, 3);
    expect(recent!.length).toBeLessThan(48);
    expect(recent!.endsWith('…')).toBe(true);
  });
});

describe('ProcessVisibilitySelector', () => {
  it('offers the three levels and says what it does not change', () => {
    const html = renderToStaticMarkup(
      <ProcessVisibilitySelector
        value="activity"
        onChange={() => undefined}
        name="visibility"
      />,
    );
    for (const label of ['隐藏', '仅活动', '活动 + 思考 + 过程说明']) {
      expect(html).toContain(label);
    }
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(
      /value="activity"[^>]*checked|checked[^>]*value="activity"/,
    );
    expect(html).toContain('不重启运行时');
    expect(html).toContain('不影响飞书等渠道');
  });
});
