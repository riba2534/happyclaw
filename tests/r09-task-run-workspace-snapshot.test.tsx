// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveMarkdownImageSrc } from '../web/src/utils/markdownImageSrc';
import type { ScheduledTask, TaskRunLog } from '../web/src/stores/tasks';

const testTask: ScheduledTask = {
  id: 'task-100',
  prompt: '每日运营数据汇总',
  schedule_type: 'cron',
  schedule_value: '0 9 * * *',
  status: 'active',
  created_at: '2026-09-01T00:00:00Z',
  next_run: '2026-09-08T09:00:00Z',
  group_folder: 'ws-b-folder',
  chat_jid: 'web:workspace-b',
  context_mode: 'group',
  execution_type: 'agent',
  execution_mode: 'container',
  can_restore: true,
  can_purge: true,
  execution_scope: 'workspace_container',
  risk_level: 'normal',
};

const runWithSnapshot: TaskRunLog = {
  id: 'run-with-snapshot',
  task_id: 'task-100',
  status: 'completed',
  duration_ms: 2500,
  started_at: '2026-09-05T09:00:00Z',
  result: '任务执行成功：\n\n![报表图](metrics.png)',
  definition_snapshot: {
    chat_jid: 'web:workspace-a',
    group_folder: 'ws-a-folder',
  },
};

const legacyRunWithoutSnapshot: TaskRunLog = {
  id: 'run-legacy',
  task_id: 'task-100',
  status: 'completed',
  duration_ms: 1800,
  started_at: '2026-09-02T09:00:00Z',
  result: '旧版本执行结果：\n\n![旧报表](old.png)',
  definition_snapshot: null,
};

vi.mock('../web/src/stores/tasks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../web/src/stores/tasks')>();
  return {
    ...actual,
    useTasksStore: (selector?: any) => {
      const state = {
        groupNames: {
          'web:workspace-a': '工作区 A (历史源)',
          'web:workspace-b': '工作区 B (当前位置)',
        },
        logs: {
          'task-100': [runWithSnapshot, legacyRunWithoutSnapshot],
        },
        loadLogs: vi.fn(),
        updateTask: vi.fn(),
      };
      return typeof selector === 'function' ? selector(state) : state;
    },
  };
});

vi.mock('../web/src/stores/groups', () => ({
  useGroupsStore: (selector?: any) => {
    const state = {
      groups: {
        'web:workspace-a': {
          jid: 'web:workspace-a',
          name: '工作区 A (历史源)',
        },
        'web:workspace-b': {
          jid: 'web:workspace-b',
          name: '工作区 B (当前位置)',
        },
      },
      loading: false,
      error: null,
      adminHostOnlyMode: false,
      loadGroups: vi.fn(),
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('../web/src/stores/auth', () => ({
  useAuthStore: (selector?: any) => {
    const state = {
      user: { id: 'admin-user', role: 'admin' },
    };
    return typeof selector === 'function' ? selector(state) : state;
  },
}));

vi.mock('../web/src/hooks/useConnectedChannels', () => ({
  useConnectedChannels: () => ({}),
}));

import { MemoryRouter } from 'react-router-dom';
import { TaskDetail } from '../web/src/components/tasks/TaskDetail';

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

    const resolvedUrlWithSnapshot = resolveMarkdownImageSrc(
      'metrics.png',
      snapshotChatJid,
    );
    expect(resolvedUrlWithSnapshot).toContain(
      encodeURIComponent('web:workspace-a'),
    );
    expect(resolvedUrlWithSnapshot).not.toContain(
      encodeURIComponent('web:workspace-b'),
    );

    const resolvedUrlFallback = resolveMarkdownImageSrc(
      'old.png',
      taskCurrentChatJid,
    );
    expect(resolvedUrlFallback).toContain(
      encodeURIComponent('web:workspace-b'),
    );
  });

  test('real TaskDetail dialog uses snapshot chat_jid for image src and shows historical attribution with migration note', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter>
          <TaskDetail task={testTask} />
        </MemoryRouter>,
      );
    });

    // Find and click the "查看完整结果" button for run-with-snapshot
    const resultButtons = Array.from(
      document.body.querySelectorAll('button[title="查看完整结果"]'),
    ) as HTMLButtonElement[];
    expect(resultButtons.length).toBeGreaterThan(0);
    const runSnapshotBtn = resultButtons[0];
    expect(runSnapshotBtn).toBeTruthy();

    await act(async () => {
      runSnapshotBtn.click();
    });

    // Verify dialog opened with accurate historical workspace attribution in real DOM
    expect(document.body.textContent).toContain(
      '运行工作区：工作区 A (历史源)',
    );
    expect(document.body.textContent).toContain(
      '（当前任务已位于：工作区 B (当前位置)）',
    );

    // Verify relative markdown image is resolved using snapshot workspace A
    const img = document.body.querySelector('img[alt="报表图"]');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toContain(
      '/api/groups/web%3Aworkspace-a/files/download/',
    );
    expect(img?.getAttribute('src')).not.toContain('web%3Aworkspace-b');
  });

  test('real TaskDetail dialog displays clear fallback banner and resolves to current workspace for legacy runs without snapshot', async () => {
    await act(async () => {
      root?.render(
        <MemoryRouter>
          <TaskDetail task={testTask} />
        </MemoryRouter>,
      );
    });

    // Click legacy run row's "查看完整结果" button
    const resultButtons = Array.from(
      document.body.querySelectorAll('button[title="查看完整结果"]'),
    ) as HTMLButtonElement[];
    expect(resultButtons.length).toBeGreaterThan(1);
    const legacyBtn = resultButtons[1];
    expect(legacyBtn).toBeTruthy();

    await act(async () => {
      legacyBtn.click();
    });

    // Verify clear fallback warning note rendered in real DOM
    const fallbackNote = document.body.querySelector('[role="note"]');
    expect(fallbackNote).toBeTruthy();
    expect(fallbackNote?.textContent).toContain('历史运行记录未包含工作区快照');
    expect(fallbackNote?.textContent).toContain('工作区 B (当前位置)');

    // Verify header indicates fallback
    expect(document.body.textContent).toContain(
      '（未记录快照，回退当前工作区）',
    );

    // Image must fallback to task current workspace B
    const img = document.body.querySelector('img[alt="旧报表"]');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toContain(
      '/api/groups/web%3Aworkspace-b/files/download/',
    );
  });
});
