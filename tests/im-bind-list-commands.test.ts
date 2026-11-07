/**
 * IM `/bind`, `/list` and `/where`: index.ts's real handlers over a real
 * database. Every session is an equal: `/bind <workspace>` makes a new one
 * named after the chat, `/list` shows the shared list order with no fixed
 * entry, and an unbound chat is 未绑定.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im-bind-list-'));
for (const dir of ['db', 'groups']) {
  fs.mkdirSync(path.join(tmp, dir), { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const mountService = await import('../src/channel-mount-service.js');
const imCommands = await import('../src/im-command-utils.js');
const { sortSessionsForList } = await import('../src/session-order.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

import type { SubAgent } from '../src/types.js';

const OWNER = 'bind-owner';
const WORKSPACE = 'web:bind-ws';
const FOLDER = 'bind-ws';
const DM = 'feishu:oc_bind_dm';
const TOPICS = 'feishu:oc_bind_topics';

function session(
  id: string,
  name: string,
  lastActiveAt: string,
  createdAt: string,
  sourceKind?: SubAgent['source_kind'],
): void {
  db.createAgent({
    id,
    group_folder: FOLDER,
    chat_jid: WORKSPACE,
    name,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: createdAt,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    last_active_at: lastActiveAt,
    source_kind: sourceKind,
  });
}

function commands() {
  const registeredGroups: Record<string, unknown> = {};
  const globals: Record<string, unknown> = {
    crypto,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registeredGroups,
    getRegisteredGroup: db.getRegisteredGroup,
    setRegisteredGroup: db.setRegisteredGroup,
    getGroupsByOwner: db.getGroupsByOwner,
    getJidsByFolder: db.getJidsByFolder,
    getUserPinnedSessions: db.getUserPinnedSessions,
    listAgentsByJid: db.listAgentsByJid,
    getAgent: db.getAgent,
    createAgent: db.createAgent,
    ensureChatExists: db.ensureChatExists,
    updateChatName: db.updateChatName,
    updateAgentLastImJid: db.updateAgentLastImJid,
    ensureAgentDirectories: () => {},
    broadcastAgentStatus: () => {},
    resolveWorkspaceJid: (jid: string) =>
      mountService.resolveWorkspaceJid(jid, {
        getRegisteredGroup: db.getRegisteredGroup,
        getJidsByFolder: db.getJidsByFolder,
      }),
    sortSessionsForList,
    isNativeContextContainer: mountService.isNativeContextContainer,
    isBindableSession: mountService.isBindableSession,
    buildSessionMountUpdate: mountService.buildSessionMountUpdate,
    buildWorkspaceMountUpdate: mountService.buildWorkspaceMountUpdate,
    markThreadMapWorkspace: () => {},
    imSendFailCounts: new Map(),
    imHealthCheckFailCounts: new Map(),
    formatWorkspaceList: imCommands.formatWorkspaceList,
    resolveLocationInfo: imCommands.resolveLocationInfo,
    findWorkspaceBySpec: imCommands.findWorkspaceBySpec,
    findSessionsBySpec: imCommands.findSessionsBySpec,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'BIND_TARGET_NOT_FOUND',
    'resolveAutoImWorkspace',
    'createAutoImConversationAgent',
    'collectWorkspaces',
    'resolveBindingTarget',
    'resolveChatLocation',
    'handleBindCommand',
    'handleListCommand',
    'handleWhereCommand',
  ]) {
    harness.install(name);
  }
  return {
    bind: (jid: string, spec: string) =>
      (globals.handleBindCommand as (j: string, s: string) => string)(
        jid,
        spec,
      ),
    list: (jid: string) =>
      (globals.handleListCommand as (j: string) => string)(jid),
    where: (jid: string) =>
      (globals.handleWhereCommand as (j: string) => string)(jid),
  };
}

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Bind WS',
    folder: FOLDER,
    added_at: '2026-01-01T00:00:00.000Z',
    created_by: OWNER,
  });
  // Creation order (the row order) differs from the list order.
  session(
    'older-1',
    'Older',
    '2026-02-01T00:00:00.000Z',
    '2026-01-03T00:00:00.000Z',
  );
  session(
    'newer-2',
    'Newer',
    '2026-03-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
  session(
    'main-3',
    'main',
    '2026-01-15T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
  );
});

beforeEach(() => {
  db.setRegisteredGroup(DM, {
    name: '小王',
    folder: 'home-bind-owner',
    added_at: '2026-01-01T00:00:00.000Z',
    created_by: OWNER,
    feishu_chat_mode: 'p2p',
  });
  db.setRegisteredGroup(TOPICS, {
    name: 'Topics',
    folder: 'home-bind-owner',
    added_at: '2026-01-01T00:00:00.000Z',
    created_by: OWNER,
    feishu_chat_mode: 'topic',
  });
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('/where and /status location', () => {
  test('an unbound chat is 未绑定, whatever its row folder', () => {
    expect(commands().where(DM)).toBe('📍 当前绑定: 未绑定');
  });
});

describe('/bind', () => {
  test('/bind <workspace> makes a new session named after the chat and binds it', () => {
    const c = commands();
    const before = db.listAgentsByJid(WORKSPACE).map((a) => a.id);
    expect(c.bind(DM, 'bind-ws')).toBe(
      '已切换到 Bind WS / 小王（新会话）\n🔁 回复策略: source_only',
    );
    const created = db
      .listAgentsByJid(WORKSPACE)
      .filter((a) => !before.includes(a.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: '小王',
      kind: 'conversation',
      chat_jid: WORKSPACE,
    });
    expect(db.getRegisteredGroup(DM)).toMatchObject({
      target_agent_id: created[0].id,
      binding_mode: 'single_context',
    });
    expect(db.getRegisteredGroup(DM)?.target_main_jid).toBeUndefined();
    expect(db.getChannelMount(DM)).toMatchObject({
      session_id: created[0].id,
      routing_mode: 'single_session',
    });
    expect(c.where(DM)).toContain('Bind WS / 小王');
    db.deleteAgent(created[0].id);
  });

  test('a chat without a name gets 「新对话」', () => {
    db.setRegisteredGroup(DM, { ...db.getRegisteredGroup(DM)!, name: '' });
    const c = commands();
    expect(c.bind(DM, 'Bind WS')).toContain('/ 新对话（新会话）');
    const agentId = db.getRegisteredGroup(DM)!.target_agent_id!;
    expect(db.getAgent(agentId)?.name).toBe('新对话');
    db.deleteAgent(agentId);
  });

  test('/bind <workspace>/<session> binds that session; `main` is just a name', () => {
    const c = commands();
    expect(c.bind(DM, 'bind-ws/newer')).toBe(
      '已切换到 Bind WS / Newer\n🔁 回复策略: source_only',
    );
    expect(db.getRegisteredGroup(DM)?.target_agent_id).toBe('newer-2');
    expect(c.bind(DM, 'bind-ws/main')).toContain('Bind WS / main');
    expect(db.getRegisteredGroup(DM)?.target_agent_id).toBe('main-3');
    for (const spec of ['bind-ws/主会话', 'bind-ws/nope', 'missing-ws']) {
      expect(c.bind(DM, spec)).toMatch(/^未找到目标/);
    }
    expect(db.getRegisteredGroup(DM)?.target_agent_id).toBe('main-3');
  });

  test('an empty session part, a prefix of several sessions or an unbindable session binds nothing', () => {
    const c = commands();
    session(
      'dup-aaa1',
      'Dup one',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    session(
      'dup-aaa2',
      'Dup two',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    );
    session(
      'router-9',
      'Router',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      'team_router',
    );
    const before = db.getRegisteredGroup(DM)?.target_agent_id;
    const sessionsBefore = db.listAgentsByJid(WORKSPACE).length;
    try {
      expect(c.bind(DM, 'bind-ws/')).toBe(
        '请在 / 后写会话短 ID 或名称：/bind <工作区>/<会话短ID>',
      );
      expect(c.bind(DM, 'bind-ws/dup-aaa')).toBe(
        [
          '匹配到多个会话，请写更长的短 ID：',
          '· Dup one [dup-aaa1]',
          '· Dup two [dup-aaa2]',
        ].join('\n'),
      );
      expect(c.bind(DM, 'bind-ws/router')).toBe(
        '这个会话不能绑定聊天（团队、自动化或话题的会话）。',
      );
      expect(db.getRegisteredGroup(DM)?.target_agent_id).toBe(before);
      expect(db.listAgentsByJid(WORKSPACE)).toHaveLength(sessionsBefore);
      expect(c.bind(DM, 'bind-ws/dup-aaa2')).toContain('Bind WS / Dup two');
    } finally {
      for (const id of ['dup-aaa1', 'dup-aaa2', 'router-9']) db.deleteAgent(id);
    }
  });

  test('a topic group binds the workspace itself, never one session', () => {
    const c = commands();
    const before = db.listAgentsByJid(WORKSPACE).length;
    expect(c.bind(TOPICS, 'bind-ws')).toContain('（每个话题一个会话）');
    expect(db.getRegisteredGroup(TOPICS)).toMatchObject({
      target_main_jid: WORKSPACE,
      binding_mode: 'thread_map',
    });
    expect(db.listAgentsByJid(WORKSPACE)).toHaveLength(before);
    expect(c.bind(TOPICS, 'bind-ws/newer')).toMatch(/只能绑定工作区/);
    expect(c.where(TOPICS)).toBe(
      '📍 当前绑定: Bind WS（每个话题一个会话）\n🔁 回复策略: source_only',
    );
  });
});

describe('/list', () => {
  test('sessions in the shared order with the owner pins, the bound one marked', () => {
    const c = commands();
    db.pinSession(OWNER, 'older-1');
    try {
      c.bind(DM, 'bind-ws/newer');
      const lines = c.list(DM).split('\n');
      const start = lines.indexOf(' ▶ Bind WS (bind-ws)');
      expect(lines.slice(start, start + 4)).toEqual([
        ' ▶ Bind WS (bind-ws)',
        '  · Older [olde] ',
        '  · Newer [newe]  ← 当前',
        '  · main [main] ',
      ]);
      expect(c.list(DM)).not.toContain('主会话');
    } finally {
      db.unpinSession(OWNER, 'older-1');
    }
  });

  test('an unbound chat marks nothing', () => {
    const text = commands().list(DM);
    expect(text).not.toContain('▶');
    expect(text).not.toContain('← 当前');
  });
});
