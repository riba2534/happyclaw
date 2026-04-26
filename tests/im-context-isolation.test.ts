import { describe, expect, test, vi } from 'vitest';

import {
  applyAutoIsolateContextForGroups,
  getUserContextIsolationConfig,
} from '../src/im-context-isolation.js';
import type { RegisteredGroup, SubAgent } from '../src/types.js';

function makeGroup(
  name: string,
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name,
    folder: 'home-u1',
    added_at: '2026-04-26T00:00:00.000Z',
    created_by: 'u1',
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id,
    group_folder: 'home-u1',
    chat_jid: 'web:home-u1',
    name: `Agent ${id}`,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'u1',
    created_at: '2026-04-26T00:00:00.000Z',
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    source_kind: 'auto_im',
    ...overrides,
  };
}

describe('getUserContextIsolationConfig', () => {
  test('only enables the current auto isolation toggle for Feishu', () => {
    const deps = {
      getUserFeishuConfig: vi.fn(() => ({ autoIsolateContext: true })),
    };

    expect(getUserContextIsolationConfig('u1', 'feishu', deps)).toEqual({
      enabled: true,
      sourceKind: 'auto_im',
    });
    expect(getUserContextIsolationConfig('u1', 'telegram', deps)).toEqual({
      enabled: false,
      sourceKind: 'auto_im',
    });
  });
});

describe('applyAutoIsolateContextForGroups', () => {
  test('enable and disable are idempotent, and disable deletes only auto_im agents', () => {
    const groups: Record<string, RegisteredGroup> = {
      'feishu:p2p-1': makeGroup('飞书私聊'),
      'feishu:manual': makeGroup('Manual', { target_agent_id: 'manual-agent' }),
      'telegram:p2p-1': makeGroup('Telegram'),
    };
    const agents = new Map<string, SubAgent>([
      ['manual-agent', makeAgent('manual-agent', { source_kind: 'manual' })],
    ]);
    let nextAgent = 1;

    const ensureBinding = vi.fn((jid: string, group: RegisteredGroup) => {
      const agentId = `auto-${nextAgent++}`;
      group.target_agent_id = agentId;
      agents.set(agentId, makeAgent(agentId, { last_im_jid: jid }));
      groups[jid] = group;
      return true;
    });
    const setGroup = vi.fn((jid: string, group: RegisteredGroup) => {
      groups[jid] = group;
    });
    const deleteAgent = vi.fn((agentId: string) => {
      agents.delete(agentId);
    });
    const broadcastAgentRemoved = vi.fn();
    const deps = {
      groups,
      channelType: 'feishu',
      getChannelType: (jid: string) =>
        jid.startsWith('feishu:') ? 'feishu' : 'telegram',
      getAgent: (agentId: string) => agents.get(agentId),
      ensureBinding,
      setGroup,
      deleteAgent,
      broadcastAgentRemoved,
    };

    expect(applyAutoIsolateContextForGroups('u1', true, deps)).toBe(1);
    expect(applyAutoIsolateContextForGroups('u1', true, deps)).toBe(0);
    expect(ensureBinding).toHaveBeenCalledTimes(1);

    const autoAgentId = groups['feishu:p2p-1'].target_agent_id!;
    expect(autoAgentId).toBe('auto-1');

    expect(applyAutoIsolateContextForGroups('u1', false, deps)).toBe(1);
    expect(deleteAgent).toHaveBeenCalledWith(autoAgentId);
    expect(deleteAgent).not.toHaveBeenCalledWith('manual-agent');
    expect(broadcastAgentRemoved).toHaveBeenCalledWith(
      'web:home-u1',
      autoAgentId,
      'Agent auto-1',
    );
    expect(groups['feishu:p2p-1'].target_agent_id).toBeUndefined();
    expect(groups['feishu:manual'].target_agent_id).toBe('manual-agent');

    expect(applyAutoIsolateContextForGroups('u1', false, deps)).toBe(0);
    expect(deleteAgent).toHaveBeenCalledTimes(1);
  });
});
