import { beforeEach, describe, expect, test } from 'vitest';

import {
  clearGeminiSignatureCacheForTest,
  encodeSignatureCarrier,
  geminiToolUseId,
  rememberToolSignature,
} from '../src/gemini-gateway/signature.js';
import {
  normalizeRequestModel,
  sanitizeFunctionName,
  sanitizeSchema,
  translateAnthropicRequest,
  type AnthropicMessagesRequest,
} from '../src/gemini-gateway/translate-request.js';
import type { GeminiModelInfo } from '../src/gemini-gateway/types.js';

const MODEL: GeminiModelInfo = {
  id: 'gemini-4-argon-medium',
  displayName: 'Gemini 4 Argon (Medium)',
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,
  supportsThinking: true,
  supportsImages: true,
  thinkingBudget: 1_024,
  minThinkingBudget: 256,
};

beforeEach(() => {
  clearGeminiSignatureCacheForTest();
});

function translate(
  request: AnthropicMessagesRequest,
  options: { disableSignatures?: boolean } = {},
) {
  return translateAnthropicRequest(request, MODEL, options);
}

describe('translateAnthropicRequest — text', () => {
  test('maps system text and plain messages', () => {
    const { payload } = translate({
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    expect(payload.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are helpful.' }],
    });
    expect(payload.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi' }] },
    ]);
  });

  test('joins system blocks and drops empty ones', () => {
    const { payload } = translate({
      system: [
        { type: 'text', text: 'first' },
        { type: 'text', text: '   ' },
        { type: 'text', text: 'second' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(payload.systemInstruction?.parts).toEqual([
      { text: 'first\n\nsecond' },
    ]);
  });

  test('rewrites the Claude Code identity line Antigravity rejects', () => {
    const { payload } = translate({
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(payload.systemInstruction?.parts).toEqual([
      {
        text: "You are an AI coding agent, Anthropic's official CLI for Claude.",
      },
    ]);
  });

  test('rewrites every case and spacing variant in system blocks', () => {
    const { payload } = translate({
      system: [
        { type: 'text', text: 'you are  claude code' },
        { type: 'text', text: 'prefix YOU ARE CLAUDE CODE suffix' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const text = payload.systemInstruction?.parts[0]?.text ?? '';
    expect(text).not.toMatch(/you\s+are\s+claude\s+code/i);
    expect(text.match(/You are an AI coding agent/g)).toHaveLength(2);
  });

  test('drops the dual-use example list Antigravity rejects', () => {
    const { payload } = translate({
      system:
        'Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(payload.systemInstruction?.parts).toEqual([
      { text: 'Dual-use security tools require clear authorization context.' },
    ]);
  });

  test('leaves user and assistant text untouched', () => {
    const { payload } = translate({
      messages: [
        { role: 'user', content: 'You are Claude Code' },
        { role: 'assistant', content: 'You are Claude Code' },
      ],
    });
    expect(payload.contents[0].parts).toEqual([
      { text: 'You are Claude Code' },
    ]);
    expect(payload.contents[1].parts).toEqual([
      { text: 'You are Claude Code' },
    ]);
  });

  test('merges consecutive messages of the same role', () => {
    const { payload } = translate({
      messages: [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'three' },
        { role: 'user', content: 'four' },
      ],
    });
    expect(payload.contents.map((content) => content.role)).toEqual([
      'user',
      'model',
      'user',
    ]);
    expect(payload.contents[0].parts).toEqual([
      { text: 'one' },
      { text: 'two' },
    ]);
  });

  test('adds a user turn when the history starts with the assistant', () => {
    const { payload } = translate({
      messages: [{ role: 'assistant', content: 'continuing' }],
    });
    expect(payload.contents.map((content) => content.role)).toEqual([
      'user',
      'model',
    ]);
  });

  test('an empty request still produces a valid body', () => {
    const { payload } = translate({ messages: [] });
    expect(payload.contents).toEqual([
      { role: 'user', parts: [{ text: '(empty)' }] },
    ]);
    expect(payload.systemInstruction).toBeUndefined();
  });

  test('attaches a text signature carrier to the following text part', () => {
    const signature = encodeSignatureCarrier({
      signature: 'sig-text',
      kind: 'text',
    });
    const { payload } = translate({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning', signature },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    });
    expect(payload.contents[1].parts).toEqual([
      { text: 'answer', thoughtSignature: 'sig-text' },
    ]);
  });
});

describe('translateAnthropicRequest — images', () => {
  test('passes base64 images through as inline data', () => {
    const { payload } = translate({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: 'AAAA',
              },
            },
          ],
        },
      ],
    });
    expect(payload.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
    ]);
  });

  test('a non-base64 source becomes a text placeholder', () => {
    const { payload } = translate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
          ],
        },
      ],
    });
    expect(payload.contents[0].parts).toEqual([
      { text: '[图片：https://x/y.png]' },
    ]);
  });

  test('rejects a malformed media type instead of sending it upstream', () => {
    const { payload } = translate({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'not a type',
                data: 'AAAA',
              },
            },
          ],
        },
      ],
    });
    expect(payload.contents[0].parts).toEqual([{ text: '(empty)' }]);
  });
});

describe('translateAnthropicRequest — tools', () => {
  const tools = [
    {
      name: 'read_file',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path' },
        },
        required: ['path', 'missing'],
      },
    },
  ];

  test('declares tools with sanitized names and schemas', () => {
    const { payload, toolNameMap, reverseToolNameMap } = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    expect(payload.tools?.[0].functionDeclarations).toEqual([
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'OBJECT',
          properties: {
            path: { type: 'STRING', description: 'Absolute path' },
          },
          required: ['path'],
        },
      },
    ]);
    expect(toolNameMap.get('read_file')).toBe('read_file');
    expect(reverseToolNameMap.get('read_file')).toBe('read_file');
  });

  test('sanitizes names Gemini would reject and keeps a reverse map', () => {
    const { toolNameMap, reverseToolNameMap, payload } = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'mcp__server__do:thing', input_schema: { type: 'object' } },
        { name: '1starts-with-digit', input_schema: { type: 'object' } },
      ],
    });
    expect(toolNameMap.get('mcp__server__do:thing')).toBe(
      'mcp__server__do_thing',
    );
    expect(toolNameMap.get('1starts-with-digit')).toBe('_starts-with-digit');
    expect(
      reverseToolNameMap.get(toolNameMap.get('mcp__server__do:thing')!),
    ).toBe('mcp__server__do:thing');
    expect(payload.tools?.[0].functionDeclarations).toHaveLength(2);
  });

  test('keeps repeated names distinct', () => {
    const used = new Set<string>();
    expect(sanitizeFunctionName('a:b', used)).toBe('a_b');
    expect(sanitizeFunctionName('a?b', used)).toBe('a_b_2');
  });

  test('a name collision gets a numeric suffix', () => {
    const used = new Set<string>(['read_file']);
    expect(sanitizeFunctionName('read_file', used)).toBe('read_file_2');
  });

  test.each([
    ['none', { mode: 'NONE' }],
    ['any', { mode: 'ANY' }],
    ['auto', { mode: 'AUTO' }],
  ])('maps tool_choice %s', (type, expected) => {
    const { payload } = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      tool_choice: { type },
    });
    expect(payload.toolConfig?.functionCallingConfig).toEqual(expected);
  });

  test('a specific tool_choice narrows the allowed function', () => {
    const { payload } = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      tool_choice: { type: 'tool', name: 'read_file' },
    });
    expect(payload.toolConfig?.functionCallingConfig).toEqual({
      mode: 'ANY',
      allowedFunctionNames: ['read_file'],
    });
  });

  test('tool_choice without declarations is not sent', () => {
    const { payload } = translate({
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'any' },
    });
    expect(payload.toolConfig).toBeUndefined();
  });
});

describe('translateAnthropicRequest — tool history', () => {
  const toolUse = {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'read_file',
    input: { path: '/tmp/x' },
  };

  test('a tool call with an adjacent signature becomes a functionCall', () => {
    const signature = encodeSignatureCarrier({
      signature: 'sig-tool',
      kind: 'tool',
      callId: 'call-1',
    });
    const { payload } = translate({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'need the file', signature },
            toolUse,
          ],
        },
      ],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(payload.contents[1].parts).toEqual([
      {
        functionCall: {
          name: 'read_file',
          args: { path: '/tmp/x' },
          id: 'call-1',
        },
        thoughtSignature: 'sig-tool',
      },
    ]);
  });

  test('falls back to the process cache when the thinking block is gone', () => {
    const toolUseId = geminiToolUseId('call-1', 'read_file');
    rememberToolSignature(toolUseId, {
      signature: 'sig-cached',
      callId: 'call-1',
      name: 'read_file',
    });
    const { payload } = translate({
      messages: [
        {
          role: 'assistant',
          content: [{ ...toolUse, id: toolUseId }],
        },
      ],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(payload.contents[1].parts[0]).toMatchObject({
      functionCall: { id: 'call-1' },
      thoughtSignature: 'sig-cached',
    });
  });

  test('a lost signature degrades to readable text instead of a 400', () => {
    const { payload } = translate({
      messages: [{ role: 'assistant', content: [toolUse] }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(payload.contents[1].parts).toEqual([
      { text: '[调用工具 read_file] {"path":"/tmp/x"}' },
    ]);
  });

  test('disableSignatures replays every call as text', () => {
    const signature = encodeSignatureCarrier({
      signature: 'sig-tool',
      kind: 'tool',
      callId: 'call-1',
    });
    const { payload } = translate(
      {
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'x', signature }, toolUse],
          },
        ],
      },
      { disableSignatures: true },
    );
    expect(payload.contents[1].parts).toEqual([
      { text: '[调用工具 read_file] {"path":"/tmp/x"}' },
    ]);
  });

  test('tool results become functionResponse with the upstream name', () => {
    const signature = encodeSignatureCarrier({
      signature: 'sig-tool',
      kind: 'tool',
      callId: 'call-1',
    });
    const { payload } = translate({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'x', signature }, toolUse],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'contents',
            },
          ],
        },
      ],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(payload.contents[2].parts).toEqual([
      {
        functionResponse: {
          name: 'read_file',
          response: { output: 'contents' },
        },
      },
    ]);
  });

  test('a tool error is preserved in the response text', () => {
    const signature = encodeSignatureCarrier({
      signature: 'sig-tool',
      kind: 'tool',
      callId: 'call-1',
    });
    const { payload } = translate({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'x', signature }, toolUse],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'ENOENT' }],
              is_error: true,
            },
          ],
        },
      ],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(payload.contents[2].parts[0]).toMatchObject({
      functionResponse: { response: { output: 'Error: ENOENT' } },
    });
  });

  test('an orphan result with no tool call becomes text', () => {
    const { payload } = translate({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'unknown', content: 'x' },
          ],
        },
      ],
    });
    expect(payload.contents[0].parts).toEqual([{ text: '[工具结果] x' }]);
  });

  test('a result for a flattened call becomes text, not a functionResponse', () => {
    const { payload } = translate({
      messages: [
        { role: 'assistant', content: [toolUse] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'body' },
          ],
        },
      ],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(payload.contents[2].parts).toEqual([
      { text: '[工具 read_file 结果] body' },
    ]);
  });

  test('a tool_use in a user turn is not treated as a function call', () => {
    const { payload } = translate({
      messages: [{ role: 'user', content: [toolUse] }],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(payload.contents[0].parts).toEqual([{ text: '(empty)' }]);
  });
});

describe('translateAnthropicRequest — generation settings', () => {
  test('caps max_tokens at the model limit and defaults when absent', () => {
    expect(
      translate({
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 200_000,
      }).payload.generationConfig?.maxOutputTokens,
    ).toBe(65_536);
    expect(
      translate({ messages: [{ role: 'user', content: 'x' }] }).payload
        .generationConfig?.maxOutputTokens,
    ).toBe(32_000);
    expect(
      translate({
        messages: [{ role: 'user', content: 'x' }],
        max_tokens: 1_000,
      }).payload.generationConfig?.maxOutputTokens,
    ).toBe(1_000);
  });

  test('carries sampling settings and the first five stop sequences', () => {
    const { payload } = translate({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.4,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(payload.generationConfig).toMatchObject({
      temperature: 0.4,
      topP: 0.9,
      topK: 40,
      stopSequences: ['a', 'b', 'c', 'd', 'e'],
    });
  });

  test('maps enabled thinking to a thought budget above the model minimum', () => {
    const { payload } = translate({
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 64 },
    });
    expect(payload.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 256,
    });
  });

  test('thinking without a budget still asks for thoughts', () => {
    const { payload } = translate({
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled' },
    });
    expect(payload.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
    });
  });

  test('an unknown model keeps the requested output size', () => {
    const { payload } = translateAnthropicRequest(
      { messages: [{ role: 'user', content: 'x' }], max_tokens: 100_000 },
      null,
    );
    expect(payload.generationConfig?.maxOutputTokens).toBe(100_000);
  });
});

describe('normalizeRequestModel', () => {
  test.each([
    ['gemini-4-argon-medium', 'gemini-4-argon-medium'],
    ['gemini-4-argon-medium[1m]', 'gemini-4-argon-medium'],
    ['  gemini-4-argon-medium [1M] ', 'gemini-4-argon-medium'],
    [undefined, ''],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeRequestModel(input)).toBe(expected);
  });
});

describe('sanitizeSchema', () => {
  test('maps a nullable union to a single type plus nullable', () => {
    expect(sanitizeSchema({ type: ['string', 'null'] })).toEqual({
      type: 'STRING',
      nullable: true,
    });
  });

  test('converts const and numeric enums into Gemini enums', () => {
    expect(sanitizeSchema({ const: 'fixed' })).toEqual({ enum: ['fixed'] });
    expect(sanitizeSchema({ enum: [1, 2] })).toEqual({ enum: ['1', '2'] });
  });

  test('recurses into arrays and fills a missing item schema', () => {
    expect(sanitizeSchema({ type: 'array' })).toEqual({
      type: 'ARRAY',
      items: { type: 'STRING' },
    });
    expect(
      sanitizeSchema({ type: 'array', items: { type: 'number' } }),
    ).toEqual({ type: 'ARRAY', items: { type: 'NUMBER' } });
  });

  test('an object without properties keeps a valid empty shape', () => {
    expect(sanitizeSchema({ type: 'object' })).toEqual({
      type: 'OBJECT',
      properties: {},
    });
  });

  test('oneOf is sent as anyOf and bounds are preserved', () => {
    const schema = sanitizeSchema({
      type: 'object',
      properties: {
        value: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      additionalProperties: false,
      minimum: 1,
    });
    expect(schema).toEqual({
      type: 'OBJECT',
      properties: {
        value: { anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }] },
      },
      minimum: 1,
    });
    // Unknown keys such as additionalProperties are dropped.
    expect(schema).not.toHaveProperty('additionalProperties');
  });

  test('non-object input degrades to a generic object', () => {
    expect(sanitizeSchema(null)).toEqual({ type: 'OBJECT' });
    expect(sanitizeSchema('nope')).toEqual({ type: 'OBJECT' });
  });
});
