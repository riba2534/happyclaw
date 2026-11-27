/**
 * `/new` in a chat that /pair already detected as a native-context container
 * (Telegram Forum) must bind the new workspace as thread_map. A session bind
 * is rejected by the inbound router for native-context containers, so every
 * later topic message would be dropped while /new reported success.
 *
 * Runs the production `/new`, pair-detection and routing-deps functions from
 * src/index.ts against a real SQLite DB and the real channel-mount / inbound
 * router modules (index.ts itself cannot be imported: it starts the server).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import * as channelMountService from '../src/channel-mount-service.js';
import { createChannelInboundRouter } from '../src/channel-inbound-routing.js';
import { isThreadMapCapableChat } from '../src/im-channel-capabilities.js';
import { getChannelType } from '../src/im-channel.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';
import type { ChannelMessageMeta, RegisteredGroup } from '../src/types.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'new-command-thread-map-'),
  );
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    STORE_DIR: path.join(paths.root, 'store'),
    GROUPS_DIR: path.join(paths.root, 'groups'),
    DATA_DIR: path.join(paths.root, 'data'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

const OWNER = 'owner-new-command';

function makeRuntime() {
  const registeredGroups: Record<string, RegisteredGroup> = {};
  const resolveOrCreateNativeThreadAgent = vi.fn(
    (
      sourceJid: string,
      workspaceJid: string,
      _workspace: RegisteredGroup,
      _group: RegisteredGroup,
      thread: { contextId: string },
    ) => ({
      effectiveJid: `${workspaceJid}#agent:thread-${thread.contextId}`,
      agentId: `thread-${thread.contextId}`,
      sourceJid,
    }),
  );
  const globals: Record<string, any> = {
    ...channelMountService,
    crypto,
    registeredGroups,
    isThreadMapCapableChat,
    getChannelType,
    getRegisteredGroup: db.getRegisteredGroup,
    setRegisteredGroup: db.setRegisteredGroup,
    getJidsByFolder: db.getJidsByFolder,
    getChannelMount: db.getChannelMount,
    getAgent: db.getAgent,
    createAgent: db.createAgent,
    ensureChatExists: db.ensureChatExists,
    updateChatName: db.updateChatName,
    updateAgentLastImJid: db.updateAgentLastImJid,
    getUserById: db.getUserById,
    getSystemSettings: () => ({ adminHostOnlyMode: false }),
    isAdminHostOnlyEffective: () => false,
    canExecuteOnHost: () => false,
    isDockerAvailable: async () => true,
    // Workspace bootstrap (dirs, container policy) is outside this contract.
    registerGroup: (jid: string, group: RegisteredGroup) => {
      db.setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
    },
    ensureAgentDirectories: vi.fn(),
    broadcastAgentStatus: vi.fn(),
    resolveOrCreateNativeThreadAgent,
    imSendFailCounts: new Map(),
    imHealthCheckFailCounts: new Map(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'isAdminHostOnlyOwner',
    'resolveWorkspaceJid',
    'markThreadMapWorkspace',
    'resolveAutoImWorkspace',
    'createAutoImConversationAgent',
    'ensureNativeContextChannelMount',
    'channelInboundRoutingDeps',
    'handleNewCommand',
  ]) {
    harness.install(name);
  }
  const route = createChannelInboundRouter(globals.channelInboundRoutingDeps());
  return {
    registeredGroups,
    resolveOrCreateNativeThreadAgent,
    pairDetect: globals.ensureNativeContextChannelMount as (
      jid: string,
      group: RegisteredGroup,
    ) => RegisteredGroup | null,
    newCommand: globals.handleNewCommand as (
      jid: string,
      name: string,
    ) => Promise<string>,
    route,
  };
}

let runtime: ReturnType<typeof makeRuntime>;
beforeEach(() => {
  runtime = makeRuntime();
});

/** An authorized, paired chat with no target yet. */
function pairChat(jid: string, extra: Partial<RegisteredGroup> = {}) {
  const group: RegisteredGroup = {
    name: `chat ${jid}`,
    folder: `im-${crypto.randomUUID().slice(0, 8)}`,
    added_at: new Date().toISOString(),
    created_by: OWNER,
    ...extra,
  };
  db.setRegisteredGroup(jid, group);
  runtime.registeredGroups[jid] = group;
  return group;
}

function current(jid: string): RegisteredGroup {
  return db.getRegisteredGroup(jid)!;
}

const topicMessage = (threadId: string): ChannelMessageMeta => ({
  messageId: `msg-${threadId}`,
  threadId,
  nativeContextType: 'thread',
  text: 'hello from a forum topic',
});

describe('/new in a native-context container', () => {
  test('Telegram Forum detected at /pair binds the new workspace as thread_map and routes topics', async () => {
    const chatJid = `telegram:-100${Date.now()}`;
    pairChat(chatJid);
    // /pair in a Forum: the first topic message detects the native context
    // before any workspace exists, so only the capability is persisted.
    expect(runtime.pairDetect(chatJid, current(chatJid))).toBeNull();
    expect(current(chatJid).native_context_type).toBe('thread');
    expect(runtime.route(chatJid, topicMessage('7'))).toBeNull();

    const reply = await runtime.newCommand(chatJid, 'Forum WS');
    expect(reply).toContain('工作区「Forum WS」已创建');

    const bound = current(chatJid);
    // A later topic message is routed into the new workspace, not dropped.
    const routed = runtime.route(chatJid, topicMessage('42'));
    expect(routed).toMatchObject({
      effectiveJid: `${bound.target_main_jid}#agent:thread-42`,
      agentId: 'thread-42',
    });
    expect(runtime.resolveOrCreateNativeThreadAgent).toHaveBeenCalledTimes(1);
    expect(bound.binding_mode).toBe('thread_map');
    expect(bound.target_agent_id ?? null).toBeNull();
    expect(bound.target_main_jid).toMatch(/^web:/);
    const workspace = db.getRegisteredGroup(bound.target_main_jid!)!;
    expect(workspace.name).toBe('Forum WS');
    // No auto-created session agent in the new workspace.
    expect(db.listAgentsByJid(bound.target_main_jid!)).toEqual([]);
  });

  test('control: an ordinary Telegram chat still session-binds and routes to that session', async () => {
    const chatJid = `telegram:${Date.now()}`;
    pairChat(chatJid);
    await runtime.newCommand(chatJid, 'Plain WS');

    const bound = current(chatJid);
    expect(bound.target_agent_id).toBeTruthy();
    expect(bound.binding_mode).not.toBe('thread_map');
    const session = db.getAgent(bound.target_agent_id!)!;
    expect(session.kind).toBe('conversation');
    expect(db.getRegisteredGroup(session.chat_jid)!.name).toBe('Plain WS');
    expect(runtime.route(chatJid, { messageId: 'm1', text: 'hi' })).toEqual({
      effectiveJid: `${session.chat_jid}#agent:${session.id}`,
      agentId: session.id,
    });
  });

  test('control: a Feishu topic group is unchanged (thread_map)', async () => {
    const chatJid = `feishu:oc_topic_${Date.now()}`;
    pairChat(chatJid, { feishu_chat_mode: 'topic' });
    await runtime.newCommand(chatJid, 'Feishu Topic WS');

    const bound = current(chatJid);
    expect(bound.binding_mode).toBe('thread_map');
    expect(bound.target_agent_id ?? null).toBeNull();
    expect(db.listAgentsByJid(bound.target_main_jid!)).toEqual([]);
  });

  test('control: a Feishu p2p chat still session-binds even with a stray native_context_type', async () => {
    const chatJid = `feishu:oc_p2p_${Date.now()}`;
    pairChat(chatJid, {
      feishu_chat_mode: 'p2p',
      native_context_type: 'thread',
    } as Partial<RegisteredGroup>);
    await runtime.newCommand(chatJid, 'Feishu P2P WS');

    const bound = current(chatJid);
    expect(bound.target_agent_id).toBeTruthy();
    expect(bound.binding_mode).not.toBe('thread_map');
    expect(db.getAgent(bound.target_agent_id!)!.kind).toBe('conversation');
  });
});
