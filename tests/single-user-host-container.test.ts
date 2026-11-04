import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

// Single-user host mode never runs Docker, even for a Container row left
// over (other users kept while the mode only comes from the environment).
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-single-user-ctr-'));
const docker = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const record =
    <T extends (...args: any[]) => any>(fn: T) =>
    (file: string, args: readonly string[] = [], ...rest: unknown[]) => {
      if (file === 'docker') {
        docker.calls.push([...args]);
        throw new Error('docker must not run');
      }
      return (fn as any)(file, args, ...rest);
    };
  return {
    ...real,
    spawn: record(real.spawn),
    execFile: record(real.execFile),
    execFileSync: record(real.execFileSync),
  };
});
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: path.join(testRoot, 'data'),
  GROUPS_DIR: path.join(testRoot, 'data', 'groups'),
  STORE_DIR: path.join(testRoot, 'data', 'db'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runContainerAgent, SINGLE_USER_HOST_CONTAINER_REFUSAL } =
  await import('../src/container-runner.js');

afterAll(() => {
  delete process.env.HAPPYCLAW_DEPLOYMENT_MODE;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('runContainerAgent in single-user host mode', () => {
  test('fails the run without any docker call', async () => {
    process.env.HAPPYCLAW_DEPLOYMENT_MODE = 'single_user_host';
    const onProcess = vi.fn();
    const result = await runContainerAgent(
      {
        name: 'Leftover',
        folder: 'leftover',
        added_at: '2026-11-04T00:00:00.000Z',
        executionMode: 'container',
        created_by: 'member-1',
      },
      { prompt: 'hi', groupFolder: 'leftover', chatJid: 'web:leftover' } as any,
      onProcess,
    );
    expect(result).toMatchObject({
      status: 'error',
      error: SINGLE_USER_HOST_CONTAINER_REFUSAL,
    });
    expect(SINGLE_USER_HOST_CONTAINER_REFUSAL).toBe(
      '单人宿主机模式不运行 Docker 工作区；请把工作区改为宿主机模式或切回多人模式。',
    );
    expect(onProcess).not.toHaveBeenCalled();
    expect(docker.calls).toEqual([]);
  });
});
