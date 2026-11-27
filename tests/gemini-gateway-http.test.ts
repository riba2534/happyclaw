import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getProviderById: vi.fn(),
  persistCredentials: vi.fn(),
  persistRefreshError: vi.fn(),
  fetch: vi.fn(),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  getProviderById: mocks.getProviderById,
  updateProviderGeminiOAuthCredentialsIfCurrent: mocks.persistCredentials,
  setProviderGeminiOAuthRefreshErrorIfCurrent: mocks.persistRefreshError,
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../src/gemini-gateway/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshGeminiToken: vi.fn(),
}));

const { geminiGatewayApp } = await import('../src/gemini-gateway/gateway.js');
const { resetGeminiTokenStateForTest } =
  await import('../src/gemini-gateway/token-manager.js');
const { GEMINI_API_BASE, GEMINI_API_VERSION } =
  await import('../src/gemini-gateway/types.js');
const { refreshGeminiToken } = await import('../src/gemini-gateway/oauth.js');

const LOCAL_RUNNER = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const encoder = new TextEncoder();
let provider: Record<string, unknown>;

function sseChunk(body: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(body)}\n\n`);
}
function upstreamStream(chunks: unknown[] = [textChunk('hi')]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(sseChunk(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function textChunk(text: string) {
  return { response: { candidates: [{ content: { parts: [{ text }] } }] } };
}
function jsonResponse(status: number, body: unknown, headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function request(
  payload: unknown = { messages: [{ role: 'user', content: 'hi' }] },
  init: RequestInit = {},
  env: unknown = LOCAL_RUNNER,
  path = '/v1/messages',
): Promise<Response> {
  return geminiGatewayApp.request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'runner-secret',
      },
      body: JSON.stringify(payload),
      ...init,
    },
    env as never,
  );
}
function sentBody(call = 0): Record<string, any> {
  return JSON.parse(String(mocks.fetch.mock.calls[call][1]?.body));
}
async function readSse(response: Response): Promise<string> {
  return await response.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetGeminiTokenStateForTest();
  provider = {
    id: 'gemini-provider',
    anthropicAuthToken: 'runner-secret',
    anthropicModel: 'gemini-4-argon-medium',
    geminiOAuthCredentials: {
      accessToken: 'google-access',
      refreshToken: 'google-refresh',
      expiresAt: Date.now() + 3_600_000,
      email: 'user@example.invalid',
      accountId: 'google-id',
      projectId: 'project-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    geminiOAuthLastRefreshError: null,
    geminiModels: [
      {
        id: 'gemini-4-argon-medium',
        displayName: 'Gemini 4 Argon (Medium)',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        supportsThinking: true,
      },
      {
        id: 'gemini-4-aurora-low',
        displayName: 'Gemini 4 Aurora (Low)',
        contextWindow: 524_288,
        maxOutputTokens: 32_768,
        supportsThinking: true,
      },
    ],
  };
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.getProviderById.mockImplementation(() => structuredClone(provider));
  mocks.persistCredentials.mockImplementation((_id, _expected, refreshed) => {
    provider.geminiOAuthCredentials = refreshed;
    provider.geminiOAuthLastRefreshError = null;
    return true;
  });
  mocks.persistRefreshError.mockImplementation((_id, _expected, state) => {
    provider.geminiOAuthLastRefreshError = state;
    return true;
  });
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (input: RequestInfo | URL) =>
    String(input).includes('streamGenerateContent')
      ? upstreamStream()
      : jsonResponse(200, textChunk('hi')),
  );
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gemini gateway authentication and source guard', () => {
  test('rejects a missing or unknown key before calling upstream', async () => {
    expect(
      (
        await request(undefined, {
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(undefined, {
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'nope',
          },
        })
      ).status,
    ).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('accepts a Bearer token as well as x-api-key', async () => {
    const response = await request(undefined, {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer runner-secret',
      },
    });
    expect(response.status).toBe(200);
  });

  test.each([
    [
      'public source',
      { incoming: { socket: { remoteAddress: '203.0.113.9' } } },
      {},
    ],
    ['missing socket', {}, {}],
    ['X-Forwarded-For', LOCAL_RUNNER, { 'x-forwarded-for': '203.0.113.9' }],
    ['Forwarded', LOCAL_RUNNER, { forwarded: 'for=203.0.113.9' }],
  ])('rejects %s even with a valid key', async (_label, env, extraHeaders) => {
    const response = await request(
      undefined,
      {
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'runner-secret',
          ...extraHeaders,
        },
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { type: 'permission_error' },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test.each(['10.1.2.3', '172.17.0.2', '192.168.65.1', '::1', 'fd00::2'])(
    'accepts runner traffic from %s',
    async (remoteAddress) => {
      const response = await request(
        undefined,
        {},
        { incoming: { socket: { remoteAddress } } },
      );
      expect(response.status).toBe(200);
    },
  );
});

describe('Gemini gateway request handling', () => {
  test('rejects a body that is not an Anthropic request', async () => {
    expect((await request(null)).status).toBe(400);
    expect((await request({ messages: 'nope' })).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('streams Anthropic SSE frames and strips the [1m] marker', async () => {
    provider.anthropicModel = 'gemini-4-argon-medium[1m]';
    const response = await request({
      model: 'gemini-4-aurora-low[1m]',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await readSse(response);
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_stop');
    expect(body).not.toContain('[DONE]');
    expect(sentBody()).toMatchObject({
      model: 'gemini-4-aurora-low',
      userAgent: 'antigravity',
      requestType: 'agent',
      project: 'project-1',
    });
    const upstreamUrl = String(mocks.fetch.mock.calls[0][0]);
    expect(upstreamUrl).toBe(
      `${GEMINI_API_BASE}/${GEMINI_API_VERSION}:streamGenerateContent?alt=sse`,
    );
  });

  test.each([
    ['an unknown model', 'gemini-9-unknown'],
    ['a Claude background model', 'claude-haiku-4-5'],
  ])('%s falls back to the connection model', async (_label, model) => {
    await request({ model, messages: [{ role: 'user', content: 'hi' }] });
    expect(sentBody().model).toBe('gemini-4-argon-medium');
  });

  test('returns a non-stream request as one folded message', async () => {
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const message = await response.json();
    expect(message).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'gemini-4-argon-medium',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  test('a non-stream upstream body without the response envelope still folds', async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }),
    );
    const message = await (
      await request({
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })
    ).json();
    expect(message.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  test('a missing project id asks for a new login instead of calling upstream', async () => {
    (provider.geminiOAuthCredentials as Record<string, unknown>).projectId =
      null;
    const response = await request();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_request_error' },
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('count_tokens estimates locally without an upstream call', async () => {
    const response = await request(
      {
        messages: [{ role: 'user', content: 'abcdefgh' }],
        system: '1234',
      },
      {},
      LOCAL_RUNNER,
      '/v1/messages/count_tokens',
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('a re-login requirement becomes a non-retryable 401', async () => {
    provider.geminiOAuthLastRefreshError = {
      kind: 'reauth_required',
      message: 'invalid_grant',
      at: '2026-01-01T00:00:00.000Z',
    };
    const response = await request();
    expect(response.status).toBe(401);
    expect(response.headers.get('x-should-retry')).toBe('false');
  });
});

describe('Gemini gateway upstream failures', () => {
  test.each([
    [429, 429, 'rate_limit_error'],
    [400, 400, 'invalid_request_error'],
    [404, 400, 'invalid_request_error'],
    [500, 502, 'api_error'],
  ])('maps upstream %s to %s', async (upstream, expected, type) => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(upstream, { error: { status: 'FAILED', message: 'nope' } }),
    );
    const response = await request();
    expect(response.status).toBe(expected);
    expect(await response.json()).toMatchObject({ error: { type } });
  });

  test('a 401 refreshes the Google token once and retries the same body', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        jsonResponse(401, { error: { message: 'expired' } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, textChunk('rotated reply')));
    vi.mocked(refreshGeminiToken).mockResolvedValueOnce({
      accessToken: 'rotated',
      refreshToken: null,
      idToken: null,
      scope: null,
      expiresAt: Date.now() + 3_600_000,
    });
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
    expect(response.status).toBe(200);
    expect(refreshGeminiToken).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(
      (mocks.fetch.mock.calls[1][1]?.headers as Record<string, string>)
        .Authorization,
    ).toBe('Bearer rotated');
  });

  test('a second 401 persists reauth_required and stops', async () => {
    mocks.fetch.mockResolvedValue(
      jsonResponse(401, { error: { message: 'expired' } }),
    );
    vi.mocked(refreshGeminiToken).mockResolvedValueOnce({
      accessToken: 'rotated',
      refreshToken: null,
      idToken: null,
      scope: null,
      expiresAt: Date.now() + 3_600_000,
    });
    const response = await request();
    expect(response.status).toBe(401);
    expect(provider.geminiOAuthLastRefreshError).toMatchObject({
      kind: 'reauth_required',
    });
  });

  test('an unreachable upstream is a 502 with a readable message', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const response = await request();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('连接失败') },
    });
  });

  test('a replayed signature rejection retries once without function calls', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: {
            status: 'INVALID_ARGUMENT',
            message: 'function call part is missing thought_signature',
          },
        }),
      )
      .mockResolvedValueOnce(upstreamStream());
    const signatureHistory = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'read_file',
      input: { path: '/tmp/x' },
    };
    const response = await request({
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: [signatureHistory] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' },
          ],
        },
      ],
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    });
    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const first = JSON.stringify(sentBody(0).request.contents);
    const retried = JSON.stringify(sentBody(1).request.contents);
    expect(first).toContain('[调用工具 read_file]');
    expect(first).not.toContain('functionCall');
    expect(retried).not.toContain('thoughtSignature');
  });
});
