import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-gateway-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');

const configFile = path.join(root, 'config', 'claude-provider.json');

function storedProvider(id: string): Record<string, unknown> {
  const file = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as {
    providers: Array<Record<string, unknown>>;
  };
  return file.providers.find((provider) => provider.id === id)!;
}

function createMagpie(
  patch: Partial<Parameters<typeof runtimeConfig.createProvider>[0]> = {},
) {
  return runtimeConfig.createProvider({
    name: 'Magpie',
    type: 'third_party',
    presetId: 'magpie',
    anthropicBaseUrl: 'http://127.0.0.1:3425',
    anthropicAuthToken: 'magpie-gateway-key-123',
    anthropicModel: 'codex/gpt-5.6-sol',
    ...patch,
  });
}

beforeEach(() => {
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('magpie connections', () => {
  test('one made from the preset is marked, skips the WebFetch check and searches tools', () => {
    const created = createMagpie();
    expect(created.gateway).toBe('magpie');
    expect(created.webFetchPreflightPolicy).toBe('skip');
    const shown = runtimeConfig.toPublicProvider(created);
    expect(shown).toMatchObject({
      gateway: 'magpie',
      presetId: 'magpie',
      toolSearch: 'default',
      toolSearchEnabled: true,
      catalog: { autoAdd: false, syncedAt: null, error: null, newModels: [] },
    });
    // An explicit WebFetch choice is kept.
    expect(
      createMagpie({ webFetchPreflightPolicy: 'check' })
        .webFetchPreflightPolicy,
    ).toBeUndefined();
  });

  test('the preset stays when the gateway runs elsewhere', () => {
    const created = createMagpie({
      anthropicBaseUrl: 'https://magpie.example.com',
    });
    expect(created.presetId).toBe('magpie');
    const moved = runtimeConfig.updateProvider(created.id, {
      anthropicBaseUrl: 'https://magpie2.example.com',
    });
    expect(moved.presetId).toBe('magpie');
    expect(moved.gateway).toBe('magpie');
  });

  test('a detected gateway is forgotten when the address changes', () => {
    const created = runtimeConfig.createProvider({
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.com',
      anthropicAuthToken: 'relay-key-1234567',
      anthropicModel: 'codex/gpt-5.6-sol',
      gateway: 'magpie',
      catalogAutoAdd: true,
    });
    expect(created.gateway).toBe('magpie');
    expect(storedProvider(created.id)).toMatchObject({
      gateway: 'magpie',
      catalog: { autoAdd: true },
    });
    const renamed = runtimeConfig.updateProvider(created.id, { name: 'R' });
    expect(renamed.gateway).toBe('magpie');
    const moved = runtimeConfig.updateProvider(created.id, {
      anthropicBaseUrl: 'https://elsewhere.example.com',
    });
    expect(moved.gateway).toBeUndefined();
    // The admin's own choice outlives the detection.
    expect(moved.catalog).toEqual({ autoAdd: true });
    expect(runtimeConfig.toPublicProvider(moved).catalog).toBeNull();
  });

  test('a magpie connection needs a model', () => {
    expect(() => createMagpie({ anthropicModel: '' })).toThrow(
      runtimeConfig.ProviderWriteError,
    );
    const created = createMagpie();
    try {
      runtimeConfig.updateProvider(created.id, {
        anthropicModel: '',
        models: [],
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(runtimeConfig.ProviderWriteError);
      expect(
        (err as InstanceType<typeof runtimeConfig.ProviderWriteError>).code,
      ).toBe('MAGPIE_MODELS_REQUIRED');
    }
    // A pass-through relay elsewhere may still have none.
    expect(
      runtimeConfig.createProvider({
        name: 'Relay',
        type: 'third_party',
        anthropicBaseUrl: 'https://relay.example.com',
        anthropicAuthToken: 'relay-key-1234567',
      }).models,
    ).toBeUndefined();
  });

  test('tool search: an explicit choice is stored, default is absent', () => {
    const created = createMagpie({ toolSearch: 'off' });
    expect(storedProvider(created.id).toolSearch).toBe('off');
    expect(runtimeConfig.toPublicProvider(created).toolSearchEnabled).toBe(
      false,
    );
    const back = runtimeConfig.updateProvider(created.id, {
      toolSearch: 'default',
    });
    expect(storedProvider(created.id).toolSearch).toBeUndefined();
    expect(runtimeConfig.providerToolSearchEnabled(back)).toBe(true);
    const relay = runtimeConfig.createProvider({
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: 'https://relay.example.com',
      anthropicAuthToken: 'relay-key-1234567',
      anthropicModel: 'm',
      toolSearch: 'on',
    });
    expect(runtimeConfig.toPublicProvider(relay)).toMatchObject({
      gateway: null,
      toolSearch: 'on',
      toolSearchEnabled: true,
    });
  });
});

describe('model metadata', () => {
  test('display name, reply limit and vendor are stored and shown; sync bookkeeping is not shown', () => {
    const created = createMagpie({
      models: [
        {
          id: 'codex/gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          maxOutputTokens: 128_000,
          vendor: 'Codex',
          efforts: ['low', 'high'],
        },
        { id: 'relaya/deepseek-chat', efforts: [] },
      ],
    });
    expect(storedProvider(created.id).models).toEqual([
      {
        id: 'codex/gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        efforts: ['low', 'high'],
        maxOutputTokens: 128_000,
        vendor: 'Codex',
      },
      { id: 'relaya/deepseek-chat', efforts: [] },
    ]);
    const synced = runtimeConfig.recordProviderCatalog(created.id, created, {
      models: [
        {
          id: 'codex/gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          contextWindow: 400_000,
          synced: { contextWindow: 400_000 },
        },
      ],
      catalog: { syncedAt: '2026-11-15T00:00:00.000Z' },
    })!;
    expect(synced.models?.[0].synced).toEqual({ contextWindow: 400_000 });
    expect(runtimeConfig.toPublicProvider(synced).models[0]).toEqual({
      id: 'codex/gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      contextWindow: 400_000,
    });
  });

  test('an admin edit that leaves out the vendor fields keeps them', () => {
    const created = createMagpie({
      models: [
        {
          id: 'codex/gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          maxOutputTokens: 128_000,
          vendor: 'Codex',
          upstreamMissingSince: '2026-11-01T00:00:00.000Z',
        },
      ],
    });
    const updated = runtimeConfig.updateProvider(created.id, {
      models: [{ id: 'codex/gpt-5.6-sol', contextWindow: 300_000 }],
    });
    expect(updated.models).toEqual([
      {
        id: 'codex/gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        contextWindow: 300_000,
        maxOutputTokens: 128_000,
        vendor: 'Codex',
        upstreamMissingSince: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });

  test('a magpie discovery alias is never written', () => {
    const created = createMagpie({
      models: [{ id: 'codex/gpt-5.6-sol' }, { id: 'anthropic/magpie-7' }],
    });
    expect(created.models?.map((entry) => entry.id)).toEqual([
      'codex/gpt-5.6-sol',
    ]);
    const updated = runtimeConfig.updateProvider(created.id, {
      models: [{ id: 'codex/gpt-5.6-sol' }, { id: 'anthropic/magpie-9' }],
    });
    expect(updated.models?.map((entry) => entry.id)).toEqual([
      'codex/gpt-5.6-sol',
    ]);
  });

  test('a new model the admin adds leaves the catalog of new models', () => {
    const created = createMagpie();
    runtimeConfig.recordProviderCatalog(created.id, created, {
      catalog: {
        syncedAt: '2026-11-15T00:00:00.000Z',
        newModels: [{ id: 'relaya/glm-5' }, { id: 'relaya/kimi' }],
      },
    });
    const updated = runtimeConfig.updateProvider(created.id, {
      models: [{ id: 'codex/gpt-5.6-sol' }, { id: 'relaya/glm-5' }],
    });
    expect(updated.catalog?.newModels).toEqual([{ id: 'relaya/kimi' }]);
    expect(updated.catalog?.syncedAt).toBe('2026-11-15T00:00:00.000Z');
  });

  test('a catalog record for a changed credential is dropped', () => {
    const created = createMagpie();
    runtimeConfig.updateProviderSecrets(created.id, {
      anthropicAuthToken: 'another-gateway-key-456',
    });
    expect(
      runtimeConfig.recordProviderCatalog(created.id, created, {
        catalog: { syncedAt: '2026-11-15T00:00:00.000Z' },
      }),
    ).toBeNull();
  });
});

describe('the reply limit at launch', () => {
  const config = {
    anthropicBaseUrl: 'https://relay.example.com',
    anthropicAuthToken: 'relay-key-1234567',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'big',
    models: [{ id: 'big', maxOutputTokens: 200_000 }],
    updatedAt: null,
  };

  test('derived from the models, unless the connection env names its own', () => {
    expect(runtimeConfig.buildClaudeEnvLines(config, {})).toContain(
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000',
    );
    const own = runtimeConfig.buildClaudeEnvLines(config, {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '50000',
    });
    expect(
      own.filter((line) => line.startsWith('CLAUDE_CODE_MAX_OUTPUT_TOKENS=')),
    ).toEqual(['CLAUDE_CODE_MAX_OUTPUT_TOKENS=50000']);
    expect(
      runtimeConfig.validateProviderCustomEnv({
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'lots',
      }),
    ).toMatch(/正整数/);
  });

  test('an inherited value never reaches a launch', () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1',
    };
    runtimeConfig.clearInheritedClaudeProviderEnv(env);
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });
});
