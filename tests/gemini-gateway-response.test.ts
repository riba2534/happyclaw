import { beforeEach, describe, expect, test } from 'vitest';

import {
  clearGeminiSignatureCacheForTest,
  decodeSignatureCarrier,
  geminiToolUseId,
  recallToolSignature,
} from '../src/gemini-gateway/signature.js';
import {
  GeminiStreamTranslator,
  anthropicErrorBody,
  foldAnthropicEvents,
  type AnthropicStreamEvent,
} from '../src/gemini-gateway/translate-response.js';

beforeEach(() => {
  clearGeminiSignatureCacheForTest();
});

function run(
  chunks: unknown[],
  reverseToolNameMap = new Map<string, string>(),
): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  const translator = new GeminiStreamTranslator({
    model: 'gemini-4-argon-medium',
    messageId: 'msg-1',
    reverseToolNameMap,
    onEvent: (event) => events.push(event),
  });
  for (const chunk of chunks) translator.ingest(chunk);
  translator.finalize();
  return events;
}

function eventsNamed(
  events: AnthropicStreamEvent[],
  name: string,
): AnthropicStreamEvent[] {
  return events.filter((event) => event.event === name);
}

describe('GeminiStreamTranslator — text', () => {
  test('streams text deltas between a start and a stop', () => {
    const events = run([
      { response: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] } },
      { response: { candidates: [{ content: { parts: [{ text: 'lo' }] } }] } },
    ]);
    expect(events.map((event) => event.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[1].data).toMatchObject({
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    expect(events[2].data).toMatchObject({ delta: { text: 'Hel' } });
    expect(events[3].data).toMatchObject({ delta: { text: 'lo' } });
  });

  test('a new text part after a thinking part opens a new block', () => {
    const events = run([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'pondering', thought: true },
                  { text: 'answer' },
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(
      eventsNamed(events, 'content_block_start').map((e) => e.data),
    ).toEqual([
      expect.objectContaining({
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
      expect.objectContaining({
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
    ]);
  });

  test('an empty stream still produces a well-formed message', () => {
    const events = run([]);
    expect(events.map((event) => event.event)).toEqual([
      'message_start',
      'message_delta',
      'message_stop',
    ]);
    expect(events[1].data).toMatchObject({
      delta: { stop_reason: 'end_turn', stop_sequence: null },
    });
  });

  test('non-object chunks are ignored', () => {
    const events = run([null, 'nope', 42, {}]);
    expect(eventsNamed(events, 'message_start')).toHaveLength(1);
  });
});

describe('GeminiStreamTranslator — thinking', () => {
  test('carries a thought signature into the thinking block', () => {
    const events = run([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'thinking…',
                    thought: true,
                    thoughtSignature: 'sig-t',
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const signature = events.find(
      (event) =>
        (event.data as { delta?: { type?: string } }).delta?.type ===
        'signature_delta',
    );
    expect(signature).toBeDefined();
    expect(
      decodeSignatureCarrier(
        (signature!.data as { delta: { signature: string } }).delta.signature,
      ),
    ).toEqual({ signature: 'sig-t', kind: 'text' });
  });
});

describe('GeminiStreamTranslator — function calls', () => {
  test('emits a signature carrier, a tool_use block, and its argument json', () => {
    const events = run(
      [
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: 'read_file',
                        args: { path: '/tmp/x' },
                        id: 'call-1',
                      },
                      thoughtSignature: 'sig-tool',
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
      new Map([['read_file', 'read_file']]),
    );
    const toolUseId = geminiToolUseId('call-1', 'read_file');
    expect(
      eventsNamed(events, 'content_block_start').map((e) => e.data),
    ).toEqual([
      expect.objectContaining({
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }),
      expect.objectContaining({
        index: 1,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: 'read_file',
          input: {},
        },
      }),
    ]);
    expect(
      events.some(
        (event) =>
          (event.data as { delta?: { partial_json?: string } }).delta
            ?.partial_json === '{"path":"/tmp/x"}',
      ),
    ).toBe(true);
    const carrier = events.find(
      (event) =>
        (event.data as { delta?: { type?: string } }).delta?.type ===
        'signature_delta',
    );
    expect(
      decodeSignatureCarrier(
        (carrier!.data as { delta: { signature: string } }).delta.signature,
      ),
    ).toEqual({ signature: 'sig-tool', kind: 'tool', callId: 'call-1' });
    // The tool signature is cached under the Anthropic tool id for replays.
    expect(recallToolSignature(toolUseId)).toEqual({
      signature: 'sig-tool',
      callId: 'call-1',
      name: 'read_file',
    });
    expect(events[events.length - 2].data).toMatchObject({
      delta: { stop_reason: 'tool_use' },
    });
  });

  test('maps an upstream function name back to the Anthropic tool name', () => {
    const events = run(
      [
        {
          response: {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'read_file', args: {} } }],
                },
              },
            ],
          },
        },
      ],
      new Map([['read_file', 'mcp__server__read']]),
    );
    expect(eventsNamed(events, 'content_block_start')[0].data).toMatchObject({
      content_block: { name: 'mcp__server__read' },
    });
  });

  test('a function call without an id still gets a stable tool_use id', () => {
    const events = run([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'do_it', args: {} } }],
              },
            },
          ],
        },
      },
    ]);
    expect(eventsNamed(events, 'content_block_start')[0].data).toMatchObject({
      content_block: { id: geminiToolUseId('call_0', 'do_it') },
    });
  });

  test('closes an open text block before the tool call', () => {
    const events = run([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'checking' },
                  { functionCall: { name: 'read_file', args: {}, id: 'c1' } },
                ],
              },
            },
          ],
        },
      },
    ]);
    const kinds = events.map((event) =>
      event.event === 'content_block_start'
        ? (event.data as { content_block: { type: string } }).content_block.type
        : event.event,
    );
    expect(kinds).toEqual([
      'message_start',
      'text',
      'content_block_delta',
      'content_block_stop',
      'tool_use',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });
});

describe('GeminiStreamTranslator — usage and finish reasons', () => {
  test('folds thought tokens into output and reports cache reads', () => {
    const events = run([
      {
        response: {
          candidates: [{ content: { parts: [{ text: 'x' }] } }],
          usageMetadata: {
            promptTokenCount: 100,
            cachedContentTokenCount: 40,
            candidatesTokenCount: 10,
            thoughtsTokenCount: 5,
          },
        },
      },
    ]);
    // Usage arrives with the chunk, after message_start has gone out; the
    // authoritative numbers travel on message_delta.
    expect(eventsNamed(events, 'message_start')[0].data).toMatchObject({
      message: { model: 'gemini-4-argon-medium' },
    });
    expect(eventsNamed(events, 'message_delta')[0].data).toMatchObject({
      usage: {
        input_tokens: 100,
        output_tokens: 15,
        cache_read_input_tokens: 40,
      },
    });
  });

  test.each([
    ['STOP', 'end_turn'],
    ['MAX_TOKENS', 'max_tokens'],
    ['SAFETY', 'end_turn'],
    ['RECITATION', 'end_turn'],
    ['MALFORMED_FUNCTION_CALL', 'tool_use'],
    ['SOMETHING_NEW', 'end_turn'],
  ])('maps finishReason %s to %s', (finishReason, expected) => {
    const events = run([
      {
        response: {
          candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason }],
        },
      },
    ]);
    expect(eventsNamed(events, 'message_delta')[0].data).toMatchObject({
      delta: { stop_reason: expected },
    });
  });

  test('a stream with a tool call always stops for tool use', () => {
    const events = run([
      {
        response: {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'x', args: {} } }] },
              finishReason: 'STOP',
            },
          ],
        },
      },
    ]);
    expect(eventsNamed(events, 'message_delta')[0].data).toMatchObject({
      delta: { stop_reason: 'tool_use' },
    });
  });

  test('a blocked prompt becomes a readable text block', () => {
    const events = run([
      { response: { promptFeedback: { blockReason: 'SAFETY' } } },
    ]);
    const delta = events.find(
      (event) =>
        (event.data as { delta?: { text?: string } }).delta?.text !== undefined,
    );
    expect((delta!.data as { delta: { text: string } }).delta.text).toContain(
      'SAFETY',
    );
  });
});

describe('GeminiStreamTranslator — upstream errors', () => {
  test('an error chunk becomes an Anthropic error event and ends the stream', () => {
    const events = run([
      { error: { code: 500, message: 'internal', status: 'INTERNAL' } },
      {
        response: { candidates: [{ content: { parts: [{ text: 'late' }] } }] },
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('error');
    expect(events[0].data).toMatchObject({
      error: { type: 'api_error', message: 'internal' },
    });
  });

  test('an error message is bounded', () => {
    const events = run([{ error: { message: 'x'.repeat(5_000) } }]);
    expect(
      (events[0].data as { error: { message: string } }).error.message,
    ).toHaveLength(600);
  });
});

describe('foldAnthropicEvents', () => {
  test('folds text, thinking and tool calls into one message', () => {
    const events = run([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'thinking',
                    thought: true,
                    thoughtSignature: 'sig-t',
                  },
                  { text: 'answer' },
                  {
                    functionCall: {
                      name: 'read_file',
                      args: { a: 1 },
                      id: 'c1',
                    },
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
        },
      },
    ]);
    const message = foldAnthropicEvents(events, {
      model: 'gemini-4-argon-medium',
      messageId: 'msg-1',
    });
    expect(message.id).toBe('msg-1');
    expect(message.role).toBe('assistant');
    expect(message.stop_reason).toBe('tool_use');
    expect(message.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'thinking', signature: expect.any(String) },
      { type: 'text', text: 'answer' },
      {
        type: 'tool_use',
        id: geminiToolUseId('c1', 'read_file'),
        name: 'read_file',
        input: { a: 1 },
      },
    ]);
  });

  test('drops index gaps left by an error', () => {
    const message = foldAnthropicEvents(
      [
        {
          event: 'content_block_start',
          data: { index: 3, content_block: { type: 'text' } },
        },
        {
          event: 'content_block_delta',
          data: { index: 3, delta: { type: 'text_delta', text: 'x' } },
        },
      ],
      { model: 'm', messageId: 'id' },
    );
    expect(message.content).toEqual([{ type: 'text', text: 'x' }]);
    expect(message.stop_reason).toBeNull();
  });

  test('malformed tool arguments fall back to an empty object', () => {
    const message = foldAnthropicEvents(
      [
        {
          event: 'content_block_start',
          data: {
            index: 0,
            content_block: { type: 'tool_use', id: 't1', name: 'n' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{oops' },
          },
        },
      ],
      { model: 'm', messageId: 'id' },
    );
    expect(message.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });
});

describe('anthropicErrorBody', () => {
  test('shapes an Anthropic error envelope', () => {
    expect(anthropicErrorBody('rate_limit_error', 'slow down')).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
  });
});
