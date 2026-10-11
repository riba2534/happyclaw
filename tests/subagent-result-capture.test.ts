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

function startTask(processor: StreamEventProcessor, toolUseId: string) {
  processor.processStreamEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        name: 'Agent',
        id: toolUseId,
        input: {},
      },
    },
  });
}

function subAgentText(
  processor: StreamEventProcessor,
  toolUseId: string,
  messageId: string,
  content: Array<Record<string, unknown>>,
) {
  processor.processSubAgentMessage({
    type: 'assistant',
    parent_tool_use_id: toolUseId,
    message: { id: messageId, content },
  });
}

function notifications(outputs: ContainerOutput[]) {
  return outputs
    .map((output) => output.streamEvent)
    .filter((event) => event?.eventType === 'task_notification');
}

describe('sub-agent final answer capture', () => {
  test('attaches the last text response of a background sub-agent to its notification', () => {
    const { processor, outputs } = makeProcessor();
    startTask(processor, 'toolu_bg');
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sdk-bg',
      tool_use_id: 'toolu_bg',
      description: 'Research',
      task_type: 'local_agent',
    });

    subAgentText(processor, 'toolu_bg', 'msg-1', [
      { type: 'text', text: 'Let me look around.' },
    ]);
    subAgentText(processor, 'toolu_bg', 'msg-1', [
      { type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: {} },
    ]);
    // One API response split into one SDK frame per content block.
    subAgentText(processor, 'toolu_bg', 'msg-2', [
      { type: 'thinking', thinking: 'summarize' },
    ]);
    subAgentText(processor, 'toolu_bg', 'msg-2', [
      { type: 'text', text: 'Root cause: stale cursor.' },
    ]);
    subAgentText(processor, 'toolu_bg', 'msg-2', [
      { type: 'text', text: 'Fix is in src/a.ts.' },
    ]);

    processor.processTaskNotification({
      task_id: 'sdk-bg',
      tool_use_id: 'toolu_bg',
      status: 'completed',
      summary: 'Agent "Research" finished',
      output_file: '',
    });

    expect(notifications(outputs).at(-1)).toMatchObject({
      taskId: 'toolu_bg',
      taskStatus: 'completed',
      taskResult: 'Root cause: stale cursor.\nFix is in src/a.ts.',
    });
  });

  test('foreground Task completion carries the captured answer too', () => {
    const { processor, outputs } = makeProcessor();
    startTask(processor, 'toolu_fg');
    subAgentText(processor, 'toolu_fg', 'msg-1', [
      { type: 'text', text: 'All 12 call sites updated.' },
    ]);
    processor.processToolUseSummary({
      type: 'tool_use_summary',
      summary: 'Updated call sites',
      preceding_tool_use_ids: ['toolu_fg'],
    });
    expect(notifications(outputs).at(-1)).toMatchObject({
      taskId: 'toolu_fg',
      isSynthetic: true,
      taskResult: 'All 12 call sites updated.',
    });
  });

  test('a task without any sub-agent text has no captured answer', () => {
    const { processor, outputs } = makeProcessor();
    startTask(processor, 'toolu_quiet');
    processor.processTaskNotification({
      task_id: 'sdk-quiet',
      tool_use_id: 'toolu_quiet',
      status: 'stopped',
      summary: 'stopped',
      output_file: '',
    });
    expect(notifications(outputs).at(-1)?.taskResult).toBeUndefined();
  });
});
