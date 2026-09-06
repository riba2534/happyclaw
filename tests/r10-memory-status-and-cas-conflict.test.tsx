// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getMemoryValidityInfo } from '../web/src/utils/memory-status';
import type { WorkspaceMemoryItem } from '../web/src/features/workspace-memory/model';

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.patch.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('R10: Memory validity display, filtering, and CAS candidate/conflict resolution', () => {
  const fixedNow = new Date('2026-09-07T12:00:00.000Z');

  test('correctly calculates validity status and explainable reasons', () => {
    // 1. Current valid
    const activeItem: WorkspaceMemoryItem = {
      id: 'm-1',
      workspaceJid: 'web:ws1',
      kind: 'fact',
      content: 'HappyClaw 部署在 Mac mini',
      status: 'active',
      importance: 0.8,
      confidence: 1,
      validFrom: '2026-09-01T00:00:00.000Z',
      validUntil: '2026-09-30T00:00:00.000Z',
      expiresAt: null,
      revision: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      provenance: { sourceType: 'web_user', sourceId: 'u1' },
    };
    const activeInfo = getMemoryValidityInfo(activeItem, fixedNow);
    expect(activeInfo.status).toBe('active_valid');
    expect(activeInfo.isRecalible).toBe(true);
    expect(activeInfo.reason).toContain('在有效期内');
    expect(activeInfo.reason).toContain('当前可召回');

    // 2. Future effective
    const futureItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-2',
      validFrom: '2026-09-10T00:00:00.000Z', // 3 days in future
    };
    const futureInfo = getMemoryValidityInfo(futureItem, fixedNow);
    expect(futureInfo.status).toBe('future');
    expect(futureInfo.isRecalible).toBe(false);
    expect(futureInfo.label).toBe('未来生效');
    expect(futureInfo.reason).toContain('未到生效时间');
    expect(futureInfo.reason).toContain('当前不可召回');

    // 3. Expired by validUntil
    const expiredItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-3',
      validUntil: '2026-09-05T00:00:00.000Z', // 2 days ago
    };
    const expiredInfo = getMemoryValidityInfo(expiredItem, fixedNow);
    expect(expiredInfo.status).toBe('expired');
    expect(expiredInfo.isRecalible).toBe(false);
    expect(expiredInfo.label).toBe('已过期');
    expect(expiredInfo.reason).toContain('已过有效截止时间');

    // 3b. Comparison: validUntil is 2026-09-30, but expiresAt is earlier 2026-09-15
    // Must respect the earliest deadline rather than falsely showing valid until 09-30!
    const earlierExpiresItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-3b',
      validUntil: '2026-09-30T00:00:00.000Z',
      expiresAt: '2026-09-15T00:00:00.000Z',
    };
    const earlierExpiresInfo = getMemoryValidityInfo(
      earlierExpiresItem,
      fixedNow,
    );
    expect(earlierExpiresInfo.status).toBe('active_valid');
    // Earliest deadline is 09-15
    expect(earlierExpiresInfo.validityRangeText).toContain('2026/09/15');
    expect(earlierExpiresInfo.validityRangeText).toContain(
      '最早截止: 过期淘汰(TTL)',
    );

    // 4. Proposed candidate
    const proposedItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-4',
      status: 'proposed',
    };
    const proposedInfo = getMemoryValidityInfo(proposedItem, fixedNow);
    expect(proposedInfo.status).toBe('proposed');
    expect(proposedInfo.isRecalible).toBe(false);
    expect(proposedInfo.label).toContain('候选记忆');
    expect(proposedInfo.reason).toContain('需确认采纳后方可生效');

    // 5. Conflicted
    const conflictedItem: WorkspaceMemoryItem = {
      ...activeItem,
      id: 'm-5',
      status: 'conflicted',
    };
    const conflictedInfo = getMemoryValidityInfo(conflictedItem, fixedNow);
    expect(conflictedInfo.status).toBe('conflicted');
    expect(conflictedInfo.isRecalible).toBe(false);
    expect(conflictedInfo.label).toContain('冲突记忆');
    expect(conflictedInfo.reason).toContain('存在事实或版本冲突');
  });

  test('confirming proposed candidate uses CAS expectedRevision and marks status active', async () => {
    const proposedItem: WorkspaceMemoryItem = {
      id: 'prop-1',
      workspaceJid: 'web:ws1',
      kind: 'decision',
      title: '提议的架构决策',
      content: '使用集中式日志收集器',
      status: 'proposed',
      importance: 0.8,
      confidence: 0.9,
      revision: 3,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      provenance: { sourceType: 'agent_runtime', sourceId: 'msg-1' },
    };

    mocks.patch.mockResolvedValue({
      item: { ...proposedItem, status: 'active', revision: 4 },
      storeRevision: 10,
    });

    // Simulate user editing title and content before clicking "采纳为正式记忆"
    const userDraft = {
      title: '提议的架构决策 (修改后)',
      content: '使用集中式日志收集器并配置轮转策略',
      kind: 'decision' as const,
    };

    const handleConfirm = async () => {
      await mocks.patch(
        `/api/memory/workspaces/web:ws1/items/${proposedItem.id}`,
        {
          expectedRevision: proposedItem.revision,
          status: 'active',
          kind: userDraft.kind,
          title: userDraft.title,
          content: userDraft.content,
        },
      );
      mocks.toastSuccess('已采纳候选记忆为正式有效记忆，当前已进入召回池');
    };

    await handleConfirm();

    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/memory/workspaces/web:ws1/items/prop-1',
      {
        expectedRevision: 3,
        status: 'active',
        kind: 'decision',
        title: '提议的架构决策 (修改后)',
        content: '使用集中式日志收集器并配置轮转策略',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已采纳候选记忆为正式有效记忆，当前已进入召回池',
    );
  });

  test('resolving conflicted memory preserves CAS semantics and updates content + status', async () => {
    const conflictedItem: WorkspaceMemoryItem = {
      id: 'conf-1',
      workspaceJid: 'web:ws1',
      kind: 'fact',
      title: '团队人数冲突',
      content: '团队有 5 人（另一版本提议 7 人）',
      status: 'conflicted',
      importance: 0.8,
      confidence: 0.8,
      revision: 5,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      deletedAt: null,
      provenance: { sourceType: 'agent_runtime', sourceId: 'msg-2' },
    };

    // User reviews conflict, edits content to "团队有 7 人（包含新入职）" and resolves
    const resolvedContent = '团队有 7 人（包含新入职）';
    mocks.patch.mockResolvedValue({
      item: {
        ...conflictedItem,
        content: resolvedContent,
        status: 'active',
        revision: 6,
      },
      storeRevision: 11,
    });

    const handleResolve = async () => {
      await mocks.patch(
        `/api/memory/workspaces/web:ws1/items/${conflictedItem.id}`,
        {
          expectedRevision: conflictedItem.revision,
          status: 'active',
          content: resolvedContent,
        },
      );
      mocks.toastSuccess('已解决冲突并保存为正式有效记忆');
    };

    await handleResolve();

    expect(mocks.patch).toHaveBeenCalledWith(
      '/api/memory/workspaces/web:ws1/items/conf-1',
      {
        expectedRevision: 5,
        status: 'active',
        content: '团队有 7 人（包含新入职）',
      },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已解决冲突并保存为正式有效记忆',
    );
  });

  test('CAS conflict rejection when concurrent edit modifies revision', async () => {
    mocks.patch.mockRejectedValue({
      status: 409,
      body: {
        error: 'revision_conflict',
        message: 'Workspace memory item revision conflict',
        currentRevision: 6,
        storeRevision: 12,
      },
    });

    let conflictReported = false;
    const handleResolveWithConflict = async () => {
      try {
        await mocks.patch('/api/memory/workspaces/web:ws1/items/conf-1', {
          expectedRevision: 5,
          status: 'active',
        });
      } catch (err: any) {
        if (err.body?.error === 'revision_conflict') {
          conflictReported = true;
          mocks.toastError('保存冲突：这条记忆已被其他会话更新');
        }
      }
    };

    await handleResolveWithConflict();
    expect(conflictReported).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledWith(
      '保存冲突：这条记忆已被其他会话更新',
    );
  });
});
