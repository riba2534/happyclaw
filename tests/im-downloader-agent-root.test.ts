/**
 * Inbound P1-6: a Host workspace with customCwd runs its Agent there, so an
 * IM attachment announced as `downloads/<channel>/<date>/<file>` must exist
 * relative to that directory, not to data/groups/{folder}.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';

const paths = vi.hoisted(() => ({ groups: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  paths.groups = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'im-dl-groups-'),
  );
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    GROUPS_DIR: paths.groups,
  };
});

const { GROUPS_DIR } = await import('../src/config.js');
const { resolveImDownloadRoot, saveDownloadedFile, setImDownloadRootResolver } =
  await import('../src/im-downloader.js');

afterAll(() => {
  fs.rmSync(paths.groups, { recursive: true, force: true });
});

const created: string[] = [];

afterEach(() => {
  setImDownloadRootResolver(null);
  for (const target of created.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('IM attachments land in the Agent working directory', () => {
  test('Host customCwd: the relative path resolves from the Agent cwd', async () => {
    const customCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'im-dl-cwd-'));
    const folder = `im-dl-host-${process.pid}-${Date.now()}`;
    created.push(customCwd, path.join(GROUPS_DIR, folder));
    setImDownloadRootResolver((groupFolder) =>
      groupFolder === folder ? customCwd : undefined,
    );

    const rel = await saveDownloadedFile(
      folder,
      'feishu',
      'report.pdf',
      Buffer.from('pdf-bytes'),
    );

    expect(rel).toMatch(/^downloads\/feishu\/\d{4}-\d{2}-\d{2}\/report\.pdf$/);
    expect(fs.readFileSync(path.join(customCwd, rel), 'utf8')).toBe(
      'pdf-bytes',
    );
    expect(fs.existsSync(path.join(GROUPS_DIR, folder, rel))).toBe(false);
  });

  test('every channel shares the same root resolution', async () => {
    const customCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'im-dl-cwd-'));
    const folder = `im-dl-any-${process.pid}-${Date.now()}`;
    created.push(customCwd, path.join(GROUPS_DIR, folder));
    setImDownloadRootResolver(() => customCwd);
    for (const channel of ['telegram', 'qq', 'wecom'] as const) {
      const rel = await saveDownloadedFile(
        folder,
        channel,
        `${channel}.txt`,
        Buffer.from(channel),
      );
      expect(fs.readFileSync(path.join(customCwd, rel), 'utf8')).toBe(channel);
    }
  });

  test('without an override (container, or Host without customCwd) keeps data/groups/{folder}', async () => {
    const folder = `im-dl-default-${process.pid}-${Date.now()}`;
    created.push(path.join(GROUPS_DIR, folder));
    setImDownloadRootResolver(() => undefined);
    expect(resolveImDownloadRoot(folder)).toBe(path.join(GROUPS_DIR, folder));
    const rel = await saveDownloadedFile(
      folder,
      'telegram',
      'a.txt',
      Buffer.from('a'),
    );
    expect(fs.existsSync(path.join(GROUPS_DIR, folder, rel))).toBe(true);
  });

  test('a relative or throwing resolver never redirects writes', () => {
    setImDownloadRootResolver(() => 'relative/dir');
    expect(resolveImDownloadRoot('f')).toBe(path.join(GROUPS_DIR, 'f'));
    setImDownloadRootResolver(() => {
      throw new Error('db unavailable');
    });
    expect(resolveImDownloadRoot('f')).toBe(path.join(GROUPS_DIR, 'f'));
  });
});
