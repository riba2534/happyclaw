import { describe, expect, test } from 'vitest';

import type { AvailableImGroup } from '../types';
import type { WorkDecision, WorkItemView } from '../work-items';
import {
  buildWorkSections,
  firstWorkItem,
} from '../components/team/WorkItemList';
import {
  subscriptionLabel,
  teamModeWorkspaceOf,
  teamSettingsProblem,
  workPermissionText,
  workStageLabel,
  workStageText,
  workStageVariant,
} from './team-mode';

function item(overrides: Partial<WorkItemView>): WorkItemView {
  return {
    id: 'wi',
    seq: 1,
    title: '修复登录报错',
    status: 'open',
    outcome: null,
    stage: 'working',
    attention: null,
    approvedAt: null,
    updatedAt: '2026-11-01T00:00:00Z',
    endedAt: null,
    mandate: { writable: true },
    ...overrides,
  } as WorkItemView;
}

describe('stage words', () => {
  test('each stage says who it waits for and what for', () => {
    expect(
      workStageText(item({ stage: 'answer', attention: '用哪个分支？' })),
    ).toBe('等你回答：用哪个分支？');
    expect(workStageText(item({ stage: 'approval' }))).toBe('等你批准修改');
    expect(workStageLabel(item({ stage: 'blocked' }))).toBe('受阻');
    expect(workStageLabel(item({ stage: 'failed' }))).toBe('失败');
    expect(workStageLabel(item({ stage: 'working' }))).toBe('工作中');
    expect(workStageLabel(item({ stage: 'idle' }))).toBe('等待新消息');
    const ended = (outcome: WorkItemView['outcome']) =>
      workStageLabel(item({ stage: 'ended', status: 'ended', outcome }));
    expect(
      ['completed', 'dropped', 'stopped', 'failed'].map((o) =>
        ended(o as WorkItemView['outcome']),
      ),
    ).toEqual(['已完成', '无需处理', '已停止', '失败']);
    expect(
      workStageVariant(item({ stage: 'ended', outcome: 'completed' })),
    ).toBe('success');
    expect(workStageVariant(item({ stage: 'approval' }))).toBe('warning');
  });

  test('permission reads from the mandate and the approval', () => {
    expect(workPermissionText(item({}))).toBe('可以修改');
    const readOnly = { mandate: { writable: false } } as never;
    expect(workPermissionText(item(readOnly))).toBe('只读，批准后才能修改');
    expect(
      workPermissionText(item({ ...(readOnly as object), approvedAt: 'x' })),
    ).toBe('已批准修改');
  });

  test('subscription keys read as topics and replies', () => {
    expect(subscriptionLabel('thread:omt_1')).toBe('话题 omt_1');
    expect(subscriptionLabel('msg:om_1')).toBe('消息 om_1 的回复');
  });
});

describe('sections', () => {
  test('needs-me first, then working, then ended; decisions kept apart', () => {
    const items = [
      item({ id: 'w', stage: 'working', updatedAt: '2026-11-01T03:00:00Z' }),
      item({ id: 'a', stage: 'answer', updatedAt: '2026-11-01T01:00:00Z' }),
      item({ id: 'p', stage: 'approval', updatedAt: '2026-11-01T02:00:00Z' }),
      item({
        id: 'e',
        stage: 'ended',
        status: 'ended',
        endedAt: '2026-11-01T04:00:00Z',
      }),
    ];
    const decisions = [
      { id: 'd1', createdAt: '2026-11-01T00:00:00Z' },
      { id: 'd2', createdAt: '2026-11-02T00:00:00Z' },
    ] as WorkDecision[];
    const sections = buildWorkSections(items, decisions);
    expect(sections.needsMe.map((i) => i.id)).toEqual(['p', 'a']);
    expect(sections.working.map((i) => i.id)).toEqual(['w']);
    expect(sections.ended.map((i) => i.id)).toEqual(['e']);
    expect(sections.decisions.map((d) => d.id)).toEqual(['d2', 'd1']);
    expect(firstWorkItem(sections)?.id).toBe('p');
    expect(firstWorkItem(buildWorkSections([], []))).toBeNull();
  });
});

describe('settings', () => {
  const group = (overrides: Partial<AvailableImGroup>) =>
    ({
      jid: 'feishu:oc_1',
      channel_type: 'feishu',
      conversation_kind: 'group',
      bound_agent_id: 's1',
      bound_session_id: 's1',
      bound_main_jid: null,
      ...overrides,
    }) as AvailableImGroup;
  const workspaceOf = (sessionId: string) =>
    sessionId === 's1' ? 'web:alpha' : null;

  test('a Feishu ordinary group bound to a session offers team mode in its workspace', () => {
    expect(teamModeWorkspaceOf(group({}), workspaceOf)).toBe('web:alpha');
    // The session id the server names the binding by is the one that counts.
    expect(
      teamModeWorkspaceOf(
        group({ bound_agent_id: null, bound_session_id: 's1' }),
        workspaceOf,
      ),
    ).toBe('web:alpha');
    expect(
      teamModeWorkspaceOf(group({ conversation_kind: 'topic' }), workspaceOf),
    ).toBe(null);
    expect(
      teamModeWorkspaceOf(group({ channel_type: 'telegram' }), workspaceOf),
    ).toBe(null);
    // Not bound, or bound to a session whose workspace is unknown.
    expect(
      teamModeWorkspaceOf(
        group({ bound_agent_id: null, bound_session_id: null }),
        workspaceOf,
      ),
    ).toBe(null);
    expect(
      teamModeWorkspaceOf(
        group({ bound_agent_id: 's9', bound_session_id: 's9' }),
        workspaceOf,
      ),
    ).toBe(null);
    // A group mounted on a workspace alone is left from before: no team mode.
    expect(
      teamModeWorkspaceOf(
        group({
          bound_agent_id: null,
          bound_session_id: null,
          bound_main_jid: 'web:alpha',
        }),
        workspaceOf,
      ),
    ).toBe(null);
  });

  test('rules need a name and an instruction', () => {
    const draft = {
      enabled: true,
      admission: {
        listedUnaddressed: 'ignore',
        unlistedAddressed: 'ignore',
        unlistedUnaddressed: 'ignore',
      },
      acceptMode: 'observe',
      rules: [{ id: 'r', name: ' ', instruction: 'x', enabled: true }],
    } as const;
    expect(teamSettingsProblem(draft as never)).toBe('第 1 条规则缺少名称');
    expect(
      teamSettingsProblem({
        ...draft,
        rules: [{ id: 'r', name: '报错', instruction: '', enabled: true }],
      } as never),
    ).toBe('规则「报错」缺少说明');
    expect(teamSettingsProblem({ ...draft, rules: [] } as never)).toBeNull();
  });
});
