/**
 * Verifies that workspace-config write routes (mcp-servers + skills) require
 * owner-level permissions (canModifyGroup), while read routes still allow
 * shared members (canAccessGroup).
 *
 * Coverage matrix (per Codex v4 review):
 *   - owner       → mcp-servers POST / PATCH succeed
 *   - shared member → mcp-servers POST / PATCH return 403
 *   - shared member → mcp-servers GET still 200
 *   - non-member  → all routes return 404 (group hidden by canAccessGroup)
 *   - owner       → skills PATCH (toggle) on a fake-on-disk skill succeeds
 *   - shared member → skills PATCH returns 403
 *   - shared member → skills DELETE returns 403
 *
 * Skills install is NOT covered (it runs `npx skills add` and is a wrapper
 * around an external tool). The DELETE / PATCH paths exercise the same
 * resolveGroup + requireWorkspaceOwner ACL chain, which is what we're testing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-workspace-config-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

let tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
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

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

const workspaceConfigRoutesModule = await import(
  '../src/routes/workspace-config.js'
);
const db = await import('../src/db.js');
const config = await import('../src/config.js');

const workspaceConfigRoutes = workspaceConfigRoutesModule.default;

const OWNER_ID = 'alice';
const MEMBER_ID = 'bob';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:test-group';
const GROUP_FOLDER = 'test-group';

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Test Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  db.addGroupMember(GROUP_FOLDER, OWNER_ID, 'owner');
  db.addGroupMember(GROUP_FOLDER, MEMBER_ID, 'member');
}

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

beforeAll(() => {
  // Ensure tmp data + db dirs exist before initDatabase().
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  // Clear DB tables between tests instead of recreating the DB (WAL handle
  // would otherwise dangle). Reuse the singleton from beforeAll.
  for (const groupFolder of [GROUP_FOLDER]) {
    try {
      db.removeGroupMember(groupFolder, OWNER_ID);
      db.removeGroupMember(groupFolder, MEMBER_ID);
    } catch {
      /* ignore */
    }
  }
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
  // Wipe groups dir to drop leftover .claude/ from previous test
  const groupsDir = path.join(tmpDataDir, 'groups');
  if (fs.existsSync(groupsDir)) {
    fs.rmSync(groupsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(groupsDir, { recursive: true });
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

async function postMcp(body: unknown): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchMcp(
  id: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteMcp(id: string): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers/${id}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getMcp(): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers`,
    { method: 'GET' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchSkill(
  id: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/skills/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteSkill(id: string): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/skills/${id}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function seedFakeSkill(skillId: string): void {
  const skillDir = path.join(
    config.GROUPS_DIR,
    GROUP_FOLDER,
    '.claude',
    'skills',
    skillId,
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: test\ndescription: t\n---\n# Test skill\n',
  );
}

describe('workspace-config ACL — MCP servers', () => {
  test('owner can POST a new MCP server', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const { status, body } = await postMcp({
      id: 'mysrv',
      command: 'echo',
      args: ['hello'],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.server.id).toBe('mysrv');
  });

  test('shared member is denied for POST (403)', async () => {
    seedTestGroup();
    asUser(MEMBER_ID);

    const { status, body } = await postMcp({ id: 'srv2', command: 'echo' });
    expect(status).toBe(403);
    expect(body.error).toMatch(/owner/i);
  });

  test('shared member is denied for PATCH (403)', async () => {
    seedTestGroup();
    // Owner first creates a server so PATCH has a target
    asUser(OWNER_ID);
    await postMcp({ id: 'srv3', command: 'echo' });

    asUser(MEMBER_ID);
    const { status, body } = await patchMcp('srv3', { enabled: false });
    expect(status).toBe(403);
    expect(body.error).toMatch(/owner/i);
  });

  test('shared member is denied for DELETE (403)', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    await postMcp({ id: 'srv4', command: 'echo' });

    asUser(MEMBER_ID);
    const { status, body } = await deleteMcp('srv4');
    expect(status).toBe(403);
    expect(body.error).toMatch(/owner/i);
  });

  test('shared member can still GET (200)', async () => {
    seedTestGroup();
    asUser(MEMBER_ID);

    const { status } = await getMcp();
    expect(status).toBe(200);
  });

  test('non-member returns 404 on POST (group hidden by canAccessGroup)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);

    const { status, body } = await postMcp({ id: 'srv5', command: 'echo' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  // Regression: legacy IM groups bound to a non-home shared workspace (created_by=null,
  // no is_home sibling) used to 403 the real owner because canModifyGroup's only
  // fallback was the sibling lookup. canModifyGroup must consult group_members
  // first so role='owner' wins.
  test('legacy IM group with created_by=null: group_members owner can POST', async () => {
    const LEGACY_JID = 'feishu:legacy-shared';
    const LEGACY_FOLDER = 'legacy-shared';
    try {
      db.setRegisteredGroup(LEGACY_JID, {
        name: 'Legacy Shared IM',
        folder: LEGACY_FOLDER,
        added_at: new Date().toISOString(),
        executionMode: 'container',
        created_by: null,
        is_home: false,
      } as any);
      db.addGroupMember(LEGACY_FOLDER, OWNER_ID, 'owner');
      db.addGroupMember(LEGACY_FOLDER, MEMBER_ID, 'member');
      asUser(OWNER_ID);

      const res = await workspaceConfigRoutes.request(
        `/${encodeURIComponent(LEGACY_JID)}/workspace-config/mcp-servers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'legacy-srv', command: 'echo' }),
        },
      );
      const body = await res.json().catch(() => ({}));
      expect(res.status).toBe(200);
      expect((body as any).success).toBe(true);
    } finally {
      try {
        db.removeGroupMember(LEGACY_FOLDER, OWNER_ID);
        db.removeGroupMember(LEGACY_FOLDER, MEMBER_ID);
        db.deleteRegisteredGroup(LEGACY_JID);
      } catch {
        /* ignore */
      }
    }
  });

  test('legacy IM group with created_by=null: group_members non-owner is still 403', async () => {
    const LEGACY_JID = 'feishu:legacy-shared-2';
    const LEGACY_FOLDER = 'legacy-shared-2';
    try {
      db.setRegisteredGroup(LEGACY_JID, {
        name: 'Legacy Shared IM 2',
        folder: LEGACY_FOLDER,
        added_at: new Date().toISOString(),
        executionMode: 'container',
        created_by: null,
        is_home: false,
      } as any);
      db.addGroupMember(LEGACY_FOLDER, OWNER_ID, 'owner');
      db.addGroupMember(LEGACY_FOLDER, MEMBER_ID, 'member');
      asUser(MEMBER_ID);

      const res = await workspaceConfigRoutes.request(
        `/${encodeURIComponent(LEGACY_JID)}/workspace-config/mcp-servers`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'legacy-srv-2', command: 'echo' }),
        },
      );
      const body = await res.json().catch(() => ({}));
      expect(res.status).toBe(403);
      expect((body as any).error).toMatch(/owner/i);
    } finally {
      try {
        db.removeGroupMember(LEGACY_FOLDER, OWNER_ID);
        db.removeGroupMember(LEGACY_FOLDER, MEMBER_ID);
        db.deleteRegisteredGroup(LEGACY_JID);
      } catch {
        /* ignore */
      }
    }
  });
});

describe('workspace-config ACL — skills', () => {
  test('owner can PATCH (disable) a fake-on-disk skill', async () => {
    seedTestGroup();
    seedFakeSkill('my-skill');
    asUser(OWNER_ID);

    const { status, body } = await patchSkill('my-skill', { enabled: false });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('shared member is denied for skills PATCH (403)', async () => {
    seedTestGroup();
    seedFakeSkill('my-skill');
    asUser(MEMBER_ID);

    const { status, body } = await patchSkill('my-skill', { enabled: false });
    expect(status).toBe(403);
    expect(body.error).toMatch(/owner/i);
  });

  test('shared member is denied for skills DELETE (403)', async () => {
    seedTestGroup();
    seedFakeSkill('my-skill');
    asUser(MEMBER_ID);

    const { status, body } = await deleteSkill('my-skill');
    expect(status).toBe(403);
    expect(body.error).toMatch(/owner/i);
  });

  test('non-member returns 404 on skills DELETE', async () => {
    seedTestGroup();
    seedFakeSkill('my-skill');
    asUser(OUTSIDER_ID);

    const { status, body } = await deleteSkill('my-skill');
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});
