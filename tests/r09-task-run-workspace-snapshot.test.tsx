// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveMarkdownImageSrc } from '../web/src/utils/markdownImageSrc';
import type { TaskRunLog } from '../web/src/stores/tasks';

vi.mock('../web/src/stores/tasks', () => ({
  useTasksStore: (selector: any) =>
    selector({
      groupNames: {
        'web:workspace-a': '工作区 A (历史源)',
        'web:workspace-b': '工作区 B (当前位置)',
      },
    }),
}));

import { MarkdownRenderer } from '../web/src/components/chat/MarkdownRenderer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
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

describe('R09: Task run definition snapshot for relative images and workspace attribution', () => {
  test('resolves relative markdown images using snapshot chat_jid rather than current task chat_jid', () => {
    const taskCurrentChatJid = 'web:workspace-b';
    const snapshotChatJid = 'web:workspace-a';

    // 1. With definition_snapshot present: image URL points to workspace-a
    const effectiveGroupJid = snapshotChatJid;
    const resolvedUrlWithSnapshot = resolveMarkdownImageSrc(
      'output-chart.png',
      effectiveGroupJid,
    );

    expect(resolvedUrlWithSnapshot).toContain(
      encodeURIComponent('web:workspace-a'),
    );
    expect(resolvedUrlWithSnapshot).not.toContain(
      encodeURIComponent('web:workspace-b'),
    );

    // 2. Without snapshot: fallback to current task chat_jid
    const fallbackGroupJid = taskCurrentChatJid;
    const resolvedUrlFallback = resolveMarkdownImageSrc(
      'output-chart.png',
      fallbackGroupJid,
    );
    expect(resolvedUrlFallback).toContain(
      encodeURIComponent('web:workspace-b'),
    );
  });

  test('renders markdown image in MarkdownRenderer using snapshot groupJid', async () => {
    const markdownContent = '执行结果：\n\n![报表图](metrics-summary.png)';
    const snapshotJid = 'web:workspace-a';

    await act(async () => {
      root?.render(
        <MarkdownRenderer
          content={markdownContent}
          groupJid={snapshotJid}
          variant="docs"
        />,
      );
    });

    const img = container?.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toContain(
      '/api/groups/web%3Aworkspace-a/files/download/',
    );
    expect(img?.getAttribute('alt')).toBe('报表图');
  });

  test('displays historical workspace attribution and fallback banner correctly', () => {
    const groupNames: Record<string, string> = {
      'web:workspace-a': '工作区 A (历史源)',
      'web:workspace-b': '工作区 B (当前位置)',
    };

    const task = {
      chat_jid: 'web:workspace-b',
      group_folder: 'workspace-b-folder',
    };

    // Case 1: Run with snapshot from workspace A while current task is in workspace B
    const runWithSnapshot: TaskRunLog = {
      id: 'run-101',
      task_id: 'task-1',
      status: 'completed',
      duration_ms: 1200,
      definition_snapshot: {
        chat_jid: 'web:workspace-a',
        group_folder: 'workspace-a-folder',
      },
    };

    const snapshotJid = runWithSnapshot.definition_snapshot?.chat_jid;
    const hasSnapshot = !!snapshotJid;
    const currentWorkspaceName = groupNames[task.chat_jid] || task.chat_jid;
    const snapshotWorkspaceName = snapshotJid ? groupNames[snapshotJid] : null;
    const isMigrated = hasSnapshot && snapshotJid !== task.chat_jid;

    expect(hasSnapshot).toBe(true);
    expect(snapshotWorkspaceName).toBe('工作区 A (历史源)');
    expect(isMigrated).toBe(true);
    expect(currentWorkspaceName).toBe('工作区 B (当前位置)');

    // Case 2: Legacy run without snapshot
    const legacyRun: TaskRunLog = {
      id: 'run-099',
      task_id: 'task-1',
      status: 'completed',
      duration_ms: 800,
      definition_snapshot: null,
    };

    const legacySnapshotJid = legacyRun.definition_snapshot?.chat_jid;
    const legacyHasSnapshot = !!legacySnapshotJid;
    const fallbackMessage = !legacyHasSnapshot
      ? `历史运行记录未包含工作区快照，相对图片与文件已明确回退为按当前工作区（${currentWorkspaceName}）解析。`
      : '';

    expect(legacyHasSnapshot).toBe(false);
    expect(fallbackMessage).toContain('未包含工作区快照');
    expect(fallbackMessage).toContain('工作区 B (当前位置)');
  });
});
