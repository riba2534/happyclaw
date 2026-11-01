import { describe, expect, test } from 'vitest';

import {
  buildDetachedWorkspaceUpdate,
  buildNativeThreadWorkspaceUpdate,
  buildSessionMountUpdate,
  normalizeChannelBindingPolicy,
  buildWorkspaceMountUpdate,
  hasRemainingThreadMapMount,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  matchesWorkspaceMount,
  resolveChannelMountTarget,
  isNativeContextContainer,
} from '../src/channel-mount-service.js';
import {
  IM_CHANNEL_CAPABILITIES,
  isThreadMapCapableChat,
} from '../src/im-channel-capabilities.js';
import type { RegisteredGroup, SubAgent } from '../src/types.js';

function makeWorkspace(name: string, folder: string): RegisteredGroup {
  return {
    name,
    folder,
    added_at: '2026-07-09T00:00:00.000Z',
  };
}

function makeSession(id: string, chatJid: string): SubAgent {
  return {
    id,
    group_folder: 'workspace-a',
    chat_jid: chatJid,
    name: `Session ${id}`,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'owner-a',
    created_at: '2026-07-09T00:00:00.000Z',
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  };
}

describe('resolveChannelMountTarget', () => {
  const workspaceA = (jid: string) =>
    jid === 'web:workspace-a'
      ? makeWorkspace('Workspace A', 'workspace-a')
      : undefined;

  test('resolves a session mount through the session owner workspace', () => {
    const result = resolveChannelMountTarget(
      {
        session_id: 'session-a',
        workspace_jid: 'web:workspace-a',
        routing_mode: 'single_session',
      },
      {
        getAgent: (id) =>
          id === 'session-a' ? makeSession(id, 'web:workspace-a') : undefined,
        getRegisteredGroup: workspaceA,
      },
    );

    expect(result).toMatchObject({
      status: 'session',
      effectiveJid: 'web:workspace-a#agent:session-a',
      workspaceJid: 'web:workspace-a',
      agentId: 'session-a',
    });
  });

  test('does not fall back when a session mount points at a missing session', () => {
    const result = resolveChannelMountTarget(
      {
        session_id: 'missing-session',
        workspace_jid: 'web:workspace-a',
        routing_mode: 'single_session',
      },
      { getAgent: () => undefined, getRegisteredGroup: workspaceA },
    );

    expect(result).toEqual({
      status: 'stale',
      reason: 'missing_session',
      sessionId: 'missing-session',
      workspaceJid: 'web:workspace-a',
    });
  });

  test('a single-session mount without its session reaches nothing, never the workspace', () => {
    const result = resolveChannelMountTarget(
      {
        session_id: null,
        workspace_jid: 'web:workspace-a',
        routing_mode: 'single_session',
      },
      { getAgent: () => undefined, getRegisteredGroup: workspaceA },
    );

    expect(result).toEqual({
      status: 'stale',
      reason: 'missing_session',
      workspaceJid: 'web:workspace-a',
    });
  });

  test('a thread-map mount targets its workspace', () => {
    const result = resolveChannelMountTarget(
      {
        session_id: null,
        workspace_jid: 'web:workspace-a',
        routing_mode: 'thread_map',
      },
      { getAgent: () => undefined, getRegisteredGroup: workspaceA },
    );

    expect(result).toMatchObject({
      status: 'thread_map',
      workspaceJid: 'web:workspace-a',
    });
  });

  test('uses the session owner workspace when stored workspace_jid is stale', () => {
    const result = resolveChannelMountTarget(
      {
        session_id: 'session-a',
        workspace_jid: 'web:old-workspace',
        routing_mode: 'single_session',
      },
      {
        getAgent: (id) =>
          id === 'session-a' ? makeSession(id, 'web:workspace-a') : undefined,
        getRegisteredGroup: workspaceA,
      },
    );

    expect(result).toMatchObject({
      status: 'session',
      effectiveJid: 'web:workspace-a#agent:session-a',
      workspaceJid: 'web:workspace-a',
      agentId: 'session-a',
      workspaceMismatch: {
        storedWorkspaceJid: 'web:old-workspace',
        actualWorkspaceJid: 'web:workspace-a',
      },
    });
  });

  test('does not fall back when a workspace mount points at a missing workspace', () => {
    const result = resolveChannelMountTarget(
      {
        session_id: null,
        workspace_jid: 'web:missing-workspace',
        routing_mode: 'thread_map',
      },
      {
        getAgent: () => undefined,
        getRegisteredGroup: () => undefined,
      },
    );

    expect(result).toEqual({
      status: 'stale',
      reason: 'missing_workspace',
      workspaceJid: 'web:missing-workspace',
    });
  });
});

describe('channel binding product contract', () => {
  test('only native-topic providers expose workspace binding capability', () => {
    expect(
      Object.values(IM_CHANNEL_CAPABILITIES)
        .filter((capability) => capability.can_bind_workspace)
        .map((capability) => capability.channel_type)
        .sort(),
    ).toEqual(['feishu', 'telegram']);
  });

  test('only transports with a real inbound gate advertise activation modes', () => {
    expect(IM_CHANNEL_CAPABILITIES.telegram.supports_activation_modes).toBe(
      false,
    );
    expect(IM_CHANNEL_CAPABILITIES.qq.supports_activation_modes).toBe(false);
    expect(IM_CHANNEL_CAPABILITIES.wechat.supports_activation_modes).toBe(
      false,
    );
    for (const provider of ['feishu', 'dingtalk', 'discord', 'whatsapp']) {
      expect(IM_CHANNEL_CAPABILITIES[provider].supports_activation_modes).toBe(
        true,
      );
    }
  });

  test('Feishu topics and Telegram Forums qualify for native thread mapping', () => {
    expect(
      isThreadMapCapableChat({ channel_type: 'feishu', chat_mode: 'topic' }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({
        channel_type: 'feishu',
        chat_mode: 'group',
        group_message_type: 'thread',
      }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({ channel_type: 'feishu', chat_mode: 'group' }),
    ).toBe(false);
    expect(
      isThreadMapCapableChat({
        channel_type: 'telegram',
        native_context_type: 'thread',
      }),
    ).toBe(true);
    expect(
      isNativeContextContainer('telegram:group-1', {
        ...makeWorkspace('Forum', 'forum'),
        native_context_type: 'thread',
      }),
    ).toBe(true);
    expect(
      isNativeContextContainer('feishu:topic-group', {
        ...makeWorkspace('Feishu topic', 'feishu-topic'),
        feishu_chat_mode: 'group',
        feishu_group_message_type: 'thread',
        activation_mode: 'always',
      }),
    ).toBe(true);
    expect(
      isThreadMapCapableChat({
        channel_type: 'qq',
        native_context_type: 'thread',
      }),
    ).toBe(false);
  });

  test('Feishu ordinary groups never use thread mapping for mention activation', () => {
    const ordinary: RegisteredGroup = {
      ...makeWorkspace('Ordinary group', 'ordinary'),
      feishu_chat_mode: 'group',
      native_context_type: 'thread',
      activation_mode: 'always',
    };
    expect(isNativeContextContainer('feishu:ordinary', ordinary)).toBe(false);
    expect(
      isNativeContextContainer('feishu:ordinary', {
        ...ordinary,
        activation_mode: 'when_mentioned',
      }),
    ).toBe(false);
    expect(
      isNativeContextContainer('feishu:ordinary', {
        ...ordinary,
        activation_mode: 'auto',
        require_mention: true,
      }),
    ).toBe(false);
    expect(
      isNativeContextContainer('feishu:direct', {
        ...ordinary,
        feishu_chat_mode: 'p2p',
        activation_mode: 'when_mentioned',
      }),
    ).toBe(false);
  });

  test('workspace and session targets remain mutually exclusive', () => {
    const source: RegisteredGroup = {
      ...makeWorkspace('Channel', 'channel-a'),
      activation_mode: 'always',
      audience_mode: 'owner_only',
      owner_im_id: 'owner-im',
    };
    const sessionBound = buildSessionMountUpdate(
      { ...source, target_main_jid: 'web:old' },
      'session-a',
    );
    expect(sessionBound.target_agent_id).toBe('session-a');
    expect(sessionBound.target_main_jid).toBeUndefined();
    expect(sessionBound).toMatchObject({
      activation_mode: 'always',
      audience_mode: 'owner_only',
      owner_im_id: 'owner-im',
    });

    const workspaceBound = buildWorkspaceMountUpdate(
      { ...source, target_agent_id: 'old-session' },
      'web:workspace-a',
      'thread_map',
    );
    expect(workspaceBound.target_agent_id).toBeUndefined();
    expect(workspaceBound.target_main_jid).toBe('web:workspace-a');
    expect(workspaceBound).toMatchObject({
      activation_mode: 'always',
      audience_mode: 'owner_only',
      owner_im_id: 'owner-im',
    });
  });

  test('centralizes target conflict and legacy workspace matching semantics', () => {
    const sessionBound = {
      ...makeWorkspace('Channel', 'channel-a'),
      target_agent_id: 'session-a',
    };
    expect(hasSessionMountConflict(sessionBound, 'session-a')).toBe(false);
    expect(hasSessionMountConflict(sessionBound, 'session-b')).toBe(true);

    const workspaceBound = {
      ...makeWorkspace('Topic', 'channel-b'),
      target_main_jid: 'web:workspace-folder',
      binding_mode: 'thread_map' as const,
    };
    expect(
      matchesWorkspaceMount(
        workspaceBound,
        'web:workspace-uuid',
        'web:workspace-folder',
      ),
    ).toBe(true);
    expect(
      hasWorkspaceMountConflict(
        workspaceBound,
        'web:workspace-uuid',
        'web:workspace-folder',
      ),
    ).toBe(false);
  });

  test('keeps native navigation until the final thread-map source leaves', () => {
    const workspace: RegisteredGroup = {
      ...makeWorkspace('Workspace', 'workspace-folder'),
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    };
    const groups: Record<string, RegisteredGroup> = {
      'web:workspace-uuid': workspace,
      'feishu:topic-a': {
        ...makeWorkspace('Topic A', 'source-a'),
        target_main_jid: 'web:workspace-folder',
        binding_mode: 'thread_map',
      },
      'telegram:forum-b': {
        ...makeWorkspace('Forum B', 'source-b'),
        target_main_jid: 'web:workspace-uuid',
        binding_mode: 'thread_map',
      },
    };
    const deps = {
      getAllGroups: () => groups,
      getGroup: (jid: string) => groups[jid],
      getJidsByFolder: (folder: string) =>
        Object.entries(groups)
          .filter(([, group]) => group.folder === folder)
          .map(([jid]) => jid),
    };

    delete groups['feishu:topic-a'];
    expect(
      hasRemainingThreadMapMount(
        'web:workspace-folder',
        'feishu:topic-a',
        deps,
      ),
    ).toBe(true);
    expect(groups['web:workspace-uuid']).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    delete groups['telegram:forum-b'];
    expect(
      hasRemainingThreadMapMount(
        'web:workspace-uuid',
        'telegram:forum-b',
        deps,
      ),
    ).toBe(false);
    groups['web:workspace-uuid'] = buildDetachedWorkspaceUpdate(workspace);
    expect(groups['web:workspace-uuid']).toMatchObject({
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
  });

  test('detaching a topic workspace preserves its data and only resets navigation', () => {
    const workspace: RegisteredGroup = {
      ...makeWorkspace('Workspace A', 'workspace-a'),
      conversation_source: 'feishu_thread',
      conversation_nav_mode: 'vertical_threads',
      skill_ids: ['skill-a'],
    };

    expect(buildDetachedWorkspaceUpdate(workspace)).toEqual({
      ...workspace,
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
  });

  test('marking a native thread workspace enables vertical navigation and preserves legacy Feishu source', () => {
    const manual = makeWorkspace('Workspace A', 'workspace-a');
    expect(buildNativeThreadWorkspaceUpdate(manual)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const legacyFeishu: RegisteredGroup = {
      ...manual,
      conversation_source: 'feishu_thread',
    };
    expect(buildNativeThreadWorkspaceUpdate(legacyFeishu)).toMatchObject({
      conversation_source: 'feishu_thread',
      conversation_nav_mode: 'vertical_threads',
    });
  });
});

describe('legacy binding policy reconciliation', () => {
  test('ordinary group mention flags become one session binding without changing the chosen session', () => {
    const group: RegisteredGroup = {
      ...makeWorkspace('Group', 'home'),
      target_agent_id: 'session-chosen',
      binding_mode: 'thread_map',
      feishu_chat_mode: 'group',
      feishu_group_message_type: 'chat',
      native_context_type: 'thread',
      activation_mode: 'when_mentioned',
      reply_policy: 'mirror',
    };
    const updated = normalizeChannelBindingPolicy('feishu:ordinary', group);
    expect(updated).toMatchObject({
      target_agent_id: 'session-chosen',
      binding_mode: 'single_context',
      native_context_type: 'none',
      activation_mode: 'when_mentioned',
      reply_policy: 'source_only',
    });
    expect(normalizeChannelBindingPolicy('feishu:ordinary', updated)).toBe(
      updated,
    );
    expect(group.binding_mode).toBe('thread_map');
  });
  test('a topic workspace keeps its destination and maps each topic, but an unbound topic stays unbound', () => {
    const group: RegisteredGroup = {
      ...makeWorkspace('Topics', 'home'),
      feishu_chat_mode: 'topic',
      target_main_jid: 'web:chosen',
      binding_mode: 'single_context',
    };
    expect(normalizeChannelBindingPolicy('feishu:topics', group)).toMatchObject(
      { target_main_jid: 'web:chosen', binding_mode: 'thread_map' },
    );
    const unbound = normalizeChannelBindingPolicy('feishu:topics', {
      ...group,
      target_main_jid: undefined,
    });
    expect(unbound.target_main_jid).toBeUndefined();
    expect(unbound.target_agent_id).toBeUndefined();
  });
  test('does not remount an incompatible topic session or erase its history target', () => {
    const group: RegisteredGroup = {
      ...makeWorkspace('Topics', 'home'),
      feishu_chat_mode: 'topic',
      target_agent_id: 'existing-session',
    };
    expect(
      normalizeChannelBindingPolicy('feishu:topics', group).target_agent_id,
    ).toBe('existing-session');
  });
});
