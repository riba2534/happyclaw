// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  get: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: { get: mocks.get },
  apiFetch: mocks.apiFetch,
}));

vi.mock('../../stores/chat', async () => {
  const { create } = await import('zustand');
  return {
    useChatStore: create(() => ({
      activeRuns: {} as Record<string, unknown>,
    })),
  };
});

const { useChatStore } = await import('../../stores/chat');
const { ReviewPanel } = await import('./ReviewPanel');
const { emulatePointer, flushHistory } =
  await import('@/components/ui/overlay-test-utils');
const { parseUnifiedDiff } = await import('./diff-lines');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const GROUP = 'web:ws';
const STATUS_URL = '/api/groups/web%3Aws/git/status';

const okStatus = (overrides: Record<string, unknown> = {}) => ({
  state: 'ok',
  root: '/repo',
  worktree: null,
  branch: 'feat/review',
  head: 'abcdef1234567890',
  upstream: 'origin/feat/review',
  ahead: 2,
  behind: 1,
  files: [
    {
      path: 'src/routes/git-review.ts',
      status: 'modified',
      index_status: '.',
      worktree_status: 'M',
      additions: 12,
      deletions: 3,
      binary: false,
    },
    {
      path: 'src/new-name.ts',
      orig_path: 'src/old-name.ts',
      status: 'renamed',
      index_status: 'R',
      worktree_status: '.',
      additions: 1,
      deletions: 1,
      binary: false,
    },
    {
      path: 'assets/logo.png',
      status: 'added',
      index_status: 'A',
      worktree_status: '.',
      additions: null,
      deletions: null,
      binary: true,
    },
    {
      path: 'big.log',
      status: 'untracked',
      index_status: '?',
      worktree_status: '?',
      additions: null,
      deletions: null,
      binary: false,
    },
  ],
  total_files: 4,
  truncated: false,
  ...overrides,
});

const RENAME_DIFF = [
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 90%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  'index 1111111..2222222 100644',
  '--- a/src/old-name.ts',
  '+++ b/src/new-name.ts',
  '@@ -1,3 +1,3 @@',
  ' const keep = 1;',
  '-const before = 2;',
  '+const after = 3;',
  ' export {};',
  '',
].join('\n');

type Route = (url: URL) => unknown;

let routes: Route[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function respond(route: Route) {
  routes.push(route);
}

function calls(pathname: string): URL[] {
  return mocks.apiFetch.mock.calls
    .map(([path]) => new URL(path as string, 'http://localhost'))
    .filter((url) => url.pathname === pathname);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  routes = [];
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (path: string) => {
    const url = new URL(path, 'http://localhost');
    for (const route of routes) {
      const result = route(url);
      if (result !== undefined) return result;
    }
    throw { status: 404, message: 'Not found' };
  });
  useChatStore.setState({ activeRuns: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(agentId: string | null) {
  container ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(container);
  act(() => root!.render(<ReviewPanel groupJid={GROUP} agentId={agentId} />));
  await flush();
  return container;
}

function fileRow(path: string): HTMLButtonElement {
  const row = container!.querySelector<HTMLButtonElement>(
    `button[data-path="${path}"]`,
  );
  if (!row) throw new Error(`no row for ${path}`);
  return row;
}

describe('ReviewPanel', () => {
  test('lists changed files with counts, renames and branch state', async () => {
    respond((url) => (url.pathname === STATUS_URL ? okStatus() : undefined));
    const view = await render('s1');

    const [statusCall] = calls(STATUS_URL);
    expect(statusCall.searchParams.get('agentId')).toBe('s1');

    const bar = view.querySelector('[data-testid="review-branch-bar"]')!;
    expect(bar.textContent).toContain('feat/review');
    expect(bar.textContent).toContain('↑2 ↓1');
    expect(bar.textContent).toContain('4 个文件');

    const modified = fileRow('src/routes/git-review.ts');
    expect(modified.textContent).toContain('修改');
    expect(modified.textContent).toContain('+12');
    expect(modified.textContent).toContain('-3');
    expect(modified.querySelector('.text-success')?.textContent).toBe('+12');
    expect(modified.querySelector('.text-error')?.textContent).toBe('-3');

    const renamed = fileRow('src/new-name.ts');
    const label = renamed.querySelector('[data-testid="review-file-path"]')!;
    expect(label.textContent?.replace(/\u00a0/g, ' ')).toBe(
      'src/old-name.ts → src/new-name.ts',
    );
    // The file name is its own element so it stays visible when truncated.
    expect(label.lastElementChild?.textContent).toBe('new-name.ts');
    expect(renamed.textContent).toContain('重命名');

    expect(fileRow('assets/logo.png').textContent).toContain('二进制');
    const untracked = fileRow('big.log');
    expect(untracked.textContent).toContain('未跟踪');
    expect(untracked.textContent).not.toMatch(/[+-]\d/);

    expect(view.textContent).not.toContain('独立 worktree');
  });

  test('shows detached HEAD, no ahead/behind without upstream, worktree badge and truncation', async () => {
    respond((url) =>
      url.pathname === STATUS_URL
        ? okStatus({
            branch: null,
            upstream: null,
            truncated: true,
            total_files: 1500,
            worktree: {
              branch: 'happyclaw/s1',
              base_commit: 'feedface00',
              status: 'active',
              broken_reason: null,
            },
          })
        : undefined,
    );
    const view = await render(null);

    expect(calls(STATUS_URL)[0].search).toBe('');
    const bar = view.querySelector('[data-testid="review-branch-bar"]')!;
    expect(bar.textContent).toContain('分离 HEAD');
    expect(bar.textContent).toContain('abcdef1');
    expect(bar.textContent).not.toContain('↑');
    expect(view.textContent).toContain('独立 worktree');
    expect(view.textContent).toContain('只显示前 4 个文件（共 1500 个）');
  });

  test('opens a diff with the file query and colours its lines', async () => {
    respond((url) => (url.pathname === STATUS_URL ? okStatus() : undefined));
    respond((url) =>
      url.pathname === '/api/groups/web%3Aws/git/diff'
        ? {
            state: 'ok',
            path: 'src/new-name.ts',
            orig_path: 'src/old-name.ts',
            diff: RENAME_DIFF,
            binary: false,
            truncated: true,
            untracked: false,
          }
        : undefined,
    );
    const view = await render('s1');

    act(() => fileRow('src/new-name.ts').click());
    await flush();

    const [diffCall] = calls('/api/groups/web%3Aws/git/diff');
    expect(diffCall.searchParams.get('agentId')).toBe('s1');
    expect(diffCall.searchParams.get('path')).toBe('src/new-name.ts');
    expect(diffCall.searchParams.get('orig_path')).toBe('src/old-name.ts');

    const scroll = view.querySelector('[data-testid="review-diff-scroll"]')!;
    const added = [...scroll.querySelectorAll('[data-kind="add"]')];
    const removed = [...scroll.querySelectorAll('[data-kind="del"]')];
    expect(added.map((line) => line.textContent)).toEqual([
      '+const after = 3;',
    ]);
    expect(removed.map((line) => line.textContent)).toEqual([
      '-const before = 2;',
    ]);
    expect(added[0].className).toContain('bg-success/10');
    expect(removed[0].className).toContain('bg-error/10');
    expect(scroll.querySelector('[data-kind="hunk"]')?.textContent).toBe(
      '@@ -1,3 +1,3 @@',
    );
    expect(scroll.querySelectorAll('[data-kind="meta"]')).toHaveLength(7);
    expect(view.textContent).toContain('差异过大，只显示前 512 KB');

    // Back returns to the list without refetching it.
    const back = view.querySelector<HTMLButtonElement>(
      'button[aria-label="返回文件列表"]',
    )!;
    act(() => back.click());
    expect(view.querySelector('[data-testid="review-diff-scroll"]')).toBeNull();
    expect(fileRow('src/new-name.ts').closest('.hidden')).toBeNull();
    expect(calls(STATUS_URL)).toHaveLength(1);
  });

  test('a phone’s system back closes the diff, not the panel', async () => {
    emulatePointer('phone');
    respond((url) => (url.pathname === STATUS_URL ? okStatus() : undefined));
    respond((url) =>
      url.pathname === '/api/groups/web%3Aws/git/diff'
        ? {
            state: 'ok',
            path: 'src/routes/git-review.ts',
            diff: RENAME_DIFF,
            binary: false,
            truncated: false,
            untracked: false,
          }
        : undefined,
    );
    const view = await render('s1');
    const entries = window.history.length;
    act(() => fileRow('src/routes/git-review.ts').click());
    await flush();
    expect(
      view.querySelector('[data-testid="review-diff-scroll"]'),
    ).not.toBeNull();
    expect(window.history.length).toBe(entries + 1);

    act(() => window.history.back());
    await flushHistory(act);
    expect(view.querySelector('[data-testid="review-diff-scroll"]')).toBeNull();
  });

  test('says when a diff is binary or empty', async () => {
    respond((url) => (url.pathname === STATUS_URL ? okStatus() : undefined));
    respond((url) =>
      url.searchParams.get('path') === 'assets/logo.png'
        ? {
            state: 'ok',
            path: 'assets/logo.png',
            diff: 'Binary files /dev/null and b/assets/logo.png differ\n',
            binary: true,
            truncated: false,
            untracked: false,
          }
        : url.searchParams.get('path') === 'big.log'
          ? {
              state: 'ok',
              path: 'big.log',
              diff: '',
              binary: false,
              truncated: false,
              untracked: true,
            }
          : undefined,
    );
    const view = await render('s1');

    act(() => fileRow('assets/logo.png').click());
    await flush();
    expect(view.textContent).toContain('二进制文件，不显示差异');

    act(() =>
      view
        .querySelector<HTMLButtonElement>('button[aria-label="返回文件列表"]')!
        .click(),
    );
    act(() => fileRow('big.log').click());
    await flush();
    expect(view.textContent).toContain('没有改动');
  });

  test('renders calm states for container mode and non-git directories', async () => {
    respond((url) =>
      url.pathname === STATUS_URL && url.searchParams.get('agentId') === 'c1'
        ? {
            state: 'unavailable',
            reason: 'container_mode',
            message: '代码改动面板目前只支持宿主机模式的工作区',
            worktree: null,
          }
        : undefined,
    );
    respond((url) =>
      url.pathname === STATUS_URL && url.searchParams.get('agentId') === 'n1'
        ? {
            state: 'not_git_repo',
            message: '工作目录不是 git 仓库',
            worktree: null,
          }
        : undefined,
    );
    const view = await render('c1');
    expect(view.textContent).toContain(
      '代码改动面板目前只支持宿主机模式的工作区',
    );
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.querySelector('[data-testid="review-branch-bar"]')).toBeNull();

    await render('n1');
    expect(view.textContent).toContain('工作目录不是 git 仓库');
    expect(view.textContent).not.toContain('宿主机模式');
  });

  test('shows a broken worktree as a warning and git errors with retry', async () => {
    let attempts = 0;
    respond((url) => {
      if (url.pathname !== STATUS_URL) return undefined;
      if (url.searchParams.get('agentId') === 'b1') {
        return {
          state: 'unavailable',
          reason: 'worktree_broken',
          message: '会话的独立 worktree 不可用：目录已被删除',
          worktree: {
            branch: 'happyclaw/b1',
            base_commit: 'feedface00',
            status: 'broken',
            broken_reason: '目录已被删除',
          },
        };
      }
      attempts++;
      return attempts === 1
        ? { state: 'error', error: 'git status timed out', worktree: null }
        : okStatus();
    });
    const view = await render('b1');
    const warning = view.querySelector('[role="status"]')!;
    expect(warning.textContent).toContain('目录已被删除');
    expect(warning.querySelector('.text-warning')).not.toBeNull();

    await render('e1');
    const alert = view.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('git status timed out');
    const retry = [...alert.querySelectorAll('button')].find(
      (button) => button.textContent === '重试',
    )!;
    act(() => retry.click());
    await flush();
    expect(fileRow('src/routes/git-review.ts')).toBeTruthy();
  });

  test('maps HTTP failures to a retryable notice', async () => {
    let fail = true;
    respond((url) => {
      if (url.pathname !== STATUS_URL) return undefined;
      if (fail) throw { status: 403, message: 'Insufficient permissions' };
      return okStatus({ files: [], total_files: 0 });
    });
    const view = await render('s1');
    const alert = view.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('没有权限查看这个工作区的代码改动');

    fail = false;
    act(() =>
      [...alert.querySelectorAll('button')]
        .find((button) => button.textContent === '重试')!
        .click(),
    );
    await flush();
    expect(view.textContent).toContain('没有未提交的改动');
  });

  test('refetches status and the open diff when this conversation’s run ends', async () => {
    let statusVersion = 0;
    respond((url) => {
      if (url.pathname !== STATUS_URL) return undefined;
      statusVersion++;
      return okStatus(
        statusVersion === 1
          ? {}
          : {
              files: [
                {
                  ...okStatus().files[0],
                  additions: 40,
                },
              ],
              total_files: 1,
            },
      );
    });
    let diffVersion = 0;
    respond((url) => {
      if (url.pathname !== '/api/groups/web%3Aws/git/diff') return undefined;
      diffVersion++;
      return {
        state: 'ok',
        path: 'src/routes/git-review.ts',
        diff: `@@ -1 +1 @@\n-old\n+version ${diffVersion}\n`,
        binary: false,
        truncated: false,
        untracked: false,
      };
    });
    const view = await render('s1');
    act(() => fileRow('src/routes/git-review.ts').click());
    await flush();
    expect(view.querySelector('[data-kind="add"]')?.textContent).toBe(
      '+version 1',
    );

    const run = {
      chatJid: `${GROUP}#agent:s1`,
      runId: 'run-1',
      startedAt: '2026-10-29T00:00:00.000Z',
      phase: 'running' as const,
    };
    act(() => useChatStore.setState({ activeRuns: { [run.chatJid]: run } }));
    await flush();
    // Starting a run, or a run of another conversation, never refetches.
    act(() =>
      useChatStore.setState({
        activeRuns: {
          [run.chatJid]: run,
          [`${GROUP}#agent:s2`]: { ...run, chatJid: `${GROUP}#agent:s2` },
        },
      }),
    );
    act(() => useChatStore.setState({ activeRuns: { [run.chatJid]: run } }));
    await flush();
    expect(calls(STATUS_URL)).toHaveLength(1);
    expect(calls('/api/groups/web%3Aws/git/diff')).toHaveLength(1);

    act(() => useChatStore.setState({ activeRuns: {} }));
    await flush();
    expect(calls(STATUS_URL)).toHaveLength(2);
    expect(calls('/api/groups/web%3Aws/git/diff')).toHaveLength(2);
    expect(view.querySelector('[data-kind="add"]')?.textContent).toBe(
      '+version 2',
    );
    // The open file's header picks up the refreshed counts.
    expect(view.textContent).toContain('+40');
  });

  test('the workspace checkout, with no session open, follows no run', async () => {
    respond((url) => (url.pathname === STATUS_URL ? okStatus() : undefined));
    await render(null);
    const run = {
      chatJid: `${GROUP}#agent:s1`,
      runId: 'run-1',
      startedAt: '2026-10-29T00:00:00.000Z',
      phase: 'running' as const,
    };
    act(() => useChatStore.setState({ activeRuns: { [run.chatJid]: run } }));
    act(() => useChatStore.setState({ activeRuns: {} }));
    await flush();
    expect(calls(STATUS_URL)).toHaveLength(1);
  });

  test('ignores a late response for the previous session', async () => {
    const slow = deferred<unknown>();
    respond((url) => {
      if (url.pathname !== STATUS_URL) return undefined;
      if (url.searchParams.get('agentId') === 'a') return slow.promise;
      return okStatus({
        files: [{ ...okStatus().files[0], path: 'only-in-b.ts' }],
        total_files: 1,
      });
    });
    const view = await render('a');
    expect(view.textContent).toContain('加载中');

    await render('b');
    expect(fileRow('only-in-b.ts')).toBeTruthy();

    slow.resolve(
      okStatus({
        files: [{ ...okStatus().files[0], path: 'only-in-a.ts' }],
        total_files: 1,
      }),
    );
    await flush();
    expect(view.querySelector('button[data-path="only-in-a.ts"]')).toBeNull();
    expect(fileRow('only-in-b.ts')).toBeTruthy();
    // The superseded request was cancelled, not just ignored.
    const [aCall] = mocks.apiFetch.mock.calls.filter(([path]) =>
      String(path).includes('agentId=a'),
    );
    expect((aCall[1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  test('ignores an older diff once another file is opened', async () => {
    const slow = deferred<unknown>();
    respond((url) => (url.pathname === STATUS_URL ? okStatus() : undefined));
    respond((url) => {
      if (url.pathname !== '/api/groups/web%3Aws/git/diff') return undefined;
      const path = url.searchParams.get('path');
      if (path === 'src/routes/git-review.ts') return slow.promise;
      return {
        state: 'ok',
        path,
        diff: '@@ -1 +1 @@\n-x\n+from rename\n',
        binary: false,
        truncated: false,
        untracked: false,
      };
    });
    const view = await render('s1');
    act(() => fileRow('src/routes/git-review.ts').click());
    act(() =>
      view
        .querySelector<HTMLButtonElement>('button[aria-label="返回文件列表"]')!
        .click(),
    );
    act(() => fileRow('src/new-name.ts').click());
    await flush();
    slow.resolve({
      state: 'ok',
      path: 'src/routes/git-review.ts',
      diff: '@@ -1 +1 @@\n-x\n+from modified\n',
      binary: false,
      truncated: false,
      untracked: false,
    });
    await flush();
    expect(view.querySelector('[data-kind="add"]')?.textContent).toBe(
      '+from rename',
    );
  });

  test('auto-switches to branch scope when working tree has 0 files and baseAhead > 0, and supports manual scope toggle', async () => {
    const worktreeMeta = {
      branch: 'happyclaw/s1',
      base_commit: '1111111111111111111111111111111111111111',
      status: 'active' as const,
      broken_reason: null,
    };
    respond((url) => {
      if (url.pathname !== STATUS_URL) return undefined;
      const scope = url.searchParams.get('scope') ?? 'working';
      if (scope === 'working') {
        return okStatus({
          worktree: worktreeMeta,
          branch: 'happyclaw/s1',
          upstream: null,
          ahead: 0,
          behind: 0,
          baseCommit: worktreeMeta.base_commit,
          baseAhead: 2,
          scope: 'working',
          files: [],
          total_files: 0,
        });
      }
      return okStatus({
        worktree: worktreeMeta,
        branch: 'happyclaw/s1',
        upstream: null,
        ahead: 0,
        behind: 0,
        baseCommit: worktreeMeta.base_commit,
        baseAhead: 2,
        scope: 'branch',
        files: [
          {
            path: 'src/committed.ts',
            status: 'added',
            index_status: 'A',
            worktree_status: '.',
            additions: 15,
            deletions: 0,
            binary: false,
          },
        ],
        total_files: 1,
      });
    });
    respond((url) => {
      if (url.pathname !== '/api/groups/web%3Aws/git/diff') return undefined;
      return {
        state: 'ok',
        path: 'src/committed.ts',
        diff: '@@ -0,0 +1 @@\n+export const committed = true;\n',
        binary: false,
        truncated: false,
        untracked: false,
      };
    });

    const view = await render('s1');

    // Initial load fetched working (0 files, baseAhead=2) and automatically switched to branch
    const statusUrls = calls(STATUS_URL);
    expect(statusUrls).toHaveLength(2);
    expect(statusUrls[0].searchParams.get('scope')).toBeNull();
    expect(statusUrls[1].searchParams.get('scope')).toBe('branch');

    const bar = view.querySelector('[data-testid="review-branch-bar"]')!;
    expect(bar.textContent).toContain('领先基底 2 个提交');
    expect(bar.textContent).toContain('1 个文件');
    expect(fileRow('src/committed.ts')).toBeTruthy();

    // Opening a file in branch scope passes scope=branch to git/diff
    act(() => fileRow('src/committed.ts').click());
    await flush();
    const [diffCall] = calls('/api/groups/web%3Aws/git/diff');
    expect(diffCall.searchParams.get('scope')).toBe('branch');
    expect(view.querySelector('[data-kind="add"]')?.textContent).toBe(
      '+export const committed = true;',
    );

    // Return to list and manually toggle to 未提交 (working)
    act(() =>
      view
        .querySelector<HTMLButtonElement>('button[aria-label="返回文件列表"]')!
        .click(),
    );
    const workingBtn = [
      ...view.querySelectorAll<HTMLButtonElement>(
        '[data-slot="segmented-control"] button',
      ),
    ].find((btn) => btn.textContent === '未提交')!;
    act(() => workingBtn.click());
    await flush();

    expect(view.textContent).toContain('没有未提交的改动');
    expect(calls(STATUS_URL)).toHaveLength(3);
  });
});

describe('parseUnifiedDiff', () => {
  test('keeps hunk bodies apart from file headers', () => {
    const lines = parseUnifiedDiff(
      [
        'diff --git a/a.md b/a.md',
        '--- a/a.md',
        '+++ b/a.md',
        '@@ -1,2 +1,2 @@',
        '--- a horizontal rule that was removed',
        '+++ an added line that looks like a header',
        ' ',
        '\\ No newline at end of file',
        'diff --git a/b.md b/b.md',
      ].join('\n'),
    );
    expect(lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'del',
      'add',
      'context',
      'note',
      'meta',
    ]);
  });
});
