/**
 * Catalog syncs and quota reads reach a saved connection with the header its
 * Runner would send, so they cannot pass where the runs fail or the reverse.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-access-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { storedConnectionAccess } = await import('../src/model-catalog-sync.js');
const { buildClaudeEnvLines } = await import('../src/runtime-config.js');
type UnifiedProvider = import('../src/runtime-config.js').UnifiedProvider;

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function connection(fields: Partial<UnifiedProvider>): UnifiedProvider {
  return {
    id: 'c1',
    name: 'magpie',
    type: 'third_party',
    anthropicBaseUrl: 'https://magpie.example',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    anthropicModel: 'kimi/k3',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    codexOAuthCredentials: null,
    customEnv: {},
    updatedAt: new Date(0).toISOString(),
    ...fields,
  } as UnifiedProvider;
}

describe('storedConnectionAccess', () => {
  test('a key stored as an API key goes as x-api-key, as the Runner sends it', () => {
    const provider = connection({
      anthropicApiKey: 'stored-api-key',
      anthropicAuthMode: 'bearer',
    });
    expect(storedConnectionAccess(provider)).toMatchObject({
      credential: 'stored-api-key',
      authMode: 'x-api-key',
      explicitAuthMode: true,
    });
    // The Runner's environment for the same connection names it an API key.
    expect(
      buildClaudeEnvLines(
        {
          ...provider,
          anthropicModel: provider.anthropicModel,
        } as never,
        {},
      ),
    ).toContain('ANTHROPIC_API_KEY=stored-api-key');
  });

  test('a token takes the stored header style', () => {
    expect(
      storedConnectionAccess(
        connection({ anthropicAuthToken: 'tok', anthropicAuthMode: 'bearer' }),
      ),
    ).toMatchObject({ authMode: 'bearer', explicitAuthMode: true });
    expect(
      storedConnectionAccess(
        connection({
          anthropicAuthToken: 'tok',
          anthropicAuthMode: 'x-api-key',
        }),
      ),
    ).toMatchObject({ authMode: 'x-api-key', explicitAuthMode: true });
  });
});
