import { describe, expect, it } from 'vitest';
import {
  MAX_STEPS,
  addCommentaryStep,
  answerStart,
  appendThinkingText,
  closeOpenSteps,
  closeTextStep,
  closeThinkingStep,
  endToolStep,
  ensureTaskStep,
  failToolStep,
  finishSteps,
  openTextStep,
  openThinkingStep,
  patchToolStep,
  progressToolStep,
  QUESTION_DEFERRED_MARK,
  railSteps,
  readStepQuestions,
  rebuildSteps,
  setTaskStepStatus,
  startToolStep,
  stepList,
  summarizeSteps,
  type StepList,
} from '../src/lib/stream-steps';

const empty = (): StepList => stepList(undefined, undefined);

describe('thinking steps', () => {
  it('keeps one running thinking step and grows its text', () => {
    let list = openThinkingStep(empty(), 100);
    list = openThinkingStep(list, 150);
    expect(list.steps).toHaveLength(1);
    list = appendThinkingText(list, '**读取文件**\n\n先看一下', 200);
    list = appendThinkingText(list, '入口。', 210);
    expect(list.steps[0].text).toBe('**读取文件**\n\n先看一下入口。');
    expect(list.steps[0].title).toBe('读取文件');
    expect(list.steps[0].status).toBe('running');
  });

  it('lasts as long as the clock says, or as the model reports if that is longer', () => {
    const open = appendThinkingText(empty(), '想。', 1000);
    expect(closeThinkingStep(open, 4000).steps[0].durationMs).toBe(3000);
    // The step starts with the request, so a shorter own timing does not shrink it.
    expect(closeThinkingStep(open, 4000, 2500).steps[0].durationMs).toBe(3000);
    expect(closeThinkingStep(open, 4000, 3500).steps[0].durationMs).toBe(3500);
    expect(closeThinkingStep(open, 4000).steps[0].status).toBe('done');
  });

  it('opens a new step for the next burst', () => {
    let list = closeThinkingStep(appendThinkingText(empty(), '一。', 0), 10);
    list = startToolStep(list, { toolUseId: 't1', toolName: 'Read' }, 20);
    list = appendThinkingText(list, '二。', 30);
    expect(list.steps.map((step) => step.kind)).toEqual([
      'thinking',
      'tool',
      'thinking',
    ]);
  });

  it('bounds the text of one step and says so', () => {
    const list = appendThinkingText(empty(), '段落。\n\n'.repeat(5000), 0);
    expect(list.steps[0].text!.length).toBeLessThanOrEqual(6000);
    expect(list.steps[0].text!.startsWith('*（已省略较早的思考）*')).toBe(true);
  });

  it('has an empty thinking step for a silent burst', () => {
    const list = closeThinkingStep(openThinkingStep(empty(), 0), 5000, 4800);
    expect(list.steps[0]).toMatchObject({
      kind: 'thinking',
      text: '',
      durationMs: 5000,
      status: 'done',
    });
  });

  it('counts the whole wait of a burst that arrives at once, after silent reasoning', () => {
    // Opened at the request (t=0); the model's reasoning came back whole at
    // t=13s with a timing of a few milliseconds.
    const list = closeThinkingStep(openThinkingStep(empty(), 0), 13_000, 3);
    expect(list.steps[0].durationMs).toBe(13_000);
  });
});

describe('tool steps', () => {
  it('previews the start of a long result, not its end', () => {
    const output = `${'HEAD '.repeat(10)}${'x'.repeat(600)}TAIL`;
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Bash' }, 0);
    list = endToolStep(list, 't1', 5, output);
    const preview = list.steps[0].resultPreview ?? '';
    expect(preview.startsWith('HEAD HEAD HEAD')).toBe(true);
    expect(preview).not.toContain('TAIL');
    expect(preview.length).toBeLessThanOrEqual(400);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('trusts the SDK is_error over the text, even for an empty failure', () => {
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Bash' }, 0);
    list = startToolStep(list, { toolUseId: 't2', toolName: 'Bash' }, 1);
    list = startToolStep(list, { toolUseId: 't3', toolName: 'Bash' }, 2);
    // no text at all, but the SDK says it failed
    list = endToolStep(list, 't1', 5, undefined, { isError: true });
    // the legacy prefix still marks a failure when the SDK sent no flag
    list = endToolStep(list, 't2', 6, '⚠️ boom');
    // text that happens to start with the prefix is not a failure if the SDK says so
    list = endToolStep(list, 't3', 7, '⚠️ just output', { isError: false });
    expect(list.steps.map((step) => step.status)).toEqual([
      'error',
      'error',
      'done',
    ]);
    expect(list.steps[1].resultPreview).toBe('boom');
    // a successful result keeps its text, emoji included
    expect(list.steps[2].resultPreview).toBe('⚠️ just output');
  });

  it('keeps what the tool did as facts', () => {
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Edit' }, 0);
    list = endToolStep(list, 't1', 5, 'edited', {
      facts: { added: 12, removed: 3 },
    });
    expect(list.steps[0].resultFacts).toEqual({ added: 12, removed: 3 });
    // a later end without facts does not erase them
    list = endToolStep(list, 't1', 6, 'edited');
    expect(list.steps[0].resultFacts).toEqual({ added: 12, removed: 3 });
  });

  it('keeps a sub-agent call running but records what it reported', () => {
    let list = ensureTaskStep(
      empty(),
      { taskId: 'k1', toolUseId: 'k1', title: '读文件' },
      0,
    );
    list = endToolStep(list, 'k1', 9, 'done', {
      facts: { agent: { toolUses: 4, tokens: 1200 } },
    });
    expect(list.steps[0]).toMatchObject({
      kind: 'task',
      status: 'running',
      resultFacts: { agent: { toolUses: 4, tokens: 1200 } },
    });
    expect(list.steps[0].endedAt).toBeUndefined();
  });

  it('runs, then finishes with what it returned', () => {
    let list = startToolStep(
      empty(),
      { toolUseId: 't1', toolName: 'Bash', summary: 'ls' },
      100,
    );
    list = patchToolStep(list, 't1', { summary: 'ls -la' });
    list = endToolStep(list, 't1', 400, 'total 8\ndrwx');
    expect(list.steps[0]).toMatchObject({
      kind: 'tool',
      status: 'done',
      endedAt: 400,
      summary: 'ls -la',
      resultPreview: 'total 8\ndrwx',
    });
  });

  it('marks a failed result as an error without its warning prefix', () => {
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Bash' }, 0);
    list = endToolStep(list, 't1', 50, '⚠️ command not found');
    expect(list.steps[0].status).toBe('error');
    expect(list.steps[0].resultPreview).toBe('command not found');
  });

  it('keeps an error through a later plain end', () => {
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Bash' }, 0);
    list = endToolStep(list, 't1', 50, '⚠️ boom');
    list = endToolStep(list, 't1', 60);
    expect(list.steps[0].status).toBe('error');
  });

  it('does not duplicate a tool that starts twice', () => {
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Read' }, 0);
    list = startToolStep(
      list,
      { toolUseId: 't1', toolName: 'Read', summary: 'a.ts' },
      5,
    );
    expect(list.steps).toHaveLength(1);
    expect(list.steps[0].summary).toBe('a.ts');
  });

  it('marks the denied call', () => {
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Bash' }, 0);
    list = failToolStep(list, 't1', 9, '被权限策略拒绝');
    expect(list.steps[0]).toMatchObject({
      status: 'error',
      resultPreview: '被权限策略拒绝',
      outcome: 'denied',
    });
  });

  it('ignores an unknown tool id', () => {
    const list = startToolStep(
      empty(),
      { toolUseId: 't1', toolName: 'Read' },
      0,
    );
    expect(endToolStep(list, 'other', 5)).toBe(list);
    expect(patchToolStep(list, 'other', { summary: 'x' })).toBe(list);
  });
});

describe('sub-agent steps', () => {
  it('turns a Task tool into a task step that ends on its own lifecycle', () => {
    let list = startToolStep(
      empty(),
      { toolUseId: 'task-1', toolName: 'Task', summary: '检查滚动' },
      0,
    );
    expect(list.steps[0]).toMatchObject({ kind: 'task', taskId: 'task-1' });
    list = endToolStep(list, 'task-1', 100);
    expect(list.steps[0].status).toBe('running');
    list = setTaskStepStatus(list, 'task-1', 'done', 200, '已完成检查');
    expect(list.steps[0]).toMatchObject({
      status: 'done',
      endedAt: 200,
      summary: '已完成检查',
    });
  });

  it('shares one step between the tool, task_start and progress', () => {
    let list = startToolStep(
      empty(),
      { toolUseId: 'task-1', toolName: 'Agent' },
      0,
    );
    list = ensureTaskStep(
      list,
      { taskId: 'task-1', title: '检查', summary: '读到第 3 个文件' },
      5,
    );
    expect(list.steps).toHaveLength(1);
    expect(list.steps[0]).toMatchObject({
      title: '检查',
      summary: '读到第 3 个文件',
    });
  });

  it('adds a workflow that has no tool call of its own', () => {
    const list = ensureTaskStep(empty(), { taskId: 'wf-1', title: '审查' }, 0);
    expect(list.steps[0]).toMatchObject({ kind: 'task', taskId: 'wf-1' });
  });

  it('keeps why a stop ended a sub-agent, until it runs or finishes again', () => {
    let list = ensureTaskStep(empty(), { taskId: 'task-1' }, 0);
    list = setTaskStepStatus(list, 'task-1', 'error', 50, undefined, 'stopped');
    expect(list.steps[0]).toMatchObject({
      status: 'error',
      endedAt: 50,
      outcome: 'stopped',
    });
    // A failure that reports no outcome of its own leaves the stop's.
    list = setTaskStepStatus(list, 'task-1', 'error', 60);
    expect(list.steps[0].outcome).toBe('stopped');
    list = setTaskStepStatus(list, 'task-1', 'running', 70);
    expect(list.steps[0]).not.toHaveProperty('outcome');
    list = setTaskStepStatus(list, 'task-1', 'error', 80, undefined, 'stopped');
    list = setTaskStepStatus(list, 'task-1', 'done', 90);
    expect(list.steps[0].status).toBe('done');
    expect(list.steps[0]).not.toHaveProperty('outcome');
  });

  it('marks a failed Task tool result as an error', () => {
    let list = startToolStep(
      empty(),
      { toolUseId: 'task-1', toolName: 'Task' },
      0,
    );
    list = endToolStep(list, 'task-1', 9, '⚠️ aborted');
    expect(list.steps[0].status).toBe('error');
  });
});

describe('text steps', () => {
  it('is the answer when nothing runs after it', () => {
    let list = openTextStep(empty(), 0, 0);
    list = openTextStep(list, 5, 10);
    expect(list.steps).toHaveLength(1);
    expect(answerStart(list.steps, 0)).toBe(0);
    expect(railSteps(list.steps)).toEqual([]);
  });

  it('becomes commentary once a tool starts after it', () => {
    const text = '我先看一下文件。';
    let list = openTextStep(empty(), 0, 0);
    list = closeOpenSteps(list, 10, text, 0);
    list = startToolStep(list, { toolUseId: 't1', toolName: 'Read' }, 11);
    expect(list.steps[0]).toMatchObject({ kind: 'text', text, status: 'done' });
    expect(answerStart(list.steps, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(railSteps(list.steps).map((step) => step.kind)).toEqual([
      'text',
      'tool',
    ]);
  });

  it('puts the answer after the last tool', () => {
    const first = '我先看一下。';
    const second = '结论如下。';
    let list = openTextStep(empty(), 0, 0);
    list = closeOpenSteps(list, 10, first, 0);
    list = startToolStep(list, { toolUseId: 't1', toolName: 'Read' }, 11);
    list = endToolStep(list, 't1', 20);
    list = openTextStep(list, 30, first.length);
    expect(answerStart(list.steps, 0)).toBe(first.length);
    expect((first + second).slice(first.length)).toBe(second);
  });

  it('keeps offsets right after the head of the text was cut', () => {
    let list = openTextStep(empty(), 0, 500);
    expect(answerStart(list.steps, 400)).toBe(100);
    expect(answerStart(list.steps, 900)).toBe(0);
    list = closeTextStep(list, 1, 'x'.repeat(50), 480);
    expect(list.steps[0].text).toBe('x'.repeat(30));
  });

  it('closes every running text step, each with its own part of the text', () => {
    const first = '先说明第一件事。';
    const second = '再说明第二件事。';
    // Text, a reasoning burst, then text again before the tool: the first
    // text step is still running when the second opens.
    let list = openTextStep(empty(), 0, 0);
    list = openThinkingStep(list, 5);
    list = closeThinkingStep(list, 8);
    list = openTextStep(list, 9, first.length);
    expect(list.steps.filter((step) => step.kind === 'text')).toHaveLength(2);

    list = closeOpenSteps(list, 20, first + second, 0);
    list = startToolStep(list, { toolUseId: 't1', toolName: 'Bash' }, 21);
    list = endToolStep(list, 't1', 30);
    list = startToolStep(list, { toolUseId: 't2', toolName: 'Bash' }, 31);

    const texts = list.steps
      .filter((step) => step.kind === 'text')
      .map((step) => [step.status, step.text]);
    expect(texts).toEqual([
      ['done', first],
      ['done', second],
    ]);
  });

  it('has no answer start without steps', () => {
    expect(answerStart(undefined, 0)).toBeUndefined();
    expect(answerStart([], 0)).toBeUndefined();
  });
});

describe('narration handed over whole (a proactive workspace)', () => {
  it('is a finished commentary step that closes the reasoning before it', () => {
    let list = openThinkingStep(empty(), 0);
    list = addCommentaryStep(list, 5, '  先看一下记忆。\n');
    expect(list.steps.map((step) => step.kind)).toEqual(['thinking', 'text']);
    expect(list.steps[0].status).toBe('done');
    expect(list.steps[1]).toMatchObject({
      status: 'done',
      text: '先看一下记忆。',
      commentary: true,
      at: 5,
      endedAt: 5,
    });
  });

  it('is never the answer, even with no tool after it yet', () => {
    const list = addCommentaryStep(empty(), 0, '先看一下记忆。');
    expect(answerStart(list.steps, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(railSteps(list.steps).map((step) => step.kind)).toEqual(['text']);
    expect(summarizeSteps(list.steps).commentary).toBe(1);
  });

  it('leaves an answer that follows it as the answer', () => {
    let list = addCommentaryStep(empty(), 0, '先看一下。');
    list = openTextStep(list, 5, 0);
    expect(answerStart(list.steps, 0)).toBe(0);
    expect(railSteps(list.steps).map((step) => step.commentary)).toEqual([
      true,
    ]);
  });

  it('never gives two steps one id, even after narration was filtered out', () => {
    // Lowering the level drops the narration steps from the middle of the list.
    let list = openThinkingStep(empty(), 0);
    list = closeThinkingStep(list, 1);
    list = addCommentaryStep(list, 2, '先看一下。');
    list = startToolStep(list, { toolUseId: 't1', toolName: 'Read' }, 3);
    list = { ...list, steps: list.steps.filter((step) => !step.commentary) };
    list = closeThinkingStep(openThinkingStep(list, 4), 5);
    const ids = list.steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ignores blank text and keeps the end of a long passage', () => {
    expect(addCommentaryStep(empty(), 0, ' \n ').steps).toEqual([]);
    const long = addCommentaryStep(empty(), 0, `${'x'.repeat(3000)}END`);
    expect(long.steps[0].text!.length).toBe(2000);
    expect(long.steps[0].text!.endsWith('END')).toBe(true);
  });
});

describe('the end of a reply', () => {
  it('finishes whatever was running', () => {
    let list = startToolStep(empty(), { toolUseId: 't1', toolName: 'Read' }, 0);
    list = appendThinkingText(list, '想。', 1);
    const done = finishSteps(list, 50, false);
    expect(done.steps.every((step) => step.status === 'done')).toBe(true);
  });

  it('marks a tool that never returned after a stop', () => {
    const list = finishSteps(
      startToolStep(empty(), { toolUseId: 't1', toolName: 'Bash' }, 0),
      9,
      true,
    );
    expect(list.steps[0]).toMatchObject({
      status: 'error',
      resultPreview: '已停止',
      outcome: 'stopped',
    });
  });

  it('says a stop, not a failure, cut short a call that had output already', () => {
    const started = startToolStep(
      empty(),
      { toolUseId: 't1', toolName: 'Bash' },
      0,
    );
    const withOutput = {
      ...started,
      steps: [{ ...started.steps[0], resultPreview: 'half' }],
    };
    const list = finishSteps(withOutput, 9, true);
    expect(list.steps[0]).toMatchObject({
      status: 'error',
      resultPreview: 'half',
      outcome: 'stopped',
    });
    // A run that ends by itself closes what runs, with no outcome.
    expect(finishSteps(started, 9, false).steps[0].outcome).toBeUndefined();
  });

  it('returns the same list when nothing runs', () => {
    const list = closeThinkingStep(openThinkingStep(empty(), 0), 5);
    expect(finishSteps(list, 9, false)).toBe(list);
  });
});

describe('the cap', () => {
  it('drops the oldest finished steps first', () => {
    let list = startToolStep(
      empty(),
      { toolUseId: 'keep', toolName: 'Bash' },
      0,
    );
    for (let i = 0; i < MAX_STEPS + 20; i += 1) {
      list = startToolStep(
        list,
        { toolUseId: `t${i}`, toolName: 'Read' },
        i + 1,
      );
      list = endToolStep(list, `t${i}`, i + 2);
    }
    expect(list.steps).toHaveLength(MAX_STEPS);
    expect(list.dropped).toBe(21);
    // The long-running first tool is not dropped for being the oldest.
    expect(list.steps[0].toolUseId).toBe('keep');
  });
});

describe('the timeline view', () => {
  const tools = (count: number): StepList => {
    let list = empty();
    for (let i = 0; i < count; i += 1) {
      list = startToolStep(list, { toolUseId: `t${i}`, toolName: 'Read' }, i);
      list = endToolStep(list, `t${i}`, i + 1);
    }
    return list;
  };

  it('summarizes what was folded', () => {
    let list = tools(2);
    list = appendThinkingText(list, '想。', 5);
    list = ensureTaskStep(list, { taskId: 'k' }, 6);
    list = endToolStep(
      startToolStep(list, { toolUseId: 'bad', toolName: 'Bash' }, 7),
      'bad',
      8,
      '⚠️ no',
    );
    expect(summarizeSteps(list.steps)).toEqual({
      tools: 3,
      tasks: 1,
      thinking: 1,
      commentary: 0,
      failed: 1,
    });
  });
});

describe('rebuilding after a reconnect', () => {
  it('orders reasoning, tools, sub-agents, then the text', () => {
    const list = rebuildSteps({
      thinkingText: '**计划**\n\n先读。',
      thinkingDurationMs: 4000,
      isThinking: false,
      partialText: '正在回答',
      activeTools: [
        {
          toolName: 'Bash',
          toolUseId: 't2',
          startTime: 300,
          toolInputSummary: 'ls',
        },
      ],
      tasks: [{ id: 'task-1', status: 'running', title: '检查' }],
      tracedTools: [
        { toolUseId: 't1', timestamp: 100, toolName: 'Read', summary: 'a.ts' },
        { toolUseId: 't2', timestamp: 300, toolName: 'Bash', summary: 'ls' },
        { toolUseId: 'task-1', timestamp: 200, toolName: 'Task' },
      ],
      now: 1000,
    });
    expect(list.steps.map((step) => step.kind)).toEqual([
      'thinking',
      'tool',
      'tool',
      'task',
      'text',
    ]);
    expect(list.steps[1].status).toBe('done');
    expect(list.steps[2].status).toBe('running');
    expect(list.steps[0].title).toBe('计划');
    expect(answerStart(list.steps, 0)).toBe(0);
  });

  it('keeps a stopped sub-agent stopped, not failed', () => {
    const list = rebuildSteps({
      thinkingText: '',
      isThinking: false,
      partialText: '',
      activeTools: [],
      tasks: [{ id: 'task-1', status: 'stopped', title: '检查' }],
      tracedTools: [],
      now: 1000,
    });
    expect(list.steps[0]).toMatchObject({
      kind: 'task',
      status: 'error',
      outcome: 'stopped',
    });
  });
});

describe('question steps', () => {
  const input = {
    questions: [
      {
        question: '午饭吃什么？',
        header: '午饭',
        multiSelect: false,
        options: [
          { label: '面条', description: '汤面' },
          { label: '米饭', description: '盖饭' },
        ],
      },
    ],
  };

  it('reads both input shapes and bounds what the model streamed', () => {
    expect(readStepQuestions(input)).toEqual([
      {
        question: '午饭吃什么？',
        options: ['面条', '米饭'],
        descriptions: ['汤面', '盖饭'],
      },
    ]);
    expect(
      readStepQuestions({
        question: '用哪个方案？',
        options: [{ value: '窄 selector' }, '宽 selector', { label: ' ' }],
      }),
    ).toEqual([
      { question: '用哪个方案？', options: ['窄 selector', '宽 selector'] },
    ]);
    const many = readStepQuestions({
      questions: Array.from({ length: 6 }, (_, i) => ({
        question: `问题 ${i}`,
        multiSelect: true,
        options: Array.from({ length: 12 }, (_, j) => `选项 ${j}`),
      })),
    });
    expect(many).toHaveLength(4);
    expect(many?.[0]).toMatchObject({ multiSelect: true });
    expect(many?.[0].options).toHaveLength(10);
    expect(readStepQuestions({ questions: [{ question: '  ' }] })).toBe(
      undefined,
    );
    expect(readStepQuestions(undefined)).toBe(undefined);
  });

  it('keeps what each option means, beside its label', () => {
    const asked = readStepQuestions({
      questions: [
        {
          question: '用哪个方案？',
          options: [
            { label: '窄 selector', description: '只改动这一处' },
            { label: ' ', description: '没有名字的选项连同说明一起丢掉' },
            { label: '宽 selector' },
            { label: '重写', description: 'x'.repeat(300) },
          ],
        },
      ],
    });
    expect(asked?.[0].options).toEqual(['窄 selector', '宽 selector', '重写']);
    expect(asked?.[0].descriptions?.slice(0, 2)).toEqual(['只改动这一处', '']);
    expect(Array.from(asked?.[0].descriptions?.[2] ?? '')).toHaveLength(200);
    // Without any description there is no field at all.
    expect(
      readStepQuestions({ question: '午饭？', options: [{ label: '面条' }] }),
    ).toEqual([{ question: '午饭？', options: ['面条'] }]);
  });

  it('reads stored questions again, with or without descriptions', () => {
    // A trace stored before descriptions were kept.
    expect(
      readStepQuestions({
        questions: [{ question: '午饭？', options: ['面条', '米饭'] }],
      }),
    ).toEqual([{ question: '午饭？', options: ['面条', '米饭'] }]);
    // One stored with them: labels and descriptions stay paired.
    const stored = [
      {
        question: '午饭？',
        options: ['面条', ' ', '米饭'],
        descriptions: ['汤面', '空', ''],
      },
    ];
    expect(readStepQuestions({ questions: stored })).toEqual([
      {
        question: '午饭？',
        options: ['面条', '米饭'],
        descriptions: ['汤面', ''],
      },
    ]);
  });

  it('keeps the questions after the deferred call returns, which is no failure', () => {
    let list = startToolStep(
      empty(),
      { toolUseId: 'q', toolName: 'AskUserQuestion' },
      10,
    );
    list = progressToolStep(
      list,
      { toolUseId: 'q', questions: readStepQuestions(input) },
      20,
    );
    list = endToolStep(
      list,
      'q',
      30,
      `${QUESTION_DEFERRED_MARK} The answer is the next message.`,
      { isError: true },
    );
    expect(list.steps[0]).toMatchObject({
      status: 'done',
      endedAt: 30,
      questions: [{ question: '午饭吃什么？', options: ['面条', '米饭'] }],
    });
    expect(list.steps[0].resultPreview).toBeUndefined();
    expect(summarizeSteps(list.steps).failed).toBe(0);
  });

  it('drops the questions of a call refused for another reason', () => {
    let list = startToolStep(
      empty(),
      {
        toolUseId: 'q',
        toolName: 'AskUserQuestion',
        questions: readStepQuestions(input),
      },
      10,
    );
    list = endToolStep(list, 'q', 30, 'InputValidationError: too few options', {
      isError: true,
    });
    expect(list.steps[0]).toMatchObject({
      status: 'error',
      resultPreview: 'InputValidationError: too few options',
    });
    expect(list.steps[0].questions).toBeUndefined();
  });

  it('keeps questions only on an AskUserQuestion step', () => {
    const questions = readStepQuestions(input);
    let list = startToolStep(
      empty(),
      { toolUseId: 'b', toolName: 'Bash', questions },
      10,
    );
    list = patchToolStep(list, 'b', { questions });
    expect(list.steps[0].questions).toBeUndefined();
  });
});
