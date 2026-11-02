import { describe, expect, test, vi } from 'vitest';
import {
  createChannelInboundRouter,
  hasExplicitChannelBinding,
  type ChannelInboundRoutingDeps,
} from '../src/channel-inbound-routing.js';
import { buildNativeThreadRouteJid } from '../src/channel-native-context.js';
import { normalizeChannelBindingPolicy } from '../src/channel-mount-service.js';
import type { RegisteredGroup, SubAgent } from '../src/types.js';

function fixture() {
  const workspace: RegisteredGroup = {
    name: 'Workspace',
    folder: 'workspace',
    created_by: 'owner',
    added_at: '2026-09-06',
  };
  const groups = new Map<string, RegisteredGroup>([
    ['web:workspace', workspace],
  ]);
  const sessions = new Map<string, SubAgent>();
  const topics = new Map<string, string>();
  const createTopic = vi.fn((jid, workspaceJid, _workspace, _group, thread) => {
    const key = `${jid}:${thread.contextId}`;
    if (!topics.has(key)) topics.set(key, `session-${topics.size + 1}`);
    const agentId = topics.get(key)!;
    return {
      effectiveJid: `${workspaceJid}#agent:${agentId}`,
      agentId,
      sourceJid: buildNativeThreadRouteJid(
        jid,
        thread.contextId,
        thread.rootMessageId,
      ),
    };
  });
  const upgrade = vi.fn((jid, group) => {
    const updated = normalizeChannelBindingPolicy(jid, group);
    groups.set(jid, updated);
    return updated;
  });
  const deps: ChannelInboundRoutingDeps = {
    getRegisteredGroup: (jid) => groups.get(jid),
    getAgent: (id) => sessions.get(id),
    resolveWorkspaceJid: (jid) => (groups.has(jid) ? jid : null),
    getChannelMount: () => undefined,
    ensureNativeContextChannelMount: upgrade,
    resolveOrCreateNativeThreadAgent: createTopic,
  };
  const bind = (jid: string, fields: Partial<RegisteredGroup>) => {
    const group = { ...workspace, ...fields };
    groups.set(jid, group);
    return group;
  };
  return {
    deps,
    groups,
    sessions,
    topics,
    upgrade,
    createTopic,
    bind,
    route: createChannelInboundRouter(deps),
  };
}

const topicMessage = (contextId: string) => ({
  provider: 'feishu' as const,
  chatType: 'group' as const,
  nativeContextType: 'thread' as const,
  contextId,
  threadId: contextId,
  rootId: `root-${contextId}`,
  messageId: `message-${contextId}`,
});

describe('explicit channel binding routes', () => {
  test('default folder and account ownership do not authorize an unbound channel', () => {
    const f = fixture();
    f.bind('feishu:unbound', {
      feishu_chat_mode: 'topic',
      channel_account_id: 'bot-a',
    });
    expect(hasExplicitChannelBinding('feishu:unbound', f.deps)).toBe(false);
    expect(f.route('feishu:unbound', topicMessage('a'))).toBeNull();
    expect(f.upgrade).not.toHaveBeenCalled();
    expect(f.createTopic).not.toHaveBeenCalled();
  });

  test.each([
    ['p2p', 'single_context'],
    ['group', 'single_context'],
    ['group', 'thread_map'],
  ] as const)(
    'a %s bound to a workspace (%s) routes nowhere, never to the workspace',
    (mode, bindingMode) => {
      const f = fixture();
      f.bind('feishu:chat', {
        feishu_chat_mode: mode,
        target_main_jid: 'web:workspace',
        binding_mode: bindingMode,
        native_context_type: 'thread',
        activation_mode: 'when_mentioned',
      });
      expect(hasExplicitChannelBinding('feishu:chat', f.deps)).toBe(false);
      expect(f.route('feishu:chat', topicMessage('ordinary-reply'))).toBeNull();
      expect(f.route('feishu:chat')).toBeNull();
      expect(f.createTopic).not.toHaveBeenCalled();
      expect(f.upgrade).not.toHaveBeenCalled();
    },
  );

  test('a single-session mount without its session routes nowhere', () => {
    const f = fixture();
    f.bind('feishu:chat', { feishu_chat_mode: 'group' });
    f.sessions.set('chosen', {
      id: 'chosen',
      chat_jid: 'web:workspace',
      kind: 'conversation',
    } as SubAgent);
    f.groups.set('feishu:chat', {
      ...f.groups.get('feishu:chat')!,
      target_agent_id: 'chosen',
    });
    const route = createChannelInboundRouter({
      ...f.deps,
      getChannelMount: () => ({
        channel_jid: 'feishu:chat',
        channel_account_id: null,
        channel_type: 'feishu',
        workspace_jid: 'web:workspace',
        session_id: null,
        routing_mode: 'single_session',
        reply_policy: 'source_only',
        activation_mode: 'auto',
        audience_mode: 'everyone',
        owner_im_id: null,
        interaction_mode_override: null,
        created_at: '2026-09-06',
        updated_at: '2026-09-06',
      }),
    });
    expect(route('feishu:chat')).toBeNull();
  });

  test('a fixed conversation session remains selected and its deletion closes the route', () => {
    const f = fixture();
    f.sessions.set('chosen', {
      id: 'chosen',
      chat_jid: 'web:workspace',
      kind: 'conversation',
    } as SubAgent);
    f.bind('feishu:ordinary', {
      feishu_chat_mode: 'group',
      target_agent_id: 'chosen',
    });
    expect(f.route('feishu:ordinary', topicMessage('quoted'))).toEqual({
      effectiveJid: 'web:workspace#agent:chosen',
      agentId: 'chosen',
    });
    f.sessions.delete('chosen');
    expect(f.route('feishu:ordinary', topicMessage('quoted'))).toBeNull();
    expect(f.createTopic).not.toHaveBeenCalled();
  });

  test.each([
    { feishu_chat_mode: 'topic' },
    { feishu_chat_mode: 'group', feishu_group_message_type: 'thread' },
  ])(
    'only a native topic workspace allocates one session per topic (%j)',
    (metadata) => {
      const f = fixture();
      f.bind('feishu:topics#account:bot-a', {
        ...metadata,
        target_main_jid: 'web:workspace',
      });
      const first = f.route('feishu:topics#account:bot-a', topicMessage('a'));
      expect(f.route('feishu:topics#account:bot-a', topicMessage('a'))).toEqual(
        first,
      );
      const second = f.route('feishu:topics#account:bot-a', topicMessage('b'));
      expect(second?.agentId).not.toBe(first?.agentId);
      expect(first?.sourceJid).toBe(
        'feishu:topics#account:bot-a#thread:a#root:root-a',
      );
      expect(second?.sourceJid).toBe(
        'feishu:topics#account:bot-a#thread:b#root:root-b',
      );
      expect(f.topics.size).toBe(2);
      expect(f.route('feishu:topics#account:bot-a')).toBeNull();
      f.bind('feishu:topics#account:bot-a', metadata);
      expect(
        f.route('feishu:topics#account:bot-a', topicMessage('a')),
      ).toBeNull();
      expect(f.topics.size).toBe(2);
    },
  );

  test('rejects cross-user targets and a topic group incorrectly bound to a fixed session', () => {
    const f = fixture();
    f.bind('web:foreign', { created_by: 'other' });
    f.bind('feishu:cross-user', {
      feishu_chat_mode: 'p2p',
      target_main_jid: 'web:foreign',
    });
    f.sessions.set('chosen', {
      id: 'chosen',
      chat_jid: 'web:workspace',
      kind: 'conversation',
    } as SubAgent);
    f.bind('feishu:invalid-topic', {
      feishu_chat_mode: 'topic',
      target_agent_id: 'chosen',
    });
    expect(f.route('feishu:cross-user')).toBeNull();
    expect(f.route('feishu:invalid-topic', topicMessage('a'))).toBeNull();
    expect(f.createTopic).not.toHaveBeenCalled();
  });
});

describe('team mode routes', () => {
  const mount = {
    channel_jid: 'feishu:oc_team',
    channel_type: 'feishu',
    workspace_jid: 'web:workspace',
    session_id: 'bound',
    routing_mode: 'single_session' as const,
    reply_policy: 'source_only' as const,
    activation_mode: 'when_mentioned' as const,
    audience_mode: 'everyone' as const,
    created_at: '2026-11-01',
    updated_at: '2026-11-01',
  };
  const message = {
    provider: 'feishu' as const,
    chatType: 'group' as const,
    messageId: 'om_1',
  };

  function teamFixture(
    teamRoute: ChannelInboundRoutingDeps['resolveTeamRoute'],
  ) {
    const f = fixture();
    f.sessions.set('bound', {
      id: 'bound',
      chat_jid: 'web:workspace',
      kind: 'conversation',
    } as SubAgent);
    f.bind('feishu:oc_team', {
      feishu_chat_mode: 'group',
      target_agent_id: 'bound',
    });
    return createChannelInboundRouter({
      ...f.deps,
      getChannelMount: (jid) => (jid === mount.channel_jid ? mount : undefined),
      resolveTeamRoute: teamRoute,
    });
  }

  test('the lane the team decision chose wins over the bound session', () => {
    const resolveTeamRoute = vi.fn(() => ({
      effectiveJid: 'web:workspace#agent:router-1',
      agentId: 'router-1',
    }));
    expect(teamFixture(resolveTeamRoute)('feishu:oc_team', message)).toEqual({
      effectiveJid: 'web:workspace#agent:router-1',
      agentId: 'router-1',
    });
    expect(resolveTeamRoute).toHaveBeenCalledWith('feishu:oc_team', message);
  });

  test('a message no team lane takes is dropped, not given to the bound session', () => {
    expect(teamFixture(() => 'reject')('feishu:oc_team', message)).toBeNull();
  });

  test('without team mode the group reaches the session it is bound to', () => {
    for (const teamRoute of [() => null, undefined]) {
      expect(teamFixture(teamRoute)('feishu:oc_team', message)).toEqual({
        effectiveJid: 'web:workspace#agent:bound',
        agentId: 'bound',
      });
    }
  });
});
