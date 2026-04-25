import { describe, expect, it } from 'vitest';

import { CodexEventNormalizer } from '../container/agent-runner/src/codex-cli-runner.js';
import type { ContainerOutput } from '../container/agent-runner/src/types.js';

describe('Codex event normalizer', () => {
  it('emits text deltas and assistant boundaries for multiple agent messages', () => {
    const outputs: ContainerOutput[] = [];
    const normalizer = new CodexEventNormalizer(
      (output) => outputs.push(output),
      Date.now(),
    );

    normalizer.handle({
      type: 'item.updated',
      item: { id: 'msg-1', type: 'agent_message', text: 'hello' },
    });
    normalizer.handle({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'hello world' },
    });
    normalizer.handle({
      type: 'item.completed',
      item: { id: 'msg-2', type: 'agent_message', text: 'second answer' },
    });

    const events = outputs.map((output) => output.streamEvent);
    expect(events).toEqual([
      { eventType: 'text_delta', text: 'hello' },
      { eventType: 'text_delta', text: ' world' },
      {
        eventType: 'assistant_text_boundary',
        segmentText: 'hello world',
      },
      { eventType: 'text_delta', text: 'second answer' },
    ]);
  });

  it('does not duplicate completed agent_message text after full-text updates', () => {
    const outputs: ContainerOutput[] = [];
    const normalizer = new CodexEventNormalizer(
      (output) => outputs.push(output),
      Date.now(),
    );

    normalizer.handle({
      type: 'item.updated',
      item: { id: 'msg-1', type: 'agent_message', text: 'partial' },
    });
    normalizer.handle({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agent_message', text: 'partial' },
    });

    expect(outputs.map((output) => output.streamEvent)).toEqual([
      { eventType: 'text_delta', text: 'partial' },
    ]);
  });
});
