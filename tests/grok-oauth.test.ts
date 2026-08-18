import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-oauth-'));

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
const oauth = await import('../src/grok-oauth.js');
const translator = await import('../src/grok-translator.js');
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

describe('Grok translator headers and effort', () => {
  test('maps effort onto the three cli-chat-proxy grades', () => {
    expect(translator.grokEffort('low')).toBe('low');
    expect(translator.grokEffort('minimal')).toBe('low');
    expect(translator.grokEffort('HIGH')).toBe('high');
    expect(translator.grokEffort('xhigh')).toBe('high');
    expect(translator.grokEffort('max')).toBe('high');
    expect(translator.grokEffort('ultracode')).toBe('high');
    expect(translator.grokEffort('')).toBe('medium');
    expect(translator.grokEffort('balanced')).toBe('medium');
  });

  test('sets grok-shell identity headers required by cli-chat-proxy', () => {
    expect(translator.grokUpstreamHeaders('tok-1')).toMatchObject({
      Authorization: 'Bearer tok-1',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-grok-client-version': '0.2.93',
      'x-grok-client-identifier': 'grok-shell',
    });
  });

  test('anthropicToGrokRequest defaults to grok-4.5 and maps effort', () => {
    const body = translator.anthropicToGrokRequest(
      {
        messages: [{ role: 'user', content: 'hi' }],
      },
      'xhigh',
    );
    expect(body.model).toBe('grok-4.5');
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  test('extractGrokAuthCode accepts raw code or a callback URL', () => {
    expect(translator.extractGrokAuthCode('abc123')).toEqual({
      code: 'abc123',
    });
    expect(
      translator.extractGrokAuthCode(
        'http://127.0.0.1:3456/callback?code=from-url&state=st1',
      ),
    ).toEqual({ code: 'from-url', state: 'st1' });
  });
});

describe('Grok PKCE authorize URL', () => {
  test('uses auth.x.ai public client, PKCE, and grok-cli scopes', () => {
    const url = oauth.grokAuthorizeUrl(
      'st123',
      'http://127.0.0.1:3456/callback',
      'AQIDBA',
    );
    expect(url).toContain('https://auth.x.ai/oauth2/authorize');
    expect(url).toContain('client_id=b1a00492-073a-47ea-816f-4c329264a828');
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=st123');
    expect(url).toContain('nonce=st123');
    expect(url).toContain('plan=generic');
    expect(url).toContain('referrer=cli-proxy-api');
    expect(url).toContain('grok-cli%3Aaccess');
    expect(url).toContain(
      'redirect_uri=http%3A%2F%2F127.0.0.1%3A3456%2Fcallback',
    );
    expect(url).not.toContain('prompt');
    expect(oauth.grokRedirectUri()).toBe('http://127.0.0.1:3456/callback');
  });
});

describe('Grok OAuth persist and refresh rotation', () => {
  test('seals credentials, CAS-refreshes them, and never exposes plaintext', () => {
    const first = {
      accessToken: 'grok-access-1',
      refreshToken: 'grok-refresh-1',
      email: 'owner@x.ai',
    };
    const provider = runtimeConfig.createProvider({
      name: 'xAI Grok',
      type: 'grok',
      grokOAuthCredentials: first,
      enabled: true,
    });

    const publicView = runtimeConfig.toPublicProvider(provider);
    expect(publicView.type).toBe('grok');
    expect(publicView.hasGrokOAuthCredentials).toBe(true);
    expect(publicView.grokOAuthEmailMasked).toBeTruthy();
    expect(JSON.stringify(publicView)).not.toContain('grok-access-1');
    expect(JSON.stringify(publicView)).not.toContain('grok-refresh-1');
    expect(publicView.anthropicBaseUrl).toBe('');
    expect(publicView.anthropicModel).toBe('grok-4.5');

    const runner = runtimeConfig.toRunnerProviderConfig(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)!,
    );
    expect(runner.anthropicBaseUrl).toBe('http://127.0.0.1:3456/model');
    expect(runner.anthropicAuthToken).toMatch(/^[0-9a-f]{48}$/);
    expect(runner.anthropicModel).toBe('grok-4.5');
    expect(
      runtime.resolveCodexRunnerProviderId(
        `Bearer ${runner.anthropicAuthToken}`,
      ),
    ).toBe(provider.id);

    const rotated = {
      accessToken: 'grok-access-2',
      refreshToken: 'grok-refresh-2',
      email: 'owner@x.ai',
    };
    expect(
      runtimeConfig.updateProviderGrokCredentialsIfCurrent(
        provider.id,
        first,
        rotated,
      ),
    ).toBe(true);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.grokOAuthCredentials,
    ).toMatchObject({
      accessToken: 'grok-access-2',
      refreshToken: 'grok-refresh-2',
    });
    expect(
      runtimeConfig.updateProviderGrokCredentialsIfCurrent(provider.id, first, {
        ...rotated,
        accessToken: 'stale',
      }),
    ).toBe(false);
  });

  test('refreshGrokCredential persists a rotated refresh token', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: jwt({ email: 'fresh@x.ai' }),
            refresh_token: 'refresh-rotated',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
    );
    const next = await oauth.refreshGrokCredential(
      {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(next.refreshToken).toBe('refresh-rotated');
    expect(next.email).toBe('fresh@x.ai');
    expect(next.expiresAt).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('official and third_party stay direct after Grok', () => {
  test('runner env only injects the local facade for Codex and Grok', () => {
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

describe('Grok facade routing and 401 refresh', () => {
  test('sends grok-shell headers and retries once after 401 refresh', async () => {
    const access = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: 'owner@x.ai',
    });
    const provider = runtimeConfig.createProvider({
      name: 'Grok Facade',
      type: 'grok',
      grokOAuthCredentials: {
        accessToken: access,
        refreshToken: 'refresh-live',
        email: 'owner@x.ai',
      },
      enabled: true,
    });
    const runner = runtimeConfig.toRunnerProviderConfig(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)!,
    );

    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const rawBody = init?.body == null ? null : String(init.body);
      let body: unknown = rawBody;
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
      calls.push({ url, headers, body });
      if (url.includes('auth.x.ai')) {
        return new Response(
          JSON.stringify({
            access_token: jwt({
              exp: Math.floor(Date.now() / 1000) + 3600,
              email: 'owner@x.ai',
            }),
            refresh_token: 'refresh-after-401',
          }),
          { status: 200 },
        );
      }
      if (
        calls.filter((item) => item.url.includes('cli-chat-proxy')).length === 1
      ) {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        ].join('\n'),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const app = createCodexFacadeApp();
      const res = await app.request('/model/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runner.anthropicAuthToken}`,
        },
        body: JSON.stringify({
          model: 'grok-4.5',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { content?: Array<{ text?: string }> };
      expect(json.content?.[0]?.text).toBe('ok');

      const upstream = calls.filter((item) =>
        item.url.includes('cli-chat-proxy.grok.com/v1/responses'),
      );
      expect(upstream).toHaveLength(2);
      expect(upstream[0].headers.get('X-XAI-Token-Auth')).toBe('xai-grok-cli');
      expect(upstream[0].headers.get('x-grok-client-identifier')).toBe(
        'grok-shell',
      );
      expect(upstream[0].headers.get('chatgpt-account-id')).toBeNull();
      expect(upstream[0].body).toMatchObject({
        model: 'grok-4.5',
        reasoning: { effort: 'medium', summary: 'auto' },
      });
      expect(
        calls.some((item) => item.url.includes('auth.x.ai/oauth2/token')),
      ).toBe(true);
      expect(
        runtimeConfig.getProviders().find((item) => item.id === provider.id)
          ?.grokOAuthCredentials?.refreshToken,
      ).toBe('refresh-after-401');
    } finally {
      globalThis.fetch = previous;
    }
  });

  test('Codex facade token still does not hit cli-chat-proxy', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Codex Control',
      type: 'codex',
      codexOAuthCredentials: {
        accessToken: 'codex-access',
        refreshToken: 'codex-refresh',
        accountId: 'acct_1',
      },
      enabled: true,
    });
    const runner = runtimeConfig.toRunnerProviderConfig(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)!,
    );
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('chatgpt.com')) {
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"codex"}\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 500 });
    });
    const previous = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const app = createCodexFacadeApp();
      const res = await app.request('/model/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runner.anthropicAuthToken}`,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalled();
      const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('chatgpt.com'))).toBe(true);
      expect(urls.some((url) => url.includes('cli-chat-proxy'))).toBe(false);
    } finally {
      globalThis.fetch = previous;
    }
  });
});
