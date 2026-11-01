import { describe, expect, test } from 'vitest';

import type {
  StreamEvent,
  StreamEventType,
} from '../src/stream-event.types.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';
import {
  projectProgressForWeb,
  projectSdkStreamEventForWeb,
} from '../src/workspace-interaction-runtime.js';

const LEVELS: ProcessVisibility[] = ['hidden', 'activity', 'full'];

function event(
  eventType: StreamEventType | 'future_event',
  extra: Partial<StreamEvent> = {},
): StreamEvent {
  return { eventType, ...extra } as StreamEvent;
}

const proactive = (level: ProcessVisibility, e: StreamEvent) =>
  projectSdkStreamEventForWeb('proactive', level, e);

/** Which levels let an event through unchanged in shape: [hidden, activity, full]. */
const PASSES: Array<[StreamEvent, [boolean, boolean, boolean]]> = [
  // The run lifecycle is what the spinner needs; it is always there.
  [event('status', { statusText: 'requesting' }), [true, true, true]],
  [event('status', { statusText: 'idle' }), [true, true, true]],
  [event('status', { statusText: 'interrupted' }), [true, true, true]],
  // Phase statuses written by the SDK, the Runner or the host.
  [event('status', { statusText: 'compacting' }), [false, true, true]],
  [event('status', { statusText: '正在深入分析…' }), [false, true, true]],
  [event('status', { statusText: null }), [false, true, true]],
  // The structure of the work.
  [event('tool_use_start', { toolName: 'Bash' }), [false, true, true]],
  [event('tool_use_end', { toolUseId: 't1' }), [false, true, true]],
  [event('tool_progress', { toolUseId: 't1' }), [false, true, true]],
  [event('tool_result', { toolUseId: 't1' }), [false, true, true]],
  [event('task_start', { taskId: 'k1' }), [false, true, true]],
  [event('task_progress', { taskId: 'k1' }), [false, true, true]],
  [event('task_updated', { taskId: 'k1' }), [false, true, true]],
  [event('task_notification', { taskId: 'k1' }), [false, true, true]],
  [event('todo_update', { todos: [] }), [false, true, true]],
  [event('hook_started'), [false, true, true]],
  [event('hook_progress'), [false, true, true]],
  [event('hook_response'), [false, true, true]],
  [event('permission_denied'), [false, true, true]],
  [event('compact_boundary'), [false, true, true]],
  // That the model is reasoning, without a word of it.
  [event('thinking_start'), [false, true, true]],
  [event('thinking_end', { thinkingDurationMs: 900 }), [false, true, true]],
  // The reasoning summary itself, main Agent or sub-Agent.
  [event('thinking_delta', { text: '先看' }), [false, false, true]],
  [
    event('thinking_delta', { text: '子', parentToolUseId: 'k1' }),
    [false, false, true],
  ],
  // What the model said before a tool call, composed by the host.
  [event('commentary', { text: '先看一下记忆' }), [false, false, true]],
  // Never, at any level.
  [event('text_delta', { text: '答' }), [false, false, false]],
  [
    event('text_delta', { text: '子答', parentToolUseId: 'k1' }),
    [false, false, false],
  ],
  [event('usage'), [false, false, false]],
  [event('memory_recall'), [false, false, false]],
  [event('prompt_suggestion'), [false, false, false]],
  [
    event('raw_sdk_event', { rawType: 'stream_event/message_stop' }),
    [false, false, false],
  ],
  [event('notification'), [false, false, false]],
  [event('init'), [false, false, false]],
  [event('future_event'), [false, false, false]],
];

describe('process visibility projection for the Web', () => {
  test.each(PASSES)('proactive %j', (e, expected) => {
    LEVELS.forEach((level, index) => {
      const projected = proactive(level, e);
      expect(projected !== null, `${e.eventType} at ${level}`).toBe(
        expected[index],
      );
      if (projected) expect(projected.eventType).toBe(e.eventType);
    });
  });

  test('assistant workspaces show everything, unchanged, at any level', () => {
    for (const [e] of PASSES) {
      for (const level of LEVELS) {
        expect(projectSdkStreamEventForWeb('assistant', level, e)).toBe(e);
      }
    }
  });

  test('context_audit always reaches the recorder, which never forwards it', () => {
    const audit = event('context_audit');
    for (const level of LEVELS) {
      expect(proactive(level, audit)).toBe(audit);
      expect(projectSdkStreamEventForWeb('assistant', level, audit)).toBe(
        audit,
      );
    }
  });

  test('a tool result keeps its identity but loses what the tool returned', () => {
    const result = event('tool_result', {
      toolUseId: 't1',
      toolResult: 'secret output',
      detail: 'secret output',
      parentToolUseId: 'k1',
    });
    for (const level of ['activity', 'full'] as const) {
      const projected = proactive(level, result)!;
      expect(projected).toMatchObject({
        eventType: 'tool_result',
        toolUseId: 't1',
        parentToolUseId: 'k1',
      });
      expect(projected.toolResult).toBeUndefined();
      expect(projected.detail).toBeUndefined();
    }
    // The input event is not mutated: the host still feeds it to the trace.
    expect(result.toolResult).toBe('secret output');
  });

  test('a proactive tool result keeps its failure flag but not the numbers read from its output', () => {
    const result = event('tool_result', {
      toolUseId: 't1',
      toolResult: '⚠️ Exit code 3',
      detail: '⚠️ Exit code 3',
      toolIsError: true,
      toolResultFacts: {
        exitCode: 3,
        added: 4,
        files: 2,
        agent: { tokens: 9 },
      },
    });
    for (const level of ['activity', 'full'] as const) {
      const projected = proactive(level, result)!;
      expect(projected.toolIsError).toBe(true);
      expect(projected.toolResultFacts).toBeUndefined();
      expect(projected).not.toHaveProperty('toolResultFacts');
    }
    // A failure that printed nothing still reads as one.
    const silent = event('tool_result', { toolUseId: 't1', toolIsError: true });
    expect(proactive('activity', silent)).toBe(silent);
    // The input event is not mutated: the host still feeds it to the trace.
    expect(result.toolResultFacts).toEqual({
      exitCode: 3,
      added: 4,
      files: 2,
      agent: { tokens: 9 },
    });
    // An assistant Workspace shows its whole process, facts included.
    for (const level of LEVELS) {
      expect(projectSdkStreamEventForWeb('assistant', level, result)).toBe(
        result,
      );
    }
    // Hidden shows no tool at all.
    expect(proactive('hidden', result)).toBeNull();
  });

  test('the words a tool, a sub-agent or a workflow carries are stripped', () => {
    const progress = event('tool_progress', {
      toolUseId: 't1',
      toolInput: { questions: [{ question: '选哪个?' }] },
      toolInputSummary: 'command: ls',
    });
    expect(proactive('full', progress)).toMatchObject({
      toolInputSummary: 'command: ls',
    });
    expect(proactive('full', progress)!.toolInput).toBeUndefined();

    const started = event('task_start', {
      taskId: 'k1',
      taskDescription: '审查代码',
      detail: '你是一个代码审查员，请逐行检查……',
    });
    expect(proactive('activity', started)).toMatchObject({
      taskDescription: '审查代码',
    });
    expect(proactive('activity', started)!.detail).toBeUndefined();

    const done = event('task_notification', {
      taskId: 'k1',
      taskSummary: '完成',
      taskResult: '子 Agent 的最终回答',
    });
    expect(proactive('full', done)).toMatchObject({ taskSummary: '完成' });
    expect(proactive('full', done)!.taskResult).toBeUndefined();

    const workflow = event('task_progress', {
      taskId: 'k1',
      workflowRun: {
        taskId: 'k1',
        summary: 'wf',
        status: 'running',
        phases: [],
        agents: [
          {
            index: 0,
            label: 'reviewer',
            state: 'running',
            lastToolSummary: 'Read a.ts',
            promptPreview: '请审查……',
            resultPreview: '结论……',
          },
        ],
      },
    });
    const projected = proactive('activity', workflow)!;
    expect(projected.workflowRun?.agents[0]).toEqual({
      index: 0,
      label: 'reviewer',
      state: 'running',
      lastToolSummary: 'Read a.ts',
    });
    expect(workflow.workflowRun?.agents[0].promptPreview).toBe('请审查……');
  });

  test('a message the Agent sends is not repeated as a process row', () => {
    // send_message's whole input is the reply the user already gets as a chat
    // message; its summary would show it a second time, as raw JSON, in the
    // process, and `activity` promises no text the model wrote.
    const sentence = '{"text":"这是发给用户的回复","delivery_role":"final"}';
    const start = event('tool_use_start', {
      toolName: 'mcp__happyclaw__send_message',
      toolUseId: 't9',
      toolInputSummary: sentence,
    });
    const progress = event('tool_progress', {
      toolName: 'mcp__happyclaw__send_message',
      toolUseId: 't9',
      toolInputSummary: sentence,
      summary: sentence,
    });
    for (const level of ['activity', 'full'] as const) {
      for (const sent of [start, progress]) {
        const projected = proactive(level, sent)!;
        expect(projected.toolName).toBe('mcp__happyclaw__send_message');
        expect(projected.toolUseId).toBe('t9');
        expect(projected.toolInputSummary).toBeUndefined();
        expect(projected.summary).toBeUndefined();
        expect(JSON.stringify(projected)).not.toContain('发给用户');
      }
    }
    // Other tools keep their summary: it is the structure of the work.
    const bash = event('tool_progress', {
      toolName: 'Bash',
      toolInputSummary: 'command: ls',
    });
    expect(proactive('activity', bash)).toBe(bash);
    // Assistant workspaces are untouched.
    expect(projectSdkStreamEventForWeb('assistant', 'full', start)).toBe(start);
  });

  test('events without model text pass as the very same object', () => {
    const start = event('tool_use_start', {
      toolName: 'Read',
      toolUseId: 't1',
    });
    expect(proactive('activity', start)).toBe(start);
    const lifecycle = event('status', { statusText: 'idle' });
    expect(proactive('hidden', lifecycle)).toBe(lifecycle);
  });
});

describe('progress statements written by the Agent', () => {
  // The Agent's send_message(delivery_role=progress), staged on a Web turn,
  // reaches the Web through projectProgressForWeb, the function both onProgress
  // handlers call. Only the host writes one: a Runner event claiming to be a
  // progress statement is narration.
  const SENTENCE = '正在核对 /etc/secret-looking-path 下的配置';
  const progress = (mode: InteractionMode, text = SENTENCE, turnId?: string) =>
    projectProgressForWeb(mode, text, {
      inputTurnId: 'input-1',
      turnId,
      sessionId: 'session-1',
    });

  test('an assistant workspace shows it as a step and as the status line, unchanged', () => {
    // Its events keep the input's id, whatever the Runner's turn is called.
    expect(progress('assistant', SENTENCE, 'runner-turn').web).toEqual([
      {
        eventType: 'commentary',
        agentScope: 'main',
        text: SENTENCE,
        turnId: 'input-1',
        inputTurnId: 'input-1',
        sessionId: 'session-1',
      },
      {
        eventType: 'status',
        agentScope: 'system',
        statusText: SENTENCE,
        summary: SENTENCE,
        isSynthetic: true,
        displayLevel: 'primary',
        turnId: 'input-1',
        inputTurnId: 'input-1',
        sessionId: 'session-1',
      },
    ]);
  });

  test('a proactive workspace shows it as a progress step, on the card of its Runner turn', () => {
    const { step, web } = progress('proactive', SENTENCE, 'runner-turn');
    expect(step).toEqual({
      eventType: 'commentary',
      agentScope: 'main',
      text: SENTENCE,
      turnId: 'runner-turn',
      inputTurnId: 'input-1',
      sessionId: 'session-1',
      progress: true,
    });
    expect(web).toEqual([step]);
    // Before the Runner has said anything, the input's own id.
    expect(progress('proactive').step.turnId).toBe('input-1');
  });

  test('the step and the status line are bounded', () => {
    const long = '长'.repeat(5000);
    const assistant = progress('assistant', long);
    expect(assistant.step.text).toHaveLength(4000);
    expect(assistant.web[1].statusText).toHaveLength(160);
    expect(assistant.web[1].summary).toHaveLength(500);
    expect(progress('proactive', long).step.text).toHaveLength(4000);
  });

  test('narration is still shown only at full', () => {
    const narration = event('commentary', { text: SENTENCE });
    expect(proactive('hidden', narration)).toBeNull();
    expect(proactive('activity', narration)).toBeNull();
    expect(proactive('full', narration)).toBe(narration);
  });

  test('a Runner event that claims to be a progress statement is narration', () => {
    const claimed = event('commentary', { text: SENTENCE, progress: true });
    expect(proactive('hidden', claimed)).toBeNull();
    expect(proactive('activity', claimed)).toBeNull();
    const shown = proactive('full', claimed)!;
    expect(shown.text).toBe(SENTENCE);
    expect(shown.progress).toBeUndefined();
  });

  test('preserves workspace memory write receipts in tool_result while stripping detail', () => {
    const receipt = '{"result":"remembered","id":"wmi_1","title":"用户偏好"}';
    const result = event('tool_result', {
      toolUseId: 't-mem',
      toolName: 'mcp__happyclaw__workspace_memory_remember',
      toolResult: receipt,
      detail: receipt,
      toolIsError: false,
    });
    for (const level of ['activity', 'full'] as const) {
      const projected = proactive(level, result)!;
      expect(projected.toolResult).toBe(receipt);
      expect(projected.detail).toBeUndefined();
    }
  });

  test('keeps a receipt that names only its call, when that call was a memory write', () => {
    // The main Agent's tool_result carries the call id, not the tool name.
    const receipt = '{"result":"proposed","id":"wmi_2","title":"项目约定"}';
    for (const level of ['activity', 'full'] as const) {
      const id = `t-mem-${level}`;
      proactive(
        level,
        event('tool_use_start', {
          toolUseId: id,
          toolName: 'mcp__happyclaw__workspace_memory_remember',
        }),
      );
      const projected = proactive(
        level,
        event('tool_result', { toolUseId: id, toolResult: receipt }),
      )!;
      expect(projected.toolResult).toBe(receipt);
    }
  });

  test('withholds what any other tool returned, even shaped like a receipt', () => {
    // A command can print anything; looking like a receipt is no reason to
    // show the output of a tool at the activity level.
    const forged = '{"result":"remembered","id":"wmi_x","title":"偷看"}';
    for (const level of ['activity', 'full'] as const) {
      const id = `t-bash-${level}`;
      proactive(
        level,
        event('tool_use_start', { toolUseId: id, toolName: 'Bash' }),
      );
      const projected = proactive(
        level,
        event('tool_result', { toolUseId: id, toolResult: forged }),
      )!;
      expect(projected.toolResult).toBeUndefined();
      // A result whose call was never seen starting is withheld too.
      expect(
        proactive(
          level,
          event('tool_result', {
            toolUseId: `unseen-${level}`,
            toolResult: forged,
          }),
        )!.toolResult,
      ).toBeUndefined();
    }
  });
});
