import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Several src modules (runtime-config.ts, etc.) capture DATA_DIR at module
// load via top-level `path.join(DATA_DIR, ...)`. We need a real path *before*
// any of those modules import. Stash one in process.env so the mock factory
// (which is hoisted above this file's body and runs before our `await
// import(...)` lines) can read a stable value.
const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cr-wsskill-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

let tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  // The captured fs/path bindings inside this factory must use the SAME
  // shared tmp dir. We can't reach `tmpDataDir` here (hoisted above its
  // initializer), so route through env.
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
    MAIN_GROUP_FOLDER: 'main',
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

const { buildVolumeMounts } = await import('../src/container-runner.js');

const USER = 'alice';

function fakeGroup(folder: string, ownerId: string) {
  return {
    name: folder,
    folder,
    added_at: '2026-04-26T00:00:00.000Z',
    created_by: ownerId,
    is_home: false,
  };
}

beforeEach(() => {
  // tmpDataDir is fixed for the file (top-level captures in runtime-config
  // can't be relocated mid-run). Wipe its contents between tests so each
  // test starts from a clean state.
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(tmpDataDir, { recursive: true });
  }
});

afterEach(() => {
  if (fs.existsSync(tmpDataDir)) {
    for (const entry of fs.readdirSync(tmpDataDir)) {
      fs.rmSync(path.join(tmpDataDir, entry), { recursive: true, force: true });
    }
  }
});

describe('buildVolumeMounts — workspace skill confinement', () => {
  test('entry symlink escape', () => {
    const victim = path.join(tmpDataDir, 'skills', 'bob', 'payroll');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(
      path.join(victim, 'SKILL.md'),
      '---\nname: payroll\n---\n',
    );
    fs.writeFileSync(path.join(victim, 'token.txt'), 'secret-token\n');

    const skillsDir = path.join(
      tmpDataDir,
      'groups',
      'ws-a',
      '.claude',
      'skills',
    );
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.symlinkSync(victim, path.join(skillsDir, 'pwn'));

    fs.mkdirSync(path.join(tmpDataDir, 'groups', 'ws-a'), { recursive: true });

    const mounts = buildVolumeMounts(
      fakeGroup('ws-a', USER) as any,
      false,
      'session-1',
    );

    expect(
      mounts.some(
        (mount) => mount.containerPath === '/workspace/effective-skills/pwn',
      ),
    ).toBe(false);
    expect(
      mounts.some((mount) => mount.hostPath === fs.realpathSync(victim)),
    ).toBe(false);
  });

  test('directory symlink (.claude/skills ->)', () => {
    const bobSkills = path.join(tmpDataDir, 'skills', 'bob');
    const victim = path.join(bobSkills, 'payroll');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(
      path.join(victim, 'SKILL.md'),
      '---\nname: payroll\n---\n',
    );

    const claudeDir = path.join(tmpDataDir, 'groups', 'ws-a', '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.symlinkSync(bobSkills, path.join(claudeDir, 'skills'));

    fs.mkdirSync(path.join(tmpDataDir, 'groups', 'ws-a'), { recursive: true });

    const mounts = buildVolumeMounts(
      fakeGroup('ws-a', USER) as any,
      false,
      'session-1',
    );

    expect(
      mounts.some(
        (mount) =>
          mount.containerPath === '/workspace/effective-skills/payroll',
      ),
    ).toBe(false);

    const bobReal = fs.realpathSync(bobSkills);
    const isUnderBob = (p: string) =>
      p === bobReal || p.startsWith(bobReal + path.sep);
    expect(mounts.some((mount) => isUnderBob(mount.hostPath))).toBe(false);
  });

  test('.claude -> other workspace', () => {
    const wsBDir = path.join(tmpDataDir, 'groups', 'ws-b');
    const deployDir = path.join(wsBDir, '.claude', 'skills', 'deploy');
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(
      path.join(deployDir, 'SKILL.md'),
      '---\nname: deploy\n---\n',
    );

    const wsADir = path.join(tmpDataDir, 'groups', 'ws-a');
    fs.mkdirSync(wsADir, { recursive: true });
    fs.symlinkSync(path.join(wsBDir, '.claude'), path.join(wsADir, '.claude'));

    const mounts = buildVolumeMounts(
      fakeGroup('ws-a', USER) as any,
      false,
      'session-1',
    );

    expect(
      mounts.some(
        (mount) => mount.containerPath === '/workspace/effective-skills/deploy',
      ),
    ).toBe(false);

    const wsBReal = fs.realpathSync(wsBDir);
    const isUnderWsB = (p: string) =>
      p === wsBReal || p.startsWith(wsBReal + path.sep);
    expect(mounts.some((mount) => isUnderWsB(mount.hostPath))).toBe(false);
  });

  test('legit in-tree workspace skill still bound', () => {
    const wsADir = path.join(tmpDataDir, 'groups', 'ws-a');
    const legitDir = path.join(wsADir, '.claude', 'skills', 'legit');
    fs.mkdirSync(legitDir, { recursive: true });
    fs.writeFileSync(
      path.join(legitDir, 'SKILL.md'),
      '---\nname: legit\n---\n',
    );

    fs.mkdirSync(path.join(tmpDataDir, 'groups', 'ws-a'), { recursive: true });

    const mounts = buildVolumeMounts(
      fakeGroup('ws-a', USER) as any,
      false,
      'session-1',
    );

    const legitMount = mounts.find(
      (mount) => mount.containerPath === '/workspace/effective-skills/legit',
    );
    expect(legitMount).toBeDefined();
    expect(legitMount).toEqual({
      hostPath: fs.realpathSync(legitDir),
      containerPath: '/workspace/effective-skills/legit',
      readonly: true,
    });
  });

  test('non-workspace sources unchanged', () => {
    const outsideDir = path.join(tmpDataDir, 'outside', 'review');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, 'SKILL.md'),
      '---\nname: review\n---\n',
    );

    const userSkillsDir = path.join(tmpDataDir, 'skills', USER);
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(userSkillsDir, 'review'));

    fs.mkdirSync(path.join(tmpDataDir, 'groups', 'ws-a'), { recursive: true });

    const mounts = buildVolumeMounts(
      fakeGroup('ws-a', USER) as any,
      false,
      'session-1',
    );

    const reviewMount = mounts.find(
      (mount) => mount.containerPath === '/workspace/effective-skills/review',
    );
    expect(reviewMount).toBeDefined();
    expect(reviewMount).toEqual({
      hostPath: fs.realpathSync(outsideDir),
      containerPath: '/workspace/effective-skills/review',
      readonly: true,
    });
  });
});
