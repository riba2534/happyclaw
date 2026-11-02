import fs from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import {
  appendStreamingSessionAnswer,
  isStreamingSessionSettled,
} from '../src/im-channel.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';

// Regression coverage for issue #629: a freshly-created Feishu streaming
// session sits in 'idle' (card reserved, provider creation deferred to the
// first stream event). The main-runner rotation guard used a bare
// `!isActive()` check, which matched 'idle' too — the session was discarded
// on the very first stream event, beginCreation() never ran, and the durable
// reservation stayed at status=creating until restart recovery fenced it.

describe('isStreamingSessionSettled', () => {
  test('a fresh Feishu controller is idle, inactive, and NOT settled', () => {
    const controller = new StreamingCardController({
      client: {} as any,
      chatId: 'oc_idle_guard',
    });
    expect(controller.currentState).toBe('idle');
    expect(controller.isActive()).toBe(false);
    expect(isStreamingSessionSettled(controller)).toBe(false);
    controller.dispose();
  });

  test('an active session is not settled', () => {
    const session = {
      isActive: () => true,
      currentState: 'streaming',
    };
    expect(isStreamingSessionSettled(session as any)).toBe(false);
  });

  test('a terminal Feishu session is settled and may rotate out', () => {
    for (const currentState of ['completed', 'aborted', 'error']) {
      const session = { isActive: () => false, currentState };
      expect(isStreamingSessionSettled(session as any)).toBe(true);
    }
  });

  test('controllers without a currentState accessor keep prior semantics', () => {
    // DingTalk / Discord / QQ controllers report 'idle' as active inside
    // isActive() itself, so an inactive session there is genuinely terminal.
    const session = { isActive: () => false };
    expect(isStreamingSessionSettled(session as any)).toBe(true);
  });
});

describe('appendStreamingSessionAnswer', () => {
  test('a first main text delta starts an idle Feishu card and persists provider identity', async () => {
    const lifecycleEvents: Array<{
      status: string;
      messageId: string | null;
      cardId: string | null;
      version: number;
      snapshot: { state: string };
    }> = [];
    const cardCreate = vi.fn().mockResolvedValue({
      code: 0,
      data: { card_id: 'card_idle_main_text' },
    });
    const messageCreate = vi.fn().mockResolvedValue({
      data: { message_id: 'om_idle_main_text' },
    });
    const controller = new StreamingCardController({
      client: {
        cardkit: {
          v1: {
            card: {
              create: cardCreate,
              batchUpdate: vi.fn().mockResolvedValue({ code: 0 }),
              settings: vi.fn().mockResolvedValue({ code: 0 }),
              update: vi.fn().mockResolvedValue({ code: 0 }),
            },
            cardElement: {
              content: vi.fn().mockResolvedValue({ code: 0 }),
              update: vi.fn().mockResolvedValue({ code: 0 }),
            },
          },
        },
        im: {
          message: {
            reply: vi.fn().mockResolvedValue({
              data: { message_id: 'om_idle_main_text' },
            }),
          },
          v1: {
            message: {
              create: messageCreate,
              patch: vi.fn().mockResolvedValue({}),
            },
          },
        },
      } as any,
      chatId: 'oc_idle_main_text',
      lifecycle: {
        onEvent: (event) => lifecycleEvents.push(event),
      },
    });

    expect(controller.currentState).toBe('idle');
    expect(controller.isActive()).toBe(false);

    expect(
      appendStreamingSessionAnswer(controller, 'first visible answer'),
    ).toBe(true);
    expect(controller.currentState).toBe('creating');

    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    expect(cardCreate).toHaveBeenCalledTimes(1);
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(lifecycleEvents[0]).toMatchObject({
      status: 'creating',
      messageId: null,
      cardId: null,
      version: 0,
    });
    expect(lifecycleEvents).toContainEqual(
      expect.objectContaining({
        status: 'streaming',
        messageId: 'om_idle_main_text',
        cardId: 'card_idle_main_text',
        version: 1,
        snapshot: expect.objectContaining({ state: 'streaming' }),
      }),
    );
    controller.dispose();
  });

  test('terminal sessions are not reactivated', () => {
    for (const currentState of ['completed', 'aborted', 'error']) {
      const append = vi.fn();
      const session = { isActive: () => false, currentState, append };
      expect(appendStreamingSessionAnswer(session as any, 'late text')).toBe(
        false,
      );
      expect(append).not.toHaveBeenCalled();
    }
  });

  test('other active controllers keep their previous append behavior', () => {
    const append = vi.fn();
    const session = { isActive: () => true, append };
    expect(appendStreamingSessionAnswer(session as any, 'visible text')).toBe(
      true,
    );
    expect(append).toHaveBeenCalledWith('visible text');
  });
});

describe('session text projection', () => {
  const main = fs.readFileSync('src/index.ts', 'utf8');

  test('runtime-session text projection uses the idle-aware append helper', () => {
    // A session card starts idle; an isActive() guard here drops a
    // text-only turn's deltas until the final reply.
    expect(main).toMatch(
      /if \(agentAnswerProjection\?\.visibleAnswerChanged\) \{\s*appendStreamingSessionAnswer\(\s*agentStreamingSession,/,
    );
    expect(main).not.toMatch(
      /agentAnswerProjection\?\.visibleAnswerChanged &&\s*agentStreamingSession\.isActive\(\)/,
    );
  });
});
