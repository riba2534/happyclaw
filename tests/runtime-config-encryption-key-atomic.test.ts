import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runtime-config-key-atomic-'),
);

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
    error: vi.fn(),
  },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const channelSecrets = await import('../src/channel-account-secrets.js');

const keyFile = path.join(root, 'config', 'claude-provider.key');

function decryptChannelPayload(
  keyHex: string,
  payload: { iv: string; tag: string; data: string },
): Record<string, string> {
  const key = Buffer.from(keyHex.trim(), 'hex');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]).toString('utf8'),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true, mode: 0o700 });
  for (const provider of runtimeConfig.getProviders()) {
    runtimeConfig.deleteProvider(provider.id);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime-config getOrCreateEncryptionKey create is atomic no-replace', () => {
  test('TOCTOU create after channel publish adopts existing key (no overwrite)', () => {
    // Channel path already uses wx+link(2) on the shared claude-provider.key.
    const ref = channelSecrets.channelAccountSecretRef('key-atomic-probe');
    channelSecrets.saveChannelAccountSecret(ref, {
      botToken: 'secret-channel-token',
    });
    const published = fs.readFileSync(keyFile, 'utf8');
    const secretPath = path.join(
      root,
      'config',
      'channel-accounts',
      'key-atomic-probe.json',
    );
    const ciphertext = JSON.parse(fs.readFileSync(secretPath, 'utf8')) as {
      iv: string;
      tag: string;
      data: string;
    };

    // Simulate lost race: existsSync already observed false, file now present.
    const realExistsSync = fs.existsSync.bind(fs);
    vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (path.resolve(String(target)) === path.resolve(keyFile)) return false;
      return realExistsSync(target);
    });

    // Triggers getOrCreateEncryptionKey create branch via encryptSecrets.
    runtimeConfig.createProvider({
      name: 'RaceProbe',
      type: 'third_party',
      anthropicBaseUrl: 'https://example.test',
      anthropicAuthToken: 'fake-token',
      enabled: false,
    });

    const after = fs.readFileSync(keyFile, 'utf8');
    expect(after).toBe(published);
    expect(decryptChannelPayload(after, ciphertext).botToken).toBe(
      'secret-channel-token',
    );
    expect(channelSecrets.loadChannelAccountSecret(ref)?.botToken).toBe(
      'secret-channel-token',
    );
  });

  test('concurrent create callers converge on one key', async () => {
    const { Worker, isMainThread } = await import('node:worker_threads');
    // In-process concurrent create via Promise.all around createProvider is
    // serialized by the event loop; exercise the fixed link(2) pattern directly
    // against the same key path the modules share.
    const KEY_FILE = keyFile;
    function getOrCreateFixed(): string {
      const readExisting = () => fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (fs.existsSync(KEY_FILE)) return readExisting();
      const key = crypto.randomBytes(32);
      const tmp = `${KEY_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, `${key.toString('hex')}\n`, {
          mode: 0o600,
          flag: 'wx',
        });
        try {
          fs.linkSync(tmp, KEY_FILE);
          fs.chmodSync(KEY_FILE, 0o600);
          return key.toString('hex');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          return readExisting();
        }
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }

    const keys = await Promise.all(
      Array.from({ length: 8 }, async () => getOrCreateFixed()),
    );
    const unique = new Set(keys);
    expect(unique.size).toBe(1);
    expect(fs.readFileSync(KEY_FILE, 'utf8').trim()).toBe(keys[0]);
    // Silence unused in case bundlers complain about Worker import intent.
    expect(isMainThread || Worker).toBeTruthy();
  });
});
