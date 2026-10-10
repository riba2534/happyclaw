/**
 * Prod P1-3: `POST /api/groups/:jid/agents` used to accept an IM chat JID and
 * mint a `feishu:oc_…#agent:…` session whose every reply was handed to the
 * Feishu connector as an unroutable target. Sessions live in a Workspace
 * (`web:*`); IM chats bind to sessions instead.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-routes-agents-im-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDataDir,
    GROUPS_DIR: path.join(tmpDataDir, 'groups'),
    STORE_DIR: path.join(tmpDataDir, 'db'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastAgentStatus: () => {},
  broadcastAgentRemoved: () => {},
}));

const agentRoutes = (await import('../src/routes/agents.js')).default;
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const IM_JID = 'feishu:oc_im_session_parent';
const WEB_JID = 'web:im-session-parent';

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  for (const jid of [IM_JID, WEB_JID]) {
    db.setRegisteredGroup(jid, {
      name: jid,
      folder: 'im-session-parent',
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'alice',
      is_home: false,
    } as any);
  }
});

async function post(jid: string, route: 'agents' | 'sessions') {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(jid)}/${route}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deploy-verify' }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('session parents must be workspace JIDs', () => {
  test.each(['agents', 'sessions'] as const)(
    'POST /:jid/%s rejects an IM chat JID without creating a session',
    async (route) => {
      const before = db.listAgentsByJid(IM_JID).length;
      const res = await post(IM_JID, route);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspace/i);
      expect(db.listAgentsByJid(IM_JID)).toHaveLength(before);
    },
  );

  test.each(['agents', 'sessions'] as const)(
    'POST /:jid/%s still creates a session in a workspace',
    async (route) => {
      const res = await post(WEB_JID, route);
      expect(res.status).toBe(200);
      const created = route === 'agents' ? res.body.agent : res.body.session;
      expect(created?.id).toBeTruthy();
      expect(
        db.listAgentsByJid(WEB_JID).some((agent) => agent.id === created.id),
      ).toBe(true);
    },
  );
});
