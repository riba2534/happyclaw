import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-model-list-'));

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
const loggerModule = await import('../src/logger.js');
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');

const configFile = path.join(root, 'config', 'claude-provider.json');

type StoredFile = {
  version: number;
  providers: Array<Record<string, unknown>>;
};

function readFile(): StoredFile {
  return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as StoredFile;
}

function writeFile(file: StoredFile): void {
  fs.writeFileSync(configFile, JSON.stringify(file, null, 2));
}

function createThirdParty(
  patch: Partial<Parameters<typeof runtimeConfig.createProvider>[0]> = {},
) {
  return runtimeConfig.createProvider({
    name: 'GLM',
    type: 'third_party',
    anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    anthropicAuthToken: 'glm-secret-123456',
    anthropicModel: 'glm-5.3',
    ...patch,
  });
}

const PASSED = {
  ok: true,
  code: null,
  status: 200,
  model: 'glm-5.3',
  latencyMs: 120,
  at: '2026-10-20T08:00:00.000Z',
} as const;

beforeEach(() => {
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('connection WebFetch policy storage', () => {
  test.each(['check', 'skip'] as const)(
    '%s survives rereads, unrelated edits and credential changes',
    (webFetchPreflightPolicy) => {
      const created = createThirdParty({ webFetchPreflightPolicy });
      runtimeConfig.updateProvider(created.id, { name: 'Renamed connection' });
      runtimeConfig.updateProviderSecrets(created.id, {
        anthropicAuthToken: 'replacement-secret',
      });
      const reloaded = runtimeConfig.getProviderById(created.id)!;
      expect(reloaded.webFetchPreflightPolicy).toBe(webFetchPreflightPolicy);
      expect(runtimeConfig.toPublicProvider(reloaded)).toMatchObject({
        webFetchPreflightPolicy,
        hasAnthropicAuthToken: true,
      });
      expect(
        runtimeConfig.providerToConfig(reloaded).webFetchPreflightPolicy,
      ).toBe(webFetchPreflightPolicy);
      expect(reloaded.anthropicAuthToken).toBe('replacement-secret');
      expect(readFile().version).toBe(5);
    },
  );

  test('new connections default to an explicit check policy', () => {
    const created = createThirdParty();
    expect(readFile().providers[0].webFetchPreflightPolicy).toBe('check');
    expect(
      runtimeConfig.toPublicProvider(runtimeConfig.getProviderById(created.id)!)
        .webFetchPreflightPolicy,
    ).toBe('check');
  });

  test.each([undefined, 'inherit', 'unexpected'])(
    'stored %s is read as check without rewriting the configuration',
    (storedPolicy) => {
      const created = createThirdParty();
      const file = readFile();
      if (storedPolicy === undefined) {
        delete file.providers[0].webFetchPreflightPolicy;
      } else {
        file.providers[0].webFetchPreflightPolicy = storedPolicy;
      }
      writeFile(file);
      const unchangedFile = fs.readFileSync(configFile, 'utf8');
      const reloaded = runtimeConfig.getProviderById(created.id)!;
      expect(reloaded.webFetchPreflightPolicy).toBe('check');
      expect(
        runtimeConfig.toPublicProvider(reloaded).webFetchPreflightPolicy,
      ).toBe('check');
      expect(
        runtimeConfig.providerToConfig(reloaded).webFetchPreflightPolicy,
      ).toBe('check');
      expect(fs.readFileSync(configFile, 'utf8')).toBe(unchangedFile);
    },
  );

  test('returning to check persists the enabled default', () => {
    const created = createThirdParty({ webFetchPreflightPolicy: 'skip' });
    expect(readFile().providers[0].webFetchPreflightPolicy).toBe('skip');
    runtimeConfig.updateProvider(created.id, {
      webFetchPreflightPolicy: 'check',
    });
    expect(readFile().providers[0].webFetchPreflightPolicy).toBe('check');
    expect(
      runtimeConfig.toPublicProvider(runtimeConfig.getProviderById(created.id)!)
        .webFetchPreflightPolicy,
    ).toBe('check');
  });

  test('OAuth refresh and duplication keep their connection policy', () => {
    const official = runtimeConfig.createProvider({
      name: 'OAuth',
      type: 'official',
      webFetchPreflightPolicy: 'check',
      claudeOAuthCredentials: {
        accessToken: 'old-access',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
        scopes: ['user:inference'],
      },
    });
    expect(
      runtimeConfig.updateProviderOAuthCredentialsIfCurrent(
        official.id,
        official.claudeOAuthCredentials!,
        {
          ...official.claudeOAuthCredentials!,
          accessToken: 'renewed-access',
        },
      ),
    ).toBe(true);
    expect(
      runtimeConfig.getProviderById(official.id)!.webFetchPreflightPolicy,
    ).toBe('check');
    const thirdParty = createThirdParty({ webFetchPreflightPolicy: 'skip' });
    const duplicate = runtimeConfig.duplicateProvider(thirdParty.id);
    expect(
      runtimeConfig.getProviderById(duplicate.id)!.webFetchPreflightPolicy,
    ).toBe('skip');
  });
});

describe('stored model lists', () => {
  test('a connection saved before lists existed offers its one model', () => {
    const created = createThirdParty();
    // The file is what an earlier release wrote: none of the new fields.
    const file = readFile();
    expect(file.version).toBe(5);
    expect(Object.keys(file.providers[0])).not.toEqual(
      expect.arrayContaining(['models']),
    );
    expect(file.providers[0]).not.toHaveProperty('presetId');
    expect(file.providers[0]).not.toHaveProperty('lastTest');

    const [provider] = runtimeConfig.getProviders();
    expect(provider.models).toBeUndefined();
    expect(runtimeConfig.toPublicProvider(provider)).toMatchObject({
      id: created.id,
      anthropicModel: 'glm-5.3',
      models: [{ id: 'glm-5.3' }],
      presetId: null,
      lastTest: null,
    });
  });

  test('a pass-through relay without a model offers none', () => {
    createThirdParty({ anthropicModel: '' });
    const [provider] = runtimeConfig.getProviders();
    expect(runtimeConfig.toPublicProvider(provider).models).toEqual([]);
  });

  test('creating stores the list in the new shape, with the connection model, and the preset', () => {
    createThirdParty({
      presetId: 'zhipu-glm-cn',
      models: [
        {
          id: 'glm-5.3-flash',
          contextWindow: 1_000_000,
          efforts: ['low', 'high'],
          defaultEffort: 'high',
        },
        { id: 'glm-5.3' },
        { id: 'glm-5.2', contextWindow: 128_000 },
      ],
    });
    const stored = readFile().providers[0];
    expect(stored.models).toEqual([
      {
        id: 'glm-5.3-flash',
        contextWindow: 1_000_000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      },
      { id: 'glm-5.3' },
      { id: 'glm-5.2', contextWindow: 128_000 },
    ]);
    expect(stored.presetId).toBe('zhipu-glm-cn');

    createThirdParty({
      anthropicModel: 'glm-5.1',
      models: [{ id: 'glm-5.2' }],
    });
    expect(readFile().providers[1].models).toEqual([
      { id: 'glm-5.1' },
      { id: 'glm-5.2' },
    ]);
  });

  test('a default model Claude Code cannot take is refused', () => {
    expect(() => createThirdParty({ anthropicModel: 'glm 5.3' })).toThrow(
      '模型名无效',
    );
  });

  test('reading drops what this release cannot vouch for', () => {
    createThirdParty();
    const file = readFile();
    file.providers[0].models = [
      'glm-5.3',
      { id: 'has space' },
      { id: 'glm-5.2', hidden: true, effort: 'turbo', extra: 1 },
      { id: 'glm-5.2' },
      { id: 'glm-5.1[1m]', effort: 'high', efforts: ['max', 'nope'] },
      42,
    ];
    file.providers[0].presetId = 'no-such-preset';
    file.providers[0].lastTest = { ...PASSED, ok: 'yes' };
    writeFile(file);

    const [provider] = runtimeConfig.getProviders();
    // `[1m]` is read as the window, `effort` as the default; `hidden` is gone.
    expect(provider.models).toEqual([
      { id: 'glm-5.3' },
      { id: 'glm-5.2' },
      {
        id: 'glm-5.1',
        contextWindow: 1_000_000,
        efforts: ['max'],
        defaultEffort: 'high',
      },
    ]);
    expect(provider.presetId).toBeUndefined();
    expect(provider.lastTest).toBeUndefined();

    file.providers[0].models = { not: 'a list' };
    // A failure code a newer release added reads as UNKNOWN.
    file.providers[0].lastTest = {
      ...PASSED,
      ok: false,
      code: 'SOMETHING_NEW',
      status: 418,
    };
    writeFile(file);
    const [reread] = runtimeConfig.getProviders();
    expect(reread.models).toBeUndefined();
    expect(reread.lastTest).toEqual({
      ...PASSED,
      ok: false,
      code: 'UNKNOWN',
      status: 418,
    });
  });

  test('the new fields sit beside the old ones, which an older release reads unchanged', () => {
    const created = createThirdParty({
      presetId: 'zhipu-glm-cn',
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    runtimeConfig.recordProviderTest(created.id, created, PASSED);
    const withFields = readFile();
    expect(withFields.version).toBe(5);

    // What an older release keeps: everything but the fields it ignores.
    const stripped = structuredClone(withFields);
    for (const provider of stripped.providers) {
      delete provider.models;
      delete provider.presetId;
      delete provider.lastTest;
    }
    writeFile(stripped);
    const [old] = runtimeConfig.getProviders();
    writeFile(withFields);
    const [current] = runtimeConfig.getProviders();

    const { models, presetId, lastTest, ...rest } = current;
    expect(models).toHaveLength(2);
    expect(presetId).toBe('zhipu-glm-cn');
    expect(lastTest).toEqual(PASSED);
    expect(old).toEqual(rest);
    expect(old.anthropicAuthToken).toBe('glm-secret-123456');
  });

  test('ChatGPT subscriptions keep no list or preset: their catalog is the list', () => {
    const provider = runtimeConfig.createProvider({
      name: 'ChatGPT',
      type: 'third_party',
      webFetchPreflightPolicy: 'skip',
      anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      anthropicAuthToken: 'gateway-identifier-123456',
      anthropicModel: 'gpt-5.5',
      codexOAuthCredentials: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3_600_000,
        accountId: 'acct',
        planType: 'pro',
        email: null,
      },
      models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }],
      presetId: 'deepseek',
    });
    expect(provider.models).toBeUndefined();
    expect(provider.presetId).toBeUndefined();
    expect(readFile().providers[0]).not.toHaveProperty('models');
    expect(runtimeConfig.toPublicProvider(provider).models).toEqual([]);
    const reloaded = runtimeConfig.getProviderById(provider.id)!;
    expect(
      runtimeConfig.toPublicProvider(reloaded).webFetchPreflightPolicy,
    ).toBe('skip');
  });
});

describe('editing a list', () => {
  test('a new default joins the list instead of replacing the old one', () => {
    const { id } = createThirdParty();
    const updated = runtimeConfig.updateProvider(id, {
      anthropicModel: 'glm-5.2',
    });
    expect(updated.models).toEqual([{ id: 'glm-5.2' }, { id: 'glm-5.3' }]);

    // Back to the old default: the list stays as it is.
    expect(
      runtimeConfig.updateProvider(id, { anthropicModel: 'glm-5.3' }).models,
    ).toEqual([{ id: 'glm-5.2' }, { id: 'glm-5.3' }]);
  });

  test('a new list replaces the old one; the connection model stays in it', () => {
    const { id } = createThirdParty({
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    const updated = runtimeConfig.updateProvider(id, {
      models: [{ id: 'glm-5.3', defaultEffort: 'low' }, { id: 'glm-5.1' }],
    });
    expect(updated.models).toEqual([
      { id: 'glm-5.3', defaultEffort: 'low' },
      { id: 'glm-5.1' },
    ]);
    // A list without the default gets it back in front.
    expect(
      runtimeConfig.updateProvider(id, { models: [{ id: 'glm-5.1' }] }).models,
    ).toEqual([{ id: 'glm-5.3' }, { id: 'glm-5.1' }]);
    expect(
      runtimeConfig.updateProvider(id, { name: 'Renamed' }).models,
    ).toEqual([{ id: 'glm-5.3' }, { id: 'glm-5.1' }]);
  });

  test('presetId can be set, kept, cleared, and an unknown one is not kept', () => {
    const { id } = createThirdParty({ presetId: 'zhipu-glm-cn' });
    expect(runtimeConfig.updateProvider(id, { name: 'x' }).presetId).toBe(
      'zhipu-glm-cn',
    );
    expect(
      runtimeConfig.updateProvider(id, { presetId: null }).presetId,
    ).toBeUndefined();
    expect(
      runtimeConfig.updateProvider(id, { presetId: 'no-such' }).presetId,
    ).toBeUndefined();
    expect(readFile().providers[0]).not.toHaveProperty('presetId');
  });
});

describe('the last connection test', () => {
  test('is kept with the connection, with the auth header style it found', () => {
    const created = createThirdParty();
    const before = readFile().providers[0].updatedAt;
    const recorded = runtimeConfig.recordProviderTest(
      created.id,
      created,
      PASSED,
      'x-api-key',
    );
    expect(recorded).toMatchObject({
      lastTest: PASSED,
      anthropicAuthMode: 'x-api-key',
    });
    const stored = readFile().providers[0];
    expect(stored.lastTest).toEqual(PASSED);
    expect(stored.updatedAt).toBe(before);

    // A connection that has a style keeps it.
    const second = runtimeConfig.getProviderById(created.id)!;
    runtimeConfig.recordProviderTest(created.id, second, PASSED, 'bearer');
    expect(runtimeConfig.getProviderById(created.id)?.anthropicAuthMode).toBe(
      'x-api-key',
    );
  });

  test('is not written when the connection changed while the test ran', () => {
    const created = createThirdParty();
    runtimeConfig.updateProviderSecrets(created.id, {
      anthropicAuthToken: 'glm-other-654321',
    });
    expect(
      runtimeConfig.recordProviderTest(created.id, created, PASSED),
    ).toBeNull();
    expect(runtimeConfig.getProviderById(created.id)?.lastTest).toBeUndefined();
  });

  test('stops vouching once the endpoint, header or key changes', () => {
    const created = createThirdParty();
    const test = () =>
      runtimeConfig.recordProviderTest(
        created.id,
        runtimeConfig.getProviderById(created.id)!,
        PASSED,
      );

    test();
    expect(
      runtimeConfig.updateProvider(created.id, {
        name: 'Renamed',
        models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
        anthropicModel: 'glm-5.2',
      }).lastTest,
    ).toEqual(PASSED);

    expect(
      runtimeConfig.updateProvider(created.id, {
        anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
      }).lastTest,
    ).toBeUndefined();

    test();
    expect(
      runtimeConfig.updateProvider(created.id, { anthropicAuthMode: 'bearer' })
        .lastTest,
    ).toBeUndefined();

    test();
    expect(
      runtimeConfig.updateProviderSecrets(created.id, {
        anthropicAuthToken: 'glm-new-secret-999',
      }).lastTest,
    ).toBeUndefined();
    expect(readFile().providers[0]).not.toHaveProperty('lastTest');
  });
});

describe('what a test describes', () => {
  const expiresAt = Date.now() + 3_600_000;
  function oauth(suffix: string) {
    return {
      accessToken: `sk-ant-oat01-access-${suffix}`,
      refreshToken: `sk-ant-ort01-refresh-${suffix}`,
      expiresAt,
      scopes: ['user:inference', 'user:profile'],
    };
  }

  test('a renewed login is the same; a new login, even into the same account, is not', () => {
    const created = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      claudeOAuthCredentials: oauth('a'),
      claudeOAuthAccount: { accountUuid: 'acct-1' },
    });
    const tested = runtimeConfig.getProviderById(created.id)!;
    expect(tested.claudeOAuthGrantId).toMatch(/^[0-9a-f]{16}$/);

    // A renewal while the test ran keeps the login.
    expect(
      runtimeConfig.updateProviderOAuthCredentialsIfCurrent(
        created.id,
        oauth('a'),
        oauth('b'),
      ),
    ).toBe(true);
    expect(
      runtimeConfig.recordProviderTest(created.id, tested, PASSED),
    ).not.toBeNull();

    // Logging in again replaces it: a test started before is not written.
    const beforeLogin = runtimeConfig.getProviderById(created.id)!;
    runtimeConfig.updateProviderSecrets(created.id, {
      claudeOAuthCredentials: oauth('c'),
      claudeOAuthAccount: { accountUuid: 'acct-1' },
    });
    expect(
      runtimeConfig.recordProviderTest(created.id, beforeLogin, PASSED),
    ).toBeNull();
    expect(runtimeConfig.getProviderById(created.id)!.lastTest).toBeUndefined();
  });

  test('the env the test sends is part of it; other env is not', () => {
    const created = createThirdParty({
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: a' },
    });
    const record = () =>
      runtimeConfig.recordProviderTest(
        created.id,
        runtimeConfig.getProviderById(created.id)!,
        PASSED,
      );

    record();
    expect(
      runtimeConfig.updateProvider(created.id, {
        customEnv: {
          ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: a',
          API_TIMEOUT_MS: '600000',
        },
      }).lastTest,
    ).toEqual(PASSED);
    expect(
      runtimeConfig.updateProvider(created.id, {
        customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: b' },
      }).lastTest,
    ).toBeUndefined();

    // The background model is probed too, so changing it is a new test.
    const beforeHaiku = runtimeConfig.getProviderById(created.id)!;
    runtimeConfig.updateProvider(created.id, {
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }],
      roles: { smallFast: 'glm-5.3-flash' },
    });
    expect(
      runtimeConfig.recordProviderTest(created.id, beforeHaiku, PASSED),
    ).toBeNull();
  });

  test('a preset stays only with its own endpoint', () => {
    const relay = createThirdParty({
      anthropicBaseUrl: 'https://relay.example.com/anthropic',
      presetId: 'zhipu-glm-cn',
    });
    expect(relay.presetId).toBeUndefined();

    const glm = createThirdParty({ presetId: 'zhipu-glm-cn' });
    expect(glm.presetId).toBe('zhipu-glm-cn');
    // The same address written differently is still the preset's.
    expect(
      runtimeConfig.updateProvider(glm.id, {
        anthropicBaseUrl: 'https://OPEN.bigmodel.cn/api/anthropic/',
      }).presetId,
    ).toBe('zhipu-glm-cn');
    expect(
      runtimeConfig.updateProvider(glm.id, {
        anthropicBaseUrl: 'https://relay.example.com/anthropic',
      }).presetId,
    ).toBeUndefined();
    expect(readFile().providers[1]).not.toHaveProperty('presetId');
  });

  test('a list already at its cap cannot take a new default by dropping a model', () => {
    const models = Array.from({ length: 100 }, (_, index) => ({
      id: index === 0 ? 'glm-5.3' : `m-${index}`,
    }));
    const created = createThirdParty({ models });
    expect(created.models).toHaveLength(100);
    expect(() =>
      runtimeConfig.updateProvider(created.id, { anthropicModel: 'glm-new' }),
    ).toThrow('最多 100 个模型');
    expect(runtimeConfig.getProviderById(created.id)!.models).toHaveLength(100);
    // 99 models and a new default fit; 100 others and a new default do not.
    expect(() =>
      createThirdParty({ anthropicModel: 'glm-new', models: models.slice(1) }),
    ).not.toThrow();
    expect(() =>
      createThirdParty({
        anthropicModel: 'glm-new',
        models: models.map((model, index) =>
          index === 0 ? { id: 'm-0' } : model,
        ),
      }),
    ).toThrow('最多 100 个模型');
  });
});

describe('reading a connection saved before models carried their settings', () => {
  /** Writes the file an earlier release left: env keys, `[1m]`, no marker. */
  function legacy(patch: Record<string, unknown>): void {
    createThirdParty();
    const file = readFile();
    const [stored] = file.providers;
    delete stored.envPrefill;
    Object.assign(stored, patch);
    writeFile(file);
  }

  test('moves model env keys into the list and roles, and prefills the env once', () => {
    legacy({
      anthropicModel: 'glm-5.3[1m]',
      models: [{ id: 'glm-5.3[1m]' }, { id: 'glm-5.3-flash', hidden: true }],
      customEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
        CLAUDE_CODE_SUBAGENT_MODEL: 'glm-5.3[1m]',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'not-a-model-of-it',
        ANTHROPIC_DEFAULT_SONNET_MODEL: '',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '800000',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        API_TIMEOUT_MS: '600000',
        CUSTOM_FLAG: 'kept',
      },
    });

    const [provider] = runtimeConfig.getProviders();
    expect(provider.anthropicModel).toBe('glm-5.3');
    // The compact window lowered the 1M `[1m]` gave; it and the effort
    // applied to every launch, so every entry without its own gets them. A
    // model a key named but the list lacked is added, and the effort is
    // declared for it since nothing is known about its efforts.
    expect(provider.models).toEqual([
      { id: 'glm-5.3', contextWindow: 800_000, defaultEffort: 'high' },
      { id: 'glm-5.3-flash', contextWindow: 800_000, defaultEffort: 'high' },
      {
        id: 'not-a-model-of-it',
        contextWindow: 800_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      },
    ]);
    // The sub-agent key named the connection's own model: no role.
    expect(provider.roles).toEqual({
      smallFast: 'glm-5.3-flash',
      opus: 'not-a-model-of-it',
    });
    expect(provider.customEnv).toEqual({
      API_TIMEOUT_MS: '600000',
      CUSTOM_FLAG: 'kept',
      CLAUDE_CODE_NO_FLICKER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    expect(provider.envPrefill).toBe(1);

    // Written back once; reading again changes nothing.
    const migrated = fs.readFileSync(configFile, 'utf-8');
    expect(JSON.parse(migrated).version).toBe(5);
    expect(migrated).not.toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL');
    expect(runtimeConfig.getProviders()[0]).toEqual(provider);
    expect(fs.readFileSync(configFile, 'utf-8')).toBe(migrated);
  });

  test('the compact window and effort apply to a model without a window', () => {
    legacy({
      anthropicModel: 'k3',
      customEnv: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '256000',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
      },
    });
    const [provider] = runtimeConfig.getProviders();
    // Nothing is known about k3's efforts: the old effort stays usable.
    expect(provider.models).toEqual([
      {
        id: 'k3',
        contextWindow: 256_000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'max',
      },
    ]);
    const env = runtimeConfig.buildClaudeEnvLines(
      runtimeConfig.providerToConfig(provider),
      provider.customEnv,
    );
    expect(env).toContain('ANTHROPIC_MODEL=k3[1m]');
    expect(env).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=256000');
    expect(env).toContain('API_TIMEOUT_MS=3000000');
    expect(
      env.some((line) => line.startsWith('CLAUDE_CODE_EFFORT_LEVEL=')),
    ).toBe(false);
    expect(runtimeConfig.providerEffortLevel(provider)).toBe('max');
  });

  test('a compact window below 1M is the window of a [1m] model', () => {
    legacy({
      anthropicModel: 'x-model[1m]',
      customEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' },
    });
    const [provider] = runtimeConfig.getProviders();
    expect(provider.models).toEqual([
      { id: 'x-model', contextWindow: 400_000 },
    ]);
    const env = runtimeConfig.buildClaudeEnvLines(
      runtimeConfig.providerToConfig(provider),
      provider.customEnv,
    );
    expect(env).toContain('ANTHROPIC_MODEL=x-model[1m]');
    expect(env).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000');
  });

  test('a declared window or effort is not overridden', () => {
    legacy({
      anthropicModel: 'k3',
      models: [
        { id: 'k3', contextWindow: 128_000, defaultEffort: 'low' },
        { id: 'k3-big', contextWindow: 1_000_000 },
        'k3-long[1m]',
      ],
      customEnv: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '256000',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
      },
    });
    const [provider] = runtimeConfig.getProviders();
    const all = ['low', 'medium', 'high', 'xhigh', 'max'];
    // A declared 1M stays; a 1M that only came from `[1m]` in the stored
    // list was a ceiling the compact window lowered.
    expect(provider.models).toEqual([
      { id: 'k3', contextWindow: 128_000, defaultEffort: 'low' },
      {
        id: 'k3-big',
        contextWindow: 1_000_000,
        efforts: all,
        defaultEffort: 'high',
      },
      {
        id: 'k3-long',
        contextWindow: 256_000,
        efforts: all,
        defaultEffort: 'high',
      },
    ]);
  });

  test('a window the user declares later is not lowered by a kept legacy key', () => {
    legacy({
      anthropicModel: '',
      customEnv: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000' },
    });
    const [relay] = runtimeConfig.getProviders();
    // The wizard declares GLM-5.3 at 1M on the relay that kept the key.
    runtimeConfig.updateProvider(relay.id, {
      models: [{ id: 'glm-5.3', contextWindow: 1_000_000 }],
    });
    const [provider] = runtimeConfig.getProviders();
    expect(provider.models).toEqual([
      { id: 'glm-5.3', contextWindow: 1_000_000 },
    ]);
  });

  test('editing the env keeps the legacy keys the API does not show', () => {
    legacy({
      anthropicModel: '',
      customEnv: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        OLD_FLAG: 'x',
      },
    });
    const [relay] = runtimeConfig.getProviders();
    const shown = runtimeConfig.toPublicProvider(relay).customEnv;
    expect(shown).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    // The editor saves what it was shown, minus one key.
    const { OLD_FLAG: _dropped, ...edited } = shown;
    const updated = runtimeConfig.updateProvider(relay.id, {
      customEnv: { ...edited, NEW_FLAG: 'y' },
    });
    expect(updated.customEnv).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      NEW_FLAG: 'y',
    });
    expect(updated.customEnv).not.toHaveProperty('OLD_FLAG');
    expect(readFile().providers[0].customEnv).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
    });
  });

  test('a pass-through relay turns role keys into roles with their models', () => {
    legacy({
      anthropicModel: '',
      customEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
        CLAUDE_CODE_SUBAGENT_MODEL: 'relay-big[1m]',
      },
    });
    const [provider] = runtimeConfig.getProviders();
    expect(provider.anthropicModel).toBe('');
    expect(provider.models).toEqual([
      { id: 'claude-haiku-5-5' },
      { id: 'relay-big', contextWindow: 1_000_000 },
    ]);
    expect(provider.roles).toEqual({
      smallFast: 'claude-haiku-5-5',
      subagent: 'relay-big',
    });
    const env = runtimeConfig.buildClaudeEnvLines(
      runtimeConfig.providerToConfig(provider),
      provider.customEnv,
    );
    expect(env).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5');
    expect(env).toContain('CLAUDE_CODE_SUBAGENT_MODEL=relay-big[1m]');
    expect(env.some((line) => line.startsWith('ANTHROPIC_MODEL='))).toBe(false);
  });

  test('a pass-through relay with no entry keeps its window and effort keys', () => {
    const { logger } = loggerModule;
    vi.mocked(logger.warn).mockClear();
    legacy({
      anthropicModel: '',
      customEnv: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
        CLAUDE_CODE_EFFORT_LEVEL: 'high',
        CUSTOM_FLAG: 'kept',
      },
    });
    const [provider] = runtimeConfig.getProviders();
    expect(provider.models).toBeUndefined();
    expect(provider.customEnv).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
      CUSTOM_FLAG: 'kept',
    });
    // Kept in the file, said once, not injected, not offered for editing.
    expect(readFile().providers[0].customEnv).toMatchObject({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '400000',
      CLAUDE_CODE_EFFORT_LEVEL: 'high',
    });
    const saved = fs.readFileSync(configFile, 'utf-8');
    runtimeConfig.getProviders();
    expect(fs.readFileSync(configFile, 'utf-8')).toBe(saved);
    expect(
      vi
        .mocked(logger.warn)
        .mock.calls.filter((call) =>
          String(call[1]).includes('keeps legacy env keys'),
        ),
    ).toHaveLength(1);
    const env = runtimeConfig.buildClaudeEnvLines(
      runtimeConfig.providerToConfig(provider),
      provider.customEnv,
    );
    expect(env).toContain('CUSTOM_FLAG=kept');
    expect(
      env.some(
        (line) =>
          line.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW=') ||
          line.startsWith('CLAUDE_CODE_EFFORT_LEVEL='),
      ),
    ).toBe(false);
    expect(
      runtimeConfig.toPublicProvider(provider).customEnv,
    ).not.toHaveProperty('CLAUDE_CODE_EFFORT_LEVEL');
  });

  test('a key the user deleted after the prefill stays deleted', () => {
    const created = createThirdParty();
    runtimeConfig.updateProvider(created.id, { customEnv: {} });
    expect(runtimeConfig.getProviderById(created.id)!.customEnv).toEqual({});
    expect(readFile().providers[0].envPrefill).toBe(1);
  });

  test('an official connection gets no prefill, only the marker', () => {
    runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      anthropicApiKey: 'sk-ant-api03-abcdefghijklmnop',
      anthropicModel: 'claude-sonnet-5[1m]',
    });
    const file = readFile();
    delete file.providers[0].envPrefill;
    writeFile(file);
    const [provider] = runtimeConfig.getProviders();
    expect(provider.customEnv).toEqual({});
    expect(provider.anthropicModel).toBe('claude-sonnet-5');
    expect(provider.models).toEqual([
      { id: 'claude-sonnet-5', contextWindow: 1_000_000 },
    ]);
    // The declared window keeps the billed 1M opt-in it had.
    expect(
      runtimeConfig.buildClaudeEnvLines(
        runtimeConfig.providerToConfig(provider),
        provider.customEnv,
      ),
    ).toContain('ANTHROPIC_MODEL=claude-sonnet-5[1m]');
  });

  test('without a declared default effort a connection implies none', () => {
    const created = createThirdParty({ anthropicModel: 'k3' });
    expect(runtimeConfig.providerEffortLevel(created)).toBeNull();
  });
});
