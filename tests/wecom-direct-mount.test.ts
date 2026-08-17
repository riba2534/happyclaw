import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-direct-mount-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw Test',
  DATA_DIR: dataDir,
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const {
  attachDefaultChannelAccountMount,
  restoreDefaultChannelMount,
  resolveChannelMountTarget,
} = await import('../src/channel-mount-service.js');

const now = '2026-08-17T00:00:00.000Z';
const workspaceJid = 'web:wecom-ws';
const dmJid = 'wecom:c2c:user-1#account:bot-a';
const groupJid = 'wecom:group:chat-1#account:bot-a';

function workspaceGroup() {
  return {
    name: 'WeCom workspace',
    folder: 'wecom-ws',
    added_at: now,
    created_by: 'owner-a',
  };
}

function chatGroup(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    folder: 'wecom-chat',
    added_at: now,
    created_by: 'owner-a',
    ...overrides,
  };
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(workspaceJid, workspaceGroup());
  db.createChannelAccount({
    id: 'bot-a',
    owner_user_id: 'owner-a',
    provider: 'wecom',
    name: 'WeCom bot',
    secret_ref: 'channel-account:bot-a',
    default_workspace_jid: workspaceJid,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.sequential('WeCom DM / group channel-account mounts', () => {
  test('binds a new DM to a dedicated session and a group to workspace main', () => {
    const dm = attachDefaultChannelAccountMount({
      sourceJid: dmJid,
      group: chatGroup('Private DM'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(dm.channel_account_id).toBe('bot-a');
    expect(dm.target_main_jid).toBeUndefined();
    expect(dm.target_agent_id).toBeTruthy();

    db.setRegisteredGroup(dmJid, dm);
    const dmMount = db.getChannelMount(dmJid);
    expect(dmMount).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: dm.target_agent_id,
      routing_mode: 'single_session',
    });
    const dmTarget = resolveChannelMountTarget(dmMount!, {
      getAgent: db.getAgent,
      getRegisteredGroup: db.getRegisteredGroup,
    });
    expect(dmTarget).toMatchObject({
      status: 'resolved',
      effectiveJid: `${workspaceJid}#agent:${dm.target_agent_id}`,
      agentId: dm.target_agent_id,
    });

    const group = attachDefaultChannelAccountMount({
      sourceJid: groupJid,
      group: chatGroup('Team group'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(group).toMatchObject({
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    expect(group.target_agent_id).toBeUndefined();
    db.setRegisteredGroup(groupJid, group);
    expect(db.getChannelMount(groupJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: null,
    });

    const groupOwner = db.setSessionChannelOwnerOnce(
      'wecom-ws',
      null,
      groupJid,
    );
    const dmOwner = db.setSessionChannelOwnerOnce(
      'wecom-ws',
      dm.target_agent_id,
      dmJid,
    );
    expect(groupOwner).toBe(groupJid);
    expect(dmOwner).toBe(dmJid);
    expect(db.setSessionChannelOwnerOnce('wecom-ws', null, dmJid)).toBe(
      groupJid,
    );
    expect(
      db.setSessionChannelOwnerOnce('wecom-ws', dm.target_agent_id, groupJid),
    ).toBe(dmJid);
  });

  test('reuses the channel_direct session for the same DM conversation', () => {
    const first = db.getRegisteredGroup(dmJid)!;
    const again = attachDefaultChannelAccountMount({
      sourceJid: dmJid,
      group: first,
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(again).toBe(first);

    const rebound = attachDefaultChannelAccountMount({
      sourceJid: dmJid,
      group: chatGroup('Private DM replay'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(rebound.target_agent_id).toBe(first.target_agent_id);
  });

  test('keeps the same native DM isolated across WeCom accounts', () => {
    db.createChannelAccount({
      id: 'bot-b',
      owner_user_id: 'owner-a',
      provider: 'wecom',
      name: 'Second WeCom bot',
      secret_ref: 'channel-account:bot-b',
      default_workspace_jid: workspaceJid,
    });
    let secondAgentId: string | undefined;
    try {
      const first = db.getRegisteredGroup(dmJid)!;
      const second = attachDefaultChannelAccountMount({
        sourceJid: 'wecom:c2c:user-1#account:bot-b',
        group: chatGroup('Private DM on second bot'),
        accountId: 'bot-b',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      });
      secondAgentId = second.target_agent_id;
      expect(secondAgentId).toBeTruthy();
      expect(secondAgentId).not.toBe(first.target_agent_id);
      expect(db.getAgent(secondAgentId!)?.last_im_jid).toBe(
        'wecom:c2c:user-1#account:bot-b',
      );
    } finally {
      if (secondAgentId) db.deleteAgent(secondAgentId);
      db.deleteChannelAccount('bot-b', 'owner-a');
    }
  });

  test('does not overwrite a manual session or workspace bind', () => {
    const sessionBound = chatGroup('Manual session', {
      channel_account_id: 'bot-a',
      target_agent_id: 'manual-session',
    });
    expect(
      attachDefaultChannelAccountMount({
        sourceJid: 'wecom:c2c:user-2#account:bot-a',
        group: sessionBound,
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      }),
    ).toBe(sessionBound);

    const workspaceBound = chatGroup('Manual workspace', {
      channel_account_id: 'bot-a',
      target_main_jid: 'web:user-selected',
    });
    expect(
      attachDefaultChannelAccountMount({
        sourceJid: 'wecom:group:chat-2#account:bot-a',
        group: workspaceBound,
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      }),
    ).toBe(workspaceBound);
  });

  test('restore default remounts a WeCom DM onto a session, not workspace main', () => {
    const restoreJid = 'wecom:c2c:user-3#account:bot-a';
    db.setRegisteredGroup(
      restoreJid,
      chatGroup('Legacy DM', {
        channel_account_id: 'bot-a',
        target_main_jid: workspaceJid,
      }),
    );
    db.clearSessionChannelOwner('wecom-ws', null);
    expect(db.setSessionChannelOwnerOnce('wecom-ws', null, restoreJid)).toBe(
      restoreJid,
    );
    const restored = restoreDefaultChannelMount(
      restoreJid,
      db.getRegisteredGroup(restoreJid)!,
      'owner-a',
    );
    expect(restored.status).toBe('resolved');
    if (restored.status !== 'resolved') return;
    expect(restored.workspaceJid).toBe(workspaceJid);
    expect(restored.updated.target_main_jid).toBeUndefined();
    expect(restored.updated.target_agent_id).toBeTruthy();
    expect(db.getChannelMount(restoreJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: restored.updated.target_agent_id,
    });
    expect(db.getAgent(restored.updated.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );
    expect(db.getSessionChannelOwner('wecom-ws')).toBeUndefined();
  });
});
