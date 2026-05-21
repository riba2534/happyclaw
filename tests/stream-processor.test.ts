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
