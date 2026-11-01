import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-reinstall-runtime-'));
const dataDir = path.join(root, 'data');
const state = vi.hoisted(() => ({
  quiesced: 0,
  deletedFolders: [] as string[],
  unblocked: [] as string[][],
}));

vi.mock('../src/config.js', () => ({ DATA_DIR: dataDir }));
vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => path.join(root, 'external'),
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'skills-owner', role: 'admin', permissions: [] });
    return next();
  },
}));
vi.mock('../src/db.js', () => ({
  deleteWorkspaceSessions: (folder: string) =>
    state.deletedFolders.push(folder),
  getAllUsers: () => [{ id: 'skills-owner', status: 'active' }],
  listAgentProfilesForUser: () => [
    {
      id: 'profile-inherit',
      runtime_policy: {
        skills: { mode: 'inherit', ids: [] },
        mcp: { mode: 'disabled', ids: [] },
      },
    },
  ],
}));
vi.mock('../src/web-context.js', () => ({
  getWebDeps: () => ({
    queue: {
      blockGroupsForRuntimeSafety: vi.fn(),
      unblockGroupsForRuntimeSafety: (jids: string[]) =>
        state.unblocked.push(jids),
      isGroupRuntimeSafetyBlocked: () => false,
    },
  }),
}));
vi.mock('../src/agent-profile-runtime.js', () => {
  class WorkspaceRuntimeQuiesceError extends Error {
    persisted = false;
  }
  return {
    WorkspaceRuntimeQuiesceError,
    listWorkspaceGroupsForAgentProfile: () => [
      { jid: 'web:workspace', group: { folder: 'workspace-folder' } },
    ],
    getWorkspaceRuntimeJids: () => ['web:workspace'],
    collectWorkspaceRuntimeJids: () => ['web:workspace'],
    quiesceWorkspaceRunnersAroundCommit: async (
      _deps: unknown,
      _targets: unknown,
      _options: unknown,
      commit: () => Promise<unknown> | unknown,
    ) => {
      state.quiesced += 1;
      return { value: await commit(), runtimeJids: ['web:workspace'] };
    },
  };
});
vi.mock('../src/skill-import-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/skill-import-service.js')>();
  return {
    ...actual,
    runCommandWithDirectoryQuota: async (options: {
      env?: NodeJS.ProcessEnv;
    }) => {
      const home = options.env?.HOME;
      if (!home) throw new Error('missing isolated HOME');
      const installedDir = path.join(home, '.claude', 'skills', 'managed');
      fs.mkdirSync(installedDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedDir, 'SKILL.md'),
        '---\nname: Reinstalled\ndescription: updated\n---\n',
      );
    },
  };
});

const routes = (await import('../src/routes/skills.js')).default;
const app = new Hono().route('/api/skills', routes);

beforeAll(() => {
  const skillDir = path.join(dataDir, 'skills', 'skills-owner', 'managed');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: Original\ndescription: old\n---\n',
  );
  fs.writeFileSync(
    path.join(dataDir, 'skills', 'skills-owner', '.skills-manifest.json'),
    JSON.stringify({
      skills: {
        managed: {
          packageName: 'owner/repository',
          installedAt: new Date(0).toISOString(),
          source: 'skills.sh',
        },
      },
    }),
  );
});

beforeEach(() => {
  state.quiesced = 0;
  state.deletedFolders.length = 0;
  state.unblocked.length = 0;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Skill reinstall runtime invalidation', () => {
  test('quiesces affected runners, clears SDK sessions, and reports invalidation', async () => {
    const response = await app.request('/api/skills/managed/reinstall', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      installed: ['managed'],
      invalidated_runtime_jids: 1,
    });
    expect(state.quiesced).toBe(1);
    expect(state.deletedFolders).toEqual(['workspace-folder']);
    expect(state.unblocked).toEqual([['web:workspace']]);
    expect(
      fs.readFileSync(
        path.join(dataDir, 'skills', 'skills-owner', 'managed', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('name: Reinstalled');
  });
});
