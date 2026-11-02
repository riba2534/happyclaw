import { describe, expect, test } from 'vitest';

import {
  formatWorkspaceList,
  resolveBoundChatTarget,
  resolveLocationInfo,
  type RegisteredGroupLike,
  type AgentLike,
} from '../src/im-command-utils.js';

const registeredGroups = new Map<string, RegisteredGroupLike>([
  ['web:graduation-jid', { name: 'graduation', folder: 'flow-graduation' }],
  ['web:legacy-real-jid', { name: 'legacy', folder: 'flow-legacy' }],
  ['web:home-u1', { name: 'Home', folder: 'home-u1' }],
]);

const agents = new Map<string, AgentLike>([
  ['agent-1234', { name: 'Thesis Agent', chat_jid: 'web:graduation-jid' }],
]);

const getRegisteredGroup = (jid: string) => registeredGroups.get(jid);
const getAgent = (id: string) => agents.get(id);
const resolveWorkspaceJid = (jid: string) =>
  jid === 'web:flow-legacy' ? 'web:legacy-real-jid' : jid;

const chat = (fields: Partial<RegisteredGroupLike>): RegisteredGroupLike => ({
  name: 'Feishu Chat',
  folder: 'home-u1',
  ...fields,
});

describe('resolveBoundChatTarget', () => {
  const resolve = (group: RegisteredGroupLike) =>
    resolveBoundChatTarget(group, getRegisteredGroup, getAgent);

  test('uses the session parent workspace jid for session bindings', () => {
    expect(resolve(chat({ target_agent_id: 'agent-1234' }))).toEqual({
      baseChatJid: 'web:graduation-jid',
      targetChatJid: 'web:graduation-jid#agent:agent-1234',
      folder: 'flow-graduation',
      agentId: 'agent-1234',
      locationLine: 'graduation / Thesis Agent',
    });
  });

  test('an unbound chat has no target, never its row folder or Home', () => {
    expect(resolve(chat({}))).toBeNull();
  });

  test('a workspace binding names no session', () => {
    for (const target_main_jid of ['web:graduation-jid', 'web:flow-legacy']) {
      expect(
        resolve(chat({ target_main_jid, binding_mode: 'thread_map' })),
      ).toBeNull();
    }
  });

  test('returns null when a session binding points at a missing session', () => {
    expect(resolve(chat({ target_agent_id: 'missing-agent' }))).toBeNull();
  });

  test('returns null when a session parent workspace is missing', () => {
    expect(
      resolveBoundChatTarget(
        chat({ target_agent_id: 'orphan-agent' }),
        getRegisteredGroup,
        (id) =>
          id === 'orphan-agent'
            ? { name: 'Orphan Agent', chat_jid: 'web:missing-workspace' }
            : undefined,
      ),
    ).toBeNull();
  });
});

describe('resolveLocationInfo', () => {
  const locate = (group: RegisteredGroupLike) =>
    resolveLocationInfo(
      group,
      getRegisteredGroup,
      getAgent,
      resolveWorkspaceJid,
    );

  test('a session binding names the workspace, the session and its lane', () => {
    expect(locate(chat({ target_agent_id: 'agent-1234' }))).toEqual({
      locationLine: 'graduation / Thesis Agent',
      folder: 'flow-graduation',
      sessionJid: 'web:graduation-jid#agent:agent-1234',
      replyPolicy: 'source_only',
    });
  });

  test('a topic container names its workspace, one session per topic', () => {
    expect(
      locate(
        chat({
          target_main_jid: 'web:flow-legacy',
          binding_mode: 'thread_map',
        }),
      ),
    ).toEqual({
      locationLine: 'legacy（每个话题一个会话）',
      folder: 'flow-legacy',
      sessionJid: null,
      replyPolicy: 'source_only',
    });
  });

  test('an unbound or stale chat is 未绑定, whatever its row folder', () => {
    for (const group of [
      chat({}),
      chat({ target_agent_id: 'missing-agent' }),
      // A workspace on a chat that is not a thread map routes nowhere.
      chat({ target_main_jid: 'web:graduation-jid' }),
    ]) {
      expect(locate(group)).toEqual({
        locationLine: '未绑定',
        folder: null,
        sessionJid: null,
        replyPolicy: null,
      });
    }
  });
});

describe('formatWorkspaceList', () => {
  const workspaces = [
    {
      jid: 'web:home-u1',
      folder: 'home-u1',
      name: 'Home',
      agents: [
        { id: 'pinned-1', name: 'Pinned', status: 'idle' },
        { id: 'recent-2', name: 'Recent', status: 'running' },
      ],
    },
    { jid: 'web:empty', folder: 'empty', name: 'Empty', agents: [] },
  ];

  test('lists sessions in the given order and marks the bound one only', () => {
    const text = formatWorkspaceList(workspaces, 'home-u1', 'recent-2');
    const lines = text.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '📂 工作区列表：',
      ' ▶ Home (home-u1)',
      '  · Pinned [pinn] ',
      '  · Recent [rece] 🔄 ← 当前',
      ' Empty (empty)',
    ]);
    expect(lines[5]).toBe('  · 暂无会话');
    expect(text).not.toContain('主会话');
  });

  test('an unbound chat marks nothing', () => {
    const text = formatWorkspaceList(workspaces, null, null);
    expect(text).not.toContain('▶');
    expect(text).not.toContain('← 当前');
  });
});
