import { describe, expect, test } from 'vitest';

import type { WorkItemView } from '../work-items';
import {
  lastPersonMessageAt,
  normalizeWorkMode,
  sessionDelegations,
} from './multitask';
import { workItemSource, workStageLabel, workStageVariant } from './team-mode';

function item(overrides: Partial<WorkItemView>): WorkItemView {
  return {
    id: 'wi',
    seq: 1,
    title: '整理接口文档',
    origin: 'delegated',
    originAgentId: 'main',
    originSessionName: '主会话',
    channelName: null,
    status: 'open',
    outcome: null,
    stage: 'working',
    attention: null,
    lastSummary: null,
    updatedAt: '2026-11-01T02:00:00.000Z',
    endedAt: null,
    ...overrides,
  } as WorkItemView;
}

const ended = (outcome: WorkItemView['outcome'], endedAt: string) =>
  item({ status: 'ended', stage: 'ended', outcome, endedAt });

describe('work mode', () => {
  test('anything but multi reads as the single-task default', () => {
    expect(normalizeWorkMode('multi')).toBe('multi');
    expect(normalizeWorkMode('single')).toBe('single');
    expect(normalizeWorkMode(undefined)).toBe('single');
    expect(normalizeWorkMode('parallel')).toBe('single');
  });
});

describe('a delegated task in five words', () => {
  test('each stage maps to running, asking, done, failed or stopped', () => {
    const label = (overrides: Partial<WorkItemView>) =>
      workStageLabel(item(overrides));
    expect(label({ stage: 'working' })).toBe('进行中');
    expect(label({ stage: 'idle' })).toBe('进行中');
    expect(label({ stage: 'approval' })).toBe('进行中');
    expect(label({ stage: 'answer', attention: '用哪个分支？' })).toBe(
      '等你回答',
    );
    expect(label({ stage: 'blocked' })).toBe('等你回答');
    expect(label({ stage: 'failed' })).toBe('失败');
    expect(
      ['completed', 'failed', 'stopped', 'dropped'].map((outcome) =>
        workStageLabel(
          ended(outcome as WorkItemView['outcome'], '2026-11-01T03:00:00Z'),
        ),
      ),
    ).toEqual(['已完成', '失败', '已停止', '已停止']);
    expect(workStageVariant(item({ stage: 'answer' }))).toBe('warning');
    expect(workStageVariant(item({ stage: 'blocked' }))).toBe('warning');
    expect(workStageVariant(item({ stage: 'working' }))).toBe('info');
    expect(workStageVariant(ended('completed', '2026-11-01T03:00:00Z'))).toBe(
      'success',
    );
  });

  test('a team item keeps its own words; the source follows the origin', () => {
    const team = (overrides: Partial<WorkItemView>) =>
      item({ origin: 'team', ...overrides });
    expect(workStageLabel(team({ stage: 'blocked' }))).toBe('受阻');
    expect(workStageVariant(team({ stage: 'blocked' }))).toBe('error');
    expect(workStageLabel(team({ stage: 'working' }))).toBe('工作中');
    // Items from before the origin existed read as team items.
    expect(workStageLabel(team({ origin: undefined, stage: 'idle' }))).toBe(
      '等待新消息',
    );
    expect(workItemSource(item({}))).toBe('主会话');
    expect(workItemSource(team({ channelName: '研发群' }))).toBe('研发群');
  });
});

describe('what a session shows', () => {
  const message = (
    timestamp: string,
    overrides: Partial<{
      sender: string;
      is_from_me: boolean;
      source_kind: string | null;
    }> = {},
  ) => ({ sender: 'user-1', is_from_me: false, timestamp, ...overrides });

  test('the person last wrote at their newest own message', () => {
    expect(lastPersonMessageAt([])).toBe(0);
    expect(
      lastPersonMessageAt([
        message('2026-11-01T01:00:00.000Z'),
        message('2026-11-01T02:00:00.000Z', { is_from_me: true }),
        message('2026-11-01T03:00:00.000Z', { sender: '__system__' }),
        message('2026-11-01T04:00:00.000Z', {
          sender: 'happyclaw-team',
          source_kind: 'work_item_input',
        }),
        message('2026-11-01T05:00:00.000Z', {
          source_kind: 'automation_prompt',
        }),
      ]),
    ).toBe(Date.parse('2026-11-01T01:00:00.000Z'));
  });

  test('open tasks stay; ended ones until the person writes again', () => {
    const wrote = Date.parse('2026-11-01T04:00:00.000Z');
    const items = [
      item({ id: 'open', seq: 3 }),
      {
        ...ended('completed', '2026-11-01T05:00:00.000Z'),
        id: 'fresh',
        seq: 2,
      },
      { ...ended('stopped', '2026-11-01T03:00:00.000Z'), id: 'seen', seq: 1 },
      item({ id: 'other-session', seq: 4, originAgentId: 'other' }),
      item({ id: 'team', seq: 5, origin: 'team', originAgentId: null }),
    ];
    expect(
      sessionDelegations(items, 'main', wrote).map((shown) => shown.id),
    ).toEqual(['fresh', 'open']);
    expect(
      sessionDelegations(items, 'main', 0).map((shown) => shown.id),
    ).toEqual(['seen', 'fresh', 'open']);
  });
});
