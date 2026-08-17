/**
 * Covers the two owner-lifecycle fixes on the groups routes:
 *
 *   ③a  POST /api/groups/:jid/reset-owner — admin break-glass that clears a
 *       stuck IM owner (owner_im_id + sender_allowlist) and downgrades
 *       owner_mentioned → when_mentioned. Admin-only (members get 403).
 *
 *   ③b  PATCH /api/groups/:jid regression — the route used to rebuild the row
 *       from an explicit field list, and since setRegisteredGroup is
 *       INSERT OR REPLACE, a rename silently wiped owner_im_id / sender_allowlist
 *       / conversation_nav_mode / conversation_source. It now spreads ...existing.
 */
import fs from 'fs';
import fsp from 'node:fs/promises';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-groups-owner-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

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
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

// groups.ts statically imports these from web.js; mock them so importing the
// route module doesn't pull in the full Hono app + every route's middleware.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const agentProfileRoutesModule =
  await import('../src/routes/agent-profiles.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const agentProfileRuntime = await import('../src/agent-profile-runtime.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { GroupQueue } = await import('../src/group-queue.js');

const groupRoutes = groupRoutesModule.default;
const agentProfileRoutes = agentProfileRoutesModule.default;

const OWNER_ID = 'alice';
const ADMIN_ID = 'zadmin';

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

// Persistent stub cache (see setWebDeps below) — stable across getRegisteredGroups() calls.
const webDepsCache: Record<string, unknown> = {};

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  // Routes guard on getWebDeps(); they only touch getRegisteredGroups().
  // Back the stub with a single persistent object (not a fresh {} per call) so
  // reset-owner's persistGroupUpdate cache-sync writes to a stable map, matching
  // production's `() => registeredGroups` and keeping cache state assertable.
  webContext.setWebDeps({
    getRegisteredGroups: () => webDepsCache,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

describe('POST /:jid/reset-owner (admin break-glass)', () => {
  const JID = 'feishu:stuck-group';
  const FOLDER = 'stuck-group';

  beforeEach(() => {
    db.setRegisteredGroup(JID, {
      name: 'Stuck IM Group',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: ADMIN_ID,
      is_home: false,
      owner_im_id: 'ou_owner_who_left',
      sender_allowlist: ['ou_owner_who_left'],
      activation_mode: 'owner_mentioned',
    } as any);
  });

  afterEach(() => {
    try {
      db.deleteRegisteredGroup(JID);
    } catch {
      /* ignore */
    }
  });

  test('admin clears owner_im_id + allowlist and downgrades activation_mode', async () => {
    asUser(ADMIN_ID, 'admin');
    const res = await groupRoutes.request(
      `/${encodeURIComponent(JID)}/reset-owner`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);

    const after = db.getRegisteredGroup(JID);
    expect(after?.owner_im_id).toBeUndefined();
    expect(after?.sender_allowlist).toBeUndefined();
    expect(after?.activation_mode).toBe('when_mentioned');
  });

  test('non-admin member is denied (403)', async () => {
    asUser(OWNER_ID, 'member');
    const res = await groupRoutes.request(
      `/${encodeURIComponent(JID)}/reset-owner`,
      { method: 'POST' },
    );
    expect(res.status).toBe(403);

    // Owner must be untouched after a denied attempt.
    const after = db.getRegisteredGroup(JID);
    expect(after?.owner_im_id).toBe('ou_owner_who_left');
  });

  test('non-admin downgrade attempt does not change activation_mode', async () => {
    asUser(OWNER_ID, 'member');
    await groupRoutes.request(`/${encodeURIComponent(JID)}/reset-owner`, {
      method: 'POST',
    });
    expect(db.getRegisteredGroup(JID)?.activation_mode).toBe('owner_mentioned');
  });
});

describe('PATCH /:jid preserves owner fields on rename (regression)', () => {
  const JID = 'web:rename-me';
  const FOLDER = 'rename-me';

  beforeEach(() => {
    db.setRegisteredGroup(JID, {
      name: 'Original',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
      owner_im_id: 'keep-this-owner',
      sender_allowlist: ['keep-this-owner'],
      conversation_nav_mode: 'vertical_threads',
    } as any);
  });

  afterEach(() => {
    try {
      db.deleteRegisteredGroup(JID);
    } catch {
      /* ignore */
    }
  });

  test('renaming a web group keeps owner_im_id / allowlist / nav_mode', async () => {
    asUser(OWNER_ID, 'member');
    const res = await groupRoutes.request(`/${encodeURIComponent(JID)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);

    const after = db.getRegisteredGroup(JID);
    expect(after?.name).toBe('Renamed');
    expect(after?.owner_im_id).toBe('keep-this-owner');
    expect(after?.sender_allowlist).toEqual(['keep-this-owner']);
    expect(after?.conversation_nav_mode).toBe('vertical_threads');
  });
});

describe('PATCH /:jid execution mode runtime boundary', () => {
  test('admin host-only mode rejects switching a workspace to Docker', async () => {
    const jid = 'web:host-only-policy';
    db.setRegisteredGroup(jid, {
      name: 'Host-only policy',
      folder: 'host-only-policy',
      added_at: new Date().toISOString(),
      executionMode: 'host',
      created_by: ADMIN_ID,
      is_home: false,
    });
    webDepsCache[jid] = db.getRegisteredGroup(jid)!;
    runtimeConfig.saveSystemSettings({ adminHostOnlyMode: true });
    asUser(ADMIN_ID, 'admin');

    try {
      const response = await groupRoutes.request(
        `/${encodeURIComponent(jid)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ execution_mode: 'container' }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'ADMIN_HOST_ONLY_MODE_ENABLED',
      });
      expect(db.getRegisteredGroup(jid)?.executionMode).toBe('host');
    } finally {
      runtimeConfig.saveSystemSettings({ adminHostOnlyMode: false });
      delete webDepsCache[jid];
      db.deleteRegisteredGroup(jid);
    }
  });

  test('quiesces the old runtime and invalidates SDK resume state before switching', async () => {
    const jid = 'web:mode-switch';
    const folder = 'mode-switch';
    db.setRegisteredGroup(jid, {
      name: 'Mode Switch',
      folder,
      added_at: new Date().toISOString(),
      created_by: ADMIN_ID,
      executionMode: 'host',
    });
    db.setSession(folder, 'sdk-session-before-switch');

    const stopGroup = vi.fn(async () => {});
    const sessions = { [folder]: 'sdk-session-before-switch' };
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      sessions,
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: vi.fn(),
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    asUser(ADMIN_ID, 'admin');
    const response = await groupRoutes.request(`/${encodeURIComponent(jid)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ execution_mode: 'container' }),
    });

    expect(response.status).toBe(200);
    expect(db.getRegisteredGroup(jid)?.executionMode).toBe('container');
    expect(db.getSession(folder)).toBeUndefined();
    expect(sessions[folder]).toBeUndefined();
    expect(stopGroup).toHaveBeenCalledTimes(2);

    db.deleteGroupData(jid, folder);
  });
});

describe('DELETE /:jid blocks channel_mounts-bound workspaces', () => {
  const JID = 'web:mounted-delete-block';
  const FOLDER = 'mounted-delete-block';
  const IM_JID = 'telegram:mounted-delete-block';
  const HOME_JID = 'web:mounted-delete-home';
  const HOME_FOLDER = 'mounted-delete-home';

  beforeEach(() => {
    db.setRegisteredGroup(JID, {
      name: 'Mounted Workspace',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
    } as any);
    db.setRegisteredGroup(IM_JID, {
      name: 'Mounted Telegram',
      folder: 'owner-home',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    } as any);
    db.upsertChannelMount({
      channel_jid: IM_JID,
      channel_type: 'telegram',
      workspace_jid: JID,
      session_id: null,
      routing_mode: 'single_session',
      reply_policy: 'source_only',
      activation_mode: 'auto',
      owner_im_id: null,
    });
    db.setRegisteredGroup(HOME_JID, {
      name: 'Owner Home',
      folder: HOME_FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: true,
    } as any);
  });

  afterEach(() => {
    for (const jid of [JID, IM_JID, HOME_JID]) {
      delete webDepsCache[jid];
      try {
        db.deleteRegisteredGroup(jid);
      } catch {
        /* ignore */
      }
    }
  });

  test('owner gets 409 until mounted IM channel is unbound', async () => {
    asUser(OWNER_ID, 'member');
    const res = await groupRoutes.request(`/${encodeURIComponent(JID)}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.bound_main_im_groups).toEqual([
      { jid: IM_JID, name: 'Mounted Telegram' },
    ]);
  });

  test('preflight reports the channels that will be detached', async () => {
    asUser(OWNER_ID, 'member');
    const res = await groupRoutes.request(
      `/${encodeURIComponent(JID)}/delete-impact`,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      has_channel_bindings: true,
      channel_binding_count: 1,
      bound_main_im_groups: [{ jid: IM_JID, name: 'Mounted Telegram' }],
    });
  });

  test('confirmed delete reroutes channels and account defaults atomically', async () => {
    const accountId = 'delete-workspace-telegram-account';
    db.createChannelAccount({
      id: accountId,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: 'Delete workspace test Bot',
      secret_ref: 'test-secret',
      default_workspace_jid: JID,
    });
    const imGroup = db.getRegisteredGroup(IM_JID)!;
    db.setRegisteredGroup(IM_JID, {
      ...imGroup,
      channel_account_id: accountId,
      target_main_jid: JID,
      binding_mode: 'single_context',
    });
    for (const jid of [JID, IM_JID, HOME_JID]) {
      webDepsCache[jid] = db.getRegisteredGroup(jid)!;
    }
    const stopGroup = vi.fn(async () => {});
    const discardGroupsAfterMutation = vi.fn();
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      getSessions: () => ({}),
      setLastAgentTimestamp: vi.fn(),
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: vi.fn(),
        discardGroupsAfterMutation,
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      asUser(OWNER_ID, 'member');
      const res = await groupRoutes.request(
        `/${encodeURIComponent(JID)}?unbind_channels=true`,
        { method: 'DELETE' },
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        success: true,
        unbound_channel_count: 1,
      });
      expect(db.getRegisteredGroup(JID)).toBeUndefined();
      expect(db.getRegisteredGroup(IM_JID)?.target_main_jid).toBe(HOME_JID);
      expect(db.getChannelMount(IM_JID)?.workspace_jid).toBe(HOME_JID);
      expect(db.getChannelAccount(accountId)?.default_workspace_jid).toBe(
        HOME_JID,
      );
      expect(
        (webDepsCache[IM_JID] as { target_main_jid?: string }).target_main_jid,
      ).toBe(HOME_JID);
      expect(stopGroup).toHaveBeenCalled();
      expect(discardGroupsAfterMutation).toHaveBeenCalledTimes(1);
    } finally {
      db.deleteChannelAccount(accountId, OWNER_ID);
    }
  });

  test('confirmed delete keeps a WeCom DM on an isolated fallback session', async () => {
    const accountId = 'delete-workspace-wecom-account';
    const dmJid = `wecom:c2c:delete-workspace-user#account:${accountId}`;
    const oldAgentId = 'delete-workspace-wecom-old-session';
    let fallbackAgentId: string | undefined;
    db.createChannelAccount({
      id: accountId,
      owner_user_id: OWNER_ID,
      provider: 'wecom',
      name: 'Delete workspace WeCom Bot',
      secret_ref: 'test-secret',
      default_workspace_jid: JID,
    });
    db.createAgent({
      id: oldAgentId,
      group_folder: FOLDER,
      chat_jid: JID,
      name: 'Legacy direct session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: dmJid,
      spawned_from_jid: null,
      source_kind: 'channel_direct',
    });
    db.setRegisteredGroup(dmJid, {
      name: 'Mounted WeCom DM',
      folder: HOME_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: accountId,
      target_agent_id: oldAgentId,
      binding_mode: 'single_context',
    });
    for (const jid of [JID, IM_JID, HOME_JID, dmJid]) {
      webDepsCache[jid] = db.getRegisteredGroup(jid)!;
    }
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      getSessions: () => ({}),
      setLastAgentTimestamp: vi.fn(),
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: vi.fn(),
        discardGroupsAfterMutation: vi.fn(),
        listDescendantJids: () => [],
        stopGroup: vi.fn(async () => {}),
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      asUser(OWNER_ID, 'member');
      const response = await groupRoutes.request(
        `/${encodeURIComponent(JID)}?unbind_channels=true`,
        { method: 'DELETE' },
      );
      expect(response.status).toBe(200);

      const rerouted = db.getRegisteredGroup(dmJid)!;
      fallbackAgentId = rerouted.target_agent_id;
      expect(rerouted.target_main_jid).toBeUndefined();
      expect(fallbackAgentId).toBeTruthy();
      expect(fallbackAgentId).not.toBe(oldAgentId);
      expect(db.getAgent(oldAgentId)).toBeUndefined();
      expect(db.getAgent(fallbackAgentId!)).toMatchObject({
        chat_jid: HOME_JID,
        group_folder: HOME_FOLDER,
        source_kind: 'channel_direct',
        last_im_jid: dmJid,
      });
      expect(db.getChannelMount(dmJid)).toMatchObject({
        workspace_jid: HOME_JID,
        session_id: fallbackAgentId,
      });
      expect(db.getChannelAccount(accountId)?.default_workspace_jid).toBe(
        HOME_JID,
      );
    } finally {
      delete webDepsCache[dmJid];
      try {
        db.deleteRegisteredGroup(dmJid);
      } catch {
        /* ignore */
      }
      if (fallbackAgentId) db.deleteAgent(fallbackAgentId);
      db.deleteChannelAccount(accountId, OWNER_ID);
    }
  });
});

describe('DELETE /:jid mutation pause', () => {
  test('work accepted during pre-stop is discarded and never runs after deletion', async () => {
    const jid = 'web:delete-mutation-race';
    const folder = 'delete-mutation-race';
    const descendantJid = `${jid}#task:arrived-during-delete`;
    const postDeleteDescendantJid = `${jid}#task:first-seen-after-delete`;
    const lateDescendantJid = `${jid}#task:late-after-all-pauses`;
    const profile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Delete Mutation Agent',
    });
    db.setRegisteredGroup(jid, {
      name: 'Delete Mutation Workspace',
      folder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
    } as any);
    db.assignWorkspaceAgentProfile(folder, profile.id);
    const group = db.getRegisteredGroup(jid)!;
    webDepsCache[jid] = group;
    const workspaceDir = path.join(tmpDataDir, 'groups', folder);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'must-be-removed.txt'), 'delete');

    const queue = new GroupQueue();
    queue.setSerializationKeyResolver((groupJid: string) => {
      // Mirror production: the resolver depends on the registered-group cache.
      // DELETE removes that cache entry before finally discarding its token, so
      // Queue must retain each parked state's original mutation key rather than
      // dynamically degrading from `folder` to `jid` during cleanup.
      const taskSeparator = groupJid.indexOf('#task:');
      if (taskSeparator >= 0) {
        const baseJid = groupJid.slice(0, taskSeparator);
        const taskId = groupJid.slice(taskSeparator + 6);
        const cached = webDepsCache[baseJid] as { folder?: string } | undefined;
        return `${cached?.folder ?? baseJid}#task:${taskId}`;
      }
      const cached = webDepsCache[groupJid] as { folder?: string } | undefined;
      return cached?.folder ?? groupJid;
    });
    let messageRuns = 0;
    let taskRuns = 0;
    let droppedTasks = 0;
    queue.setProcessMessagesFn(async () => {
      messageRuns += 1;
      return true;
    });
    // Keep an overlapping profile-style mutation token alive after DELETE
    // consumes its own token. This exercises the terminal tombstone window.
    const overlappingToken = queue.pauseGroupsForMutation([jid]);

    const realStopGroup = queue.stopGroup.bind(queue);
    let firstStopEntered!: () => void;
    const firstStopEnteredPromise = new Promise<void>((resolve) => {
      firstStopEntered = resolve;
    });
    let releaseFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve;
    });
    let stopCalls = 0;
    vi.spyOn(queue, 'stopGroup').mockImplementation(
      async (stopJid, options) => {
        stopCalls += 1;
        if (stopCalls === 1) {
          firstStopEntered();
          await firstStopGate;
        }
        await realStopGroup(stopJid, options);
      },
    );
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      getSessions: () => ({}),
      setLastAgentTimestamp: vi.fn(),
      queue,
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      asUser(OWNER_ID);
      const deletePromise = groupRoutes.request(`/${encodeURIComponent(jid)}`, {
        method: 'DELETE',
      });
      await firstStopEnteredPromise;

      // These model message/task POST handlers that passed their DB/ACL checks
      // just before DELETE began and enqueue while its synchronous gate is held.
      queue.enqueueMessageCheck(jid, OWNER_ID);
      expect(
        queue.enqueueTask(
          descendantJid,
          'arrived-during-delete',
          async () => {
            taskRuns += 1;
          },
          { onDropped: () => (droppedTasks += 1) },
        ),
      ).toBe(true);
      expect(queue.getStatus()).toMatchObject({
        activeCount: 0,
        waitingCount: 2,
      });

      releaseFirstStop();
      const response = await deletePromise;
      expect(response.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(messageRuns).toBe(0);
      expect(taskRuns).toBe(0);
      expect(droppedTasks).toBe(1);

      // This descendant did not exist while the group/cache still provided a
      // folder resolver. A stable base-JID alias must still reject it after
      // DELETE removed resolver data, while the overlapping token is live.
      expect(
        queue.enqueueTask(
          postDeleteDescendantJid,
          'first-seen-after-delete',
          async () => {
            taskRuns += 1;
          },
          { onDropped: () => (droppedTasks += 1) },
        ),
      ).toBe(false);
      expect(droppedTasks).toBe(2);

      queue.resumeGroupsAfterMutation(overlappingToken);
      await new Promise((resolve) => setImmediate(resolve));
      expect(messageRuns).toBe(0);
      expect(taskRuns).toBe(0);
      expect(
        queue.enqueueTask(
          lateDescendantJid,
          'late-after-all-pauses',
          async () => {
            taskRuns += 1;
          },
          { onDropped: () => (droppedTasks += 1) },
        ),
      ).toBe(false);
      expect(droppedTasks).toBe(3);
      expect(queue.getStatus()).toMatchObject({
        activeCount: 0,
        waitingCount: 0,
      });
      expect(
        queue
          .getStatus()
          .groups.every(
            (state) =>
              !state.active &&
              !state.pendingMessages &&
              state.pendingTasks === 0,
          ),
      ).toBe(true);
      expect(db.getRegisteredGroup(jid)).toBeUndefined();
      expect(db.getWorkspaceAgentProfileId(folder)).toBeUndefined();
      expect(fs.existsSync(workspaceDir)).toBe(false);
    } finally {
      releaseFirstStop();
      queue.resumeGroupsAfterMutation(overlappingToken);
      await queue.shutdown(0);
      delete webDepsCache[jid];
      try {
        db.deleteGroupData(jid, folder);
      } catch {
        /* ignore */
      }
    }
  });

  test('failed pre-stop resumes the gate and leaves workspace state intact', async () => {
    const jid = 'web:delete-mutation-stop-failure';
    const folder = 'delete-mutation-stop-failure';
    const profile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Delete Failure Agent',
    });
    db.setRegisteredGroup(jid, {
      name: 'Delete Failure Workspace',
      folder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
    } as any);
    db.assignWorkspaceAgentProfile(folder, profile.id);
    const workspaceDir = path.join(tmpDataDir, 'groups', folder);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const pauseToken = { id: 77 };
    const pauseGroupsForMutation = vi.fn(() => pauseToken);
    const resumeGroupsAfterMutation = vi.fn();
    const discardGroupsAfterMutation = vi.fn();
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      queue: {
        pauseGroupsForMutation,
        resumeGroupsAfterMutation,
        discardGroupsAfterMutation,
        listDescendantJids: () => [],
        stopGroup: vi.fn(async () => {
          throw new Error('injected delete stop failure');
        }),
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      asUser(OWNER_ID);
      const response = await groupRoutes.request(
        `/${encodeURIComponent(jid)}`,
        { method: 'DELETE' },
      );
      expect(response.status).toBe(500);
      expect(pauseGroupsForMutation).toHaveBeenCalledWith([jid]);
      expect(resumeGroupsAfterMutation).toHaveBeenCalledWith(pauseToken);
      expect(discardGroupsAfterMutation).not.toHaveBeenCalled();
      expect(db.getRegisteredGroup(jid)).toBeDefined();
      expect(db.getWorkspaceAgentProfileId(folder)).toBe(profile.id);
      expect(fs.existsSync(workspaceDir)).toBe(true);
    } finally {
      db.deleteGroupData(jid, folder);
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe('PATCH /:jid/agent-profile two-phase runtime quiesce', () => {
  test('rejects moving Home Workspace to a custom Agent before runtime teardown', async () => {
    const jid = 'web:agent-migration-home';
    const folder = 'agent-migration-home';
    const builtIn = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    const custom = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Isolated Home Target',
    });
    db.setRegisteredGroup(jid, {
      name: 'Protected Home',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      is_home: true,
    });
    db.assignWorkspaceAgentProfile(folder, builtIn.id);

    asUser(OWNER_ID);
    const response = await groupRoutes.request(
      `/${encodeURIComponent(jid)}/agent-profile`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: custom.id }),
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'HOME_WORKSPACE_AGENT_IMMUTABLE',
    });
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(builtIn.id);
    db.deleteRegisteredGroup(jid);
  });

  test('pre-commit stop failure leaves the workspace AgentProfile unchanged', async () => {
    const jid = 'web:agent-migration-pre-failure';
    const folder = 'agent-migration-pre-failure';
    const oldProfile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Old Pre-failure Agent',
    });
    const newProfile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'New Pre-failure Agent',
    });
    db.setRegisteredGroup(jid, {
      name: 'Agent Migration Pre-failure',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(folder, oldProfile.id);
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['migration-pre'] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup: vi.fn(async () => {
          throw new Error('injected pre-commit stop failure');
        }),
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    asUser(OWNER_ID);
    const res = await groupRoutes.request(
      `/${encodeURIComponent(jid)}/agent-profile`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: newProfile.id }),
      },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      persisted: false,
      retryable: true,
    });
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(oldProfile.id);
    db.deleteRegisteredGroup(jid);
  });

  test('post-commit failure reports persisted and identical retry runs both cleanup passes', async () => {
    const jid = 'web:agent-migration-post-failure';
    const folder = 'agent-migration-post-failure';
    const oldProfile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Old Post-failure Agent',
    });
    const newProfile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'New Post-failure Agent',
    });
    db.setRegisteredGroup(jid, {
      name: 'Agent Migration Post-failure',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(folder, oldProfile.id);

    let stopCalls = 0;
    const stopGroup = vi.fn(async () => {
      stopCalls += 1;
      if (stopCalls === 2) {
        throw new Error('injected post-commit stop failure');
      }
    });
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      queue: {
        pauseGroupsForMutation: () => ({ keys: ['migration-post'] }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    const request = () => {
      asUser(OWNER_ID);
      return groupRoutes.request(`/${encodeURIComponent(jid)}/agent-profile`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: newProfile.id }),
      });
    };

    const failedCleanup = await request();
    expect(failedCleanup.status).toBe(503);
    expect(await failedCleanup.json()).toMatchObject({
      persisted: true,
      retryable: true,
      agent_profile_id: newProfile.id,
    });
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(newProfile.id);

    const retried = await request();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      success: true,
      agent_profile_id: newProfile.id,
    });
    expect(stopGroup).toHaveBeenCalledTimes(4);
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(newProfile.id);
    db.deleteRegisteredGroup(jid);
  });

  test('B→A migration waits for an A patch lock and only quiesces against A-new', async () => {
    const jid = 'web:agent-migration-membership-lock';
    const folder = 'agent-migration-membership-lock';
    const targetA = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Target A Old',
    });
    const oldB = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Old B',
    });
    db.setRegisteredGroup(jid, {
      name: 'Membership Lock Workspace',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(folder, oldB.id);
    const existingAJid = 'web:profile-a-existing-workspace';
    const existingAFolder = 'profile-a-existing-workspace';
    db.setRegisteredGroup(existingAJid, {
      name: 'Existing A Workspace',
      folder: existingAFolder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(existingAFolder, targetA.id);

    const observedTargetVersions: number[] = [];
    let firstStopEntered!: () => void;
    const firstStopEnteredPromise = new Promise<void>((resolve) => {
      firstStopEntered = resolve;
    });
    let releaseFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve;
    });
    const stopGroup = vi.fn(async () => {
      observedTargetVersions.push(db.getAgentProfile(targetA.id)!.version);
      if (stopGroup.mock.calls.length === 1) {
        firstStopEntered();
        await firstStopGate;
      }
    });
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    asUser(OWNER_ID);
    const patchPromise = agentProfileRoutes.request(`/${targetA.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Target A New' }),
    });
    await firstStopEnteredPromise;

    const migrationPromise = groupRoutes.request(
      `/${encodeURIComponent(jid)}/agent-profile`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: targetA.id }),
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(oldB.id);
    expect(stopGroup).toHaveBeenCalledTimes(1);

    releaseFirstStop();
    const patchResponse = await patchPromise;
    expect(patchResponse.status).toBe(200);
    const migrationResponse = await migrationPromise;
    expect(migrationResponse.status).toBe(200);
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(targetA.id);
    expect(observedTargetVersions).toEqual([
      targetA.version,
      targetA.version + 1,
      targetA.version + 1,
      targetA.version + 1,
    ]);
    db.deleteRegisteredGroup(jid);
    db.deleteRegisteredGroup(existingAJid);
  });

  test('migration releases wrongly-observed old lock and retries with the current old profile', async () => {
    const jid = 'web:agent-migration-old-retry';
    const folder = 'agent-migration-old-retry';
    const oldA = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Observed Old A',
    });
    const targetB = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Target B',
    });
    const changedOldC = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Changed Old C',
    });
    db.setRegisteredGroup(jid, {
      name: 'Old Mapping Retry Workspace',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(folder, oldA.id);

    const firstObservedLock = [oldA.id, targetB.id].sort()[0];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const firstHolder = agentProfileRuntime.withAgentProfileLocks(
      [firstObservedLock],
      async () => {
        firstEntered();
        await firstGate;
      },
    );
    await firstEnteredPromise;

    let releaseCurrentOld!: () => void;
    const currentOldGate = new Promise<void>((resolve) => {
      releaseCurrentOld = resolve;
    });
    let currentOldEntered!: () => void;
    const currentOldEnteredPromise = new Promise<void>((resolve) => {
      currentOldEntered = resolve;
    });
    const currentOldHolder = agentProfileRuntime.withAgentProfileLocks(
      [changedOldC.id],
      async () => {
        currentOldEntered();
        await currentOldGate;
      },
    );
    await currentOldEnteredPromise;

    const stopGroup = vi.fn(async () => {});
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
    asUser(OWNER_ID);
    const migrationPromise = groupRoutes.request(
      `/${encodeURIComponent(jid)}/agent-profile`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: targetB.id }),
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    db.assignWorkspaceAgentProfile(folder, changedOldC.id);
    releaseFirst();
    await firstHolder;
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(changedOldC.id);
    expect(stopGroup).not.toHaveBeenCalled();

    releaseCurrentOld();
    await currentOldHolder;
    const migrationResponse = await migrationPromise;
    expect(migrationResponse.status).toBe(200);
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(targetB.id);
    expect(stopGroup).toHaveBeenCalledTimes(2);
    db.deleteRegisteredGroup(jid);
  });

  test('archived target wins the lock and migration cannot publish a dangling mapping', async () => {
    const jid = 'web:agent-migration-archived-target';
    const folder = 'agent-migration-archived-target';
    const oldProfile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Archive Race Old',
    });
    const target = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Archive Race Target',
    });
    db.setRegisteredGroup(jid, {
      name: 'Archive Race Workspace',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(folder, oldProfile.id);

    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archiveEntered!: () => void;
    const archiveEnteredPromise = new Promise<void>((resolve) => {
      archiveEntered = resolve;
    });
    const archive = agentProfileRuntime.withAgentProfileLocks(
      [target.id],
      async () => {
        archiveEntered();
        await archiveGate;
        expect(db.archiveAgentProfile(target.id, OWNER_ID)).toBe('ok');
      },
    );
    await archiveEnteredPromise;
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        listDescendantJids: () => [],
        stopGroup: vi.fn(async () => {}),
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    asUser(OWNER_ID);
    const migrationPromise = groupRoutes.request(
      `/${encodeURIComponent(jid)}/agent-profile`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: target.id }),
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseArchive();
    await archive;
    const migrationResponse = await migrationPromise;
    expect(migrationResponse.status).toBe(409);
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(oldProfile.id);
    expect(db.getAgentProfile(target.id)?.status).toBe('archived');
    db.deleteRegisteredGroup(jid);
  });

  test('workspace deletion during migration pre-stop wins without resurrecting its mapping', async () => {
    const jid = 'web:agent-migration-delete-race';
    const folder = 'agent-migration-delete-race';
    const oldProfile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Delete Race Old',
    });
    const target = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Delete Race Target',
    });
    db.setRegisteredGroup(jid, {
      name: 'Delete Race Workspace',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(folder, oldProfile.id);

    let migrationStopEntered!: () => void;
    const migrationStopEnteredPromise = new Promise<void>((resolve) => {
      migrationStopEntered = resolve;
    });
    let releaseMigrationStop!: () => void;
    const migrationStopGate = new Promise<void>((resolve) => {
      releaseMigrationStop = resolve;
    });
    const stopGroup = vi.fn(async () => {
      // The migration owns call 1. DELETE is deliberately allowed to complete
      // through call 2 while migration is suspended in its pre-commit pass.
      if (stopGroup.mock.calls.length === 1) {
        migrationStopEntered();
        await migrationStopGate;
      }
      // If migration incorrectly treats its no-op commit as persisted, its
      // post-stop reaches call 3 and fails. The route must instead return 409.
      if (stopGroup.mock.calls.length >= 3) {
        throw new Error(
          'post-stop must not run after missing-workspace commit',
        );
      }
    });
    const discardGroupsAfterMutation = vi.fn();
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      getSessions: () => ({}),
      setLastAgentTimestamp: vi.fn(),
      queue: {
        pauseGroupsForMutation: () => ({ id: 1 }),
        resumeGroupsAfterMutation: () => {},
        discardGroupsAfterMutation,
        listDescendantJids: () => [],
        stopGroup,
      },
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    asUser(OWNER_ID);
    const migrationPromise = groupRoutes.request(
      `/${encodeURIComponent(jid)}/agent-profile`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: target.id }),
      },
    );
    await migrationStopEnteredPromise;

    const deleteResponse = await groupRoutes.request(
      `/${encodeURIComponent(jid)}`,
      { method: 'DELETE' },
    );
    expect(deleteResponse.status).toBe(200);
    expect(db.getRegisteredGroup(jid)).toBeUndefined();
    expect(db.getWorkspaceAgentProfileId(folder)).toBeUndefined();

    releaseMigrationStop();
    const migrationResponse = await migrationPromise;
    expect(migrationResponse.status).toBe(409);
    expect(await migrationResponse.json()).toMatchObject({
      persisted: false,
    });
    expect(db.getRegisteredGroup(jid)).toBeUndefined();
    expect(db.getWorkspaceAgentProfileId(folder)).toBeUndefined();
    expect(stopGroup).toHaveBeenCalledTimes(2);
    expect(discardGroupsAfterMutation).toHaveBeenCalledTimes(1);
  });
});

describe('POST / workspace Agent membership publication lock', () => {
  test('new workspace stays unpublished behind an Agent patch and publishes only A-new', async () => {
    const target = db.createAgentProfile({
      ownerUserId: ADMIN_ID,
      name: 'Create Target Old',
    });
    const ensureTerminalContainerStarted = vi.fn(() => true);
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      ensureTerminalContainerStarted,
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    let patchEntered!: () => void;
    const patchEnteredPromise = new Promise<void>((resolve) => {
      patchEntered = resolve;
    });
    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => {
      releasePatch = resolve;
    });
    const patch = agentProfileRuntime.withAgentProfileLocks(
      [target.id],
      async () => {
        patchEntered();
        await patchGate;
        db.updateAgentProfile(target.id, ADMIN_ID, {
          name: 'Create Target New',
        });
      },
    );
    await patchEnteredPromise;

    asUser(ADMIN_ID, 'admin');
    const createPromise = groupRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Locked Create Workspace',
        execution_mode: 'container',
        agent_profile_id: target.id,
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      Object.values(db.getAllRegisteredGroups()).some(
        (group) => group.name === 'Locked Create Workspace',
      ),
    ).toBe(false);
    expect(ensureTerminalContainerStarted).not.toHaveBeenCalled();

    releasePatch();
    await patch;
    const createResponse = await createPromise;
    expect(createResponse.status).toBe(200);
    const body = await createResponse.json();
    expect(body.group).toMatchObject({
      agent_profile_id: target.id,
      agent_profile_name: 'Create Target New',
      agent_profile_version: target.version + 1,
    });
    expect(db.getWorkspaceAgentProfileId(body.group.folder)).toBe(target.id);
    expect(ensureTerminalContainerStarted).toHaveBeenCalledWith(body.jid);
    db.deleteGroupData(body.jid, body.group.folder);
  });

  test('slow failing initialization never publishes a group or Agent mapping', async () => {
    const target = db.createAgentProfile({
      ownerUserId: ADMIN_ID,
      name: 'Slow Init Target',
    });
    const sourceDir = fs.mkdtempSync(
      path.join(os.homedir(), '.happyclaw-slow-init-source-'),
    );
    fs.writeFileSync(path.join(sourceDir, 'seed.txt'), 'seed');
    let copyStarted!: () => void;
    const copyStartedPromise = new Promise<void>((resolve) => {
      copyStarted = resolve;
    });
    let rejectCopy!: (reason: Error) => void;
    const copyGate = new Promise<void>((_resolve, reject) => {
      rejectCopy = reject;
    });
    const cpSpy = vi.spyOn(fsp, 'cp').mockImplementation((async () => {
      copyStarted();
      await copyGate;
    }) as typeof fsp.cp);
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      ensureTerminalContainerStarted: vi.fn(() => true),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      asUser(ADMIN_ID, 'admin');
      const createPromise = groupRoutes.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Slow Invisible Workspace',
          execution_mode: 'container',
          agent_profile_id: target.id,
          init_source_path: sourceDir,
        }),
      });
      await copyStartedPromise;
      expect(
        Object.values(db.getAllRegisteredGroups()).some(
          (group) => group.name === 'Slow Invisible Workspace',
        ),
      ).toBe(false);
      expect(db.countWorkspaceAgentProfileMappings(target.id)).toBe(0);

      rejectCopy(new Error('injected copy failure'));
      const createResponse = await createPromise;
      expect(createResponse.status).toBe(500);
      expect(
        Object.values(db.getAllRegisteredGroups()).some(
          (group) => group.name === 'Slow Invisible Workspace',
        ),
      ).toBe(false);
      expect(db.countWorkspaceAgentProfileMappings(target.id)).toBe(0);
    } finally {
      cpSpy.mockRestore();
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('archived target wins the create lock and is never published', async () => {
    const target = db.createAgentProfile({
      ownerUserId: ADMIN_ID,
      name: 'Create Archive Target',
    });
    let releaseArchive!: () => void;
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archiveEntered!: () => void;
    const archiveEnteredPromise = new Promise<void>((resolve) => {
      archiveEntered = resolve;
    });
    const archive = agentProfileRuntime.withAgentProfileLocks(
      [target.id],
      async () => {
        archiveEntered();
        await archiveGate;
        expect(db.archiveAgentProfile(target.id, ADMIN_ID)).toBe('ok');
      },
    );
    await archiveEnteredPromise;
    const ensureTerminalContainerStarted = vi.fn(() => true);
    webContext.setWebDeps({
      getRegisteredGroups: () => webDepsCache,
      ensureTerminalContainerStarted,
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    asUser(ADMIN_ID, 'admin');
    const createPromise = groupRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Archived Target Workspace',
        execution_mode: 'container',
        agent_profile_id: target.id,
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseArchive();
    await archive;
    const createResponse = await createPromise;
    expect(createResponse.status).toBe(409);
    expect(db.countWorkspaceAgentProfileMappings(target.id)).toBe(0);
    expect(ensureTerminalContainerStarted).not.toHaveBeenCalled();
    expect(
      Object.values(db.getAllRegisteredGroups()).some(
        (group) => group.name === 'Archived Target Workspace',
      ),
    ).toBe(false);
  });
});
