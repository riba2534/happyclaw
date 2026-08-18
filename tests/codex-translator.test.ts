import { describe, expect, test } from 'vitest';

import {
  anthropicToCodexRequest,
  dropOrphanFunctionCallOutputs,
  flattenSystemText,
  stripThinkingBlocks,
  translateCodexSse,
} from '../src/codex-translator.js';

describe('anthropicToCodexRequest', () => {
  test('maps system text, user text, and tools onto Responses input', () => {
    const body = anthropicToCodexRequest({
      model: 'gpt-5.6-sol',
      system: [{ type: 'text', text: 'You are a coding agent.' }],
      messages: [{ role: 'user', content: 'list the files' }],
      tools: [
        {
          name: 'Bash',
          description: 'run a command',
          input_schema: {
            type: 'object',
            properties: { command: { type: 'string' } },
          },
        },
      ],
    });

    expect(body.model).toBe('gpt-5.6-sol');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.instructions).toBe('You are a coding agent.');
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'list the files' }],
      },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'Bash',
        description: 'run a command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
        },
        strict: false,
      },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  test('pairs assistant function_call items with later tool results', () => {
    const body = anthropicToCodexRequest({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'Bash',
              input: { command: 'pwd' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [{ type: 'text', text: '/tmp' }],
            },
          ],
        },
      ],
    });

    expect(body.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'pwd' }),
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '/tmp',
      },
    ]);
  });

  test('drops orphan function_call_output items', () => {
    expect(
      dropOrphanFunctionCallOutputs([
        {
          type: 'function_call',
          call_id: 'keep',
          name: 'Bash',
          arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'keep', output: 'ok' },
        { type: 'function_call_output', call_id: 'missing', output: 'stale' },
      ]),
    ).toEqual([
      { type: 'function_call', call_id: 'keep', name: 'Bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'keep', output: 'ok' },
    ]);
  });

  test('does not forward thinking blocks or orphan tool results', () => {
    const stripped = stripThinkingBlocks([
      { type: 'thinking', thinking: 'secret scratch' },
      { type: 'text', text: 'visible' },
    ]);
    expect(stripped).toEqual([{ type: 'text', text: 'visible' }]);
    expect(flattenSystemText([{ type: 'text', text: 'sys' }])).toBe('sys');

    const body = anthropicToCodexRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'thinking', thinking: 'do not send' },
            {
              type: 'tool_result',
              tool_use_id: 'orphan',
              content: 'stale',
            },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    });
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
  });

  test('inserts a continue placeholder when every block is dropped', () => {
    const body = anthropicToCodexRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'gone', content: 'x' }],
        },
      ],
    });
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '(continue)' }],
      },
    ]);
  });
});

describe('translateCodexSse', () => {
  test('streams text and thinking without leaking a failed upstream as success', () => {
    const ok = translateCodexSse('gpt-5.6-sol', [
      'data: {"type":"response.reasoning_summary_text.delta","delta":"plan"}',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":2,"input_tokens_details":{"cached_tokens":3}}}}',
    ]);
    expect(ok.error).toBeNull();
    expect(ok.text).toBe('Hello');
    expect(ok.usage).toEqual({
      inputTokens: 11,
      outputTokens: 2,
      cacheReadTokens: 3,
    });
    expect(ok.sse).toContain('"type":"thinking"');
    expect(ok.sse).toContain('thinking_delta');
    expect(ok.sse).toContain('"text":"Hello"');
    expect(ok.sse).toContain('"stop_reason":"end_turn"');
    expect(ok.sse).toContain('event: message_stop');

    const failed = translateCodexSse('gpt-5.6-sol', [
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      'data: {"type":"response.completed","response":{"error":{"message":"upstream exploded"}}}',
    ]);
    expect(failed.error).toBe('upstream exploded');
    expect(failed.text).toBe('partial');
    expect(failed.sse).toContain('event: error');
    expect(failed.sse).toContain('upstream exploded');
    expect(failed.sse).not.toContain('event: message_stop');
    expect(failed.sse).not.toContain('"stop_reason":"end_turn"');
  });

  test('reconstructs tool arguments from the Responses arg stream', () => {
    const translated = translateCodexSse('gpt-5.6-sol', [
      'data: {"type":"response.function_call_arguments.delta","item_id":"call_9","delta":"{\\"command\\":"}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"call_9","delta":"\\"ls\\"}"}',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"Bash"}}',
      'data: {"type":"response.completed","response":{"usage":{"output_tokens":4}}}',
    ]);

    expect(translated.error).toBeNull();
    expect(translated.toolUses).toEqual([
      { id: 'call_9', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(translated.sse).toContain('"type":"tool_use"');
    expect(translated.sse).toContain('"stop_reason":"tool_use"');
    expect(translated.sse).toContain('input_json_delta');
    expect(translated.sse).toMatch(/partial_json.:.\{\\"command\\":\\"ls\\"\}/);
  });
});
