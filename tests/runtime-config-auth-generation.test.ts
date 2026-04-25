import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => ({
  dataDir: `/tmp/happyclaw-runtime-config-auth-generation-${process.pid}`,
}));

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw',
  DATA_DIR: testPaths.dataDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  createProvider,
  updateProvider,
  updateProviderSecrets,
} from '../src/runtime-config.js';

function cleanup(): void {
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
}

describe('runtime provider auth generation', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('keeps non-secret updates on the same generation', () => {
    const provider = createProvider({
      name: 'GPT',
      type: 'official',
      runtime: 'codex',
      providerFamily: 'gpt',
      providerPoolId: 'gpt',
      authMode: 'api_key',
      openaiApiKey: 'sk-test-one',
    });

    const updated = updateProvider(provider.id, { name: 'GPT Renamed' });

    expect(updated.authProfileGeneration).toBe(provider.authProfileGeneration);
    expect(
      fs.existsSync(path.join(testPaths.dataDir, 'config', 'claude-provider.json')),
    ).toBe(true);
  });

  it('bumps the generation when GPT credentials rotate', () => {
    const provider = createProvider({
      name: 'GPT',
      type: 'official',
      runtime: 'codex',
      providerFamily: 'gpt',
      providerPoolId: 'gpt',
      authMode: 'api_key',
      openaiApiKey: 'sk-test-one',
    });

    const updated = updateProviderSecrets(provider.id, {
      openaiApiKey: 'sk-test-two',
    });

    expect(updated.authProfileGeneration).toBe(
      provider.authProfileGeneration + 1,
    );
    expect(updated.authMode).toBe('api_key');
  });

  it('bumps the generation when GPT auth mode changes', () => {
    const provider = createProvider({
      name: 'GPT',
      type: 'official',
      runtime: 'codex',
      providerFamily: 'gpt',
      providerPoolId: 'gpt',
      authMode: 'api_key',
      openaiApiKey: 'sk-test-one',
    });

    const updated = updateProviderSecrets(provider.id, {
      authMode: 'chatgpt_oauth',
    });

    expect(updated.authProfileGeneration).toBe(
      provider.authProfileGeneration + 1,
    );
    expect(updated.authMode).toBe('chatgpt_oauth');
  });
});
