import { describe, expect, test, vi } from 'vitest';

import {
  buildMessagesUrl,
  connectionTestResult,
  parseCustomHeaders,
  probeProviderModel,
  redact,
  testProviderConnectivity,
} from '../src/provider-connectivity.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('provider connectivity probe', () => {
  test('sends the same request shape Claude Code would', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'msg_1' }));
    const probe = await probeProviderModel(
      {
        baseUrl: 'https://api.kimi.com/coding/',
        token: 'sk-kimi-123456789',
        authMode: 'bearer',
        model: 'kimi-for-coding[1m]',
        customHeaders: 'X-Upstream-Format: responses\nbad header',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(probe).toMatchObject({
      ok: true,
      status: 200,
      model: 'kimi-for-coding',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.kimi.com/coding/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-kimi-123456789');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['x-upstream-format']).toBe('responses');
    expect(headers['user-agent']).toMatch(/^claude-cli/);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'kimi-for-coding',
      max_tokens: 16,
    });
  });

  test('sends a fresh Claude Code session id, the header session-routed gateways need', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 'msg_1' }));
    const probe = (customHeaders?: string) =>
      probeProviderModel(
        {
          baseUrl: 'https://opencode.ai/zen/go',
          token: 'sk-opencode-123456789',
          authMode: 'x-api-key',
          model: 'minimax-m3',
          customHeaders,
        },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      );
    await probe();
    await probe();
    await probe('X-Claude-Code-Session-Id: pinned-by-user');
    const sessions = fetchImpl.mock.calls.map(
      (call) =>
        (
          (call as unknown as [string, RequestInit])[1].headers as Record<
            string,
            string
          >
        )['x-claude-code-session-id'],
    );
    expect(sessions[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(sessions[1]).not.toBe(sessions[0]);
    expect(sessions[2]).toBe('pinned-by-user');
    const headers = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    )[1].headers as Record<string, string>;
    expect(headers['x-opencode-session']).toBeUndefined();
  });

  test('explains an auth failure without echoing the key', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, {
        error: { message: 'invalid key sk-kimi-123456789 for this account' },
      }),
    );
    const probe = await probeProviderModel(
      {
        baseUrl: 'https://api.kimi.com/coding',
        token: 'Bearer sk-kimi-123456789',
        authMode: 'x-api-key',
        model: '',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(probe.ok).toBe(false);
    expect(probe.status).toBe(401);
    expect(probe.message).not.toContain('sk-kimi-123456789');
    expect(probe.hint).toContain('Bearer');
    const headers = (
      fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    )[1].headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-kimi-123456789');
    // A pass-through relay is probed with a Claude model name.
    expect(probe.model).toBe('claude-haiku-5-5');
  });

  test('flags a /v1 path and unreachable endpoints', async () => {
    const notFound = await probeProviderModel(
      {
        baseUrl: 'https://relay.test/v1',
        token: 'tok-abcdef',
        authMode: 'bearer',
        model: 'm',
      },
      {
        fetchImpl: (async () =>
          new Response('Not Found', {
            status: 404,
          })) as unknown as typeof fetch,
      },
    );
    expect(notFound.hint).toContain('/v1');

    const offline = await probeProviderModel(
      {
        baseUrl: 'https://relay.test',
        token: 'tok-abcdef',
        authMode: 'bearer',
        model: 'm',
      },
      {
        fetchImpl: (async () => {
          throw new TypeError('fetch failed');
        }) as unknown as typeof fetch,
      },
    );
    expect(offline).toMatchObject({ ok: false, status: null });
    expect(offline.hint).toContain('无法连接');
  });

  test('also probes a distinct Haiku mapping', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const result = await testProviderConnectivity(
      {
        baseUrl: 'https://api.deepseek.com/anthropic',
        token: 'tok-abcdef',
        authMode: 'bearer',
        model: 'deepseek-v4-pro[1m]',
        haikuModel: 'deepseek-v4-flash[1m]',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    expect(result.probes.map((probe) => probe.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
  });

  test('redacts a key echoed JSON-escaped and the custom header values', async () => {
    const key = 'bce-v3/ALTAK-abcdefgh/0123456789abcdef';
    const escaped = JSON.stringify({ detail: { key } }).replace(/\//g, '\\/');
    expect(redact(escaped, [key])).not.toContain('0123456789abcdef');

    const probe = await probeProviderModel(
      {
        baseUrl: 'https://relay.test',
        token: 'tok-abcdef-123',
        authMode: 'bearer',
        model: 'm',
        customHeaders: 'X-Tenant-Secret: tenant-secret-42',
      },
      {
        fetchImpl: (async () =>
          new Response('rejected tenant tenant-secret-42', {
            status: 403,
          })) as unknown as typeof fetch,
      },
    );
    expect(probe.message).toBe('rejected tenant ***');
  });

  test('strips the 1M suffix the way model lists read it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const probe = await probeProviderModel(
      {
        baseUrl: 'https://relay.test',
        token: 'tok-abcdef',
        authMode: 'bearer',
        model: ' glm-5[1M] ',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(probe.model).toBe('glm-5');
  });

  test('a test whose failing probe got no answer records no status', () => {
    const result = connectionTestResult(
      {
        ok: false,
        probes: [
          { model: 'glm-5', ok: true, status: 200, latencyMs: 80 },
          {
            model: 'glm-5-flash',
            ok: false,
            status: null,
            latencyMs: 20_000,
            message: 'timeout',
            code: 'TIMEOUT',
          },
        ],
      },
      { model: 'glm-5' },
    );
    expect(result.record).toMatchObject({
      ok: false,
      code: 'TIMEOUT',
      status: null,
      latencyMs: 80,
    });
  });

  test('helpers', () => {
    expect(buildMessagesUrl('https://a.test/anthropic//')).toBe(
      'https://a.test/anthropic/v1/messages',
    );
    expect(parseCustomHeaders('A: 1\r\n: skip\nB:two:three')).toEqual([
      ['A', '1'],
      ['B', 'two:three'],
    ]);
  });
});
