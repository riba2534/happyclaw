import { describe, expect, test } from 'vitest';

import {
  anthropicToResponses,
  normalizeCodexEffort,
  normalizeLegacyCodexModel,
  resolveCodexModel,
} from '../src/codex-gateway/convert-request.js';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
} from '../src/codex-gateway/convert-response.js';
import {
  decodeReasoningSignature,
  encodeReasoningSignature,
} from '../src/codex-gateway/reasoning-signature.js';

describe('reasoning-signature', () => {
  test('round-trips id and encrypted content through the signature field', () => {
    const encoded = encodeReasoningSignature({
      id: 'rs_abc',
      encryptedContent: 'gAAAA secret==',
    });
    expect(encoded).toMatch(/^codexrs1_/);
    expect(decodeReasoningSignature(encoded)).toEqual({
      id: 'rs_abc',
      encryptedContent: 'gAAAA secret==',
    });
  });

  test('rejects foreign signatures and corrupted payloads', () => {
    expect(encodeReasoningSignature({ id: 'rs_1', encryptedContent: '' })).toBe(
      null,
    );
    expect(decodeReasoningSignature('sk-ant-sig-real-anthropic')).toBeNull();
    expect(decodeReasoningSignature('codexrs1_not-base64-!')).toBeNull();
    expect(decodeReasoningSignature(undefined)).toBeNull();
    expect(
      decodeReasoningSignature(
        `codexrs1_${Buffer.from('{"v":2,"ec":"x"}').toString('base64url')}`,
      ),
    ).toBeNull();
  });
});

describe('resolveCodexModel', () => {
  test('rewrites claude-* model names to the configured Codex model', () => {
    expect(resolveCodexModel('claude-haiku-4-5', 'gpt-6-sol')).toBe(
      'gpt-6-sol',
    );
  });

  test('passes through non-claude model names unchanged', () => {
    expect(resolveCodexModel('gpt-6-luna', 'gpt-6-sol')).toBe('gpt-6-luna');
  });

  test('falls back to a default when no request model or configured model exists', () => {
    expect(resolveCodexModel(undefined, '')).toBe('gpt-6-sol');
  });

  test('normalizes legacy gpt-5.1 configured models to the current catalog', () => {
    expect(resolveCodexModel(undefined, 'gpt-5.1-codex')).toBe('gpt-6-sol');
    expect(resolveCodexModel('claude-sonnet-4-6', 'gpt-5.1-codex-max')).toBe(
      'gpt-6-sol',
    );
  });

  test('normalizes legacy gpt-5.1 request models to the current catalog', () => {
    expect(resolveCodexModel('gpt-5.1-codex', 'gpt-6-sol')).toBe('gpt-6-sol');
    expect(resolveCodexModel('gpt-5.1-codex-mini', 'gpt-6-sol')).toBe(
      'gpt-6-luna',
    );
  });
});

describe('normalizeLegacyCodexModel', () => {
  test('maps the removed gpt-5.1 family to GPT-6 equivalents', () => {
    expect(normalizeLegacyCodexModel('gpt-5.1')).toBe('gpt-6-sol');
    expect(normalizeLegacyCodexModel('gpt-5.1-codex')).toBe('gpt-6-sol');
    expect(normalizeLegacyCodexModel('gpt-5.1-codex-max')).toBe('gpt-6-sol');
    expect(normalizeLegacyCodexModel('gpt-5.1-codex-mini')).toBe('gpt-6-luna');
  });

  test('leaves current-catalog models untouched', () => {
    expect(normalizeLegacyCodexModel('gpt-6-sol')).toBe('gpt-6-sol');
    expect(normalizeLegacyCodexModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(normalizeLegacyCodexModel('some-future-model')).toBe(
      'some-future-model',
    );
  });
});

describe('normalizeCodexEffort', () => {
  test('defaults to medium when unset', () => {
    expect(normalizeCodexEffort(undefined)).toBe('medium');
  });

  test('maps legacy minimal to low (removed from the GPT-6 catalog)', () => {
    expect(normalizeCodexEffort('minimal')).toBe('low');
  });

  test('passes through other effort levels unchanged', () => {
    expect(normalizeCodexEffort('xhigh')).toBe('xhigh');
    expect(normalizeCodexEffort('ultra')).toBe('ultra');
  });
});

describe('anthropicToResponses', () => {
  test('maps system prompt to instructions and text messages to input items', () => {
    const result = anthropicToResponses(
      {
        model: 'claude-haiku-4-5',
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'hi' }],
      },
      { targetModel: 'gpt-5.1-codex' },
    );

    expect(result.instructions).toBe('You are helpful.');
    expect(result.model).toBe('gpt-5.1-codex');
    expect(result.stream).toBe(true);
    expect(result.store).toBe(false);
    expect(result.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
    ]);
  });

  test('translates tool_use/tool_result blocks to function_call/function_call_output', () => {
    const result = anthropicToResponses(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'search',
                input: { q: 'x' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: 'found it',
              },
            ],
          },
        ],
      },
      { targetModel: 'gpt-5.1-codex' },
    );

    expect(result.input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        arguments: JSON.stringify({ q: 'x' }),
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'found it',
      },
    ]);
  });

  test('drops tools/tool_choice when no tools are provided', () => {
    const result = anthropicToResponses(
      { messages: [{ role: 'user', content: 'hi' }] },
      { targetModel: 'gpt-5.1-codex' },
    );
    expect(result.tools).toBeUndefined();
    expect(result.tool_choice).toBeUndefined();
  });

  test('converts Anthropic tool definitions to Responses function tools', () => {
    const result = anthropicToResponses(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'search',
            description: 'search the web',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        tool_choice: { type: 'any' },
      },
      { targetModel: 'gpt-5.1-codex' },
    );
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'search the web',
        parameters: { type: 'object', properties: {} },
        strict: false,
      },
    ]);
    expect(result.tool_choice).toBe('required');
  });
});

describe('ResponsesToAnthropicConverter', () => {
  test('streams text deltas as Anthropic content_block events', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-5.1-codex');
    const events = [
      ...converter.handleEvent({
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-5.1-codex' },
      }),
      ...converter.handleEvent({
        type: 'response.output_text.delta',
        delta: 'Hello',
      }),
      ...converter.handleEvent({
        type: 'response.completed',
        response: { usage: { input_tokens: 10, output_tokens: 2 } },
      }),
    ];

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const delta = events.find((e) => e.event === 'content_block_delta');
    expect(delta?.data.delta).toEqual({ type: 'text_delta', text: 'Hello' });
    const stop = events.find((e) => e.event === 'message_delta');
    expect(stop?.data.delta.stop_reason).toBe('end_turn');
  });

  test('reports tool_use stop_reason when a function_call item was emitted', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-5.1-codex');
    converter.handleEvent({ type: 'response.created', response: {} });
    converter.handleEvent({
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'search',
      },
    });
    const events = converter.handleEvent({
      type: 'response.completed',
      response: { usage: {} },
    });
    const messageDelta = events.find((e) => e.event === 'message_delta');
    expect(messageDelta?.data.delta.stop_reason).toBe('tool_use');
  });

  test('emits signature_delta carrying encrypted reasoning content', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-5.1-codex');
    converter.handleEvent({ type: 'response.created', response: {} });
    const events = [
      ...converter.handleEvent({
        type: 'response.output_item.added',
        item: { type: 'reasoning', id: 'rs_1' },
      }),
      ...converter.handleEvent({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        delta: 'thinking...',
      }),
      ...converter.handleEvent({
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1' },
      }),
    ];

    const signatureDelta = events.find(
      (e) =>
        e.event === 'content_block_delta' &&
        e.data.delta.type === 'signature_delta',
    );
    expect(signatureDelta).toBeDefined();
    expect(
      decodeReasoningSignature(signatureDelta?.data.delta.signature),
    ).toEqual({ id: 'rs_1', encryptedContent: 'ENC1' });
    // signature 必须先于 content_block_stop 到达
    const stopPos = events.findIndex((e) => e.event === 'content_block_stop');
    const sigPos = events.indexOf(signatureDelta!);
    expect(sigPos).toBeLessThan(stopPos);
  });

  test('finish() reports premature EOF as an error exactly once', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-5.1-codex');
    converter.handleEvent({ type: 'response.created', response: {} });
    converter.handleEvent({
      type: 'response.output_text.delta',
      delta: 'partial',
    });
    const first = converter.finish();
    const second = converter.finish();
    // 上游断流未到 response.completed 属于失败，必须让调用方看到 error，
    // 而不是伪装成成功的 end_turn（会静默截断回复且不计失败重试）。
    expect(first.map((e) => e.event)).toEqual(['error']);
    expect(first[0].data).toMatchObject({
      type: 'error',
      error: { type: 'api_error' },
    });
    expect(second).toEqual([]);
  });
});

describe('aggregateResponsesStream', () => {
  test('produces usage totals from a full event list', () => {
    const aggregated = aggregateResponsesStream(
      [
        { type: 'response.created', response: {} },
        { type: 'response.output_text.delta', delta: 'hi' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 5, output_tokens: 1 } },
        },
      ],
      'gpt-5.1-codex',
    );
    expect(aggregated.usage.input_tokens).toBe(5);
    expect(aggregated.usage.output_tokens).toBe(1);
  });

  test('P0-1: assembles text content and metadata into a non-streaming message', () => {
    const aggregated = aggregateResponsesStream(
      [
        {
          type: 'response.created',
          response: { id: 'resp_9', model: 'gpt-5.1-codex' },
        },
        { type: 'response.output_text.delta', delta: 'Hello ' },
        { type: 'response.output_text.delta', delta: 'world' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 7, output_tokens: 3 } },
        },
      ],
      'gpt-5.1-codex',
    );
    expect(aggregated.id).toBe('resp_9');
    expect(aggregated.model).toBe('gpt-5.1-codex');
    expect(aggregated.stopReason).toBe('end_turn');
    expect(aggregated.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  test('P0-1: assembles tool_use blocks with parsed JSON input and tool_use stop reason', () => {
    const aggregated = aggregateResponsesStream(
      [
        { type: 'response.created', response: {} },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'search',
            arguments: '',
          },
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'search',
            arguments: '{"q":"x","n":2}',
          },
        },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 1, output_tokens: 9 } },
        },
      ],
      'gpt-5.1-codex',
    );
    expect(aggregated.stopReason).toBe('tool_use');
    expect(aggregated.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'search',
        input: { q: 'x', n: 2 },
      },
    ]);
  });

  test('P0-1: assembles thinking blocks with replayable signature', () => {
    const aggregated = aggregateResponsesStream(
      [
        { type: 'response.created', response: {} },
        {
          type: 'response.output_item.added',
          item: { type: 'reasoning', id: 'rs_1' },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_1',
          delta: 'pondering',
        },
        {
          type: 'response.output_item.done',
          item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1' },
        },
        { type: 'response.output_text.delta', delta: 'answer' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ],
      'gpt-5.1-codex',
    );
    expect(aggregated.content).toEqual([
      {
        type: 'thinking',
        thinking: 'pondering',
        signature: expect.any(String),
      },
      { type: 'text', text: 'answer' },
    ]);
    expect(
      decodeReasoningSignature(
        (aggregated.content[0] as { signature: string }).signature,
      ),
    ).toEqual({ id: 'rs_1', encryptedContent: 'ENC1' });
  });
});

describe('anthropicToResponses reasoning replay (P0-2)', () => {
  test('replays gateway-issued thinking signatures as reasoning items before function_call', () => {
    const signature = encodeReasoningSignature({
      id: 'rs_1',
      encryptedContent: 'ENC1',
    });
    const result = anthropicToResponses(
      {
        messages: [
          { role: 'user', content: 'run the tool' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'pondering', signature },
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'search',
                input: { q: 'x' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
            ],
          },
        ],
      },
      { targetModel: 'gpt-5.1-codex' },
    );
    expect(result.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'run the tool' }],
      },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'search',
        arguments: JSON.stringify({ q: 'x' }),
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ]);
  });

  test('skips thinking blocks whose signature is foreign or missing', () => {
    const result = anthropicToResponses(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'real anthropic thinking',
                signature: 'sk-ant-sig-real',
              },
              { type: 'text', text: 'plain answer' },
            ],
          },
        ],
      },
      { targetModel: 'gpt-5.1-codex' },
    );
    expect(result.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'plain answer' }],
      },
    ]);
  });

  test('full round trip: upstream reasoning survives into the next request', () => {
    const aggregated = aggregateResponsesStream(
      [
        { type: 'response.created', response: {} },
        {
          type: 'response.output_item.added',
          item: { type: 'reasoning', id: 'rs_rt' },
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'rs_rt',
          delta: 'hmm',
        },
        {
          type: 'response.output_item.done',
          item: { type: 'reasoning', id: 'rs_rt', encrypted_content: 'ENC-RT' },
        },
        { type: 'response.completed', response: { usage: {} } },
      ],
      'gpt-5.1-codex',
    );

    const thinkingBlock = aggregated.content.find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    const nextRequest = anthropicToResponses(
      {
        messages: [{ role: 'assistant', content: [thinkingBlock!] }],
      },
      { targetModel: 'gpt-5.1-codex' },
    );
    expect(nextRequest.input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_rt',
        summary: [],
        encrypted_content: 'ENC-RT',
      },
    ]);
  });
});
