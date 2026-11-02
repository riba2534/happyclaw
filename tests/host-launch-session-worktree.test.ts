/**
 * A Runtime Session with its own worktree runs in that worktree: the runner
 * gets it as cwd and as HAPPYCLAW_WORKSPACE_GROUP, and the session's Skill
 * links point into the worktree's .claude/skills. A missing worktree fails
 * the launch before any process starts instead of running in the main
 * checkout, and a container launch refuses such a session.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_HOST_WORKTREE_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-host-worktree-'),
    );
    process.env.HAPPYCLAW_HOST_WORKTREE_DIR = dir;
    return dir;
  })();
const FAKE_RUNNER = path.join(SHARED_TMP, 'fake-worktree-runner.mjs');
const CAPTURE = path.join(SHARED_TMP, 'runner-saw.json');

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    spawn: ((
      command: string,
      args?: readonly string[] | string,
      options?: object,
    ) => {
      const dir = process.env.HAPPYCLAW_HOST_WORKTREE_DIR;
      const runner = dir ? path.join(dir, 'fake-worktree-runner.mjs') : '';
      if (
        runner &&
        fs.existsSync(runner) &&
        Array.isArray(args) &&
        typeof args[0] === 'string' &&
        args[0].includes(`${path.sep}agent-runner${path.sep}dist${path.sep}`)
      ) {
        return real.spawn(command, [runner], options);
      }
      return real.spawn(command, args as string[], options);
    }) as typeof real.spawn,
  };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const root = process.env.HAPPYCLAW_HOST_WORKTREE_DIR!;
  return {
    ...real,
    DATA_DIR: path.join(root, 'data'),
    GROUPS_DIR: path.join(root, 'data', 'groups'),
    STORE_DIR: path.join(root, 'data', 'db'),
    MOUNT_ALLOWLIST_PATH: path.join(root, 'no-mount-allowlist.json'),
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
    isLevelEnabled: () => false,
  },
}));

vi.mock('../src/agent-capabilities.js', () => ({
  checkHostCapabilities: async () => ({
    available: [],
    missing: [],
    envVars: {},
    resolvedPaths: {},
  }),
  logCapabilityPreflight: () => {},
  resetHostCapabilitiesCache: () => {},
}));

const db = await import('../src/db.js');
const { runHostAgent, runContainerAgent } =
  await import('../src/container-runner.js');
const worktrees = await import('../src/session-worktree.js');

const FOLDER = 'host-worktree';
const DATA_DIR = path.join(SHARED_TMP, 'data');
const REPO = path.join(SHARED_TMP, 'repo');

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd },
  );
}

function writeFakeRunner(): void {
  fs.writeFileSync(
    FAKE_RUNNER,
    `import fs from 'node:fs';
import path from 'node:path';
const skillsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? '', 'skills');
const skills = {};
for (const name of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
  skills[name] = fs.realpathSync(path.join(skillsDir, name));
}
fs.writeFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({
  cwd: process.cwd(),
  workspace: process.env.HAPPYCLAW_WORKSPACE_GROUP ?? null,
  skills,
}));
process.stdout.write(
  [
    '---HAPPYCLAW_OUTPUT_START---',
    JSON.stringify({ status: 'success', result: 'done' }),
    '---HAPPYCLAW_OUTPUT_END---',
    '',
  ].join('\\n'),
);
process.exit(0);
`,
  );
}

const group = {
  name: 'Host worktree',
  folder: FOLDER,
  added_at: '2026-10-29T00:00:00.000Z',
  executionMode: 'host' as const,
  customCwd: REPO,
  is_home: false,
};

async function launch(agentId: string) {
  const existsSync = fs.existsSync.bind(fs);
  const spy = vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
    const value = String(target);
    if (
      value.includes(`${path.sep}agent-runner${path.sep}`) &&
      (value.endsWith(`${path.sep}package.json`) ||
        value.endsWith(`${path.sep}index.js`))
    ) {
      return true;
    }
    return existsSync(target);
  });
  try {
    return await runHostAgent(
      group,
      {
        prompt: 'hello',
        groupFolder: FOLDER,
        chatJid: `web:${FOLDER}#agent:${agentId}`,
        agentId,
      },
      () => {},
    );
  } finally {
    spy.mockRestore();
  }
}

beforeAll(() => {
  fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
  fs.mkdirSync(path.join(REPO, '.claude', 'skills', 'repo-skill'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(REPO, '.claude', 'skills', 'repo-skill', 'SKILL.md'),
    '---\nname: repo-skill\n---\n',
  );
  git(REPO, 'init', '-q', '-b', 'main');
  git(REPO, 'add', '.');
  git(REPO, 'commit', '-qm', 'init');
  writeFakeRunner();
  db.initDatabase();
});

afterAll(() => {
  try {
    db.closeDatabase();
  } catch {
    // test-only
  }
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

describe('launching a session that owns a worktree', () => {
  test('runs in the worktree with the worktree Skills', async () => {
    const record = await worktrees.createSessionWorktree({
      group,
      chatJid: `web:${FOLDER}`,
      agentId: 'aaaaaaaa-1111-0000-0000-000000000000',
    });
    fs.rmSync(CAPTURE, { force: true });
    const result = await launch(record.agent_id);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'success',
    });
    const saw = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
    const worktreeReal = fs.realpathSync(record.worktree_path);
    expect(saw.cwd).toBe(worktreeReal);
    expect(saw.workspace).toBe(worktreeReal);
    expect(saw.skills['repo-skill']).toBe(
      path.join(worktreeReal, '.claude', 'skills', 'repo-skill'),
    );
  });

  test('a missing worktree fails before anything runs', async () => {
    const record = await worktrees.createSessionWorktree({
      group,
      chatJid: `web:${FOLDER}`,
      agentId: 'bbbbbbbb-2222-0000-0000-000000000000',
    });
    fs.rmSync(record.worktree_path, { recursive: true, force: true });
    fs.rmSync(CAPTURE, { force: true });
    const result = await launch(record.agent_id);
    expect(result.status).toBe('error');
    expect(result.error).toContain(record.worktree_path);
    expect(result.error).toContain(record.branch);
    expect(fs.existsSync(CAPTURE)).toBe(false);
  });

  test('a container launch refuses the session', async () => {
    const record = await worktrees.createSessionWorktree({
      group,
      chatJid: `web:${FOLDER}`,
      agentId: 'cccccccc-3333-0000-0000-000000000000',
    });
    const result = await runContainerAgent(
      { ...group, executionMode: 'container', customCwd: undefined },
      {
        prompt: 'hello',
        groupFolder: FOLDER,
        chatJid: `web:${FOLDER}#agent:${record.agent_id}`,
        agentId: record.agent_id,
      },
      () => {},
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain(record.branch);
  });
});
