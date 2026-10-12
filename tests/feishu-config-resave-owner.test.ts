import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-resave-owner-'));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const migration = await import('../src/channel-account-migration.js');
const secrets = await import('../src/channel-account-secrets.js');

type Secret = Record<string, string | undefined>;

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Seed a legacy default Feishu account whose first DM already claimed it. */
function seedClaimedAccount(adminId: string, appId = 'cli_app') {
  const account = migration.ensureLegacyDefaultChannelAccount({
    ownerUserId: adminId,
    provider: 'feishu',
    name: '默认飞书',
    enabled: true,
    secret: { appId, appSecret: 'old-secret' },
  });
  // What onP2pSender persists after the first valid DM.
  secrets.saveChannelAccountSecret(account.secret_ref, {
    ...secrets.loadChannelAccountSecret(account.secret_ref),
    ownerOpenId: 'ou_owner',
  });
  return account;
}

/** Same composition as reloadFeishuConnection in src/index.ts. */
function resaveGlobalFeishu(
  adminId: string,
  config: { appId: string; appSecret: string; enabled?: boolean },
) {
  return migration.syncDefaultChannelAccountCredentials({
    ownerUserId: adminId,
    provider: 'feishu',
    name: '默认飞书',
    enabled: config.enabled !== false,
    secret: migration.mergeLegacyFeishuOwner(adminId, {
      appId: config.appId,
      appSecret: config.appSecret,
    }),
  });
}

function storedSecret(accountId: string): Secret | null {
  const account = db.getChannelAccount(accountId);
  if (!account) throw new Error(`missing account ${accountId}`);
  return secrets.loadChannelAccountSecret(account.secret_ref);
}

describe('PUT /api/config/feishu re-save keeps the learned bot owner', () => {
  test('same-appId re-save keeps ownerOpenId', () => {
    const account = seedClaimedAccount('admin-same');
    const saved = resaveGlobalFeishu('admin-same', {
      appId: 'cli_app',
      appSecret: 'rotated-secret',
    });
    expect(saved.id).toBe(account.id);
    expect(saved.enabled).toBe(true);
    expect(storedSecret(account.id)).toEqual({
      appId: 'cli_app',
      appSecret: 'rotated-secret',
      ownerOpenId: 'ou_owner',
    });
  });

  test('enabled:false keeps ownerOpenId', () => {
    const account = seedClaimedAccount('admin-disable');
    const saved = resaveGlobalFeishu('admin-disable', {
      appId: 'cli_app',
      appSecret: 'old-secret',
      enabled: false,
    });
    expect(saved.id).toBe(account.id);
    expect(saved.enabled).toBe(false);
    expect(storedSecret(account.id)).toEqual({
      appId: 'cli_app',
      appSecret: 'old-secret',
      ownerOpenId: 'ou_owner',
    });
  });

  test('a different appId drops ownerOpenId (open_id is per app)', () => {
    const account = seedClaimedAccount('admin-new-app');
    expect(
      migration.mergeLegacyFeishuOwner('admin-new-app', {
        appId: 'cli_other',
        appSecret: 'other-secret',
      }),
    ).toEqual({ appId: 'cli_other', appSecret: 'other-secret' });
    resaveGlobalFeishu('admin-new-app', {
      appId: 'cli_other',
      appSecret: 'other-secret',
    });
    expect(storedSecret(account.id)).toEqual({
      appId: 'cli_other',
      appSecret: 'other-secret',
    });
  });

  test('no prior account returns the new secret unchanged', () => {
    const secret = { appId: 'cli_fresh', appSecret: 'fresh-secret' };
    expect(migration.mergeLegacyFeishuOwner('admin-fresh', secret)).toEqual(
      secret,
    );
    const saved = resaveGlobalFeishu('admin-fresh', secret);
    expect(saved).toMatchObject({
      provider: 'feishu',
      is_legacy_default: true,
      enabled: true,
    });
    expect(storedSecret(saved.id)).toEqual(secret);
  });

  test('reloadFeishuConnection routes its secret through mergeLegacyFeishuOwner', () => {
    const indexSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const start = indexSource.indexOf('const reloadFeishuConnection = async');
    const end = indexSource.indexOf(
      'const reloadTelegramConnection = async',
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = indexSource.slice(start, end).replace(/\s+/g, '');
    const call = body.indexOf('syncDefaultChannelAccountCredentials({');
    expect(call).toBeGreaterThan(-1);
    expect(body.slice(call)).toMatch(
      /^syncDefaultChannelAccountCredentials\(\{ownerUserId:adminUser\.id,provider:'feishu',[^}]*secret:mergeLegacyFeishuOwner\(adminUser\.id,\{appId:config\.appId,appSecret:config\.appSecret,?\}\),?\}\);/,
    );
  });
});
