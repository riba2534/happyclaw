import { describe, expect, test } from 'vitest';
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
  test('maps SDK task_progress to structured task_progress event', () => {
    const { processor, outputs } = makeProcessor();

    expect(processor.processSystemMessage({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'sdk-task-1',
      tool_use_id: 'tool-task-1',
      description: 'Search the repo',
      summary: 'Found the streaming entrypoint',
      subagent_type: 'explorer',
      last_tool_name: 'Grep',
      usage: { total_tokens: 123, tool_uses: 2, duration_ms: 4567 },
    })).toBe(true);

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
        content_block: { type: 'tool_use', name: 'Task', id: 'task-tool-1', input: {} },
      },
    });
    processor.processToolUseSummary({
      type: 'tool_use_summary',
      summary: 'The sub-agent identified the fix.',
      preceding_tool_use_ids: ['task-tool-1'],
    });

    expect(outputs.map(o => o.streamEvent).filter(Boolean)).toContainEqual(expect.objectContaining({
      eventType: 'task_notification',
      taskId: 'task-tool-1',
      taskSummary: 'The sub-agent identified the fix.',
      isSynthetic: true,
    }));
  });

  test('buffers early sub-agent messages until their Task is registered', () => {
    const { processor, outputs } = makeProcessor();

    expect(processor.processSubAgentMessage({
      type: 'assistant',
      parent_tool_use_id: 'task-tool-2',
      message: { content: [{ type: 'text', text: 'early child output' }] },
    })).toBe(true);
    expect(outputs.some(o => o.streamEvent?.eventType === 'text_delta')).toBe(false);

    processor.processStreamEvent({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', name: 'Task', id: 'task-tool-2', input: {} },
      },
    });

    expect(outputs.map(o => o.streamEvent).filter(Boolean)).toContainEqual(expect.objectContaining({
      eventType: 'text_delta',
      agentScope: 'subagent',
      parentToolUseId: 'task-tool-2',
      text: 'early child output',
    }));
  });

  test('maps unknown SDK system messages to raw_sdk_event instead of dropping them', () => {
    const { processor, outputs } = makeProcessor();

    expect(processor.processSystemMessage({
      type: 'system',
      subtype: 'future_event',
      summary: 'new SDK thing',
      uuid: 'msg-1',
      session_id: 'sess-1',
    })).toBe(true);

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

    expect(processor.processSystemMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
    })).toBe(false);
    expect(processor.processMiscMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
    })).toBe(false);
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
        content_block: { type: 'tool_use', name: 'AskUserQuestion', id: 'ask-1', input: {} },
      },
    });

    // input_json_delta accumulates the questions JSON.
    const inputJson = JSON.stringify({
      questions: [{ question: '选哪个方案?', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson } },
    });

    // A tool_progress event must carry the parsed questions in toolInput — this is
    // the field the Feishu ASK panel reads via collectAskQuestions(tc.toolInput).
    const askProgress = outputs
      .map((o) => o.streamEvent)
      .find((e) => e?.eventType === 'tool_progress' && e?.toolName === 'AskUserQuestion');
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
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      parent_tool_use_id: 'task-parent-1',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子 Agent 中间输出' } },
    });
    // Force the buffered text out (FLUSH_CHARS not reached for short text).
    processor.cleanup();

    const subText = outputs
      .map((o) => o.streamEvent)
      .find((e) => e?.eventType === 'text_delta' && e?.text === '子 Agent 中间输出');
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
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    });
    processor.processStreamEvent({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '主 Agent 正文' } },
    });
    processor.cleanup();

    const mainText = outputs
      .map((o) => o.streamEvent)
      .find((e) => e?.eventType === 'text_delta' && e?.text === '主 Agent 正文');
    expect(mainText).toBeDefined();
    // null/undefined parentToolUseId ⟹ passes the `!parentToolUseId` guard ⟹ accumulates.
    expect(mainText?.parentToolUseId ?? null).toBeNull();
    expect(mainText?.agentScope).toBe('main');
  });
});
