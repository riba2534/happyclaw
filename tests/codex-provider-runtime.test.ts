import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-provider-runtime-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  CONTAINER_IMAGE: 'happyclaw-agent:test',
  TIMEZONE: 'UTC',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const {
  applyCodexGatewayVerdict,
  buildVolumeMounts,
  getContainerRuntimeEnvDir,
} = await import('../src/container-runner.js');
const { CodexGatewayRunnerLease, resolveCodexGatewayToken } =
  await import('../src/codex-gateway/runner-tokens.js');
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');
const { CODEX_REAUTH_REQUIRED_USER_NOTICE } =
  await import('../src/provider-failure.js');

const configFile = path.join(root, 'config', 'claude-provider.json');

function codexCredentials(token = 'upstream-access') {
  return {
    accessToken: token,
    refreshToken: `refresh-${token}`,
    expiresAt: Date.now() + 3_600_000,
    accountId: 'account',
    planType: 'plus',
    email: 'fake@example.invalid',
    updatedAt: new Date().toISOString(),
  };
}

function createCodexProvider(
  overrides: Partial<Parameters<typeof runtimeConfig.createProvider>[0]> = {},
) {
  return runtimeConfig.createProvider({
    name: `ChatGPT ${Math.random()}`,
    type: 'third_party',
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: 'stored-gateway-identifier',
    anthropicModel: 'gpt-6-sol',
    codexOAuthCredentials: codexCredentials(),
    enabled: true,
    ...overrides,
  });
}

beforeEach(() => {
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex provider state in the public provider shape', () => {
  test('exposes the effective default effort for Codex providers only', () => {
    const configured = createCodexProvider({
      customEnv: { CODEX_REASONING_EFFORT: 'high' },
    });
    expect(runtimeConfig.toPublicProvider(configured)).toMatchObject({
      codexDefaultEffort: 'high',
      codexOAuthNeedsReauth: false,
      codexOAuthLastRefreshError: null,
    });
    // Unconfigured: the model's catalog default (gpt-6-astra defaults to low).
    expect(
      runtimeConfig.toPublicProvider(
        createCodexProvider({ anthropicModel: 'gpt-6-astra' }),
      ).codexDefaultEffort,
    ).toBe('low');
    // Unsupported levels are clamped exactly as the gateway clamps them.
    expect(
      runtimeConfig.toPublicProvider(
        createCodexProvider({
          anthropicModel: 'gpt-6-luna',
          customEnv: { CODEX_REASONING_EFFORT: 'ultra' },
        }),
      ).codexDefaultEffort,
    ).toBe('medium');
    const thirdParty = runtimeConfig.createProvider({
      name: 'Third party',
      type: 'third_party',
      anthropicBaseUrl: 'https://api.example.test',
      anthropicAuthToken: 'key',
      anthropicModel: 'model',
    });
    expect(runtimeConfig.toPublicProvider(thirdParty)).toMatchObject({
      codexDefaultEffort: null,
      codexOAuthNeedsReauth: false,
      codexOAuthLastRefreshError: null,
    });
  });

  test('persists the refresh failure outside the secrets, guarded by the credential snapshot', () => {
    const provider = createCodexProvider();
    const state = {
      kind: 'reauth_required' as const,
      message: 'refresh_token 被拒绝（invalid_grant）',
      at: '2026-10-11T00:00:00.000Z',
      accessTokenRejected: true,
    };
    expect(
      runtimeConfig.setProviderCodexOAuthRefreshErrorIfCurrent(
        provider.id,
        codexCredentials('someone-else'),
        state,
      ),
    ).toBe(false);
    expect(
      runtimeConfig.setProviderCodexOAuthRefreshErrorIfCurrent(
        provider.id,
        provider.codexOAuthCredentials!,
        state,
      ),
    ).toBe(true);
    const stored = runtimeConfig.getProviderById(provider.id)!;
    expect(stored.codexOAuthLastRefreshError).toEqual(state);
    expect(stored.updatedAt).toBe(provider.updatedAt);
    expect(runtimeConfig.toPublicProvider(stored)).toMatchObject({
      codexOAuthNeedsReauth: true,
      codexOAuthLastRefreshError: {
        kind: 'reauth_required',
        message: state.message,
        at: state.at,
      },
    });
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const record = onDisk.providers.find(
      (entry: { id: string }) => entry.id === provider.id,
    );
    expect(record.codexOAuthLastRefreshError.kind).toBe('reauth_required');
    expect(JSON.stringify(record)).not.toContain('upstream-access');
  });

  test('a new login or a successful refresh clears the failure', () => {
    const provider = createCodexProvider();
    const failure = {
      kind: 'transient' as const,
      message: '令牌刷新暂时失败（HTTP 503）',
      at: new Date().toISOString(),
    };
    runtimeConfig.setProviderCodexOAuthRefreshErrorIfCurrent(
      provider.id,
      provider.codexOAuthCredentials!,
      failure,
    );
    const refreshed = codexCredentials('refreshed');
    expect(
      runtimeConfig.updateProviderCodexOAuthCredentialsIfCurrent(
        provider.id,
        provider.codexOAuthCredentials!,
        refreshed,
      ),
    ).toBe(true);
    expect(
      runtimeConfig.getProviderById(provider.id)!.codexOAuthLastRefreshError,
    ).toBeNull();

    runtimeConfig.setProviderCodexOAuthRefreshErrorIfCurrent(
      provider.id,
      refreshed,
      { ...failure, kind: 'reauth_required' },
    );
    runtimeConfig.updateProviderSecrets(provider.id, {
      codexOAuthCredentials: codexCredentials('relogin'),
    });
    expect(
      runtimeConfig.getProviderById(provider.id)!.codexOAuthLastRefreshError,
    ).toBeNull();
  });

  test('ignores a malformed stored failure record', () => {
    const provider = createCodexProvider();
    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    onDisk.providers[0].codexOAuthLastRefreshError = { kind: 'bogus' };
    fs.writeFileSync(configFile, JSON.stringify(onDisk));
    // Bypass the mtime-keyed cache for the rewritten file.
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(configFile, future, future);
    expect(
      runtimeConfig.getProviderById(provider.id)!.codexOAuthLastRefreshError,
    ).toBeNull();
  });
});

const SESSION = 'session-1';

describe('container launch substitution', () => {
  test('the env file carries a runner token, never the stored identifier', () => {
    const provider = createCodexProvider();
    const lease = new CodexGatewayRunnerLease({
      kind: 'container',
      groupFolder: 'codex-ws',
    });
    fs.mkdirSync(path.join(root, 'groups', 'codex-ws'), { recursive: true });
    buildVolumeMounts(
      {
        name: 'codex-ws',
        folder: 'codex-ws',
        added_at: new Date().toISOString(),
      } as never,
      false,
      SESSION,
      false,
      undefined,
      runtimeConfig.resolveProviderById(provider.id),
      undefined,
      undefined,
      {
        envLines: ['HTTP_PROXY=http://proxy.example:8080'],
        addHostGateway: false,
      },
      lease,
    );
    const envFile = fs.readFileSync(
      path.join(getContainerRuntimeEnvDir('codex-ws', SESSION), 'env'),
      'utf8',
    );
    expect(envFile).not.toContain('stored-gateway-identifier');
    expect(envFile).not.toContain(CODEX_GATEWAY_BASE_URL_PLACEHOLDER);
    expect(envFile).toMatch(
      /ANTHROPIC_BASE_URL='http:\/\/host\.docker\.internal:\d+\/gateway\/chatgpt'/,
    );
    expect(envFile).toMatch(/NO_PROXY='[^']*host\.docker\.internal'/);
    const token = /ANTHROPIC_API_KEY='(hcgw_[^']+)'/.exec(envFile)?.[1];
    expect(token).toBeTruthy();
    expect(resolveCodexGatewayToken(token!)).toMatchObject({
      providerId: provider.id,
      owner: { kind: 'container', groupFolder: 'codex-ws' },
    });
    lease.revoke();
    expect(resolveCodexGatewayToken(token!)).toBeNull();
  });

  test("a conversation's model runs the main tiers, background work stays on the configuration, and the pick travels in the grant", () => {
    const provider = createCodexProvider({ anthropicModel: 'gpt-6-sol' });
    const resolved = runtimeConfig.resolveProviderById(provider.id);
    const lease = new CodexGatewayRunnerLease({
      kind: 'container',
      groupFolder: 'codex-pick',
      agentId: SESSION,
      sessionEffort: 'ultra',
    });
    fs.mkdirSync(path.join(root, 'groups', 'codex-pick'), { recursive: true });
    buildVolumeMounts(
      {
        name: 'codex-pick',
        folder: 'codex-pick',
        added_at: new Date().toISOString(),
      } as never,
      false,
      SESSION,
      false,
      undefined,
      // What trySelectPoolProvider hands over for a pinned model.
      {
        config: { ...resolved.config, anthropicModel: 'gpt-6-astra' },
        customEnv: resolved.customEnv,
      },
      undefined,
      undefined,
      { envLines: [], addHostGateway: false },
      lease,
    );
    const envFile = fs.readFileSync(
      path.join(getContainerRuntimeEnvDir('codex-pick', SESSION), 'env'),
      'utf8',
    );
    const value = (key: string) =>
      new RegExp(`^${key}='([^']*)'$`, 'm').exec(envFile)?.[1];
    expect(value('ANTHROPIC_MODEL')).toBe('gpt-6-astra');
    expect(value('ANTHROPIC_DEFAULT_OPUS_MODEL')).toBe('gpt-6-astra');
    expect(value('ANTHROPIC_DEFAULT_SONNET_MODEL')).toBe('gpt-6-astra');
    expect(value('CLAUDE_CODE_SUBAGENT_MODEL')).toBe('gpt-6-astra');
    // The gateway maps the haiku tier to the configuration's model at low effort.
    expect(value('ANTHROPIC_DEFAULT_HAIKU_MODEL')).toBe('claude-haiku-5-5');
    // The effort is the gateway's to apply: it never becomes a runner variable
    // that the CLI would round down (ultra) or override.
    expect(envFile).not.toContain('ultra');
    const token = /ANTHROPIC_API_KEY='(hcgw_[^']+)'/.exec(envFile)?.[1];
    expect(resolveCodexGatewayToken(token!)).toMatchObject({
      providerId: provider.id,
      sessionEffort: 'ultra',
      owner: { groupFolder: 'codex-pick', sessionEffort: 'ultra' },
    });
    lease.revoke();
  });
});

describe('applyCodexGatewayVerdict', () => {
  const accountFailure = () => ({
    status: 'error' as const,
    result: null,
    providerFailure: true,
    providerFailureClass: 'account' as const,
  });

  test('a throttle the gateway applied itself is transient', () => {
    const output = accountFailure();
    applyCodexGatewayVerdict(output, { lastVerdict: 'local_transient' });
    expect(output.providerFailureClass).toBe('transient');
  });

  test('a rejected refresh grant stays an account verdict with a re-login notice', () => {
    const output: ReturnType<typeof accountFailure> & {
      providerFailureNotice?: string;
    } = accountFailure();
    applyCodexGatewayVerdict(output, { lastVerdict: 'reauth_required' });
    expect(output.providerFailureClass).toBe('account');
    expect(output.providerFailureNotice).toBe(
      CODEX_REAUTH_REQUIRED_USER_NOTICE,
    );
  });

  test.each(['ok', 'upstream_failure', null] as const)(
    'leaves upstream verdicts (%s) untouched',
    (lastVerdict) => {
      const output = accountFailure();
      applyCodexGatewayVerdict(output, { lastVerdict });
      expect(output.providerFailureClass).toBe('account');
    },
  );

  test('only rewrites account-class provider failures', () => {
    const config = {
      ...accountFailure(),
      providerFailureClass: 'config' as const,
    };
    applyCodexGatewayVerdict(config, { lastVerdict: 'local_transient' });
    expect(config.providerFailureClass).toBe('config');
    const healthy = { status: 'success' as const, result: 'ok' };
    applyCodexGatewayVerdict(healthy, { lastVerdict: 'local_transient' });
    expect(healthy).toEqual({ status: 'success', result: 'ok' });
  });
});
