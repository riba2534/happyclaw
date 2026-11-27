import { afterEach, describe, expect, test, vi } from 'vitest';

// The gateway embeds no OAuth client credentials; tests supply a fake pair
// before the modules read the environment.
vi.hoisted(() => {
  process.env.GEMINI_OAUTH_CLIENT_ID =
    'test-client-id.apps.googleusercontent.com';
  process.env.GEMINI_OAUTH_CLIENT_SECRET = 'test-client-secret';
});

import {
  GeminiOAuthError,
  buildGeminiAuthorizeUrl,
  buildGeminiCredentials,
  emailFromIdToken,
  exchangeGeminiCode,
  fetchGeminiModels,
  fetchGeminiProjectId,
  fetchGeminiUserInfo,
  isPermanentGeminiTokenRejection,
  refreshGeminiToken,
} from '../src/gemini-gateway/oauth.js';
import {
  GEMINI_API_BASE,
  GEMINI_API_VERSION,
  GEMINI_OAUTH_AUTH_URL,
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_SCOPES,
  GEMINI_OAUTH_TOKEN_URL,
  GEMINI_OAUTH_USERINFO_URL,
} from '../src/gemini-gateway/types.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ''));
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(typeof input === 'string' ? input : input.toString(), init),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function jwt(payload: unknown): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildGeminiAuthorizeUrl', () => {
  test('requests an offline consent grant on the fixed localhost callback', () => {
    const url = new URL(buildGeminiAuthorizeUrl('state-1'));
    expect(`${url.origin}${url.pathname}`).toBe(GEMINI_OAUTH_AUTH_URL);
    expect(url.searchParams.get('client_id')).toBe(GEMINI_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(
      GEMINI_OAUTH_REDIRECT_URI,
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe(GEMINI_OAUTH_SCOPES.join(' '));
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
});

describe('token endpoint', () => {
  test('exchanges an authorization code as a form post', async () => {
    const fetch = stubFetch(() =>
      json(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        id_token: jwt({ email: 'user@example.invalid' }),
        expires_in: 3600,
        scope: 'openid email',
      }),
    );
    const token = await exchangeGeminiCode('auth-code');
    expect(token).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      scope: 'openid email',
    });
    expect(token.expiresAt).toBeGreaterThan(Date.now() + 3_000_000);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(GEMINI_OAUTH_TOKEN_URL);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const form = bodyOf(init);
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(GEMINI_OAUTH_REDIRECT_URI);
    expect(form.get('client_id')).toBe(GEMINI_OAUTH_CLIENT_ID);
    expect(form.has('client_secret')).toBe(true);
  });

  test('refreshes with the rotating refresh token', async () => {
    const fetch = stubFetch(() =>
      json(200, { access_token: 'access-2', expires_in: 60 }),
    );
    const token = await refreshGeminiToken('refresh-old');
    expect(token).toMatchObject({
      accessToken: 'access-2',
      refreshToken: null,
    });
    const form = bodyOf(fetch.mock.calls[0][1]);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('refresh-old');
  });

  test.each([
    ['invalid_grant', 400],
    ['invalid_client', 400],
    ['unauthorized_client', 401],
  ])('marks %s as a permanent rejection', async (code, status) => {
    stubFetch(() => json(status, { error: code }));
    const error = await refreshGeminiToken('refresh-old').catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(GeminiOAuthError);
    const oauthError = error as GeminiOAuthError;
    expect(oauthError.code).toBe(code);
    expect(oauthError.transient).toBe(false);
  });

  test('a 5xx or 429 is transient and may be retried', async () => {
    stubFetch(() => json(503, { error: 'backend_error' }));
    const error = await refreshGeminiToken('refresh-old').catch(
      (err: unknown) => err,
    );
    expect((error as GeminiOAuthError).transient).toBe(true);
    expect((error as GeminiOAuthError).status).toBe(503);
  });

  test('an unreachable endpoint is transient and no grant was used', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const error = await refreshGeminiToken('refresh-old').catch(
      (err: unknown) => err,
    );
    expect((error as GeminiOAuthError).transient).toBe(true);
    expect((error as GeminiOAuthError).status).toBeNull();
  });

  test('a response without access_token is rejected rather than stored', async () => {
    stubFetch(() => json(200, { refresh_token: 'refresh-1' }));
    await expect(exchangeGeminiCode('auth-code')).rejects.toThrow(
      'missing access_token',
    );
  });

  test.each([
    [400, 'invalid_grant', true],
    [400, 'invalid_request', false],
    [401, null, true],
    [403, null, false],
    [429, 'rate_limited', false],
    [null, null, false],
  ])(
    'classifies status %s / code %s as permanent=%s',
    (status, code, expected) => {
      expect(isPermanentGeminiTokenRejection(status as number, code)).toBe(
        expected,
      );
    },
  );
});

describe('userinfo', () => {
  test('sends the bearer token and returns identity fields', async () => {
    const fetch = stubFetch(() =>
      json(200, { id: 'google-id', email: 'user@example.invalid' }),
    );
    await expect(fetchGeminiUserInfo('access-1')).resolves.toEqual({
      id: 'google-id',
      email: 'user@example.invalid',
    });
    expect(fetch.mock.calls[0][0]).toBe(GEMINI_OAUTH_USERINFO_URL);
    expect(
      (fetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer access-1');
  });

  test('a failed lookup surfaces the status', async () => {
    stubFetch(() => json(403, { error: 'forbidden' }));
    await expect(fetchGeminiUserInfo('access-1')).rejects.toMatchObject({
      status: 403,
      transient: false,
    });
  });
});

describe('project resolution', () => {
  test('uses the project returned by loadCodeAssist without onboarding', async () => {
    const fetch = stubFetch(() =>
      json(200, { cloudaicompanionProject: 'project-1' }),
    );
    await expect(fetchGeminiProjectId('access-1')).resolves.toBe('project-1');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${GEMINI_API_BASE}/${GEMINI_API_VERSION}:loadCodeAssist`,
    ]);
  });

  test('accepts the object form of the project', async () => {
    stubFetch(() =>
      json(200, { cloudaicompanionProject: { id: 'project-2' } }),
    );
    await expect(fetchGeminiProjectId('access-1')).resolves.toBe('project-2');
  });

  test('onboards the account and polls until the project is ready', async () => {
    let onboardCalls = 0;
    const fetch = stubFetch((url) => {
      if (url.endsWith(':loadCodeAssist')) {
        return json(200, {
          allowedTiers: [
            { id: 'free-tier', isDefault: true },
            { id: 'paid-tier' },
          ],
        });
      }
      onboardCalls += 1;
      if (onboardCalls === 1) return json(200, { done: false });
      return json(200, { done: true, response: { projectId: 'project-3' } });
    });
    await expect(fetchGeminiProjectId('access-1')).resolves.toBe('project-3');
    expect(onboardCalls).toBe(2);
    const onboardInit = fetch.mock.calls.find(([url]) =>
      url.endsWith(':onboardUser'),
    )?.[1];
    expect(JSON.parse(String(onboardInit?.body))).toMatchObject({
      tier_id: 'free-tier',
      metadata: { ide_type: 'ANTIGRAVITY' },
    });
  }, 20_000);

  test('a completed onboarding without a project fails loudly', async () => {
    stubFetch((url) =>
      url.endsWith(':loadCodeAssist')
        ? json(200, {})
        : json(200, { done: true, response: {} }),
    );
    await expect(fetchGeminiProjectId('access-1')).rejects.toMatchObject({
      message: expect.stringContaining('项目 ID'),
      transient: false,
    });
  });

  test('the control plane error body is bounded into the message', async () => {
    stubFetch(() =>
      json(403, {
        error: { message: 'Cloud AI Companion API is not enabled' },
      }),
    );
    await expect(fetchGeminiProjectId('access-1')).rejects.toMatchObject({
      status: 403,
      transient: false,
      message: expect.stringContaining('Cloud AI Companion API is not enabled'),
    });
  });
});

describe('fetchGeminiModels', () => {
  test('keeps usable entries and sorts them by display name', async () => {
    stubFetch(() =>
      json(200, {
        models: {
          'gemini-4-argon-medium': {
            displayName: 'Gemini 4 Argon (Medium)',
            maxTokens: 1_048_576,
            maxOutputTokens: 65_536,
            supportsThinking: true,
            supportsImages: true,
            minThinkingBudget: 128,
          },
          'gemini-4-aurora-low': {
            displayName: 'Gemini 4 Aurora (Low)',
            maxTokens: 524_288,
            thinkingBudget: 1024,
          },
          tab_completion: { displayName: 'Tab', maxTokens: 1000 },
          chat_default: { displayName: 'Chat', maxTokens: 1000 },
          'no-display-name': { maxTokens: 1000 },
          'bad id!': { displayName: 'Bad id' },
        },
      }),
    );
    const models = await fetchGeminiModels('access-1', 'project-1');
    expect(models.map((model) => model.id)).toEqual([
      'gemini-4-argon-medium',
      'gemini-4-aurora-low',
    ]);
    expect(models[0]).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      supportsThinking: true,
      supportsImages: true,
      minThinkingBudget: 128,
    });
    // Absent flags stay explicit so the picker can reason about them.
    expect(models[1]).toMatchObject({ supportsThinking: false });
  });

  test('an unexpected body yields an empty catalog', async () => {
    stubFetch(() => json(200, { models: [] }));
    await expect(fetchGeminiModels('access-1', 'project-1')).resolves.toEqual(
      [],
    );
  });
});

describe('credentials', () => {
  test('builds complete credentials from the token response', () => {
    const credentials = buildGeminiCredentials(
      {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        idToken: null,
        scope: 'openid email profile',
        expiresAt: 123,
      },
      { id: 'google-id', email: 'user@example.invalid' },
      'project-1',
    );
    expect(credentials).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 123,
      email: 'user@example.invalid',
      accountId: 'google-id',
      projectId: 'project-1',
      scopes: ['openid', 'email', 'profile'],
    });
    expect(credentials.updatedAt).toMatch(/T.*Z$/);
  });

  test('a refresh response without new values keeps the previous ones', () => {
    const credentials = buildGeminiCredentials(
      {
        accessToken: 'access-2',
        refreshToken: null,
        idToken: null,
        scope: null,
        expiresAt: 456,
      },
      { id: null, email: null },
      '',
      {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: 123,
        email: 'user@example.invalid',
        accountId: 'google-id',
        projectId: 'project-1',
        scopes: ['openid'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(credentials).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-1',
      email: 'user@example.invalid',
      accountId: 'google-id',
      projectId: 'project-1',
      scopes: ['openid'],
    });
  });

  test('emailFromIdToken reads the email claim and tolerates junk', () => {
    expect(emailFromIdToken(jwt({ email: 'a@b.invalid' }))).toBe('a@b.invalid');
    expect(emailFromIdToken(jwt({ sub: 'no-email' }))).toBeNull();
    expect(emailFromIdToken('not-a-jwt')).toBeNull();
    expect(emailFromIdToken(null)).toBeNull();
  });
});
