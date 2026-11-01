import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getProviderById: vi.fn(),
  persistCredentials: vi.fn(),
  persistRefreshError: vi.fn(),
  fetch: vi.fn(),
  limiters: [] as Array<{ size: number }>,
  logger: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../src/runtime-config.js', () => ({
  getProviders: mocks.getProviders,
  getProviderById: mocks.getProviderById,
  updateProviderCodexOAuthCredentialsIfCurrent: mocks.persistCredentials,
  setProviderCodexOAuthRefreshErrorIfCurrent: mocks.persistRefreshError,
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../src/codex-gateway/model-catalog-sync.js', () => ({
  getResolvedCodexCatalog: () => ({ models: [] }),
  getCodexCatalogForProvider: () => [],
  maybeRefreshCodexProviderCatalog: () => {},
  noteCodexModelsEtag: () => {},
}));
vi.mock(
  '../src/codex-gateway/provider-rate-limit.js',
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import('../src/codex-gateway/provider-rate-limit.js')
      >();
    return {
      CodexProviderRateLimiter: class extends real.CodexProviderRateLimiter {
        constructor() {
          super();
          mocks.limiters.push(this);
        }
      },
    };
  },
);
const { codexGatewayApp } = await import('../src/codex-gateway/gateway.js');
const {
  issueCodexGatewayToken,
  revokeCodexGatewayToken,
  updateLiveSessionEffort,
} = await import('../src/codex-gateway/runner-tokens.js');
const { resetCodexTokenManagerForTests } =
  await import('../src/codex-gateway/token-manager.js');
const { encodeReasoningSignature } =
  await import('../src/codex-gateway/reasoning-signature.js');
const { clearCodexProviderRateLimits, getCodexProviderRateLimits } =
  await import('../src/codex-gateway/rate-limit-snapshot.js');
const { providerPool } = await import('../src/provider-pool.js');
let fixtureNumber = 0;
let runnerToken: string;
let runnerGrant: ReturnType<typeof issueCodexGatewayToken>['grant'];
const LOCAL_RUNNER = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
let provider: Record<string, unknown>;
const encoder = new TextEncoder();
const created = {
  type: 'response.created',
  response: { id: 'resp-http', model: 'gpt-6-sol' },
};
const completed = {
  type: 'response.completed',
  response: {
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: 10,
    },
  },
};
function frame(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}
function upstreamEvents(events = [created, completed]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        events.forEach((event) => c.enqueue(frame(event)));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function request(
  payload: unknown = {
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  },
  key = runnerToken,
  init: RequestInit = {},
  env: unknown = LOCAL_RUNNER,
  path = '/v1/messages',
): Promise<Response> {
  return codexGatewayApp.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(payload),
      ...init,
    },
    env as never,
  );
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
/** Upstream bodies are zstd-compressed like the official client's. */
function upstreamJson(init: {
  headers: Record<string, string>;
  body: string | Uint8Array;
}): Record<string, any> {
  const bytes =
    init.headers['Content-Encoding'] === 'zstd'
      ? zlib.zstdDecompressSync(init.body as Uint8Array)
      : Buffer.from(init.body);
  return JSON.parse(bytes.toString('utf8'));
}
function sentBody(call = 0): Record<string, any> {
  return upstreamJson(mocks.fetch.mock.calls[call][1]);
}
beforeEach(() => {
  vi.clearAllMocks();
  resetCodexTokenManagerForTests();
  provider = {
    id: `provider-${++fixtureNumber}`,
    enabled: true,
    anthropicAuthToken: 'stored-identifier',
    anthropicModel: 'gpt-6-sol',
    customEnv: {},
    codexOAuthCredentials: {
      accessToken: 'fake-upstream',
      refreshToken: 'fake-refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'business-workspace',
    },
    codexOAuthLastRefreshError: null,
  };
  mocks.getProviders.mockImplementation(() => [structuredClone(provider)]);
  mocks.getProviderById.mockImplementation(() => structuredClone(provider));
  mocks.persistCredentials.mockImplementation((_id, _expected, refreshed) => {
    provider.codexOAuthCredentials = refreshed;
    provider.codexOAuthLastRefreshError = null;
    return true;
  });
  mocks.persistRefreshError.mockImplementation((_id, _expected, state) => {
    provider.codexOAuthLastRefreshError = state;
    return true;
  });
  // Drop once-implementations a failed test may have left queued.
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async () => upstreamEvents());
  vi.stubGlobal('fetch', mocks.fetch);
  ({ token: runnerToken, grant: runnerGrant } = issueCodexGatewayToken(
    provider.id as string,
    { kind: 'container', groupFolder: 'workspace' },
  ));
});
afterEach(() => {
  revokeCodexGatewayToken(runnerToken);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Codex gateway HTTP boundary', () => {
  test('random unauthenticated keys allocate no rate counters and never call upstream', async () => {
    const before = mocks.limiters[0].size;
    for (let i = 0; i < 1200; i++)
      expect((await request(undefined, `invalid-${i}`)).status).toBe(401);
    expect(mocks.limiters[0].size).toBe(before);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect((await request()).status).toBe(200);
  });

  test('the stored provider identifier is not a gateway credential', async () => {
    const response = await request(undefined, 'stored-identifier');
    expect(response.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('a revoked runner token stops working immediately', async () => {
    expect((await request()).status).toBe(200);
    revokeCodexGatewayToken(runnerToken);
    expect((await request()).status).toBe(401);
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
    ['X-Real-IP', LOCAL_RUNNER, { 'x-real-ip': '203.0.113.9' }],
  ])(
    'rejects %s even with a live token, before reading the body',
    async (_label, env, extraHeaders) => {
      const response = await request(
        undefined,
        runnerToken,
        {
          headers: {
            'content-type': 'application/json',
            'x-api-key': runnerToken,
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
    },
  );

  test.each(['10.1.2.3', '172.17.0.2', '192.168.65.1', '::1', 'fd00::2'])(
    'accepts runner traffic from local address %s',
    async (remoteAddress) => {
      const response = await request(
        undefined,
        runnerToken,
        {},
        {
          incoming: { socket: { remoteAddress } },
        },
      );
      expect(response.status).toBe(200);
    },
  );

  test('rate budget is per runner grant and answers with retry-after', async () => {
    for (let i = 0; i < 120; i++) {
      // Malformed requests consume budget without spending upstream subscription.
      expect((await request(null)).status).toBe(400);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(limited.headers.get('x-should-retry')).toBeNull();
    expect(runnerGrant.lastVerdict).toBe('local_transient');
    expect(mocks.fetch).not.toHaveBeenCalled();
    // Another runner on the same provider keeps its own budget.
    const other = issueCodexGatewayToken(provider.id as string, {
      kind: 'host',
    });
    try {
      expect((await request(undefined, other.token)).status).toBe(200);
    } finally {
      revokeCodexGatewayToken(other.token);
    }
  });

  test.each([
    null,
    [],
    {},
    { messages: null },
    { messages: 'bad' },
    { messages: [{ role: 'unknown', content: 'bad' }] },
    {
      messages: [
        {
          role: 'system',
          content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: {} }],
        },
      ],
    },
    { messages: [{ role: 'user', content: [null] }] },
    { messages: [{ role: 'user', content: 'hi' }], tools: 'bad' },
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'missing call id' }],
        },
      ],
    },
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png' },
            },
          ],
        },
      ],
    },
  ])(
    'malformed consumed input returns 400 before upstream (%#)',
    async (payload) => {
      const response = await request(payload);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { type: 'invalid_request_error' },
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  test('validation errors name the offending field path, never its value', async () => {
    const response = await request({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ok' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'SECRET-VALUE' },
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.message).toContain('messages.0.content.1.source.data');
    expect(error.message).not.toContain('SECRET-VALUE');
  });

  test('unsupported historical blocks degrade instead of failing every later turn', async () => {
    const response = await request({
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.invalid/image.png' },
            },
            {
              type: 'search_result',
              title: 'Doc',
              content: [{ type: 'text', text: 'found' }],
            },
          ],
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next turn' },
      ],
    });
    expect(response.status).toBe(200);
    const content = sentBody().input[0].content;
    expect(content[0].text).toContain('Image omitted');
    expect(content[1].text).toContain('found');
  });

  test('authenticated oversized request bodies receive 413 before JSON buffering', async () => {
    const response = await request(undefined, runnerToken, {
      headers: {
        'x-api-key': runnerToken,
        'content-type': 'application/json',
        'content-length': String(40 * 1024 * 1024),
      },
    });
    expect(response.status).toBe(413);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('sends the account header and cache-exclusive nonstream usage', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 80,
        output_tokens: 10,
      },
    });
    expect(mocks.fetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer fake-upstream',
      'ChatGPT-Account-ID': 'business-workspace',
    });
  });

  test('preserves SDK system reminders at their conversation position', async () => {
    const response = await request({
      model: 'claude-sonnet-4-6',
      system: [
        {
          type: 'text',
          text: 'You are an assistant with Bash.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read README.' }] },
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: '<system-reminder>Use Bash.</system-reminder>',
            },
          ],
        },
      ],
      tools: [
        { name: 'Bash', input_schema: { type: 'object', properties: {} } },
      ],
      stream: true,
      max_tokens: 32_000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      context_management: { edits: [] },
      metadata: { user_id: 'sdk-test' },
    });
    expect(response.status).toBe(200);
    await response.text();
    const body = sentBody();
    expect(body).not.toHaveProperty('instructions');
    // gpt-6-sol is a Responses Lite model: tools travel in the input prefix.
    expect(body).not.toHaveProperty('tools');
    expect(body.input[0]).toMatchObject({
      type: 'additional_tools',
      role: 'developer',
    });
    expect(body.input.slice(1)).toEqual([
      {
        type: 'message',
        id: expect.stringMatching(/^msg_/),
        role: 'developer',
        content: [
          { type: 'input_text', text: 'You are an assistant with Bash.' },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Read README.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<system-reminder>\n<system-reminder>Use Bash.</system-reminder>\n</system-reminder>',
          },
        ],
      },
    ]);
    expect(body.input[0].tools[0].tools[0].name).toBe('Bash');
    expect(body.thinking).toBeUndefined();
    expect(body.metadata).toBeUndefined();
  });

  test('SSE publishes cache-exclusive usage and a single successful terminal', async () => {
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const text = await response.text();
    expect(text).toContain('"input_tokens":20');
    expect(text).toContain('"cache_read_input_tokens":80');
    expect(text.match(/event: message_stop/g)).toHaveLength(1);
    expect(text).not.toContain('event: error');
  });

  test('tool screenshot reaches upstream with its call identity', async () => {
    const response = await request({
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'screen', name: 'screenshot', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'screen',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'c2NyZWVu',
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    const translated = sentBody();
    expect(translated.input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'screen',
    });
    expect(translated.input[1].output).toContainEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,c2NyZWVu',
    });
  });

  test('downstream cancellation cancels a pending upstream without enqueue/close errors', async () => {
    const cancel = vi.fn();
    let signal!: AbortSignal;
    mocks.fetch.mockImplementation(async (_url, init) => {
      signal = init.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(frame(created));
            c.enqueue(
              frame({ type: 'response.output_text.delta', delta: 'partial' }),
            );
          },
          cancel,
        }),
      );
    });
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  test('client request abort also terminates a pending nonstream upstream reader', async () => {
    const cancel = vi.fn();
    let opened!: () => void;
    const bodyOpened = new Promise<void>((resolve) => {
      opened = resolve;
    });
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
              opened();
            },
            cancel,
          }),
        ),
    );
    const client = new AbortController();
    const pending = request(undefined, runnerToken, {
      signal: client.signal,
    });
    await bodyOpened;
    // Let the response attach its upstream reader's abort handler.
    await Promise.resolve();
    client.abort();
    expect((await pending).status).toBe(504);
    expect(cancel).toHaveBeenCalled();
  });

  test('a slow consumer does not drain an entire upstream into an unbounded queue', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              pulls++;
              c.enqueue(
                frame(
                  pulls === 1
                    ? created
                    : { type: 'response.output_text.delta', delta: 'more' },
                ),
              );
            },
            cancel,
          }),
        ),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBeLessThanOrEqual(3);
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalled();
  });

  test('a success terminal without a trailing SSE separator is preserved', async () => {
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
              c.enqueue(encoder.encode(`data: ${JSON.stringify(completed)}`));
              c.close();
            },
          }),
        ),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 80,
      },
    });
  });

  test('stalled SSE cancels upstream and emits an error without a success terminal', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(frame(created));
            },
            cancel,
          }),
        ),
    );
    const pendingResponse = request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    // The handshake is held back until content or the bootstrap time budget.
    await vi.advanceTimersByTimeAsync(20_000);
    const response = await pendingResponse;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const drained = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        chunks.push(decoder.decode(value));
      }
    })();
    // A quiet reasoning phase is not a stall before the 300s idle deadline.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100_000);
    await drained;
    const text = chunks.join('');
    expect(text).toContain('event: error');
    expect(text).toContain('Upstream Codex stream timed out');
    expect(text).not.toContain('event: message_stop');
    expect(cancel).toHaveBeenCalled();
    expect(runnerGrant.lastVerdict).toBe('upstream_failure');
  });

  test('an upstream error body is read only up to its bound, redacted, and never logged', async () => {
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                encoder.encode(
                  JSON.stringify({
                    error: {
                      message: `SECRET echo Bearer sk-abcdefghijklmnop ${'x'.repeat(2000)}`,
                    },
                  }),
                ),
              );
              // An oversized tail is never buffered.
              c.enqueue(new Uint8Array(128 * 1024));
            },
            cancel,
          }),
          { status: 500 },
        ),
    );
    const response = await request();
    expect(response.status).toBe(500);
    const { error } = await response.json();
    expect(error.type).toBe('api_error');
    expect(error.message).toContain('SECRET echo');
    expect(error.message).not.toContain('sk-abcdefghijklmnop');
    expect(error.message.length).toBeLessThan(700);
    expect(cancel).toHaveBeenCalled();
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      'SECRET',
    );
  });

  test('a stalled upstream error body is abandoned after its read deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    mocks.fetch.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                encoder.encode('{"error":{"code":"rate_limit_exceeded"'),
              );
            },
            cancel,
          }),
          { status: 429 },
        ),
    );
    const pending = request();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(429);
    expect((await response.json()).error.type).toBe('rate_limit_error');
    expect(cancel).toHaveBeenCalled();
  });
});

describe('upstream 401 handling', () => {
  const refreshed = () =>
    jsonResponse(200, {
      access_token: 'rotated-upstream',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
    });

  test('refreshes once and retries the request with the new access token', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'token revoked' }))
      .mockResolvedValueOnce(refreshed())
      .mockImplementationOnce(async () => upstreamEvents());
    const response = await request();
    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(String(mocks.fetch.mock.calls[1][0])).toContain('oauth/token');
    expect(mocks.fetch.mock.calls[2][1].headers.Authorization).toBe(
      'Bearer rotated-upstream',
    );
    expect(provider.codexOAuthCredentials).toMatchObject({
      accessToken: 'rotated-upstream',
    });
  });

  test('a rejected refresh grant answers authentication_error naming the re-login and persists the state', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'token revoked' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
    const response = await request();
    expect(response.status).toBe(401);
    expect(response.headers.get('x-should-retry')).toBe('false');
    const { error } = await response.json();
    expect(error.type).toBe('authentication_error');
    expect(error.message).toContain('重新登录 ChatGPT');
    expect(error.message).toContain('invalid_grant');
    expect(provider.codexOAuthLastRefreshError).toMatchObject({
      kind: 'reauth_required',
      accessTokenRejected: true,
    });
    expect(runnerGrant.lastVerdict).toBe('reauth_required');
    // Later requests stop at the gateway: no upstream call, no refresh.
    mocks.fetch.mockClear();
    expect((await request()).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('a transient refresh failure answers a retryable 503 with retry-after', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, { detail: 'token revoked' }))
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }));
    const response = await request();
    expect(response.status).toBe(503);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await response.json()).error.type).toBe('api_error');
    expect(provider.codexOAuthLastRefreshError?.kind).toBe('transient');
    expect(runnerGrant.lastVerdict).toBe('local_transient');
  });

  test('a second 401 after a successful refresh needs a new login and stops client retries', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(refreshed())
      .mockResolvedValueOnce(
        new Response('{}', {
          status: 401,
          headers: { 'x-request-id': 'req-401', 'cf-ray': 'ray-401' },
        }),
      );
    const response = await request();
    expect(response.status).toBe(401);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    // Retrying would only refresh again: Claude Code must surface it.
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect((await response.json()).error.message).toContain('重新登录');
    expect(runnerGrant.lastVerdict).toBe('reauth_required');
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).toContain('req-401');
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).toContain('ray-401');
  });
});

describe('upstream error mapping', () => {
  test('usage limits become 429 with retry-after, a reset time and no client retry', async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(429, {
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          resets_in_seconds: 7200,
        },
      }),
    );
    const response = await request();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7200');
    expect(response.headers.get('x-should-retry')).toBe('false');
    const { error } = await response.json();
    expect(error.type).toBe('rate_limit_error');
    expect(error.message).toMatch(/重置.*2 小时/);
  });

  test.each([
    [
      { error: { code: 'server_is_overloaded', message: 'busy' } },
      503,
      529,
      'overloaded_error',
    ],
    [
      { error: { code: 'slow_down', message: 'slow' } },
      429,
      429,
      'rate_limit_error',
    ],
    [{ detail: { code: 'usage_not_included' } }, 403, 403, 'permission_error'],
    [
      {
        error: {
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window of this model.',
        },
      },
      400,
      400,
      'invalid_request_error',
    ],
  ])(
    'maps upstream %j (HTTP %i) to %i %s',
    async (body, upstreamStatus, status, type) => {
      vi.useFakeTimers();
      // 5xx answers are retried first; each attempt gets a fresh body.
      mocks.fetch.mockImplementation(async () =>
        jsonResponse(upstreamStatus, body),
      );
      const pending = request();
      await vi.advanceTimersByTimeAsync(10_000);
      const response = await pending;
      expect(response.status).toBe(status);
      expect((await response.json()).error.type).toBe(type);
      expect(mocks.fetch).toHaveBeenCalledTimes(upstreamStatus >= 500 ? 5 : 1);
    },
  );

  test('context-length rejections use the wording Claude Code compacts on', async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(400, {
        error: {
          message: 'Your input exceeds the context window of this model.',
        },
      }),
    );
    const { error } = await (await request()).json();
    expect(error.message.toLowerCase()).toContain('prompt is too long');
  });

  test('a failure before any content becomes a real HTTP status on a stream', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        { type: 'response.in_progress', response: {} },
        {
          type: 'response.failed',
          response: {
            error: {
              type: 'usage_limit_reached',
              message: 'limit',
              resets_at: Math.floor(Date.now() / 1000) + 600,
            },
          },
        },
      ]),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(500);
    expect((await response.json()).error.type).toBe('rate_limit_error');
  });

  test('an overload reported inside a 200 stream before content is a 529', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        {
          type: 'error',
          error: {
            type: 'service_unavailable_error',
            code: 'server_is_overloaded',
            message: 'Our servers are currently overloaded.',
          },
        },
      ]),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(response.status).toBe(529);
    expect((await response.json()).error.type).toBe('overloaded_error');
  });

  test('a failure after content has streamed stays an in-stream error event', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'error',
          error: { code: 'server_is_overloaded', message: 'x' },
        },
      ]),
    );
    const response = await request({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('partial');
    expect(text).toContain('event: error');
  });
});

describe('count_tokens', () => {
  test('estimates input tokens locally without an upstream call', async () => {
    const response = await request(
      {
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello world, 你好世界' }],
        tools: [
          {
            name: 'Bash',
            description: 'Run a command',
            input_schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
            },
          },
        ],
      },
      runnerToken,
      {},
      LOCAL_RUNNER,
      '/v1/messages/count_tokens',
    );
    expect(response.status).toBe(200);
    const { input_tokens } = await response.json();
    expect(input_tokens).toBeGreaterThan(10);
    expect(input_tokens).toBeLessThan(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  test('requires a live runner token', async () => {
    const response = await request(
      { messages: [{ role: 'user', content: 'hi' }] },
      'stored-identifier',
      {},
      LOCAL_RUNNER,
      '/v1/messages/count_tokens',
    );
    expect(response.status).toBe(401);
  });
});

describe('reasoning effort policy', () => {
  const adaptive = (extra: Record<string, unknown> = {}) => ({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Bash', input_schema: { type: 'object', properties: {} } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
    stream: false,
    ...extra,
  });

  test('an inheriting Agent uses the provider effort, not the SDK default', async () => {
    provider.customEnv = { CODEX_REASONING_EFFORT: 'high' };
    await request(adaptive());
    expect(sentBody().reasoning.effort).toBe('high');
  });

  test('without a provider effort the model catalog default applies', async () => {
    await request(adaptive());
    expect(sentBody().reasoning.effort).toBe('medium');
  });

  test('an explicit Agent effort beats the provider effort', async () => {
    provider.customEnv = { CODEX_REASONING_EFFORT: 'low' };
    const agent = issueCodexGatewayToken(provider.id as string, {
      kind: 'container',
      agentEffort: 'xhigh',
    });
    try {
      await request(adaptive({ output_config: undefined }), agent.token);
      expect(sentBody().reasoning.effort).toBe('xhigh');
      await request(
        adaptive({ output_config: { effort: 'high' } }),
        agent.token,
      );
      expect(sentBody(1).reasoning.effort).toBe('high');
    } finally {
      revokeCodexGatewayToken(agent.token);
    }
  });

  test('disabled thinking and haiku-tier requests use a low effort', async () => {
    provider.customEnv = { CODEX_REASONING_EFFORT: 'xhigh' };
    await request(adaptive({ thinking: { type: 'disabled' } }));
    expect(sentBody(0).reasoning.effort).toBe('low');
    await request(adaptive({ model: 'claude-haiku-4-5' }));
    expect(sentBody(1).reasoning.effort).toBe('low');
    expect(sentBody(1).model).toBe('gpt-6-sol');
  });

  describe("the conversation's own pick", () => {
    const withPick = (
      owner: Partial<Parameters<typeof issueCodexGatewayToken>[1]> = {},
    ) =>
      issueCodexGatewayToken(provider.id as string, {
        kind: 'container',
        groupFolder: 'pick-workspace',
        agentId: null,
        ...owner,
      });

    test('reaches the upstream as is: ultra survives the CLI and beats the Agent and provider', async () => {
      provider.customEnv = { CODEX_REASONING_EFFORT: 'low' };
      const picked = withPick({
        agentEffort: 'medium',
        sessionEffort: 'ultra',
      });
      try {
        // The real CLI sends its own max on every request.
        await request(adaptive(), picked.token);
        expect(sentBody().reasoning.effort).toBe('ultra');
        await request(
          adaptive({ output_config: { effort: 'high' } }),
          picked.token,
        );
        expect(sentBody(1).reasoning.effort).toBe('ultra');
      } finally {
        revokeCodexGatewayToken(picked.token);
      }
    });

    test('runs the model the runner asked for, background work stays cheap on the default model', async () => {
      const picked = withPick({ sessionEffort: 'xhigh' });
      try {
        await request(adaptive({ model: 'gpt-6-astra' }), picked.token);
        expect(sentBody(0)).toMatchObject({
          model: 'gpt-6-astra',
          reasoning: { effort: 'xhigh' },
        });
        await request(adaptive({ model: 'claude-haiku-5-5' }), picked.token);
        expect(sentBody(1)).toMatchObject({
          model: 'gpt-6-sol',
          reasoning: { effort: 'low' },
        });
      } finally {
        revokeCodexGatewayToken(picked.token);
      }
    });

    test('a change made while the runner is warm applies from the next request', async () => {
      const picked = withPick({ sessionEffort: 'low' });
      try {
        await request(adaptive(), picked.token);
        expect(sentBody(0).reasoning.effort).toBe('low');
        expect(
          updateLiveSessionEffort({ groupFolder: 'pick-workspace' }, 'ultra'),
        ).toBe(1);
        await request(adaptive(), picked.token);
        expect(sentBody(1).reasoning.effort).toBe('ultra');
        // Back to the default: the provider and Agent rules apply again.
        provider.customEnv = { CODEX_REASONING_EFFORT: 'high' };
        updateLiveSessionEffort({ groupFolder: 'pick-workspace' }, undefined);
        await request(adaptive(), picked.token);
        expect(sentBody(2).reasoning.effort).toBe('high');
      } finally {
        revokeCodexGatewayToken(picked.token);
      }
    });
  });
});

/** An upstream SSE body the test feeds frame by frame. */
function controlledUpstream(headers: Record<string, string> = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel,
    }),
    { headers: { 'content-type': 'text/event-stream', ...headers } },
  );
  return {
    response,
    cancel,
    send: (event: Record<string, unknown>) => controller.enqueue(frame(event)),
    close: () => controller.close(),
  };
}

/** Read every chunk with the fake clock time it arrived at. */
function collect(response: Response) {
  const chunks: Array<{ at: number; text: string }> = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) return;
      chunks.push({ at: Date.now(), text: decoder.decode(value) });
    }
  })();
  return { chunks, done };
}

const streamed = (extra: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  ...extra,
});
const delta = (text: string) => ({
  type: 'response.output_text.delta',
  delta: text,
});

describe('downstream keepalive', () => {
  test('pings after 15s of downstream silence, never before message_start, and stops at the end', async () => {
    vi.useFakeTimers({ now: 0 });
    const upstream = controlledUpstream();
    mocks.fetch.mockResolvedValueOnce(upstream.response);
    const pending = request(streamed());
    // Nothing upstream: the bootstrap budget releases an empty stream.
    await vi.advanceTimersByTimeAsync(20_000);
    const { chunks, done } = collect(await pending);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(chunks).toEqual([]);

    upstream.send(created);
    await vi.advanceTimersByTimeAsync(15_000);
    upstream.send(delta('thinking done'));
    await vi.advanceTimersByTimeAsync(16_000);
    upstream.send(completed);
    upstream.close();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    const timeline = chunks.map(({ at, text }) => [
      at,
      /event: (\w+)/.exec(text)![1],
    ]);
    expect(timeline).toEqual([
      [40_000, 'message_start'],
      [40_000, 'ping'],
      [55_000, 'ping'],
      [55_000, 'content_block_start'],
      [55_000, 'content_block_delta'],
      [70_000, 'ping'],
      [71_000, 'content_block_stop'],
      [71_000, 'message_delta'],
      [71_000, 'message_stop'],
    ]);
    // No keepalive survives the end of the stream.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('official error and retry semantics', () => {
  test('an empty reasoning block start still holds the handshake for a real status', async () => {
    providerPool.refreshFromConfig(
      [{ id: provider.id as string, enabled: true, weight: 1 }],
      {
        strategy: 'failover',
        unhealthyThreshold: 3,
        recoveryIntervalMs: 300_000,
      },
    );
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    mocks.fetch.mockImplementationOnce(async () => upstreamEvents());
    expect((await request()).status).toBe(200);
    expect(runnerGrant.lastVerdict).toBe('ok');
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'rs_1', summary: [] },
        },
        {
          type: 'response.failed',
          response: {
            error: {
              type: 'usage_limit_reached',
              message: 'limit',
              resets_at: resetsAt,
            },
          },
        },
      ]),
    );
    const response = await request(streamed());
    expect(response.status).toBe(429);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(3500);
    expect(runnerGrant.lastVerdict).toBe('upstream_failure');
    // The pool waits until the reported reset instead of its flat interval.
    const health = providerPool
      .getHealthStatuses()
      .find((status) => status.profileId === provider.id);
    expect(health).toMatchObject({
      healthy: false,
      quarantinedUntil: resetsAt * 1000,
    });
    providerPool.refreshFromConfig([], {
      strategy: 'failover',
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    });
  });

  test('in-stream rate limits before content keep their retry advice', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        {
          type: 'response.failed',
          response: {
            error: {
              code: 'rate_limit_exceeded',
              message: 'Rate limit reached. Please try again in 6.2s.',
            },
          },
        },
      ]),
    );
    const response = await request(streamed());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(response.headers.get('x-should-retry')).toBeNull();
  });

  test.each([
    ['bio_policy', 400, 'invalid_request_error'],
    ['insufficient_quota', 429, 'rate_limit_error'],
  ])('%s is answered once and never retried', async (code, status, type) => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        { type: 'response.failed', response: { error: { code, message: '' } } },
      ]),
    );
    const response = await request(streamed());
    expect(response.status).toBe(status);
    expect(response.headers.get('x-should-retry')).toBe('false');
    expect((await response.json()).error.type).toBe(type);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  test('5xx answers retry with 200 ms exponential backoff before any byte is sent', async () => {
    vi.useFakeTimers({ now: 0 });
    const sentAt: number[] = [];
    let calls = 0;
    mocks.fetch.mockImplementation(async () => {
      sentAt.push(Date.now());
      return ++calls < 3
        ? new Response('{"error":{"message":"boom"}}', {
            status: 500,
            headers: { 'x-request-id': `req-${calls}` },
          })
        : upstreamEvents();
    });
    const pending = request();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe(200);
    expect(sentAt).toHaveLength(3);
    // backoff(1) = 200 ms, backoff(2) = 400 ms, each ±10%.
    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(180);
    expect(sentAt[1] - sentAt[0]).toBeLessThanOrEqual(220);
    expect(sentAt[2] - sentAt[1]).toBeGreaterThanOrEqual(360);
    expect(sentAt[2] - sentAt[1]).toBeLessThanOrEqual(440);
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).toContain('req-1');
    expect(runnerGrant.lastVerdict).toBe('ok');
  });

  test('Retry-After paces a 5xx retry; advice beyond the retry window is returned instead', async () => {
    vi.useFakeTimers({ now: 0 });
    const sentAt: number[] = [];
    mocks.fetch.mockImplementation(async () => {
      sentAt.push(Date.now());
      return sentAt.length === 1
        ? new Response('busy', { status: 503, headers: { 'retry-after': '2' } })
        : upstreamEvents();
    });
    let pending = request();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).status).toBe(200);
    expect(sentAt).toEqual([0, 2_000]);

    mocks.fetch.mockClear();
    mocks.fetch.mockImplementation(
      async () =>
        new Response('busy', {
          status: 503,
          headers: { 'retry-after': '120' },
        }),
    );
    pending = request();
    await vi.advanceTimersByTimeAsync(1_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  test('429 is never retried by the gateway', async () => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }),
    );
    expect((await request()).status).toBe(429);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  test('transport failures and a dropped stream before content are retried', async () => {
    vi.useFakeTimers({ now: 0 });
    mocks.fetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      // Ends after the handshake: a dropped connection, not a reply.
      .mockImplementationOnce(async () => upstreamEvents([created]))
      .mockImplementationOnce(async () =>
        upstreamEvents([created, delta('recovered'), completed]),
      );
    const pending = request(streamed());
    await vi.advanceTimersByTimeAsync(2_000);
    const response = await pending;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('recovered');
    expect(text.match(/event: message_start/g)).toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  test('retries stop after four attempts', async () => {
    vi.useFakeTimers({ now: 0 });
    mocks.fetch.mockRejectedValue(new TypeError('fetch failed'));
    const pending = request();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    expect(runnerGrant.lastVerdict).toBe('upstream_failure');
  });

  test('an attempt that hit its own headers deadline counts as a timeout', async () => {
    vi.useFakeTimers({ now: 0 });
    mocks.fetch.mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    const pending = request();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect((await response.json()).error.message).toContain('timed out');
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
  });

  test('a nonstream stall answers 504 like the stream does', async () => {
    vi.useFakeTimers();
    const upstream = controlledUpstream();
    mocks.fetch.mockResolvedValueOnce(upstream.response);
    upstream.send(created);
    const pending = request();
    await vi.advanceTimersByTimeAsync(300_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect((await response.json()).error.message).toContain('timed out');
    expect(upstream.cancel).toHaveBeenCalled();
  });

  test('a client cancel is not recorded as an upstream failure', async () => {
    mocks.fetch.mockImplementationOnce(async () => upstreamEvents());
    await request();
    expect(runnerGrant.lastVerdict).toBe('ok');
    const upstream = controlledUpstream();
    mocks.fetch.mockResolvedValueOnce(upstream.response);
    upstream.send(created);
    upstream.send(delta('partial'));
    const response = await request(streamed());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(upstream.cancel).toHaveBeenCalled();
    expect(runnerGrant.lastVerdict).toBe('ok');
  });
});

describe('invalid_encrypted_content recovery', () => {
  const signature = encodeReasoningSignature({
    id: 'rs_foreign',
    encryptedContent: 'sealed-by-another-account',
  });
  const withReasoning = (stream: boolean) => ({
    stream,
    messages: [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'earlier', signature },
          { type: 'text', text: 'answer' },
        ],
      },
      { role: 'user', content: 'second' },
    ],
  });
  const reasoningItems = (call: number) =>
    sentBody(call).input.filter(
      (item: Record<string, unknown>) => item.type === 'reasoning',
    );

  test('an HTTP 400 strips replayed reasoning and retries once', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: {
            code: 'invalid_encrypted_content',
            message: 'The encrypted content could not be verified.',
          },
        }),
      )
      .mockImplementationOnce(async () => upstreamEvents());
    expect((await request(withReasoning(false))).status).toBe(200);
    expect(reasoningItems(0)).toHaveLength(1);
    expect(reasoningItems(1)).toHaveLength(0);
    expect(
      sentBody(1).input.map((item: { type: string }) => item.type),
    ).toEqual(['message', 'message', 'message']);
  });

  test('a response.failed before content strips and retries once', async () => {
    const failed = {
      type: 'response.failed',
      response: {
        error: {
          code: 'invalid_encrypted_content',
          message: 'Could not decrypt the provided encrypted_content.',
        },
      },
    };
    mocks.fetch
      .mockImplementationOnce(async () => upstreamEvents([created, failed]))
      .mockImplementationOnce(async () => upstreamEvents([created, failed]));
    const response = await request(withReasoning(true));
    // The second rejection stands: there is nothing left to strip.
    expect(response.status).toBe(400);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(reasoningItems(1)).toHaveLength(0);
  });

  test('without replayed reasoning the rejection is returned unchanged', async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: 'invalid_encrypted_content' } }),
    );
    expect((await request()).status).toBe(400);
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

describe('end_turn: false follow-ups', () => {
  const reasoningDone = {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'cipher-1',
    },
  };
  const firstPart = [
    created,
    reasoningDone,
    { ...delta('Hello '), item_id: 'msg_1', output_index: 1 },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello ' }],
      },
    },
    {
      type: 'response.completed',
      response: {
        end_turn: false,
        usage: { input_tokens: 100, output_tokens: 4 },
      },
    },
  ];
  const secondPart = [
    { ...created, response: { id: 'resp-2', model: 'gpt-6-sol' } },
    { ...delta('world'), item_id: 'msg_2' },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 110, output_tokens: 2 } },
    },
  ];

  test.each([true, false])(
    'continues into the same message with the earlier output replayed (stream=%s)',
    async (stream) => {
      mocks.fetch
        .mockImplementationOnce(async () => upstreamEvents(firstPart))
        .mockImplementationOnce(async () => upstreamEvents(secondPart));
      const response = await request(streamed({ stream }));
      expect(response.status).toBe(200);
      // A released stream follows up while the client reads it.
      const body = stream ? await response.text() : await response.json();
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      const original = sentBody(0).input;
      expect(sentBody(1).input).toEqual([
        ...original,
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [],
          encrypted_content: 'cipher-1',
        },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello ' }],
        },
      ]);
      if (stream) {
        expect(body.match(/event: message_start/g)).toHaveLength(1);
        expect(body.match(/event: message_stop/g)).toHaveLength(1);
        expect(body.match(/"stop_reason":"end_turn"/g)).toHaveLength(1);
        expect(body).toContain('"output_tokens":6');
      } else {
        expect(
          body.content.filter((b: { type: string }) => b.type === 'text'),
        ).toEqual([
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ]);
        expect(body.usage).toMatchObject({
          input_tokens: 210,
          output_tokens: 6,
        });
      }
      expect(runnerGrant.lastVerdict).toBe('ok');
    },
  );

  test('follow-ups are bounded', async () => {
    mocks.fetch.mockImplementation(async () =>
      upstreamEvents([
        created,
        delta('more'),
        { type: 'response.completed', response: { end_turn: false } },
      ]),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(5);
    expect((await response.json()).stop_reason).toBe('end_turn');
  });

  test('a follow-up that fails after content becomes an in-stream error', async () => {
    mocks.fetch
      .mockImplementationOnce(async () => upstreamEvents(firstPart))
      .mockImplementationOnce(async () =>
        jsonResponse(400, { error: { message: 'bad follow-up' } }),
      );
    const response = await request(streamed());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Hello ');
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: message_stop');
    expect(runnerGrant.lastVerdict).toBe('upstream_failure');
  });
});

describe('message usage and rate-limit headers', () => {
  test('message_start carries an input estimate and the stream reports a truncated call as max_tokens', async () => {
    mocks.fetch.mockImplementationOnce(async () =>
      upstreamEvents([
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'c1',
            name: 'Write',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          delta: '{"content":"long',
        },
        {
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 30, output_tokens: 8 },
          },
        },
      ]),
    );
    const response = await request(
      streamed({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }),
    );
    const text = await response.text();
    const start = JSON.parse(/event: message_start\ndata: (.*)/.exec(text)![1]);
    expect(start.message.usage.input_tokens).toBeGreaterThan(900);
    expect(text).toContain('"stop_reason":"max_tokens"');
    expect(text).not.toContain('event: error');
  });

  test('x-codex-* headers update the provider snapshot', async () => {
    clearCodexProviderRateLimits();
    mocks.fetch.mockImplementationOnce(async () => {
      const response = upstreamEvents();
      response.headers.set('x-codex-primary-used-percent', '80');
      response.headers.set('x-codex-primary-window-minutes', '300');
      response.headers.set('x-codex-primary-reset-at', '1788303600');
      response.headers.set('x-codex-other-primary-used-percent', '5');
      response.headers.set('x-codex-other-limit-name', 'Other models');
      return response;
    });
    await request();
    expect(getCodexProviderRateLimits(provider.id as string)).toMatchObject({
      kind: 'codex_rate_limits',
      limits: [
        {
          limitId: 'codex',
          primary: {
            usedPercent: 80,
            windowMinutes: 300,
            resetsAt: 1788303600,
          },
          secondary: null,
        },
        {
          limitId: 'codex_other',
          limitName: 'Other models',
          primary: { usedPercent: 5, windowMinutes: null, resetsAt: null },
        },
      ],
    });
  });
});
