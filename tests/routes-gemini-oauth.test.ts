import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// The gateway embeds no OAuth client credentials; tests supply a fake pair
// before the modules read the environment.
vi.hoisted(() => {
  process.env.GEMINI_OAUTH_CLIENT_ID =
    'test-client-id.apps.googleusercontent.com';
  process.env.GEMINI_OAUTH_CLIENT_SECRET = 'test-client-secret';
});

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-gemini-oauth-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'gemini-oauth-admin',
        username: 'gemini-oauth-admin',
        display_name: 'Gemini OAuth Admin',
        role: 'admin',
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const {
  GEMINI_API_BASE,
  GEMINI_API_VERSION,
  GEMINI_GATEWAY_BASE_URL_PLACEHOLDER,
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_TOKEN_URL,
  GEMINI_OAUTH_USERINFO_URL,
} = await import('../src/gemini-gateway/types.js');
const { geminiAccountChanged, parseGeminiCallbackInput } =
  await import('../src/routes/gemini.js');

const queue = {
  listDescendantJids: () => [],
  pauseGroupsForMutation: () => ({ id: 1 }),
  resumeGroupsAfterMutation: vi.fn(),
  stopGroup: vi.fn(async () => {}),
  unblockGroupsForRuntimeSafety: vi.fn(),
  drainProviderRunnersForCredentialRefresh: vi.fn(() => 0),
};
const app = web.createAppForTest({
  queue,
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

const tokenEndpoint = vi.fn();
const userInfoEndpoint = vi.fn();
const loadCodeAssistEndpoint = vi.fn();
const modelsEndpoint = vi.fn();

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function tokenBody() {
  return {
    access_token: 'google-access',
    refresh_token: 'google-refresh',
    expires_in: 3600,
    scope: 'openid email profile',
    id_token: jwt({ email: 'user@example.invalid' }),
  };
}
function catalogBody() {
  return {
    models: {
      'gemini-4-argon-medium': {
        displayName: 'Gemini 4 Argon (Medium)',
        maxTokens: 1_048_576,
        maxOutputTokens: 65_536,
        supportsThinking: true,
      },
      'gemini-4-aurora-low': {
        displayName: 'Gemini 4 Aurora (Low)',
        maxTokens: 524_288,
        maxOutputTokens: 32_768,
      },
    },
  };
}

async function startFlow(targetProviderId?: string): Promise<string> {
  const response = await app.request('/api/config/gemini/oauth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(targetProviderId ? { targetProviderId } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json()).state;
}
function callback(input: string, state = 'unknown-state'): Promise<Response> {
  return app.request('/api/config/gemini/oauth/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, code: input }),
  });
}
const callbackUrl = (state: string, host = 'localhost') =>
  `http://${host}:51121/oauth-callback?code=auth-code&state=${state}`;

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  vi.clearAllMocks();
  tokenEndpoint.mockReset();
  tokenEndpoint.mockImplementation(async () => json(200, tokenBody()));
  userInfoEndpoint.mockReset();
  userInfoEndpoint.mockImplementation(async () =>
    json(200, { id: 'google-id', email: 'user@example.invalid' }),
  );
  loadCodeAssistEndpoint.mockReset();
  loadCodeAssistEndpoint.mockImplementation(async () =>
    json(200, { cloudaicompanionProject: 'project-1' }),
  );
  modelsEndpoint.mockReset();
  modelsEndpoint.mockImplementation(async () => json(200, catalogBody()));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === GEMINI_OAUTH_TOKEN_URL) return tokenEndpoint(url, init);
      if (url === GEMINI_OAUTH_USERINFO_URL) return userInfoEndpoint(url, init);
      if (url === `${GEMINI_API_BASE}/${GEMINI_API_VERSION}:loadCodeAssist`) {
        return loadCodeAssistEndpoint(url, init);
      }
      if (
        url === `${GEMINI_API_BASE}/${GEMINI_API_VERSION}:fetchAvailableModels`
      ) {
        return modelsEndpoint(url, init);
      }
      throw new Error(`blocked ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/config/gemini/oauth/start', () => {
  test('returns a Google authorize URL for the fixed callback', async () => {
    const response = await app.request('/api/config/gemini/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.redirectHint).toBe(GEMINI_OAUTH_REDIRECT_URI);
    const url = new URL(body.authorizeUrl);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe(GEMINI_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      GEMINI_OAUTH_REDIRECT_URI,
    );
    expect(url.searchParams.get('state')).toBe(body.state);
  });

  test('an unknown target provider is a 404', async () => {
    const response = await app.request('/api/config/gemini/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetProviderId: 'missing' }),
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/config/gemini/oauth/callback', () => {
  test('creates a Gemini subscription with the catalog default model', async () => {
    const state = await startFlow();
    const response = await callback(callbackUrl(state, '127.0.0.1'), state);
    expect(response.status).toBe(200);
    const provider = await response.json();
    expect(provider).toMatchObject({
      anthropicBaseUrl: GEMINI_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicModel: 'gemini-4-argon-medium',
      name: 'Gemini 订阅 (user@example.invalid)',
      hasGeminiOAuthCredentials: true,
      geminiOAuthCredentialsEmail: 'user@example.invalid',
      geminiOAuthProjectId: 'project-1',
      geminiOAuthNeedsReauth: false,
      models: [
        { id: 'gemini-4-argon-medium', contextWindow: 1_048_576 },
        { id: 'gemini-4-aurora-low', contextWindow: 524_288 },
      ],
    });
    expect(
      provider.geminiModels.map((model: { id: string }) => model.id),
    ).toEqual(['gemini-4-argon-medium', 'gemini-4-aurora-low']);
    // Google tokens stay in the encrypted secret, never in the public payload.
    expect(JSON.stringify(provider)).not.toContain('google-access');
    expect(JSON.stringify(provider)).not.toContain('google-refresh');
    // The token exchange used the pasted code.
    const form = new URLSearchParams(
      String(tokenEndpoint.mock.calls[0][1]?.body ?? ''),
    );
    expect(form.get('code')).toBe('auth-code');
  });

  test('accepts a bare authorization code', async () => {
    const state = await startFlow();
    const response = await callback('4/0Abrigaded', state);
    expect(response.status).toBe(200);
    expect((await response.json()).hasGeminiOAuthCredentials).toBe(true);
  });

  test('rejects an unknown state without exchanging the code', async () => {
    const response = await callback('4/0Acode', 'missing-state');
    expect(response.status).toBe(400);
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  test('rejects a state that does not match the pasted URL', async () => {
    const state = await startFlow();
    const other = await startFlow();
    const response = await callback(callbackUrl(state), other);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'State mismatch' });
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  test('a Google error response stays retryable', async () => {
    const state = await startFlow();
    const response = await callback(
      `http://localhost:51121/oauth-callback?error=access_denied&error_description=Denied&state=${state}`,
      state,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ retryable: true });
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  test('a token endpoint failure consumes the flow and asks for a new login', async () => {
    const state = await startFlow();
    tokenEndpoint.mockResolvedValueOnce(json(503, { error: 'backend_error' }));
    const failed = await callback(callbackUrl(state), state);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ retryable: false });
    // A delivered exchange may have burned the code, so the flow is not reused.
    const again = await callback(callbackUrl(state), state);
    expect(again.status).toBe(400);
  });

  test('a permanent token rejection asks for a fresh login', async () => {
    const state = await startFlow();
    tokenEndpoint.mockResolvedValueOnce(json(400, { error: 'invalid_grant' }));
    const response = await callback(callbackUrl(state), state);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      retryable: false,
      error: expect.stringContaining('重新登录 Google'),
    });
  });

  test('converts an existing connection in place when it has no Google login', async () => {
    const existing = runtimeConfig.createProvider({
      name: 'CPA Gemini',
      type: 'third_party',
      anthropicBaseUrl: 'http://172.17.0.1:8317',
      anthropicAuthToken: 'relay-key',
      anthropicModel: 'gemini-4-argon-medium',
    });
    const state = await startFlow(existing.id);
    const response = await callback(callbackUrl(state), state);
    expect(response.status).toBe(200);
    const provider = await response.json();
    expect(provider.id).toBe(existing.id);
    expect(provider.anthropicBaseUrl).toBe(GEMINI_GATEWAY_BASE_URL_PLACEHOLDER);
    expect(provider.hasGeminiOAuthCredentials).toBe(true);
    const stored = runtimeConfig.getProviderById(existing.id);
    // The relay key is replaced by a fresh internal gateway identifier.
    expect(stored?.anthropicAuthToken).toBeTruthy();
    expect(stored?.anthropicAuthToken).not.toBe('relay-key');
    expect(stored?.anthropicApiKey).toBe('');
  });

  test('keeps the selected model when the new account still offers it', async () => {
    const existing = runtimeConfig.createProvider({
      name: 'CPA Gemini',
      type: 'third_party',
      anthropicBaseUrl: 'http://172.17.0.1:8317',
      anthropicAuthToken: 'relay-key',
      anthropicModel: 'gemini-4-aurora-low',
    });
    const state = await startFlow(existing.id);
    const provider = await (await callback(callbackUrl(state), state)).json();
    expect(provider.anthropicModel).toBe('gemini-4-aurora-low');
  });

  test('a missing project still saves the connection for a later retry', async () => {
    const state = await startFlow();
    loadCodeAssistEndpoint.mockResolvedValueOnce(
      json(403, { error: { message: 'not onboarded' } }),
    );
    const provider = await (await callback(callbackUrl(state), state)).json();
    expect(provider).toMatchObject({
      hasGeminiOAuthCredentials: true,
      geminiOAuthProjectId: null,
      anthropicModel: 'gemini-4-argon-medium',
    });
    expect(provider.geminiModels).toEqual([]);
    expect(modelsEndpoint).not.toHaveBeenCalled();
  });
});

describe('POST /api/config/gemini/models/refresh', () => {
  async function createGeminiProvider() {
    const state = await startFlow();
    const provider = await (await callback(callbackUrl(state), state)).json();
    return provider.id as string;
  }

  test('replaces the catalog and default model from upstream', async () => {
    const providerId = await createGeminiProvider();
    modelsEndpoint.mockResolvedValueOnce(
      json(200, {
        models: {
          'gemini-5-argon-high': {
            displayName: 'Gemini 5 Argon (High)',
            maxTokens: 2_000_000,
            maxOutputTokens: 128_000,
          },
        },
      }),
    );
    const response = await app.request('/api/config/gemini/models/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId }),
    });
    expect(response.status).toBe(200);
    const provider = await response.json();
    expect(provider.anthropicModel).toBe('gemini-5-argon-high');
    expect(provider.models).toEqual([
      { id: 'gemini-5-argon-high', contextWindow: 2_000_000 },
    ]);
    expect(provider.geminiModels).toHaveLength(1);
  });

  test('rejects a provider that is not a Gemini login', async () => {
    const other = runtimeConfig.createProvider({
      name: 'API key',
      type: 'third_party',
      anthropicBaseUrl: 'https://example.invalid',
      anthropicApiKey: 'sk-test',
      anthropicModel: 'model',
    });
    const response = await app.request('/api/config/gemini/models/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: other.id }),
    });
    expect(response.status).toBe(404);
  });

  test('an empty upstream catalog is a 502 and keeps the stored one', async () => {
    const providerId = await createGeminiProvider();
    modelsEndpoint.mockResolvedValueOnce(json(200, { models: {} }));
    const response = await app.request('/api/config/gemini/models/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId }),
    });
    expect(response.status).toBe(502);
    expect(
      runtimeConfig.getProviderById(providerId)?.geminiModels,
    ).toHaveLength(2);
  });
});

describe('POST /api/config/gemini/disconnect', () => {
  test('clears the Google login and the gateway identifier', async () => {
    const state = await startFlow();
    const created = await (await callback(callbackUrl(state), state)).json();
    const response = await app.request('/api/config/gemini/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: created.id }),
    });
    expect(response.status).toBe(200);
    const provider = await response.json();
    expect(provider).toMatchObject({
      hasGeminiOAuthCredentials: false,
      hasAnthropicAuthToken: false,
      geminiModels: [],
    });
    expect(runtimeConfig.getProviderById(created.id)?.anthropicAuthToken).toBe(
      '',
    );
  });

  test('a non-Gemini provider is a 404', async () => {
    const other = runtimeConfig.createProvider({
      name: 'API key',
      type: 'third_party',
      anthropicBaseUrl: 'https://example.invalid',
      anthropicApiKey: 'sk-test',
      anthropicModel: 'model',
    });
    const response = await app.request('/api/config/gemini/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: other.id }),
    });
    expect(response.status).toBe(404);
  });
});

describe('parseGeminiCallbackInput', () => {
  test.each([
    ['4/0Abrigaded', { code: '4/0Abrigaded' }],
    [
      'http://localhost:51121/oauth-callback?code=abc&state=s1',
      { code: 'abc', state: 's1' },
    ],
    ['code=abc&state=s1', { code: 'abc', state: 's1' }],
    [
      'https://127.0.0.1:51121/oauth-callback?error=access_denied&error_description=no&state=s1',
      { error: 'access_denied', description: 'no', state: 's1' },
    ],
  ])('parses %s', (input, expected) => {
    expect(parseGeminiCallbackInput(input)).toEqual(expected);
  });

  test.each(['', '   ', 'short', 'has space', 'https://', 'scope=openid'])(
    'rejects %s',
    (input) => {
      expect(parseGeminiCallbackInput(input)).toBeNull();
    },
  );
});

describe('geminiAccountChanged', () => {
  const credentials = (accountId: string, email: string) => ({
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: 0,
    email,
    accountId,
    projectId: 'p',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  test('compares account ids first, then the email case-insensitively', () => {
    expect(
      geminiAccountChanged(
        credentials('id-1', 'a@x.invalid'),
        credentials('id-2', 'a@x.invalid'),
      ),
    ).toBe(true);
    expect(
      geminiAccountChanged(
        credentials('id-1', 'a@x.invalid'),
        credentials('id-1', 'a@x.invalid'),
      ),
    ).toBe(false);
    expect(
      geminiAccountChanged(
        credentials('', 'A@x.invalid'),
        credentials('', 'a@x.invalid'),
      ),
    ).toBe(false);
  });

  test('assumes the same account when identity is missing', () => {
    expect(geminiAccountChanged(null, credentials('id-1', 'a@x.invalid'))).toBe(
      false,
    );
    expect(
      geminiAccountChanged(
        credentials('', ''),
        credentials('id-1', 'a@x.invalid'),
      ),
    ).toBe(false);
  });
});
