import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/happyclaw-codex-auth-material-${process.pid}`,
}));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw',
  DATA_DIR: testPaths.dataDir,
}));

import {
  toPublicProvider,
  writeCodexProviderAuthMaterial,
  type UnifiedProvider,
} from '../src/runtime-config.js';

function provider(
  overrides: Partial<UnifiedProvider> = {},
): UnifiedProvider {
  return {
    id: 'gpt-test',
    name: 'GPT Test',
    type: 'official',
    runtime: 'codex',
    providerFamily: 'gpt',
    providerPoolId: 'gpt',
    authMode: 'api_key',
    authProfileGeneration: 3,
    enabled: true,
    weight: 1,
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicModel: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    openaiApiKey: '',
    codexAuthJson: '',
    customEnv: {},
    updatedAt: '2026-04-25T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  for (const id of ['gpt-test', 'gpt-oauth-test']) {
    fs.rmSync(path.join(testPaths.dataDir, 'config', 'codex', id), {
      recursive: true,
      force: true,
    });
  }
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
});

describe('Codex provider auth material', () => {
  it('writes provider-scoped CODEX_HOME and masks API keys in public config', () => {
    const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz';
    const material = writeCodexProviderAuthMaterial(
      provider({ openaiApiKey: secret }),
    );

    expect(material.env.OPENAI_API_KEY).toBe(secret);
    expect(material.env.CODEX_HOME).toBe(material.codexHomeDir);
    expect(material.authProfileGeneration).toBe(3);
    expect(
      fs.readFileSync(path.join(material.codexHomeDir!, 'config.toml'), 'utf-8'),
    ).toContain('project_doc_fallback_filenames = ["CLAUDE.md"]');
    expect(fs.existsSync(path.join(material.codexHomeDir!, 'auth.json'))).toBe(
      false,
    );

    const publicProvider = toPublicProvider(provider({ openaiApiKey: secret }));
    expect(publicProvider.hasOpenaiApiKey).toBe(true);
    expect(publicProvider.openaiApiKeyMasked).not.toBe(secret);
    expect(publicProvider.hasCodexAuthJson).toBe(false);
  });

  it('writes ChatGPT OAuth auth.json without exposing an API key env var', () => {
    const authJson = JSON.stringify({
      OPENAI_API_KEY: 'unused',
      refresh_token: 'refresh-token',
    });
    const material = writeCodexProviderAuthMaterial(
      provider({
        id: 'gpt-oauth-test',
        authMode: 'chatgpt_oauth',
        codexAuthJson: authJson,
      }),
    );

    expect(material.env.OPENAI_API_KEY).toBeUndefined();
    expect(
      fs
        .readFileSync(path.join(material.codexHomeDir!, 'auth.json'), 'utf-8')
        .trim(),
    ).toBe(authJson);
    const config = fs.readFileSync(
      path.join(material.codexHomeDir!, 'config.toml'),
      'utf-8',
    );
    expect(config).toContain('cli_auth_credentials_store = "file"');
    expect(config).toContain('forced_login_method = "chatgpt"');
    expect(config).toContain('project_doc_fallback_filenames = ["CLAUDE.md"]');

    const publicProvider = toPublicProvider(
      provider({ authMode: 'chatgpt_oauth', codexAuthJson: authJson }),
    );
    expect(publicProvider.hasCodexAuthJson).toBe(true);
    expect(publicProvider.hasOpenaiApiKey).toBe(false);
  });
});
