import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(
  path.join(os.tmpdir(), 'whatsapp-cus-direct-mount-'),
);
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
const { attachDefaultChannelAccountMount, buildSessionMountUpdate } =
  await import('../src/channel-mount-service.js');

const now = '2026-08-20T00:00:00.000Z';
const workspaceJid = 'web:whatsapp-cus-ws';
const cusDmJid = 'whatsapp:16505361212@c.us#account:bot-a';
const groupJid = 'whatsapp:120363012345678901@g.us#account:bot-a';

function workspaceGroup() {
  return {
    name: 'WhatsApp workspace',
    folder: 'whatsapp-cus-ws',
    added_at: now,
    created_by: 'owner-a',
  };
}

function chatGroup(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    folder: 'whatsapp-cus-chat',
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
    provider: 'whatsapp',
    name: 'WhatsApp bot',
    secret_ref: 'channel-account:bot-a',
    default_workspace_jid: workspaceJid,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.sequential('WhatsApp @c.us DM / group channel-account mounts', () => {
  test('discovery leaves @c.us DMs and groups unbound', () => {
    const onCreated = vi.fn();
    const sessionsBefore = db.listAgentsByJid(workspaceJid);
    for (const sourceJid of [cusDmJid, groupJid]) {
      const discovered = attachDefaultChannelAccountMount({
        sourceJid,
        group: chatGroup('Discovered WhatsApp chat', {
          folder: 'whatsapp-cus-ws',
        }),
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
        onCreated,
      });
      expect(discovered.channel_account_id).toBe('bot-a');
      expect(discovered.target_main_jid).toBeUndefined();
      expect(discovered.target_agent_id).toBeUndefined();
      db.setRegisteredGroup(sourceJid, discovered);
      expect(db.getRegisteredGroup(sourceJid)?.channel_account_id).toBe(
        'bot-a',
      );
      expect(db.getChannelMount(sourceJid)).toBeUndefined();
    }
    expect(db.listAgentsByJid(workspaceJid)).toEqual(sessionsBefore);
    expect(db.getSessionChannelOwner('whatsapp-cus-ws')).toBeUndefined();
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('an explicit bind of the @c.us DM and the group gives each its own session', () => {
    for (const [sourceJid, sessionId] of [
      [cusDmJid, 'wa-dm-session'],
      [groupJid, 'wa-group-session'],
    ] as const) {
      db.createAgent({
        id: sessionId,
        group_folder: 'whatsapp-cus-ws',
        chat_jid: workspaceJid,
        name: sessionId,
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_by: 'owner-a',
        created_at: now,
        completed_at: null,
        result_summary: null,
        last_im_jid: sourceJid,
        spawned_from_jid: null,
      });
      const bound = buildSessionMountUpdate(
        chatGroup(sessionId, { channel_account_id: 'bot-a' }),
        sessionId,
      );
      expect(bound.target_main_jid).toBeUndefined();
      db.setRegisteredGroup(sourceJid, bound);
      expect(db.getChannelMount(sourceJid)).toMatchObject({
        channel_account_id: 'bot-a',
        workspace_jid: workspaceJid,
        session_id: sessionId,
        routing_mode: 'single_session',
      });
    }
  });

  test('discovering the canonical alias of a bound @c.us DM leaves it unbound', () => {
    const canonicalJid = 'whatsapp:16505361212@s.whatsapp.net#account:bot-a';
    const sessionsBefore = db.listAgentsByJid(workspaceJid);
    const discovered = attachDefaultChannelAccountMount({
      sourceJid: canonicalJid,
      group: chatGroup('Canonical official business'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(discovered.channel_account_id).toBe('bot-a');
    expect(discovered.target_agent_id).toBeUndefined();
    expect(discovered.target_main_jid).toBeUndefined();
    db.setRegisteredGroup(canonicalJid, discovered);
    expect(db.getChannelMount(canonicalJid)).toBeUndefined();
    expect(db.listAgentsByJid(workspaceJid)).toEqual(sessionsBefore);
  });
});
