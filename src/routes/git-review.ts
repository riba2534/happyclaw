/**
 * Read-only developer workbench routes under /api/groups/:jid:
 *
 *   GET git/status?agentId=           changed files of the session's checkout
 *   GET git/diff?agentId=&path=       unified diff of one changed file
 *   GET git/worktree-support          can a new session get its own worktree
 *
 * Access follows the file panel: the workspace must be visible to the caller
 * (404 otherwise, no admin bypass) and Host workspaces need host permission.
 * Git runs only for Host workspaces: a container Agent controls its
 * repository's config and hooks, which must never execute on the host.
 */
import { Hono, type Context } from 'hono';

import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../group-acl.js';
import { getRegisteredGroup } from '../db.js';
import {
  hasHostExecutionPermission,
  isHostExecutionGroup,
  type Variables,
} from '../web-context.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import {
  GitCommandError,
  GitPathError,
  locateGitRepo,
  readGitFileDiff,
  readGitStatus,
  resolveBranchReviewBase,
} from '../git-review.js';
import {
  getWorktreeSupport,
  resolveSessionWorkingDirectory,
  resolveWorkspaceProjectRoot,
  toSessionWorktreePayload,
  workspaceSessionFromQuery,
  WORKTREE_UNAVAILABLE_MESSAGES,
} from '../session-worktree.js';
import { getSessionWorktree } from '../session-worktree-store.js';
import { logger } from '../logger.js';

const gitReviewRoutes = new Hono<{ Variables: Variables }>();

type WorkspaceGroup = RegisteredGroup & { jid: string };

interface ReviewScope {
  group: WorkspaceGroup;
  authUser: AuthUser;
  /** Runtime Session id, or null for the workspace root. */
  agentId: string | null;
}

function resolveReviewScope(
  c: Context<{ Variables: Variables }>,
): ReviewScope | Response {
  const jid = c.req.param('jid') ?? '';
  const group = getRegisteredGroup(jid);
  const authUser = c.get('user') as AuthUser;
  if (
    !group ||
    !canAccessGroup({ id: authUser.id, role: authUser.role }, group)
  ) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  const agentId = workspaceSessionFromQuery(c.req.query('agentId'), jid);
  if (agentId === undefined) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return { group, authUser, agentId };
}

type ReviewRoot =
  | { state: 'ok'; root: string }
  | {
      state: 'unavailable';
      reason: 'container_mode' | 'worktree_broken';
      message: string;
    }
  | { state: 'not_git_repo'; message: string };

async function resolveReviewRoot(scope: ReviewScope): Promise<ReviewRoot> {
  if (!isHostExecutionGroup(scope.group)) {
    return {
      state: 'unavailable',
      reason: 'container_mode',
      message: '代码改动面板目前只支持宿主机模式的工作区',
    };
  }
  const session = resolveSessionWorkingDirectory(scope.agentId);
  if (session.kind === 'broken') {
    return {
      state: 'unavailable',
      reason: 'worktree_broken',
      message: `会话的独立 worktree 不可用：${session.reason}`,
    };
  }
  if (session.kind === 'worktree') {
    return { state: 'ok', root: session.worktree.worktree_path };
  }
  // data/groups/<folder> is nested in the HappyClaw checkout; only its own
  // repository counts, never the enclosing one.
  const repo = await locateGitRepo(resolveWorkspaceProjectRoot(scope.group), {
    requireTopLevel: !scope.group.customCwd,
  });
  if (!repo) {
    return { state: 'not_git_repo', message: '工作目录不是 git 仓库' };
  }
  return { state: 'ok', root: repo.topLevel };
}

function gitErrorPayload(error: unknown): { state: 'error'; error: string } {
  const message =
    error instanceof GitCommandError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { state: 'error', error: message.slice(0, 500) };
}

function parseReviewScopeQuery(
  raw: string | undefined,
): 'working' | 'branch' | null {
  if (raw === undefined || raw === '' || raw === 'working') return 'working';
  if (raw === 'branch') return 'branch';
  return null;
}

gitReviewRoutes.get('/:jid/git/status', authMiddleware, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const scope = resolveReviewScope(c);
  if (scope instanceof Response) return scope;
  const reviewScope = parseReviewScopeQuery(c.req.query('scope'));
  if (!reviewScope) return c.json({ error: 'Invalid scope' }, 400);
  const root = await resolveReviewRoot(scope);
  const storedWorktree = getSessionWorktree(scope.agentId);
  const worktree = toSessionWorktreePayload(storedWorktree);
  if (root.state !== 'ok') return c.json({ ...root, worktree });
  try {
    const status = await readGitStatus(root.root, {
      baseCommit: await resolveBranchReviewBase(
        root.root,
        storedWorktree?.base_commit,
      ),
      scope: reviewScope,
    });
    return c.json({ state: 'ok', root: root.root, worktree, ...status });
  } catch (error) {
    logger.warn({ err: error, root: root.root }, 'git status failed');
    return c.json({ ...gitErrorPayload(error), worktree });
  }
});

gitReviewRoutes.get('/:jid/git/diff', authMiddleware, async (c) => {
  c.header('Cache-Control', 'private, no-store');
  const scope = resolveReviewScope(c);
  if (scope instanceof Response) return scope;
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'path is required' }, 400);
  const reviewScope = parseReviewScopeQuery(c.req.query('scope'));
  if (!reviewScope) return c.json({ error: 'Invalid scope' }, 400);
  const root = await resolveReviewRoot(scope);
  if (root.state !== 'ok') return c.json(root);
  const storedWorktree = getSessionWorktree(scope.agentId);
  try {
    const diff = await readGitFileDiff(
      root.root,
      filePath,
      c.req.query('orig_path') || undefined,
      {
        baseCommit:
          reviewScope === 'branch'
            ? await resolveBranchReviewBase(
                root.root,
                storedWorktree?.base_commit,
              )
            : null,
        scope: reviewScope,
      },
    );
    return c.json({ state: 'ok', ...diff });
  } catch (error) {
    if (error instanceof GitPathError) {
      return c.json({ error: error.message }, 400);
    }
    logger.warn({ err: error, root: root.root }, 'git diff failed');
    return c.json(gitErrorPayload(error));
  }
});

gitReviewRoutes.get('/:jid/git/worktree-support', authMiddleware, async (c) => {
  const scope = resolveReviewScope(c);
  if (scope instanceof Response) return scope;
  const support = await getWorktreeSupport(scope.group);
  if (support.available) return c.json({ available: true });
  return c.json({
    available: false,
    reason: support.reason,
    message: WORKTREE_UNAVAILABLE_MESSAGES[support.reason],
  });
});

export default gitReviewRoutes;
