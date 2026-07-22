import { describe, expect, test } from 'vitest';

import {
  buildClaudeEnvLines,
  buildContainerEnvLines,
  clearInheritedClaudeProviderEnv,
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

  test('treats native 1M models (Fable 5) as 1M without the [1m] suffix', () => {
    const lines = buildClaudeEnvLines(
      config({ anthropicModel: 'claude-fable-5' }),
      NO_CUSTOM_ENV,
    );

    expect(lines).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
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
