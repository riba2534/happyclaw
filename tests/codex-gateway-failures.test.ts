import { describe, expect, test } from 'vitest';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
} from '../src/codex-gateway/convert-response.js';

const created = {
  type: 'response.created',
  response: { id: 'r1', model: 'gpt-6-sol' },
};

describe('Codex upstream failure semantics', () => {
  test('premature EOF emits error rather than a successful stop', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(created);
    const events = converter.finish();
    expect(events.map(({ event }) => event)).toEqual(['error']);
    expect(events[0].data).toMatchObject({ type: 'error' });
  });

  test.each([
    [created],
    [
      created,
      { type: 'response.failed', response: { error: { message: 'quota' } } },
    ],
    [created, { type: 'error', message: 'backend error' }],
  ])(
    'aggregation rejects missing success terminal or upstream failure',
    (...events) => {
      expect(() => aggregateResponsesStream(events, 'gpt-6-sol')).toThrow();
    },
  );

  // 实测上游形态：裸 error 事件把详情挂在 error.{type,code,message} 下。
  const flaggedPrompt = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'invalid_prompt',
      message: 'Invalid prompt: your prompt was flagged.',
    },
  };

  test('bare error event keeps upstream reason and non-retryable type', () => {
    const converter = new ResponsesToAnthropicConverter('gpt-6-sol');
    converter.handleEvent(created);
    const [event] = converter.handleEvent(flaggedPrompt);
    expect(event.data).toMatchObject({
      type: 'error',
      error: { type: 'invalid_request_error' },
    });
    const message = String((event.data.error as { message: string }).message);
    expect(message).toContain('invalid_prompt');
    expect(message).toContain('Invalid prompt: your prompt was flagged.');
    expect(converter.getFailure()).toMatchObject({
      type: 'invalid_request_error',
      code: 'invalid_prompt',
    });
  });

  test('aggregation surfaces typed upstream failure', () => {
    expect(() =>
      aggregateResponsesStream([created, flaggedPrompt], 'gpt-6-sol'),
    ).toThrow(
      expect.objectContaining({
        name: 'CodexUpstreamError',
        errorType: 'invalid_request_error',
        status: 400,
      }),
    );
  });

  test.each([
    [
      {
        type: 'error',
        error: { code: 'rate_limit_exceeded', message: 'slow' },
      },
      'rate_limit_error',
      429,
    ],
    [
      { type: 'error', error: { type: 'server_error', message: 'boom' } },
      'api_error',
      502,
    ],
    [
      {
        type: 'response.failed',
        response: { error: { code: 'usage_limit_reached', message: 'quota' } },
      },
      'rate_limit_error',
      429,
    ],
  ])(
    'maps upstream failure %# to Anthropic error type',
    (failure, type, status) => {
      expect(() =>
        aggregateResponsesStream([created, failure], 'gpt-6-sol'),
      ).toThrow(expect.objectContaining({ errorType: type, status }));
    },
  );

  test('premature EOF is a retryable api_error', () => {
    expect(() => aggregateResponsesStream([created], 'gpt-6-sol')).toThrow(
      expect.objectContaining({ errorType: 'api_error', status: 502 }),
    );
  });

  test('completed response still succeeds', () => {
    expect(
      aggregateResponsesStream(
        [created, { type: 'response.completed', response: {} }],
        'gpt-6-sol',
      ).stopReason,
    ).toBe('end_turn');
  });
});
