import { describe, expect, test } from 'vitest';

import {
  channelOutboxFailureDetail,
  channelRejectionAgentGuidance,
  describeChannelDeliveryFailure,
  isFeishuCardContentRejection,
  rememberChannelOutboxFailure,
  withChannelFailureReason,
} from '../src/channel-delivery-failure.js';
import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';
import { PartialChannelDeliveryError } from '../src/im-delivery-progress.js';
import { classifyImSendFailure } from '../src/im-send-retry-policy.js';

const axios = (status: number, code: number) => ({
  code: 'ERR_BAD_REQUEST',
  message: `Request failed with status code ${status}`,
  response: { status, data: { code, msg: 'x' }, headers: {} },
});

class FeishuCardContentRejectedError extends Error {
  constructor(cause: unknown) {
    super('card body rejected', { cause });
    this.name = 'FeishuCardContentRejectedError';
  }
}

describe('channel delivery failure detail', () => {
  test('reads the Feishu cause behind a host definitive rejection', () => {
    const dlp = new DefinitiveChannelDeliveryError('Feishu rejected', {
      cause: axios(400, 230028),
    });
    expect(describeChannelDeliveryFailure(dlp)).toMatchObject({
      kind: 'content_rejected',
      code: 230028,
      reason: '内容含邮箱等敏感信息，被飞书安全策略拦截',
      contentRejected: true,
      targetUnavailable: false,
    });
    const recalled = new DefinitiveChannelDeliveryError('gone', {
      cause: axios(400, 230011),
    });
    expect(describeChannelDeliveryFailure(recalled)).toMatchObject({
      kind: 'target_unavailable',
      targetUnavailable: true,
    });
  });

  test('non-Feishu failures carry no provider detail', () => {
    expect(describeChannelDeliveryFailure(new Error('ETIMEDOUT'))).toEqual({
      targetUnavailable: false,
      contentRejected: false,
    });
  });

  test('remembers the detail per Outbox row', () => {
    rememberChannelOutboxFailure(
      'outbox-dlp',
      new DefinitiveChannelDeliveryError('x', { cause: axios(400, 230028) }),
    );
    expect(channelOutboxFailureDetail('outbox-dlp')?.reason).toContain(
      '敏感信息',
    );
    expect(channelOutboxFailureDetail('missing')).toBeUndefined();
  });

  test('notices and tool results state the reason (prod P2-6)', () => {
    expect(withChannelFailureReason('未能送达。', '内容含邮箱')).toBe(
      '未能送达。\n原因：内容含邮箱。',
    );
    expect(withChannelFailureReason('未能送达。', undefined)).toBe(
      '未能送达。',
    );
    const guidance = channelRejectionAgentGuidance(
      describeChannelDeliveryFailure(axios(400, 230028)),
    );
    expect(guidance).toContain('内容含邮箱等敏感信息');
    expect(guidance).toContain('send it again');
    expect(
      channelRejectionAgentGuidance(
        describeChannelDeliveryFailure(axios(400, 231003)),
      ),
    ).toContain('Do not retry');
  });
});

describe('refused Feishu card body (outbound P1-4)', () => {
  test('is an explicit rejection, never uncertain', () => {
    const error = new FeishuCardContentRejectedError(axios(400, 230099));
    expect(isFeishuCardContentRejection(error)).toBe(true);
    expect(classifyImSendFailure(error)).toBe('rejected');
    // Wrapped in partial-ACK evidence it no longer proves nothing became
    // visible, so the acknowledged prefix keeps the outcome uncertain.
    expect(
      classifyImSendFailure(new PartialChannelDeliveryError(1, 2, error)),
    ).toBe('uncertain');
  });

  test('other card failures keep their classification', () => {
    expect(
      classifyImSendFailure(
        new PartialChannelDeliveryError(1, 2, new Error('timeout')),
      ),
    ).toBe('uncertain');
  });
});

describe('Feishu capability refusals (outbound review follow-up)', () => {
  test('a capability refusal is rejected; an unreachable Feishu is pre-accept', async () => {
    const {
      DefinitiveFeishuCapabilityError,
      definitiveFeishuHttpRejection,
      definitiveFeishuPreAcceptanceFailure,
    } = await import('../src/feishu-capability.js');
    expect(
      classifyImSendFailure(definitiveFeishuHttpRejection(axios(400, 230002))),
    ).toBe('rejected');
    expect(
      classifyImSendFailure(
        new DefinitiveFeishuCapabilityError(
          'Current Feishu chat id is missing',
        ),
      ),
    ).toBe('rejected');
    expect(
      classifyImSendFailure(
        definitiveFeishuPreAcceptanceFailure(
          Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
        ),
      ),
    ).toBe('pre_accept');
  });

  test('a raw Feishu 4xx is rejected; 5xx and 408 stay uncertain', () => {
    expect(classifyImSendFailure(axios(400, 230028))).toBe('rejected');
    expect(classifyImSendFailure(axios(502, 9999))).toBe('uncertain');
    expect(classifyImSendFailure(axios(408, 408))).toBe('uncertain');
  });
});

describe('refused card body text (outbound P1-4, cross-review M3)', () => {
  test('a terminalized refused card hands over exactly the text it never showed', async () => {
    const { feishuCardStaticFallbackText } =
      await import('../src/channel-delivery-failure.js');
    const error = Object.assign(
      new FeishuCardContentRejectedError(axios(400, 11310)),
      { undeliveredText: 'page 2 and 3', cardTerminalized: true },
    );
    expect(feishuCardStaticFallbackText(error)).toBe('page 2 and 3');
    expect(classifyImSendFailure(error)).toBe('rejected');
    expect(feishuCardStaticFallbackText(new Error('x'))).toBeUndefined();
  });

  test('a refused card that could not be terminalized gets no static copy and stays uncertain', async () => {
    const { feishuCardStaticFallbackText } =
      await import('../src/channel-delivery-failure.js');
    const error = Object.assign(
      new FeishuCardContentRejectedError(axios(400, 300317)),
      { undeliveredText: 'whole reply', cardTerminalized: false },
    );
    expect(feishuCardStaticFallbackText(error)).toBeUndefined();
    expect(classifyImSendFailure(error)).toBe('uncertain');
  });
});

describe('contract with the real card controller error', () => {
  test('field names and classification line up with feishu-streaming-card', async () => {
    const { FeishuCardContentRejectedError: RealError } =
      await import('../src/feishu-streaming-card.js');
    const { feishuCardStaticFallbackText } =
      await import('../src/channel-delivery-failure.js');
    const terminalized = new RealError({
      cause: axios(400, 230099),
      undeliveredText: 'body',
    });
    expect(feishuCardStaticFallbackText(terminalized)).toBe('body');
    expect(classifyImSendFailure(terminalized)).toBe('rejected');
    const live = new RealError({
      cause: axios(400, 230099),
      undeliveredText: 'body',
      cardTerminalized: false,
    });
    expect(feishuCardStaticFallbackText(live)).toBeUndefined();
    expect(classifyImSendFailure(live)).toBe('uncertain');
  });
});
