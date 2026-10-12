/**
 * PUT /api/config/user-im/bindings/:imJid activation-only reads imGroup before
 * await c.req.json(), then spreads that pre-await snapshot into
 * applyBindingUpdate. Unbind / session / workspace branches re-read after the
 * yield; activation-only does not. A concurrent unbind during body parse is
 * silently remounted to the stale target_main_jid.
 *
 * Probes:
 *   B_current_remounts_stale_target — before the re-read, activation sticks but
 *     target_main_jid returns to the unbound workspace.
 *   B_fix_keeps_unbind — after the re-read overlay, unbind sticks and
 *     activation_mode updates on the fresh row.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { RegisteredGroup } from '../src/types.js';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-bindings-activation-race-'),
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

vi.mock('../src/middleware/auth.js', () => ({
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
  adminRoleMiddleware: async (_c: any, next: any) => next(),
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  broadcastAgentStatus: () => {},
  broadcastAgentRemoved: () => {},
  invalidateAllowedUserCache: () => {},
}));

const configRoutesModule = await import('../src/routes/config.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const { injectChannelMountRuntimePort, unbindChannelMount } =
  await import('../src/channel-mount-service.js');

const configRoutes = configRoutesModule.default;
const OWNER_ID = 'alice';
const IM_JID = 'feishu:oc_bindings_activation_race';
const WS_JID = 'web:bindings-activation-race-ws';
const FOLDER = 'bindings-activation-race-ws';

const cache: Record<string, RegisteredGroup> = {};

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER_ID,
    username: 'alice',
    password_hash: 'test-only',
    display_name: 'Alice',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup(WS_JID, {
    name: 'Activation race workspace',
    folder: FOLDER,
    added_at: now,
    created_by: OWNER_ID,
  });
  cache[WS_JID] = db.getRegisteredGroup(WS_JID)!;
  webContext.setWebDeps({
    getRegisteredGroups: () => cache,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  injectChannelMountRuntimePort({ getRegisteredGroups: () => cache });
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
  delete cache[IM_JID];
  try {
    db.deleteRegisteredGroup(IM_JID);
  } catch {
    /* ignore */
  }
});

describe('PUT /user-im/bindings/:imJid activation-only vs concurrent unbind', () => {
  test('B_fix_keeps_unbind', async () => {
    const now = new Date().toISOString();
    db.setRegisteredGroup(IM_JID, {
      name: 'Bound Feishu group',
      folder: FOLDER,
      added_at: now,
      created_by: OWNER_ID,
      activation_mode: 'auto',
      audience_mode: 'everyone',
      target_main_jid: WS_JID,
      binding_mode: 'single_session',
      feishu_chat_mode: 'group',
      feishu_group_message_type: 'chat',
    });
    cache[IM_JID] = db.getRegisteredGroup(IM_JID)!;
    asUser(OWNER_ID, 'member');

    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let markBodyRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (pulled) return;
        pulled = true;
        markBodyRead();
        await bodyGate;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ activation_mode: 'when_mentioned' }),
          ),
        );
        controller.close();
      },
    });

    const pending = configRoutes.request(
      `/user-im/bindings/${encodeURIComponent(IM_JID)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body,
        duplex: 'half',
      } as RequestInit,
    );

    await bodyRead;

    const mid = db.getRegisteredGroup(IM_JID);
    expect(mid?.target_main_jid).toBe(WS_JID);
    unbindChannelMount(IM_JID, mid!);
    expect(db.getRegisteredGroup(IM_JID)?.target_main_jid).toBeUndefined();
    expect(cache[IM_JID]?.target_main_jid).toBeUndefined();

    releaseBody();
    const res = await pending;
    expect(res.status).toBe(200);

    const after = db.getRegisteredGroup(IM_JID);
    const live = cache[IM_JID];
    const remounted =
      after?.target_main_jid === WS_JID || live?.target_main_jid === WS_JID;
    if (remounted) {
      throw new Error(
        `B_current_remounts_stale_target activation_mode=${after?.activation_mode} target_main_jid=${String(after?.target_main_jid)} live_target=${String(live?.target_main_jid)}`,
      );
    }
    expect(after?.activation_mode).toBe('when_mentioned');
    expect(after?.target_main_jid).toBeUndefined();
    expect(live?.activation_mode).toBe('when_mentioned');
    expect(live?.target_main_jid).toBeUndefined();
  });
});
