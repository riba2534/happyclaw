import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-oauth-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  WEB_PORT: 3456,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const oauth = await import('../src/codex-oauth.js');
const runtime = await import('../src/codex-runtime.js');
const { createCodexFacadeApp } = await import('../src/codex-facade.js');
const { buildContainerEnvLines } = runtimeConfig;

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'none', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex JWT claims', () => {
  test('reads account id, email, and plan from OpenAI claim namespaces', () => {
    const token = jwt({
      email: 'owner@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_123',
        chatgpt_user_id: 'user_9',
        chatgpt_plan_type: 'plus',
      },
    });
    expect(oauth.decodeCodexClaims(token)).toEqual({
      email: 'owner@example.com',
      accountId: 'acct_123',
      userId: 'user_9',
      planType: 'plus',
    });
  });

  test('falls back to the profile email claim', () => {
    const token = jwt({
      'https://api.openai.com/profile': { email: 'profile@example.com' },
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_2' },
    });
    expect(oauth.decodeCodexClaims(token).email).toBe('profile@example.com');
  });

  test('codexTokenExpiresSoon uses exp with a refresh buffer', () => {
    const now = 1_700_000_000_000;
    const fresh = jwt({ exp: Math.floor((now + 30 * 60 * 1000) / 1000) });
    const soon = jwt({ exp: Math.floor((now + 2 * 60 * 1000) / 1000) });
    expect(oauth.codexTokenExpiresSoon(fresh, 5 * 60 * 1000, now)).toBe(false);
    expect(oauth.codexTokenExpiresSoon(soon, 5 * 60 * 1000, now)).toBe(true);
    expect(oauth.codexTokenExpiresSoon('not-a-jwt', 5 * 60 * 1000, now)).toBe(
      false,
    );
  });
});

describe('Codex OAuth persist and refresh rotation', () => {
  test('seals credentials, CAS-refreshes them, and never exposes plaintext', () => {
    const first = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accountId: 'acct_1',
      email: 'owner@example.com',
      planType: 'plus',
    };
    const provider = runtimeConfig.createProvider({
      name: 'ChatGPT Codex',
      type: 'codex',
      codexOAuthCredentials: first,
      enabled: true,
    });

    const publicView = runtimeConfig.toPublicProvider(provider);
    expect(publicView.hasCodexOAuthCredentials).toBe(true);
    expect(publicView.codexOAuthPlanType).toBe('plus');
    expect(publicView.codexOAuthEmailMasked).toBeTruthy();
    expect(JSON.stringify(publicView)).not.toContain('access-1');
    expect(JSON.stringify(publicView)).not.toContain('refresh-1');
    expect(publicView.anthropicBaseUrl).toBe('');

    expect(runtimeConfig.getClaudeProviderConfig()).toMatchObject({
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: '',
    });

    const runner = runtimeConfig.toRunnerProviderConfig(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)!,
    );
    expect(runner.anthropicBaseUrl).toBe('http://127.0.0.1:3456/model');
    expect(runner.anthropicAuthToken).toMatch(/^[0-9a-f]{48}$/);
    expect(
      runtime.resolveCodexRunnerProviderId(
        `Bearer ${runner.anthropicAuthToken}`,
      ),
    ).toBe(provider.id);

    const rotated = {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accountId: 'acct_1',
      email: 'owner@example.com',
      planType: 'plus',
    };
    expect(
      runtimeConfig.updateProviderCodexCredentialsIfCurrent(
        provider.id,
        first,
        rotated,
      ),
    ).toBe(true);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.codexOAuthCredentials,
    ).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });

    expect(
      runtimeConfig.updateProviderCodexCredentialsIfCurrent(
        provider.id,
        first,
        { ...rotated, accessToken: 'access-stale' },
      ),
    ).toBe(false);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.codexOAuthCredentials?.accessToken,
    ).toBe('access-2');
  });

  test('refreshCodexCredential persists a rotated refresh token from the token endpoint', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: jwt({
              'https://api.openai.com/auth': {
                chatgpt_account_id: 'acct_9',
                chatgpt_plan_type: 'pro',
              },
            }),
            refresh_token: 'refresh-rotated',
          }),
          { status: 200 },
        ),
    );
    const next = await oauth.refreshCodexCredential(
      {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        accountId: 'acct_9',
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(next.refreshToken).toBe('refresh-rotated');
    expect(next.accountId).toBe('acct_9');
    expect(next.planType).toBe('pro');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('official and third_party stay direct', () => {
  test('runner env only injects the local facade for Codex', () => {
    const official = runtimeConfig.createProvider({
      name: 'Official Claude',
      type: 'official',
      anthropicApiKey: 'sk-ant-official',
      anthropicModel: 'sonnet',
      enabled: true,
    });
    const third = runtimeConfig.createProvider({
      name: 'Gateway',
      type: 'third_party',
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
      anthropicModel: 'gateway-model',
      enabled: true,
    });
    const officialCfg = runtimeConfig.toRunnerProviderConfig(
      runtimeConfig.getProviders().find((item) => item.id === official.id)!,
    );
    const thirdCfg = runtimeConfig.toRunnerProviderConfig(
      runtimeConfig.getProviders().find((item) => item.id === third.id)!,
    );
    expect(officialCfg).toMatchObject({
      anthropicBaseUrl: '',
      anthropicApiKey: 'sk-ant-official',
      anthropicModel: 'sonnet',
    });
    expect(thirdCfg).toMatchObject({
      anthropicBaseUrl: 'https://gateway.example.test',
      anthropicAuthToken: 'gateway-token',
    });

    const officialLines = buildContainerEnvLines(officialCfg, {}, {});
    const thirdLines = buildContainerEnvLines(thirdCfg, {}, {});
    expect(officialLines).toContain('HAPPYCLAW_CLAUDE_ENDPOINT_KIND=official');
    expect(officialLines.join('\n')).not.toContain('/model');
    expect(thirdLines).toContain('HAPPYCLAW_CLAUDE_ENDPOINT_KIND=custom');
    expect(thirdLines).toContain(
      'ANTHROPIC_BASE_URL=https://gateway.example.test',
    );
    expect(thirdLines.join('\n')).not.toContain('127.0.0.1');
  });
});

describe('local Anthropic facade auth', () => {
  test('rejects missing or unknown bearer without calling upstream', async () => {
    const fetchSpy = vi.fn();
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const app = createCodexFacadeApp();
      const missing = await app.request('/model/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const unknown = await app.request('/model/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer deadbeef',
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const count = await app.request('/model/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(missing.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(count.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previous;
    }
  });
});
