import { describe, expect, test, vi } from 'vitest';
import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';

function makeProcessor() {
  const outputs: ContainerOutput[] = [];
  const processor = new StreamEventProcessor(
    (output) => outputs.push(output),
    () => {},
  );
  return { processor, outputs };
}

describe('StreamEventProcessor observability mapping', () => {
  test('emits assistant message boundaries for host-side answer-lane classification', () => {
    const { processor, outputs } = makeProcessor();

    processor.processStreamEvent({
      type: 'stream_event',
      uuid: 'assistant-frame-1',
      session_id: 'session-1',
      event: {
        type: 'message_start',
        message: { id: 'api-message-1' },
      },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      uuid: 'assistant-frame-1',
      session_id: 'session-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'short buffered final' },
      },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      uuid: 'assistant-frame-1',
      session_id: 'session-1',
      event: { type: 'message_stop' },
    });

    const events = outputs.map((output) => output.streamEvent).filter(Boolean);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'raw_sdk_event',
          rawType: 'stream_event/message_start',
          messageUuid: 'assistant-frame-1',
          sessionId: 'session-1',
        }),
        expect.objectContaining({
          eventType: 'raw_sdk_event',
          rawType: 'stream_event/message_stop',
          messageUuid: 'assistant-frame-1',
          sessionId: 'session-1',
        }),
      ]),
    );
    expect(
      events.findIndex((event) => event?.eventType === 'text_delta'),
    ).toBeLessThan(
      events.findIndex(
        (event) => event?.rawType === 'stream_event/message_stop',
      ),
    );
  });

  test('coalesces thinking_tokens into a low-frequency semantic heartbeat', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    const { processor, outputs } = makeProcessor();

    processor.processSystemMessage({
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 10,
      estimated_tokens_delta: 10,
      uuid: 'thinking-1',
      session_id: 'session-1',
    });
    now.mockReturnValue(1_500);
    processor.processSystemMessage({
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 20,
      estimated_tokens_delta: 10,
      uuid: 'thinking-1',
      session_id: 'session-1',
    });
    now.mockReturnValue(3_100);
    processor.processSystemMessage({
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 30,
      estimated_tokens_delta: 10,
      uuid: 'thinking-1',
      session_id: 'session-1',
    });

    const heartbeats = outputs
      .map((output) => output.streamEvent)
      .filter((event) => event?.statusText === '正在深入分析…');
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]).toMatchObject({
      eventType: 'status',
      isSynthetic: true,
      agentScope: 'system',
    });
    expect(JSON.stringify(heartbeats)).not.toContain('estimated_tokens');
    now.mockRestore();
  });

  test('detached local bash does not block input receipt, while finite background Agent still does', () => {
    const { processor } = makeProcessor();

    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bash-1',
      description: 'npm run dev',
      task_type: 'local_bash',
    });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-1',
      description: 'review the code',
      task_type: 'local_agent',
    });
    expect(processor.getPendingSdkTaskCount()).toBe(2);
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(2);

    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bash-1',
      patch: { status: 'running', is_backgrounded: true },
    });
    expect(processor.getPendingSdkTaskCount()).toBe(2);
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);

    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-1',
      patch: { status: 'running', is_backgrounded: true },
    });
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);

    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-1',
      patch: { status: 'completed' },
    });
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(0);
  });

  test('merged background-completion placeholders settle their own debt but never complete the input', () => {
    const { processor } = makeProcessor();
    // Message order observed from Claude Code 2.1.280 when two background
    // Bash commands finish while the main reply is still being generated.
    for (const taskId of ['bash-a', 'bash-b']) {
      processor.processSystemMessage({
        type: 'system',
        subtype: 'task_started',
        task_id: taskId,
        description: taskId,
        task_type: 'local_bash',
      });
    }
    processor.processSystemMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bash-a' }, { task_id: 'bash-b' }],
    });
    for (const [taskId, remaining] of [
      ['bash-a', [{ task_id: 'bash-b' }]],
      ['bash-b', []],
    ] as const) {
      processor.processSystemMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: remaining,
      });
      processor.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: taskId,
        patch: { status: 'completed' },
      });
      processor.processSystemMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: taskId,
        status: 'completed',
        summary: `${taskId} done`,
      });
    }
    expect(processor.getBlockingBackgroundCompletionDebtCount()).toBe(2);

    // The CLI answers both queued notifications with one call: first an
    // empty num_turns=0 placeholder, then the shared reply. With a later user
    // turn already accepted, no activity is attributed to these debts, so each
    // task-notification Result must still settle one of them.
    processor.observeMergedCompletionPlaceholder();
    expect(processor.getBlockingBackgroundCompletionDebtCount()).toBe(1);
    expect(processor.canCompleteObservedBackgroundResult()).toBe(false);

    expect(processor.observeBackgroundResult('task-notification')).toBe(true);
    expect(processor.getBlockingBackgroundCompletionDebtCount()).toBe(0);

    // Even with no debt left, a placeholder is never a completion boundary:
    // the shared call that answers it has not run yet.
    processor.observeMergedCompletionPlaceholder();
    expect(processor.canCompleteObservedBackgroundResult()).toBe(false);
  });

  test('treats stopped and aborted task_updated as terminal SDK statuses', () => {
    const { processor } = makeProcessor();

    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'stopped-1',
      description: 'user stopped this task',
      task_type: 'local_agent',
    });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'aborted-1',
      description: 'user aborted this task',
      task_type: 'local_agent',
    });
    expect(processor.getPendingSdkTaskCount()).toBe(2);
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(2);

    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'stopped-1',
      patch: { status: 'stopped' },
    });
    expect(processor.getPendingSdkTaskCount()).toBe(1);
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(1);

    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'aborted-1',
      patch: { status: 'aborted' },
    });
    expect(processor.getPendingSdkTaskCount()).toBe(0);
    expect(processor.getBlockingPendingSdkTaskCount()).toBe(0);
  });

  test('maps SDK task_progress to structured task_progress event', () => {
    const { processor, outputs } = makeProcessor();

    expect(
      processor.processSystemMessage({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'sdk-task-1',
        tool_use_id: 'tool-task-1',
        description: 'Search the repo',
        summary: 'Found the streaming entrypoint',
        subagent_type: 'explorer',
        last_tool_name: 'Grep',
        usage: { total_tokens: 123, tool_uses: 2, duration_ms: 4567 },
      }),
    ).toBe(true);

    expect(outputs.at(-1)?.streamEvent).toMatchObject({
      eventType: 'task_progress',
      agentScope: 'task',
      taskId: 'tool-task-1',
      toolUseId: 'tool-task-1',
      taskDescription: 'Search the repo',
      summary: 'Found the streaming entrypoint',
      subagentType: 'explorer',
      lastToolName: 'Grep',
      sdkTaskUsage: { totalTokens: 123, toolUses: 2, durationMs: 4567 },
    });
  });

  test('uses tool_use_summary.summary for foreground Task completion', () => {
    const { processor, outputs } = makeProcessor();

    processor.processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'Task',
          id: 'task-tool-1',
          input: {},
        },
      },
    });
    processor.processToolUseSummary({
      type: 'tool_use_summary',
      summary: 'The sub-agent identified the fix.',
      preceding_tool_use_ids: ['task-tool-1'],
    });

    expect(outputs.map((o) => o.streamEvent).filter(Boolean)).toContainEqual(
      expect.objectContaining({
        eventType: 'task_notification',
        taskId: 'task-tool-1',
        taskSummary: 'The sub-agent identified the fix.',
        isSynthetic: true,
      }),
    );
  });

  test('buffers early sub-agent messages until their Task is registered', () => {
    const { processor, outputs } = makeProcessor();

    expect(
      processor.processSubAgentMessage({
        type: 'assistant',
        parent_tool_use_id: 'task-tool-2',
        message: { content: [{ type: 'text', text: 'early child output' }] },
      }),
    ).toBe(true);
    expect(outputs.some((o) => o.streamEvent?.eventType === 'text_delta')).toBe(
      false,
    );

    processor.processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'Task',
          id: 'task-tool-2',
          input: {},
        },
      },
    });

    expect(outputs.map((o) => o.streamEvent).filter(Boolean)).toContainEqual(
      expect.objectContaining({
        eventType: 'text_delta',
        agentScope: 'subagent',
        parentToolUseId: 'task-tool-2',
        text: 'early child output',
      }),
    );
  });

  test('maps unknown SDK system messages to raw_sdk_event instead of dropping them', () => {
    const { processor, outputs } = makeProcessor();

    expect(
      processor.processSystemMessage({
        type: 'system',
        subtype: 'future_event',
        summary: 'new SDK thing',
        uuid: 'msg-1',
        session_id: 'sess-1',
      }),
    ).toBe(true);

    expect(outputs.at(-1)?.streamEvent).toMatchObject({
      eventType: 'raw_sdk_event',
      rawType: 'system/future_event',
      summary: 'new SDK thing',
      messageUuid: 'msg-1',
      sessionId: 'sess-1',
    });
  });

  test('does not swallow system/init before the runner records the SDK session', () => {
    const { processor, outputs } = makeProcessor();

    expect(
      processor.processSystemMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
      }),
    ).toBe(false);
    expect(
      processor.processMiscMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
      }),
    ).toBe(false);
    expect(outputs).toHaveLength(0);
  });
});

// Guards the data contracts that the Feishu/Web streaming-card consumers depend on.
// See the "僵尸卡片 / parity" fixes: Feishu feedStreamEventToCard now consumes
// tool_progress.toolInput (AskUserQuestion), and both Feishu accumulation and Web
// applyStreamEvent filter sub-agent text by parentToolUseId.
describe('StreamEventProcessor card-consumer data contracts', () => {
  test('AskUserQuestion streams its questions via tool_progress.toolInput (not toolInputSummary)', () => {
    const { processor, outputs } = makeProcessor();

    // tool_use_start: streaming input is empty (SDK sends input via input_json_delta).
    processor.processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          name: 'AskUserQuestion',
          id: 'ask-1',
          input: {},
        },
      },
    });

    // input_json_delta accumulates the questions JSON.
    const inputJson = JSON.stringify({
      questions: [
        { question: '选哪个方案?', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: inputJson },
      },
    });

    // A tool_progress event must carry the parsed questions in toolInput — this is
    // the field the Feishu ASK panel reads via collectAskQuestions(tc.toolInput).
    const askProgress = outputs
      .map((o) => o.streamEvent)
      .find(
        (e) =>
          e?.eventType === 'tool_progress' && e?.toolName === 'AskUserQuestion',
      );
    expect(askProgress).toBeDefined();
    expect(askProgress?.toolUseId).toBe('ask-1');
    expect(askProgress?.toolInput).toMatchObject({
      questions: [{ question: '选哪个方案?' }],
    });
  });

  test('sub-agent text_delta carries parentToolUseId so consumers can isolate it from the main card', () => {
    const { processor, outputs } = makeProcessor();

    // A nested (sub-agent) text block: parent_tool_use_id is set.
    processor.processStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: 'task-parent-1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: 'task-parent-1',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '子 Agent 中间输出' },
      },
    });
    // Force the buffered text out (FLUSH_CHARS not reached for short text).
    processor.cleanup();

    const subText = outputs
      .map((o) => o.streamEvent)
      .find(
        (e) => e?.eventType === 'text_delta' && e?.text === '子 Agent 中间输出',
      );
    expect(subText).toBeDefined();
    // The guard in src/index.ts (Feishu) and web/src/stores/chat.ts (Web) keys off
    // this field to keep sub-agent text out of the main card body.
    expect(subText?.parentToolUseId).toBe('task-parent-1');
    expect(subText?.agentScope).toBe('subagent');
  });

  test('main-agent text_delta has no parentToolUseId so it accumulates into the main card', () => {
    const { processor, outputs } = makeProcessor();

    processor.processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '主 Agent 正文' },
      },
    });
    processor.cleanup();

    const mainText = outputs
      .map((o) => o.streamEvent)
      .find(
        (e) => e?.eventType === 'text_delta' && e?.text === '主 Agent 正文',
      );
    expect(mainText).toBeDefined();
    // null/undefined parentToolUseId ⟹ passes the `!parentToolUseId` guard ⟹ accumulates.
    expect(mainText?.parentToolUseId ?? null).toBeNull();
    expect(mainText?.agentScope).toBe('main');
  });
});
