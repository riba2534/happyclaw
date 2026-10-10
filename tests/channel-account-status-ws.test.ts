import { WebSocket } from 'ws';
import { afterEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  clients: new Map<any, any>(),
  sessions: new Map<string, any>(),
}));

vi.mock('../src/web-context.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    wsClients: harness.clients,
    getCachedSessionWithUser: (sessionId: string) =>
      harness.sessions.get(sessionId),
    invalidateSessionCache: vi.fn(),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { broadcastChannelAccountStatus, broadcastWhatsAppStatus } =
  await import('../src/web.js');

afterEach(() => {
  harness.clients.clear();
  harness.sessions.clear();
});

function addClient(sessionId: string, userId: string) {
  const client = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
  };
  harness.sessions.set(sessionId, {
    id: sessionId,
    user_id: userId,
    username: userId,
    role: 'member',
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  harness.clients.set(client, { sessionId });
  return client;
}

describe('account-scoped channel status WebSocket event', () => {
  test('WhatsApp status always identifies the account and is user-isolated', () => {
    const owner = addClient('session-owner', 'ws-owner');
    const other = addClient('session-other', 'ws-other');
    broadcastWhatsAppStatus('ws-owner', 'whatsapp-account-a', {
      status: 'qr',
      qrDataUrl: 'data:image/png;base64,account-a',
    });

    expect(owner.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(owner.send.mock.calls[0][0])).toEqual({
      type: 'whatsapp_status',
      userId: 'ws-owner',
      accountId: 'whatsapp-account-a',
      status: 'qr',
      qrDataUrl: 'data:image/png;base64,account-a',
    });
    expect(other.send).not.toHaveBeenCalled();
  });

  test('two account events remain distinguishable on one user connection', () => {
    const owner = addClient('session-owner', 'ws-owner');
    broadcastWhatsAppStatus('ws-owner', 'whatsapp-account-a', {
      status: 'connecting',
    });
    broadcastWhatsAppStatus('ws-owner', 'whatsapp-account-b', {
      status: 'connected',
      meJid: 'bot-b@s.whatsapp.net',
    });
    const messages = owner.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(messages.map((message) => message.accountId)).toEqual([
      'whatsapp-account-a',
      'whatsapp-account-b',
    ]);
    expect(messages[0].status).toBe('connecting');
    expect(messages[1]).toMatchObject({
      status: 'connected',
      meJid: 'bot-b@s.whatsapp.net',
    });
  });

  test('generic reconnect state includes the account and stays user-isolated', () => {
    const owner = addClient('session-owner', 'ws-owner');
    const other = addClient('session-other', 'ws-other');

    broadcastChannelAccountStatus('ws-owner', 'wechat-account-a', {
      transportStatus: 'reconnecting',
      lastError: '连接微信服务超时，HappyClaw 正在自动重试',
      errorCode: 'connect_timeout',
      consecutiveFailures: 2,
      nextRetryMs: 6000,
    });

    expect(JSON.parse(owner.send.mock.calls[0][0])).toMatchObject({
      type: 'channel_account_status',
      userId: 'ws-owner',
      accountId: 'wechat-account-a',
      transportStatus: 'reconnecting',
      errorCode: 'connect_timeout',
      consecutiveFailures: 2,
      nextRetryMs: 6000,
    });
    expect(other.send).not.toHaveBeenCalled();
  });
});

describe('broadcast backpressure', () => {
  test('drops a client only after its send buffer stays backed up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { MAX_WS_BUFFERED_BYTES } = await import('../src/web.js');
      const healthy = addClient('session-healthy', 'ws-owner');
      const stalled = Object.assign(addClient('session-stalled', 'ws-owner'), {
        bufferedAmount: MAX_WS_BUFFERED_BYTES + 1,
        terminate: vi.fn(),
      });
      const status = () =>
        broadcastWhatsAppStatus('ws-owner', 'whatsapp-account-a', {
          status: 'connected',
        } as any);

      // A brief burst (two observations within the grace) keeps the client.
      status();
      vi.advanceTimersByTime(4_000);
      status();
      expect(stalled.terminate).not.toHaveBeenCalled();
      expect(stalled.send).toHaveBeenCalledTimes(2);

      // Still over the limit after the grace period: dropped.
      vi.advanceTimersByTime(7_000);
      status();
      expect(stalled.terminate).toHaveBeenCalledTimes(1);
      expect(harness.clients.has(stalled)).toBe(false);
      expect(healthy.send).toHaveBeenCalledTimes(3);
      expect(harness.clients.has(healthy)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
