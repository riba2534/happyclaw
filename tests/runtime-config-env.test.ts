import { describe, expect, test } from 'vitest';

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

  test('derives managed Claude Code defaults for third-party models', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2[1m]');
    expect(lines).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.2[1m]');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
    expect(lines).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1');
    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).toContain('CLAUDE_CODE_NO_FLICKER=1');
    expect(lines).toContain('API_TIMEOUT_MS=3000000');
  });

  test('defaults the compact window to 1M only for 1M-native or [1m] models', () => {
    const windowFor = (anthropicModel: string) =>
      buildClaudeEnvLines(config({ anthropicModel }), NO_CUSTOM_ENV).find(
        (line) => line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW='),
      );
    for (const model of [
      'claude-sonnet-5',
      'anthropic/claude-sonnet-5-20260101',
      'claude-opus-4-7',
      'us.anthropic.claude-opus-5-5-v1:0',
      'claude-haiku-5-5',
      'claude-fable-5-1',
      'claude-opus-4-6[1m]',
    ]) {
      expect(windowFor(model)).toBe('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
    }
    for (const model of [
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
      'claude-3-5-sonnet-20241022',
      'glm-5.2',
      'k3',
    ]) {
      expect(windowFor(model)).toBe('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
    }
  });

  test('uses defaults but lets provider settings override third-party values', () => {
    const lines = buildClaudeEnvLines(config({ anthropicModel: 'k3' }), {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '999999',
      CLAUDE_CODE_EFFORT_LEVEL: 'low',
      CUSTOM_FLAG: 'kept',
    });

    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=999999');
    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=low');
    expect(lines).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
    expect(lines).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).toContain('CUSTOM_FLAG=kept');
  });

  test('keeps runtime tuning customizable for official providers', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicBaseUrl: '', anthropicModel: 'sonnet' }),
      { CLAUDE_CODE_EFFORT_LEVEL: 'low' },
    );

    expect(lines).toContain('CLAUDE_CODE_EFFORT_LEVEL=low');
    expect(lines).not.toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(lines).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000');
  });

  test('prevents workspace overrides from replacing third-party managed values', () => {
    const lines = buildContainerEnvLines(
      config({ anthropicModel: 'glm-5.2[1m]' }),
      {
        customEnv: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-model',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '42',
          HAPPYCLAW_FALLBACK_MODEL: 'workspace-fallback',
          PROJECT_ENV: 'kept',
        },
      },
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2[1m]');
    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
    expect(lines).not.toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=stale-model');
    expect(lines).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=42');
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
