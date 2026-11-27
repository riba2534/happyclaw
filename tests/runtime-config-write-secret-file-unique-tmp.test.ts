import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'runtime-config-secret-unique-tmp-'),
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

const configDir = path.join(root, 'config');
const feishuConfigFile = path.join(configDir, 'feishu-provider.json');

beforeEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime-config writeSecretFile unique tmp', () => {
  test('a stale shared .tmp left behind no longer blocks publishing', () => {
    // A directory (or anything else) at the old shared temp path used to
    // make every save of this file fail.
    fs.mkdirSync(`${feishuConfigFile}.tmp`);

    runtimeConfig.saveFeishuProviderConfig({
      appId: 'cli_after_stale_tmp',
      appSecret: 'stale_tmp_secret',
      enabled: true,
    });

    expect(runtimeConfig.getFeishuProviderConfig()).toMatchObject({
      appId: 'cli_after_stale_tmp',
      appSecret: 'stale_tmp_secret',
    });
  });

  test("another writer's temp file is neither unlinked nor truncated", () => {
    // What a concurrent writer is about to publish at the shared temp path.
    const otherWriter = `${feishuConfigFile}.tmp`;
    fs.writeFileSync(otherWriter, 'payload of another writer', {
      mode: 0o600,
    });
    const inode = fs.statSync(otherWriter).ino;

    runtimeConfig.saveFeishuProviderConfig({
      appId: 'cli_concurrent',
      appSecret: 'concurrent_secret',
      enabled: true,
    });

    expect(fs.statSync(otherWriter).ino).toBe(inode);
    expect(fs.readFileSync(otherWriter, 'utf8')).toBe(
      'payload of another writer',
    );
    expect(runtimeConfig.getFeishuProviderConfig()).toMatchObject({
      appId: 'cli_concurrent',
      appSecret: 'concurrent_secret',
    });
  });

  test('a failed publish leaves the durable file and no temp file behind', () => {
    runtimeConfig.saveFeishuProviderConfig({
      appId: 'cli_before',
      appSecret: 'before_secret',
      enabled: true,
    });
    const before = fs.readFileSync(feishuConfigFile, 'utf8');
    const renameSync = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    });
    try {
      expect(() =>
        runtimeConfig.saveFeishuProviderConfig({
          appId: 'cli_after',
          appSecret: 'after_secret',
          enabled: true,
        }),
      ).toThrow('EIO');
    } finally {
      renameSync.mockRestore();
    }
    expect(fs.readFileSync(feishuConfigFile, 'utf8')).toBe(before);
    expect(
      fs.readdirSync(configDir).filter((entry) => entry.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('production writeSecretFile via saveFeishuProviderConfig uses unique tmp with O_EXCL and mode 0o600', () => {
    const openSyncSpy = vi.spyOn(fs, 'openSync');

    runtimeConfig.saveFeishuProviderConfig({
      appId: 'cli_prod_test',
      appSecret: 'prod_secret_value',
      enabled: true,
    });

    const feishuOpenCalls = openSyncSpy.mock.calls.filter(([target]) =>
      String(target).startsWith(feishuConfigFile),
    );
    expect(feishuOpenCalls).toHaveLength(1);

    const [openedPath, openedFlags, openedMode] = feishuOpenCalls[0];
    const openedPathStr = String(openedPath);

    // Must NOT be bare `${target}.tmp`; must match `${target}.${pid}.${uuid}.tmp`.
    expect(openedPathStr).not.toBe(`${feishuConfigFile}.tmp`);
    const escapedTarget = feishuConfigFile.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    const uniqueTmpRegex = new RegExp(
      `^${escapedTarget}\\.${process.pid}\\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
      'i',
    );
    expect(openedPathStr).toMatch(uniqueTmpRegex);

    // Flags must include O_WRONLY | O_CREAT | O_EXCL, and NOT O_TRUNC.
    expect(typeof openedFlags).toBe('number');
    const flagsNum = openedFlags as number;
    expect(flagsNum & fs.constants.O_WRONLY).toBe(fs.constants.O_WRONLY);
    expect(flagsNum & fs.constants.O_CREAT).toBe(fs.constants.O_CREAT);
    expect(flagsNum & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
    expect(flagsNum & fs.constants.O_TRUNC).toBe(0);

    // Mode must be 0o600.
    expect(openedMode).toBe(0o600);

    // Durable file must be non-empty and readable via public API.
    expect(fs.existsSync(feishuConfigFile)).toBe(true);
    const durableRaw = fs.readFileSync(feishuConfigFile, 'utf8');
    expect(durableRaw.length).toBeGreaterThan(0);
    expect(JSON.parse(durableRaw)).toMatchObject({
      version: 1,
      appId: 'cli_prod_test',
      enabled: true,
    });
    expect(runtimeConfig.getFeishuProviderConfig()).toMatchObject({
      appId: 'cli_prod_test',
      appSecret: 'prod_secret_value',
      enabled: true,
    });

    // No leftover shared .tmp or unique .tmp files.
    expect(fs.existsSync(`${feishuConfigFile}.tmp`)).toBe(false);
    expect(fs.existsSync(openedPathStr)).toBe(false);
    const leftoverTmps = fs
      .readdirSync(configDir)
      .filter((entry) => entry.endsWith('.tmp'));
    expect(leftoverTmps).toEqual([]);
  });
});
