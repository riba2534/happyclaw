import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-config-cache-'));
const logged = vi.hoisted(() => ({ error: [] as string[] }));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (_obj: unknown, msg: string) => logged.error.push(msg),
  },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const configFile = path.join(root, 'config', 'claude-provider.json');
const keyFile = path.join(root, 'config', 'claude-provider.key');

/** Move both files' mtimes out of the racy window so signatures can settle. */
function settleFiles(): void {
  const past = new Date(Date.now() - 60_000);
  for (const file of [configFile, keyFile]) {
    if (fs.existsSync(file)) fs.utimesSync(file, past, past);
  }
}

function countReads() {
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  const createDecipheriv = vi.spyOn(crypto, 'createDecipheriv');
  return {
    configReads: () =>
      readFileSync.mock.calls.filter(([file]) => file === configFile).length,
    keyReads: () =>
      readFileSync.mock.calls.filter(([file]) => file === keyFile).length,
    decrypts: () => createDecipheriv.mock.calls.length,
  };
}

function seedProviders(): void {
  for (const provider of runtimeConfig.getProviders()) {
    runtimeConfig.deleteProvider(provider.id);
  }
  runtimeConfig.createProvider({
    name: 'Official',
    type: 'official',
    anthropicApiKey: 'fake-official-key',
    customEnv: { FOO: 'bar' },
    enabled: true,
  });
  runtimeConfig.createProvider({
    name: 'Gateway',
    type: 'third_party',
    anthropicBaseUrl: 'https://gateway.example.test',
    anthropicAuthToken: 'fake-gateway-token',
    enabled: true,
  });
  const official = runtimeConfig
    .getProviders()
    .find((p) => p.name === 'Official')!;
  runtimeConfig.updateProviderSecrets(official.id, {
    claudeOAuthCredentials: {
      accessToken: 'fake-access',
      refreshToken: 'fake-refresh',
      expiresAt: 1,
      scopes: ['a', 'b'],
    },
  });
}

beforeEach(() => {
  seedProviders();
  settleFiles();
  logged.error.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('provider config read cache', () => {
  test('repeated reads neither re-read nor re-decrypt the file', () => {
    const first = runtimeConfig.getProviders();
    const reads = countReads();
    for (let i = 0; i < 50; i++) {
      expect(runtimeConfig.getProviders()).toEqual(first);
      runtimeConfig.getBalancingConfig();
      runtimeConfig.resolveProviderById(first[1].id);
    }
    expect(reads.configReads()).toBe(0);
    expect(reads.keyReads()).toBe(0);
    expect(reads.decrypts()).toBe(0);
  });

  test('saves encrypt with the cached key and are visible on the next read', () => {
    const [official, gateway] = runtimeConfig.getProviders();
    const reads = countReads();

    runtimeConfig.updateProvider(gateway.id, { name: 'Renamed gateway' });
    expect(runtimeConfig.getProviderById(gateway.id)?.name).toBe(
      'Renamed gateway',
    );
    runtimeConfig.setProviderEnabled(official.id, false);
    expect(runtimeConfig.getProviderById(official.id)?.enabled).toBe(false);
    runtimeConfig.saveBalancingConfig({ unhealthyThreshold: 7 });
    expect(runtimeConfig.getBalancingConfig().unhealthyThreshold).toBe(7);
    runtimeConfig.updateProviderSecrets(gateway.id, {
      anthropicAuthToken: 'fake-rotated-token',
    });
    expect(runtimeConfig.getProviderById(gateway.id)?.anthropicAuthToken).toBe(
      'fake-rotated-token',
    );
    runtimeConfig.deleteProvider(official.id);
    expect(runtimeConfig.getProviders().map((p) => p.id)).toEqual([gateway.id]);
    // The key file was settled before these saves; it is never re-read.
    expect(reads.keyReads()).toBe(0);
  });

  test('returned objects are private copies', () => {
    const providers = runtimeConfig.getProviders();
    providers[0].name = 'mutated';
    providers[0].customEnv.INJECTED = '1';
    providers[0].claudeOAuthCredentials!.scopes.push('mutated');
    providers.push({ ...providers[1], id: 'ghost' });
    runtimeConfig.getBalancingConfig().unhealthyThreshold = 999;

    const again = runtimeConfig.getProviders();
    expect(again).toHaveLength(2);
    expect(again[0].name).toBe('Official');
    expect(again[0].customEnv).toEqual({ FOO: 'bar' });
    expect(again[0].claudeOAuthCredentials?.scopes).toEqual(['a', 'b']);
    expect(runtimeConfig.getBalancingConfig().unhealthyThreshold).not.toBe(999);
  });

  test('picks up an external rewrite of the file', () => {
    runtimeConfig.getProviders();
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    stored.providers[1].name = 'Edited on disk, longer name';
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);
    expect(runtimeConfig.getProviders()[1].name).toBe(
      'Edited on disk, longer name',
    );
  });

  test('picks up a same-size in-place rewrite right after a read', () => {
    // Coarse timestamps can give both writes one mtime; the racy window makes
    // the fresh signature untrusted until it settles.
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    stored.providers[1].name = 'AAAA';
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);
    expect(runtimeConfig.getProviders()[1].name).toBe('AAAA');
    stored.providers[1].name = 'BBBB';
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);
    expect(runtimeConfig.getProviders()[1].name).toBe('BBBB');
  });

  test('a corrupted file fails every read, as before, and recovers', () => {
    const good = fs.readFileSync(configFile, 'utf8');
    runtimeConfig.getProviders();
    fs.writeFileSync(configFile, '{ not json');
    expect(runtimeConfig.getProviders()).toEqual([]);
    expect(runtimeConfig.getProviders()).toEqual([]);
    expect(logged.error).toEqual([
      'Failed to read Claude model configuration V5',
      'Failed to read Claude model configuration V5',
    ]);
    fs.writeFileSync(configFile, good);
    expect(runtimeConfig.getProviders()).toHaveLength(2);
  });

  test('a removed file reads as empty', () => {
    const [official] = runtimeConfig.getProviders();
    fs.rmSync(configFile);
    expect(runtimeConfig.getProviders()).toEqual([]);
    expect(runtimeConfig.getProviderById(official.id)).toBeNull();
  });

  test('a replaced key invalidates the decrypted cache', () => {
    runtimeConfig.getProviders();
    const original = fs.readFileSync(keyFile, 'utf8');
    fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('hex')}\n`);
    // Decrypting with the wrong key fails the read, exactly as uncached.
    expect(runtimeConfig.getProviders()).toEqual([]);
    expect(logged.error).toContain(
      'Failed to read Claude model configuration V5',
    );
    fs.writeFileSync(keyFile, original);
    expect(runtimeConfig.getProviders()).toHaveLength(2);
  });

  test('a V4 file still migrates once, then reads from the cache', () => {
    const stored = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    stored.version = 4;
    fs.writeFileSync(configFile, `${JSON.stringify(stored, null, 2)}\n`);
    const migrated = runtimeConfig.getProviders();
    expect(migrated.map((p) => p.name)).toEqual(['Official', 'Gateway']);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).version).toBe(5);

    settleFiles();
    runtimeConfig.getProviders();
    const reads = countReads();
    expect(runtimeConfig.getProviders()).toEqual(migrated);
    expect(reads.configReads()).toBe(0);
  });
});
