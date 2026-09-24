import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-sigkill-'));
const groups = path.join(root, 'groups');
fs.mkdirSync(path.join(groups, 'workspace'), { recursive: true });

vi.mock('../src/config.js', () => ({ GROUPS_DIR: groups }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    containerTimeout: 30_000,
  }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// The scripts rely on /bin/sh, `kill -KILL $$` and POSIX process groups.
const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('script runner signaled death', () => {
  test('live self-SIGKILL close(null, SIGKILL) is not coalesced to exit 0', async () => {
    const { runScript } = await import('../src/script-runner.js');
    const result = await runScript('kill -KILL $$', 'workspace');

    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    // External / self signal death must never look like a clean success.
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });

  test('live external SIGKILL of the spawned shell is not success', async () => {
    const { runScript } = await import('../src/script-runner.js');
    const pidFile = path.join(groups, 'workspace', 'ext-sigkill.pid');
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* absent */
    }

    // $$ is the /bin/sh ChildProcess from spawn(..., { shell, detached }).
    // Builtin loop keeps work in that same process (no separate sleep child).
    const pending = runScript(
      'echo $$ > ext-sigkill.pid; while true; do :; done',
      'workspace',
    );

    await vi.waitFor(
      () => {
        expect(fs.existsSync(pidFile)).toBe(true);
      },
      { timeout: 5_000 },
    );
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    // Match production killScriptProcessTree: signal the process group.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }

    const result = await pending;
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  }, 15_000);
});
