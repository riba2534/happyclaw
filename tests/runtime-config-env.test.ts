import { describe, expect, test } from 'vitest';

import { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } from '../src/codex-gateway/types.js';
import {
  isCodexBackgroundRequest,
  resolveCodexModel,
  resolveGatewayReasoningEffort,
} from '../src/codex-gateway/convert-request.js';
import { CODEX_MODEL_CATALOG } from '../src/codex-gateway/model-catalog.js';
import {
  buildClaudeEnvLines,
  buildContainerEnvLines,
  clearInheritedClaudeProviderEnv,
  hasExplicitWorkspaceClaudeAuth,
  mergeClaudeEnvConfig,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

function config(patch: Partial<ClaudeProviderConfig>): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: 'https://example.test/anthropic',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'test-model',
    updatedAt: null,
    ...patch,
  };
}

// Always pass an explicit (empty) profileCustomEnv so buildClaudeEnvLines does
// NOT fall through to getActiveProfileCustomEnv() → readStoredStateV4(), which
// reads (and may lazily migrate-write) the real on-disk claude-provider.json.
// Keeping the test hermetic avoids leaking ambient config and disk mutation.
const NO_CUSTOM_ENV: Record<string, string> = {};

describe('buildClaudeEnvLines', () => {
  test.each([
    {
      override: { anthropicApiKey: 'workspace-api-key' },
      expectedKey: 'workspace-api-key',
      expectedToken: '',
    },
    {
      override: { anthropicAuthToken: 'Bearer workspace-auth-token' },
      expectedKey: '',
      expectedToken: 'Bearer workspace-auth-token',
    },
  ])(
    'treats explicit workspace key/token as the authoritative auth mode',
    ({ override, expectedKey, expectedToken }) => {
      const merged = mergeClaudeEnvConfig(
        config({
          anthropicBaseUrl: '',
          anthropicApiKey: 'global-api-key',
          anthropicAuthToken: 'global-auth-token',
          claudeCodeOauthToken: 'global-oauth-token',
          claudeOAuthCredentials: {
            accessToken: 'oauth-access',
            refreshToken: 'oauth-refresh',
            expiresAt: 2_000_000_000_000,
            scopes: ['user:inference'],
          },
        }),
        override,
      );

      expect(hasExplicitWorkspaceClaudeAuth(override)).toBe(true);
      expect(merged.anthropicApiKey).toBe(expectedKey);
      expect(merged.anthropicAuthToken).toBe(expectedToken);
      expect(merged.claudeCodeOauthToken).toBe('');
      expect(merged.claudeOAuthCredentials).toBeNull();
    },
  );

  test('treats a workspace base URL as non-OAuth while retaining inherited key credentials', () => {
    const merged = mergeClaudeEnvConfig(
      config({
        anthropicBaseUrl: '',
        anthropicApiKey: 'global-api-key',
        anthropicAuthToken: 'global-auth-token',
        claudeCodeOauthToken: 'global-oauth-token',
        claudeOAuthCredentials: {
          accessToken: 'oauth-access',
          refreshToken: 'oauth-refresh',
          expiresAt: 2_000_000_000_000,
          scopes: ['user:inference'],
        },
      }),
      { anthropicBaseUrl: 'https://workspace-proxy.test' },
    );

    expect(merged.anthropicBaseUrl).toBe('https://workspace-proxy.test');
    expect(merged.anthropicApiKey).toBe('global-api-key');
    expect(merged.anthropicAuthToken).toBe('global-auth-token');
    expect(merged.claudeCodeOauthToken).toBe('');
    expect(merged.claudeOAuthCredentials).toBeNull();
  });

  test('maps plain third-party auth tokens to ANTHROPIC_API_KEY', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'plain-token' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_API_KEY=plain-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=plain-token');
  });

  test('routes explicit Bearer tokens to ANTHROPIC_AUTH_TOKEN without doubling the prefix', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicAuthToken: 'Bearer upstream-token' }),
      NO_CUSTOM_ENV,
    );

    // The SDK emits `Authorization: Bearer <value>` itself, so the stored value
    // must be the bare token — otherwise the header becomes `Bearer Bearer …`.
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=upstream-token');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=Bearer upstream-token');
    expect(lines).not.toContain('ANTHROPIC_API_KEY=upstream-token');
  });

  test('preserves newlines in ANTHROPIC_CUSTOM_HEADERS', () => {
    const lines = buildClaudeEnvLines(config({}), {
      ANTHROPIC_CUSTOM_HEADERS: 'x-one: 1\nx-two: 2',
    });

    expect(lines).toContain('ANTHROPIC_CUSTOM_HEADERS=x-one: 1\nx-two: 2');
  });

  test('third-party tiers, sub-agent and window follow the turn model', () => {
    const lines = buildClaudeEnvLines(
      config({
        anthropicModel: 'glm-5.2',
        models: [{ id: 'glm-5.2', contextWindow: 1_000_000 }],
      }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.2[1m]');
    expect(lines).toContain('CLAUDE_CODE_SUBAGENT_MODEL=glm-5.2[1m]');
    // 1M is what `[1m]` already gives: no compact window.
    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=')),
    ).toBe(false);
  });

  test('roles pick other models of the connection, each with its own window', () => {
    const lines = buildClaudeEnvLines(
      config({
        anthropicModel: 'k3',
        models: [
          { id: 'k3', contextWindow: 256_000 },
          { id: 'k3-mini' },
          { id: 'k3-long', contextWindow: 1_000_000 },
        ],
        roles: { smallFast: 'k3-mini', subagent: 'k3-long' },
      }),
      NO_CUSTOM_ENV,
    );

    // Above 200K needs `[1m]` to lift the ceiling, the compact window
    // brings it back down to the model's.
    expect(lines).toContain('ANTHROPIC_MODEL=k3[1m]');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=256000');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=k3-mini');
    expect(lines).toContain('CLAUDE_CODE_SUBAGENT_MODEL=k3-long[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=k3[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=k3[1m]');
  });

  test('a model with no known window gets neither [1m] nor a compact window', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'k3' }),
      NO_CUSTOM_ENV,
    );
    expect(lines).toContain('ANTHROPIC_MODEL=k3');
    expect(
      lines.some((line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=')),
    ).toBe(false);
  });

  test('injects nothing implicitly: no effort, no timeout, no traffic flags', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'k3' }),
      NO_CUSTOM_ENV,
    );
    for (const key of [
      'CLAUDE_CODE_EFFORT_LEVEL',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_NO_FLICKER',
      'API_TIMEOUT_MS',
    ]) {
      expect(lines.some((line) => line.startsWith(`${key}=`))).toBe(false);
    }
  });

  test('connection env: non-empty values only, model keys never', () => {
    const lines = buildClaudeEnvLines(config({ anthropicModel: 'k3' }), {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_NO_FLICKER: '',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '   ',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '999999',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'stale',
      CUSTOM_FLAG: 'kept',
    });

    expect(lines).toContain('API_TIMEOUT_MS=3000000');
    expect(lines).toContain('CUSTOM_FLAG=kept');
    for (const key of [
      'CLAUDE_CODE_NO_FLICKER',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'CLAUDE_CODE_EFFORT_LEVEL',
    ]) {
      expect(lines.some((line) => line.startsWith(`${key}=`))).toBe(false);
    }
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=k3');
  });

  test('a pass-through relay without a model only gets the roles it names', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: '', roles: {} }),
      NO_CUSTOM_ENV,
    );
    expect(
      lines.some(
        (line) =>
          line.startsWith('ANTHROPIC_MODEL=') ||
          line.startsWith('ANTHROPIC_DEFAULT_') ||
          line.startsWith('CLAUDE_CODE_SUBAGENT_MODEL='),
      ),
    ).toBe(false);
  });

  test.each([
    CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    'http://127.0.0.1:3000/gateway/chatgpt',
    'http://host.docker.internal:3000/gateway/chatgpt/',
  ])(
    'keeps a Claude haiku tier behind the Codex gateway (%s)',
    (anthropicBaseUrl) => {
      const lines = buildClaudeEnvLines(
        config({ anthropicBaseUrl, anthropicModel: 'gpt-6-sol' }),
        NO_CUSTOM_ENV,
      );
      expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5');
      expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-6-sol');
      expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-6-sol');
      expect(lines).toContain('CLAUDE_CODE_SUBAGENT_MODEL=gpt-6-sol');
    },
  );

  test('haiku-tier calls from a Codex gateway provider run at low effort', () => {
    const haiku = buildClaudeEnvLines(
      config({
        anthropicBaseUrl: 'http://127.0.0.1:3000/gateway/chatgpt',
        anthropicModel: 'gpt-6-sol',
      }),
      { CODEX_REASONING_EFFORT: 'xhigh' },
    )
      .find((line) => line.startsWith('ANTHROPIC_DEFAULT_HAIKU_MODEL='))!
      .split('=')[1];
    // What Claude Code sends for a title/summary call with that env.
    const request = {
      model: haiku,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    };
    const model = resolveCodexModel(request.model, 'gpt-6-sol');
    expect(model).toBe('gpt-6-sol');
    expect(isCodexBackgroundRequest(request)).toBe(true);
    expect(
      resolveGatewayReasoningEffort(request, {
        catalog: CODEX_MODEL_CATALOG,
        model,
        providerEffort: 'xhigh',
        agentEffort: 'max',
      }),
    ).toBe('low');
    // Other third-party gateways keep every tier on the provider model; a
    // window the registry knows is only a suggestion, so no `[1m]`.
    expect(
      buildClaudeEnvLines(
        config({
          anthropicBaseUrl: 'http://127.0.0.1:3000/other/path',
          anthropicModel: 'gpt-6-sol',
        }),
        NO_CUSTOM_ENV,
      ),
    ).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-6-sol');
  });

  test('official: [1m] only for a declared window, never from the registry', () => {
    const official = (patch: Partial<ClaudeProviderConfig>) =>
      buildClaudeEnvLines(config({ anthropicBaseUrl: '', ...patch }), {
        CLAUDE_CODE_EFFORT_LEVEL: 'low',
        CUSTOM_FLAG: 'kept',
      });

    // claude-sonnet-5 is 1M in the registry; that is the billed opt-in.
    const registry = official({ anthropicModel: 'claude-sonnet-5' });
    expect(registry).toContain('ANTHROPIC_MODEL=claude-sonnet-5');
    expect(registry).toContain('CUSTOM_FLAG=kept');
    const declared = official({
      anthropicModel: 'claude-sonnet-5',
      models: [{ id: 'claude-sonnet-5', contextWindow: 1_000_000 }],
    });
    expect(declared).toContain('ANTHROPIC_MODEL=claude-sonnet-5[1m]');
    // A name a session or Agent saved with `[1m]` keeps its 1M opt-in,
    // even when the connection lists the model without a window.
    const saved = official({
      anthropicModel: 'claude-sonnet-4-5[1m]',
      models: [{ id: 'claude-sonnet-4-5' }],
    });
    expect(saved).toContain('ANTHROPIC_MODEL=claude-sonnet-4-5[1m]');
    for (const lines of [registry, declared, saved]) {
      for (const prefix of [
        'ANTHROPIC_DEFAULT_',
        'CLAUDE_CODE_SUBAGENT_MODEL=',
        'CLAUDE_CODE_AUTO_COMPACT_WINDOW=',
        'CLAUDE_CODE_EFFORT_LEVEL=',
      ]) {
        expect(lines.some((line) => line.startsWith(prefix))).toBe(false);
      }
    }
  });

  test('prevents workspace overrides from replacing third-party managed values', () => {
    const lines = buildContainerEnvLines(
      config({
        anthropicModel: 'glm-5.2',
        models: [{ id: 'glm-5.2', contextWindow: 1_000_000 }],
      }),
      {
        customEnv: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-model',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '42',
          API_TIMEOUT_MS: '1',
          HAPPYCLAW_FALLBACK_MODEL: 'workspace-fallback',
          PROJECT_ENV: 'kept',
        },
      },
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]');
    expect(lines).not.toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=stale-model');
    expect(lines).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=42');
    expect(lines).not.toContain('API_TIMEOUT_MS=1');
    expect(lines).not.toContain('HAPPYCLAW_FALLBACK_MODEL=workspace-fallback');
    expect(lines).toContain('PROJECT_ENV=kept');
  });

  test('blocks legacy internal workspace path variables from custom env', () => {
    const lines = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      {
        customEnv: {
          HAPPYCLAW_WORKSPACE_GLOBAL: '/attacker/global',
          HAPPYCLAW_WORKSPACE_MEMORY: '/attacker/memory',
          PROJECT_ENV: 'kept',
        },
      },
      NO_CUSTOM_ENV,
    );

    expect(lines).not.toContain('HAPPYCLAW_WORKSPACE_GLOBAL=/attacker/global');
    expect(lines).not.toContain('HAPPYCLAW_WORKSPACE_MEMORY=/attacker/memory');
    expect(lines).toContain('PROJECT_ENV=kept');
  });

  test('blocks container identity and session permission control variables', () => {
    const blocked = {
      HAPPYCLAW_HOST_IDENTITY_MODE: 'direct',
      HAPPYCLAW_HOST_UID: '0',
      HAPPYCLAW_HOST_GID: '0',
      HAPPYCLAW_INTERNAL_IDENTITY_MODE: 'direct',
      HAPPYCLAW_INTERNAL_FUTURE_ROOT_KNOB: '/workspace/group/evil',
      HAPPYCLAW_PASSWD_FILE: '/workspace/group/passwd',
      HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS: '1',
      HAPPYCLAW_MOUNT_PREPARE_MODE: 'recursive',
      HAPPYCLAW_RUNTIME_USER: 'root',
      HAPPYCLAW_SESSION_ROOT: '/',
      HAPPYCLAW_SESSION_PERMISSION_PID: '1',
      HAPPYCLAW_SESSION_PERMISSION_HELPER: '/workspace/group/evil.sh',
      PATH: '/workspace/group/bin',
      NODE_OPTIONS: '--require=/workspace/group/evil.js',
      LD_PRELOAD: '/workspace/group/evil.so',
      BASH_ENV: '/workspace/group/evil.sh',
    };
    const lines = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      { customEnv: { ...blocked, PROJECT_ENV: 'kept' } },
      blocked,
    );

    for (const key of Object.keys(blocked)) {
      expect(lines.some((line) => line.startsWith(`${key}=`))).toBe(false);
    }
    expect(lines).toContain('PROJECT_ENV=kept');
  });

  test('injects an authoritative endpoint kind that custom env cannot replace', () => {
    const thirdParty = buildContainerEnvLines(
      config({ anthropicBaseUrl: 'https://proxy.test' }),
      { customEnv: { HAPPYCLAW_CLAUDE_ENDPOINT_KIND: 'official' } },
      { HAPPYCLAW_CLAUDE_ENDPOINT_KIND: 'official' },
    );
    const official = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      {},
      NO_CUSTOM_ENV,
    );

    expect(thirdParty).toContain('HAPPYCLAW_CLAUDE_ENDPOINT_KIND=custom');
    expect(thirdParty).not.toContain('HAPPYCLAW_CLAUDE_ENDPOINT_KIND=official');
    expect(official).toContain('HAPPYCLAW_CLAUDE_ENDPOINT_KIND=official');
  });

  test('clears every routing and credential key a parent shell left, keeping network config', () => {
    // HappyClaw started from an admin shell that runs its own Claude Code on Bedrock.
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'admin-bedrock',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.admin.test',
      ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.admin.test',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'admin-fable',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'admin-refresh',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/home/admin/token',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '60',
      HTTPS_PROXY: 'http://proxy.test:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      AWS_PROFILE: 'admin',
      PATH: '/usr/bin',
    };
    clearInheritedClaudeProviderEnv(env);
    expect(env).toEqual({
      HTTPS_PROXY: 'http://proxy.test:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      AWS_PROFILE: 'admin',
      PATH: '/usr/bin',
    });
  });

  test('clears inherited provider values before host-mode config is applied', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_BASE_URL: 'https://stale-proxy.test',
      ANTHROPIC_AUTH_TOKEN: 'stale-token',
      ANTHROPIC_API_KEY: 'stale-key',
      ANTHROPIC_MODEL: 'stale-model',
      ANTHROPIC_CUSTOM_HEADERS: 'x-stale-auth: yes',
      HAPPYCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      KEEP_ME: 'yes',
    };

    clearInheritedClaudeProviderEnv(env);

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.HAPPYCLAW_CLAUDE_ENDPOINT_KIND).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');

    const selectedProviderLines = buildContainerEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: '' }),
      {},
      { ANTHROPIC_CUSTOM_HEADERS: 'x-current-provider: yes' },
    );
    for (const line of selectedProviderLines) {
      const separator = line.indexOf('=');
      env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-current-provider: yes');
  });
});

describe('official endpoint sub-agent model', () => {
  test('only an explicit sub-agent model is sent', () => {
    const official = config({
      anthropicBaseUrl: '',
      anthropicApiKey: 'key',
      anthropicModel: 'claude-opus-5-5',
    });
    expect(
      buildClaudeEnvLines(official, NO_CUSTOM_ENV).some((line) =>
        line.startsWith('CLAUDE_CODE_SUBAGENT_MODEL='),
      ),
    ).toBe(false);
    expect(
      buildClaudeEnvLines(
        { ...official, roles: { subagent: 'claude-haiku-5-5' } },
        NO_CUSTOM_ENV,
      ),
    ).toContain('CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-5-5');
  });
});
