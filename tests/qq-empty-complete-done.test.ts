import { describe, expect, test, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger }));

import { QQStreamingController } from '../src/qq-streaming-card.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';
import { PartialChannelDeliveryError } from '../src/im-delivery-progress.js';

describe('QQStreamingController empty complete() after visible GENERATING stream', () => {
  test('visible stream completed with empty text sends prefix-safe DONE and acknowledges', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const send = vi.fn(async () => {
        calls += 1;
        return { id: calls === 1 ? 'stream-visible' : 'stream-done' };
      });
      const fallback = vi.fn(async () => {});
      const controller = new QQStreamingController({
        openid: 'user',
        msgSeq: 1,
        passiveMsgId: 'message',
        sendStreamChunk: send,
        fallbackSend: fallback,
      });

      controller.append('visible preview');
      await vi.advanceTimersByTimeAsync(600);

      const finalized = await finalizeChannelCardAfterDelivery(
        controller,
        '',
        true,
        'delivery failed',
      );

      expect(finalized).toEqual({ acknowledged: true });
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][1]).toMatchObject({
        input_state: 10,
        content_raw: 'visible preview',
        stream_msg_id: 'stream-visible',
      });
      expect(fallback).not.toHaveBeenCalled();
      expect(controller.getAcknowledgedProviderOutputCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('idle controller completed with empty text is a no-op without sending chunks', async () => {
    const send = vi.fn(async () => ({ id: 'stream-id' }));
    const fallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 1,
      passiveMsgId: 'message',
      sendStreamChunk: send,
      fallbackSend: fallback,
    });

    const finalized = await finalizeChannelCardAfterDelivery(
      controller,
      '',
      true,
      'delivery failed',
    );

    expect(finalized).toEqual({ acknowledged: true });
    expect(send).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(controller.getAcknowledgedProviderOutputCount()).toBe(0);
  });

  test('visible stream DONE failure on empty complete turns into PartialChannelDeliveryError without fallback', async () => {
    vi.useFakeTimers();
    try {
      const error = new Error('QQ API stream DONE failed');
      let calls = 0;
      const send = vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw error;
        return { id: 'stream-visible' };
      });
      const fallback = vi.fn(async () => {});
      const controller = new QQStreamingController({
        openid: 'user',
        msgSeq: 1,
        passiveMsgId: 'message',
        sendStreamChunk: send,
        fallbackSend: fallback,
      });

      controller.append('visible preview');
      await vi.advanceTimersByTimeAsync(600);

      const finalized = await finalizeChannelCardAfterDelivery(
        controller,
        '',
        true,
        'delivery failed',
      );

      expect(finalized.acknowledged).toBe(false);
      expect(finalized.error).toBeInstanceOf(PartialChannelDeliveryError);
      expect(finalized.error).toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        cause: error,
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('visible stream with empty/whitespace baseline sends empty-notice on empty complete', async () => {
    const send = vi.fn(async () => ({ id: 'stream-done' }));
    const fallback = vi.fn(async () => {});
    const controller = new QQStreamingController({
      openid: 'user',
      msgSeq: 1,
      passiveMsgId: 'message',
      sendStreamChunk: send,
      fallbackSend: fallback,
    });
    (controller as any).streamMsgId = 'stream-visible';
    (controller as any).sentChunkCount = 1;

    const finalized = await finalizeChannelCardAfterDelivery(
      controller,
      '   ',
      true,
      'delivery failed',
    );

    expect(finalized).toEqual({ acknowledged: true });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toMatchObject({
      input_state: 10,
      content_raw: '> ⚠️ 本次运行没有生成可展示的最终内容。',
      stream_msg_id: 'stream-visible',
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(controller.getAcknowledgedProviderOutputCount()).toBe(2);
  });
});
