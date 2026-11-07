/**
 * Session-level git worktrees and the workspace "project root" every
 * consumer shares.
 *
 * A Runtime Session in a Host workspace whose directory is a git repository
 * can own a worktree: HappyClaw adds it under data/worktrees/<folder>/<id> on
 * a new `happyclaw/<short id>` branch and runs that session there, so
 * parallel sessions stop overwriting each other's files. The host creates
 * and removes worktrees; the Agent never gets EnterWorktree (the CLI is
 * closed after every turn, so a CLI-owned worktree would silently vanish).
 *
 * Invariants: branches are never deleted, the main checkout's files are never
 * touched, a missing or damaged worktree fails the run instead of falling
 * back to the main checkout, and nothing is removed outside data/worktrees
 * except the worktree's own admin dir in the repository (what `git worktree
 * remove` deletes), never another worktree's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { getAgent } from './db.js';
import {
  GitCommandError,
  locateGitRepo,
  neutralFilterArgs,
  resolveHeadCommit,
  runGit,
} from './git-review.js';
import { logger } from './logger.js';
import {
  deleteSessionWorktreeRecord,
  getSessionWorktree,
  insertSessionWorktree,
  listAllSessionWorktrees,
  markSessionWorktreeActive,
  markSessionWorktreeBroken,
  type SessionWorktree,
} from './session-worktree-store.js';
import { workspaceDirOf } from './workspace-dir.js';
import type {
  RegisteredGroup,
  SessionWorktreeInfo,
  WorktreeIncludeIncomplete,
} from './types.js';
import { isRealpathInside, realpathBestEffort } from './utils.js';

export const WORKTREES_DIR = path.join(DATA_DIR, 'worktrees');

const BRANCH_PREFIX = 'happyclaw/';

type WorkspaceLike = Pick<
  RegisteredGroup,
  'folder' | 'executionMode' | 'customCwd'
>;

function isHostWorkspace(group: WorkspaceLike): boolean {
  return (group.executionMode || 'container') === 'host';
}

/**
 * The directory a run of this workspace (or of one of its sessions) works in,
 * which is also its Claude project context root (`.claude/skills`, MCP) and
 * the file panel root: the session's worktree when it has one, a Host
 * workspace's custom directory, otherwise the workspace's own directory
 * (recorded in the workspace root, or data/groups/<folder>).
 *
 * A broken worktree still resolves to its own path so callers report the
 * missing directory instead of quietly switching to the main checkout.
 */
export function resolveWorkspaceProjectRoot(
  group: WorkspaceLike,
  options: { agentId?: string | null } = {},
): string {
  return projectRootOf(group, getSessionWorktree(options.agentId));
}

/**
 * The session a request's `?agentId=` names in workspace `jid`: null when
 * none is named (the workspace root), undefined when it is no session there.
 */
export function workspaceSessionFromQuery(
  raw: string | undefined,
  jid: string,
): string | null | undefined {
  if (!raw) return null;
  return getAgent(raw)?.chat_jid === jid ? raw : undefined;
}

function projectRootOf(
  group: WorkspaceLike,
  worktree: SessionWorktree | undefined,
): string {
  if (worktree) return path.join(worktree.worktree_path, worktree.cwd_subpath);
  if (isHostWorkspace(group) && group.customCwd) return group.customCwd;
  return workspaceDirOf(group.folder);
}

function hasGitEntry(dir: string): boolean {
  try {
    fs.lstatSync(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The `.claude/skills` directories Claude Code discovers natively from `cwd`
 * (settingSources includes 'project'), lowest precedence first: it walks up
 * to the git root (inclusive) and stops before the home directory. A linked
 * worktree whose root has no `.claude/skills` also reads the main
 * checkout's, as the CLI does. `cwd`'s own directory is always last, even
 * before it exists, so callers can show where workspace Skills belong.
 *
 * HappyClaw hands the CLI an exact Skill name list, so the resolver must scan
 * these same directories: a native project Skill missing from the list is
 * hidden, while one that is also linked into the session config dir is the
 * same file twice, which the CLI loads once.
 */
export function projectSkillRoots(
  cwd: string,
  options: { mainRepoRoot?: string } = {},
): string[] {
  const home = realpathBestEffort(os.homedir());
  const start = realpathBestEffort(cwd);
  const own = path.join(start, '.claude', 'skills');
  const nearestFirst: string[] = [];
  let gitRoot: string | null = null;
  for (let dir = start; dir !== home; ) {
    const root = path.join(dir, '.claude', 'skills');
    if (root === own || fs.existsSync(root)) nearestFirst.push(root);
    if (hasGitEntry(dir)) {
      gitRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (options.mainRepoRoot && gitRoot) {
    const gitRootSkills = path.join(gitRoot, '.claude', 'skills');
    const mainSkills = path.join(
      realpathBestEffort(options.mainRepoRoot),
      '.claude',
      'skills',
    );
    if (
      mainSkills !== gitRootSkills &&
      !fs.existsSync(gitRootSkills) &&
      fs.existsSync(mainSkills)
    ) {
      nearestFirst.push(mainSkills);
    }
  }
  return nearestFirst.reverse();
}

/**
 * Project Skill roots for a run or a capability preview, lowest precedence
 * first. The workspace's own directory is its own git root (the host initializes it
 * before every run) and is all a container sees at /workspace/group, so it
 * keeps a single root; a custom directory or worktree mirrors the CLI walk.
 */
export function resolveWorkspaceSkillRoots(
  group: WorkspaceLike,
  options: { agentId?: string | null } = {},
): string[] {
  const worktree = getSessionWorktree(options.agentId);
  const root = projectRootOf(group, worktree);
  if (!isHostWorkspace(group) || (!group.customCwd && !worktree)) {
    return [path.join(root, '.claude', 'skills')];
  }
  return projectSkillRoots(root, { mainRepoRoot: worktree?.repo_path });
}

export type WorktreeUnavailableReason =
  | 'container_mode'
  | 'directory_missing'
  | 'not_git_repo'
  | 'repo_has_no_commits';

export const WORKTREE_UNAVAILABLE_MESSAGES: Record<
  WorktreeUnavailableReason,
  string
> = {
  container_mode: '独立 worktree 目前只支持宿主机模式的工作区',
  directory_missing: '工作目录不存在或无法访问',
  not_git_repo: '工作目录不是 git 仓库',
  repo_has_no_commits: 'git 仓库还没有任何提交，无法创建 worktree',
};

export type WorktreeSupport =
  | {
      available: true;
      repoRoot: string;
      subpath: string;
      baseCommit: string;
    }
  | { available: false; reason: WorktreeUnavailableReason };

export async function getWorktreeSupport(
  group: WorkspaceLike,
): Promise<WorktreeSupport> {
  if (!isHostWorkspace(group)) {
    return { available: false, reason: 'container_mode' };
  }
  const dir = resolveWorkspaceProjectRoot(group);
  if (!fs.existsSync(dir)) {
    return { available: false, reason: 'directory_missing' };
  }
  // The workspace's own directory (data/groups/<folder> sits inside the
  // HappyClaw checkout) counts only with the repository the host initializes
  // there; a custom directory may be nested in a larger repository.
  const repo = await locateGitRepo(dir, {
    requireTopLevel: !group.customCwd,
  });
  if (!repo) return { available: false, reason: 'not_git_repo' };
  const baseCommit = await resolveHeadCommit(repo.topLevel);
  if (!baseCommit) return { available: false, reason: 'repo_has_no_commits' };
  return {
    available: true,
    repoRoot: repo.topLevel,
    subpath: repo.subpath,
    baseCommit,
  };
}

export class WorktreeUnavailableError extends Error {
  constructor(readonly reason: WorktreeUnavailableReason) {
    super(WORKTREE_UNAVAILABLE_MESSAGES[reason]);
    this.name = 'WorktreeUnavailableError';
  }
}

export class SessionWorktreeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionWorktreeError';
  }
}

const WORKTREE_INCLUDE_FILE_MAX_BYTES = 64 * 1024;
const WORKTREE_INCLUDE_LIST_MAX_BYTES = 256 * 1024;
const WORKTREE_INCLUDE_MAX_FILES = 100;
const WORKTREE_INCLUDE_SINGLE_FILE_MAX_BYTES = 10 * 1024 * 1024;
const WORKTREE_INCLUDE_TOTAL_MAX_BYTES = 50 * 1024 * 1024;

/** Paths `include_incomplete` names as examples of what was left out. */
const WORKTREE_INCLUDE_SKIPPED_SAMPLE = 5;

/**
 * Copy the untracked ignored files `.worktreeinclude` names (`.env` and the
 * like) into a new worktree within fixed caps. Returns, and logs, what the
 * caps left out; null when everything matched was copied.
 */
async function copyWorktreeIncludeFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<WorktreeIncludeIncomplete | null> {
  let incomplete: WorktreeIncludeIncomplete | null;
  try {
    incomplete = await copyIncludedFiles(repoRoot, worktreePath);
  } catch (err) {
    logger.warn(
      { err, repoRoot, worktreePath },
      'Failed to copy .worktreeinclude files into session worktree',
    );
    return null;
  }
  if (incomplete) {
    logger.warn(
      { repoRoot, worktreePath, ...incomplete },
      '.worktreeinclude matched more files than were copied into the worktree',
    );
  }
  return incomplete;
}

async function copyIncludedFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<WorktreeIncludeIncomplete | null> {
  const includeFile = path.join(repoRoot, '.worktreeinclude');
  let includeStat: fs.Stats;
  try {
    includeStat = fs.lstatSync(includeFile);
  } catch {
    return null;
  }
  if (!includeStat.isFile() || !isRealpathInside(includeFile, repoRoot)) {
    return null;
  }
  const nothingCopied = (reason: WorktreeIncludeIncomplete['reason']) => ({
    reason,
    copied_files: 0,
    skipped_files: [],
  });
  if (includeStat.size > WORKTREE_INCLUDE_FILE_MAX_BYTES) {
    return nothingCopied('include_file_too_large');
  }
  const lsResult = await runGit(
    repoRoot,
    [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-from=.worktreeinclude',
    ],
    { maxBytes: WORKTREE_INCLUDE_LIST_MAX_BYTES },
  );
  // A cut list may end mid-path; copy nothing rather than a guessed subset.
  if (lsResult.truncated) return nothingCopied('list_truncated');
  // `--exclude-from` lists every untracked file the patterns name; only the
  // ones the repository's own ignore rules (.gitignore, info/exclude,
  // core.excludesFile) also ignore are copied, so work-in-progress that
  // happens to match a pattern never lands in someone else's worktree.
  const candidates = lsResult.stdout.split('\0').filter(Boolean);
  const ignored =
    candidates.length === 0
      ? new Set<string>()
      : new Set(
          (
            await runGit(repoRoot, ['check-ignore', '-z', '--stdin'], {
              input: `${candidates.join('\0')}\0`,
              maxBytes: WORKTREE_INCLUDE_LIST_MAX_BYTES,
              okExitCodes: [0, 1],
            })
          ).stdout
            .split('\0')
            .filter(Boolean),
        );
  const matched = candidates.filter((relPath) => ignored.has(relPath));
  let reason: WorktreeIncludeIncomplete['reason'] | null = null;
  const skipped: string[] = [];
  let copiedCount = 0;
  let totalBytes = 0;
  for (const [index, relPath] of matched.entries()) {
    if (copiedCount >= WORKTREE_INCLUDE_MAX_FILES) {
      reason = 'file_limit';
      skipped.push(
        ...matched.slice(
          index,
          index + WORKTREE_INCLUDE_SKIPPED_SAMPLE - skipped.length,
        ),
      );
      break;
    }
    if (
      !relPath ||
      path.isAbsolute(relPath) ||
      path.posix.isAbsolute(relPath) ||
      relPath.split('/').includes('..') ||
      relPath.split(path.sep).includes('..')
    ) {
      continue;
    }
    const srcPath = path.join(repoRoot, relPath);
    const dstPath = path.join(worktreePath, relPath);
    if (
      !isRealpathInside(srcPath, repoRoot) ||
      !isRealpathInside(dstPath, worktreePath)
    ) {
      continue;
    }
    let srcStat: fs.Stats;
    try {
      srcStat = fs.lstatSync(srcPath);
    } catch {
      continue;
    }
    if (!srcStat.isFile()) continue;
    if (
      srcStat.size > WORKTREE_INCLUDE_SINGLE_FILE_MAX_BYTES ||
      totalBytes + srcStat.size > WORKTREE_INCLUDE_TOTAL_MAX_BYTES
    ) {
      reason = 'size_limit';
      if (skipped.length < WORKTREE_INCLUDE_SKIPPED_SAMPLE) {
        skipped.push(relPath);
      }
      continue;
    }
    try {
      fs.lstatSync(dstPath);
      continue;
    } catch {
      /* destination does not exist yet */
    }
    const dstDir = path.dirname(dstPath);
    fs.mkdirSync(dstDir, { recursive: true });
    if (!isRealpathInside(dstDir, worktreePath)) continue;
    fs.copyFileSync(srcPath, dstPath, fs.constants.COPYFILE_EXCL);
    copiedCount++;
    totalBytes += srcStat.size;
  }
  return reason
    ? { reason, copied_files: copiedCount, skipped_files: skipped }
    : null;
}

function worktreePathFor(folder: string, agentId: string): string {
  return path.join(WORKTREES_DIR, folder, agentId);
}

/**
 * True only for a path strictly below data/worktrees whose real location
 * (through any symlinked component) is also below it, so creating or removing
 * a worktree can never reach a directory outside.
 */
export function isManagedWorktreePath(target: string): boolean {
  const resolved = path.resolve(target);
  const relative = path.relative(path.resolve(WORKTREES_DIR), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  return (
    realpathBestEffort(resolved) !== realpathBestEffort(WORKTREES_DIR) &&
    isRealpathInside(resolved, WORKTREES_DIR)
  );
}

async function branchExists(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  try {
    await runGit(
      repoRoot,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { maxBytes: 1024 },
    );
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return false;
    throw error;
  }
}

async function pickBranchName(
  repoRoot: string,
  agentId: string,
): Promise<string> {
  const compact = agentId.replace(/[^a-zA-Z0-9]/g, '');
  for (const length of [8, 12, compact.length]) {
    const candidate = `${BRANCH_PREFIX}${compact.slice(0, length)}`;
    if (!(await branchExists(repoRoot, candidate))) return candidate;
  }
  throw new Error(`branch ${BRANCH_PREFIX}${compact} already exists`);
}

/** A new worktree's record and what `.worktreeinclude` could not copy. */
export type CreatedSessionWorktree = SessionWorktree & {
  include_incomplete: WorktreeIncludeIncomplete | null;
};

/**
 * Add a worktree for a new session on a fresh branch at the repository's
 * current HEAD and record it. Throws WorktreeUnavailableError when the
 * workspace cannot have one.
 */
export async function createSessionWorktree(input: {
  group: WorkspaceLike;
  chatJid: string;
  agentId: string;
}): Promise<CreatedSessionWorktree> {
  const support = await getWorktreeSupport(input.group);
  if (!support.available) throw new WorktreeUnavailableError(support.reason);
  const worktreePath = worktreePathFor(input.group.folder, input.agentId);
  if (!isManagedWorktreePath(worktreePath) || fs.existsSync(worktreePath)) {
    throw new Error(`worktree path is not available: ${worktreePath}`);
  }
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const branch = await pickBranchName(support.repoRoot, input.agentId);
  let addResult;
  try {
    addResult = await runGit(
      support.repoRoot,
      ['worktree', 'add', '-b', branch, worktreePath, support.baseCommit],
      // The user's own repository: its hooks run as they would for them.
      { timeoutMs: 120_000, maxBytes: 256 * 1024, trustRepoConfig: true },
    );
  } catch (error) {
    await detachWorktreeDirectory(support.repoRoot, worktreePath, branch);
    throw new SessionWorktreeError(
      'GIT_WORKTREE_ADD_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (addResult.exitCode !== 0 || addResult.truncated) {
    await detachWorktreeDirectory(support.repoRoot, worktreePath, branch);
    throw new SessionWorktreeError(
      'GIT_WORKTREE_ADD_FAILED',
      addResult.truncated
        ? 'git worktree add output exceeded maximum size'
        : `git worktree add exited with ${addResult.exitCode}`,
    );
  }
  const includeIncomplete = await copyWorktreeIncludeFiles(
    support.repoRoot,
    worktreePath,
  );
  try {
    const record = insertSessionWorktree({
      agent_id: input.agentId,
      group_folder: input.group.folder,
      chat_jid: input.chatJid,
      repo_path: support.repoRoot,
      cwd_subpath: support.subpath,
      worktree_path: worktreePath,
      branch,
      base_commit: support.baseCommit,
      created_at: new Date().toISOString(),
    });
    return { ...record, include_incomplete: includeIncomplete };
  } catch (error) {
    await detachWorktreeDirectory(support.repoRoot, worktreePath, branch);
    throw error;
  }
}

/** Why a recorded worktree cannot be used, or null when it looks intact. */
export function inspectSessionWorktree(record: SessionWorktree): string | null {
  try {
    if (!fs.statSync(record.worktree_path).isDirectory()) {
      return 'worktree path is not a directory';
    }
  } catch {
    return 'worktree directory is missing';
  }
  if (!hasGitEntry(record.worktree_path)) {
    return 'worktree has no .git entry';
  }
  const cwd = path.join(record.worktree_path, record.cwd_subpath);
  if (record.cwd_subpath && !fs.existsSync(cwd)) {
    return `worktree has no ${record.cwd_subpath} directory`;
  }
  return null;
}

export type SessionWorkingDirectory =
  | { kind: 'none' }
  | { kind: 'worktree'; cwd: string; worktree: SessionWorktree }
  | { kind: 'broken'; worktree: SessionWorktree; reason: string };

/**
 * The run directory for a session that owns a worktree. A missing or damaged
 * checkout is recorded as broken and reported; callers must fail the run
 * rather than use the workspace directory.
 */
export function resolveSessionWorkingDirectory(
  agentId: string | null | undefined,
): SessionWorkingDirectory {
  const stored = getSessionWorktree(agentId);
  if (!stored) return { kind: 'none' };
  const worktree = refreshSessionWorktreeStatus(stored);
  if (worktree.status === 'broken') {
    return {
      kind: 'broken',
      worktree,
      reason: worktree.broken_reason ?? 'worktree is marked broken',
    };
  }
  return {
    kind: 'worktree',
    cwd: path.join(worktree.worktree_path, worktree.cwd_subpath),
    worktree,
  };
}

/**
 * Check a recorded worktree on disk and store the outcome both ways: a
 * missing or damaged checkout becomes broken, and one that is back (restored
 * directory, recreated subdirectory) becomes active again.
 */
export function refreshSessionWorktreeStatus(
  record: SessionWorktree,
): SessionWorktree {
  const reason = inspectSessionWorktree(record);
  // A worktree already broken keeps the reason it was given, which may say
  // more than what inspecting it now finds (removed with its session).
  if (reason && record.status !== 'broken') {
    markSessionWorktreeBroken(record.agent_id, reason);
    return { ...record, status: 'broken', broken_reason: reason };
  }
  if (!reason && record.status === 'broken') {
    markSessionWorktreeActive(record.agent_id);
    return { ...record, status: 'active', broken_reason: null };
  }
  return record;
}

export function sessionWorktreeRunError(
  worktree: SessionWorktree,
  reason: string,
): string {
  return `会话的独立 worktree 不可用（${reason}）：${worktree.worktree_path}，分支 ${worktree.branch}。为避免改动落到主仓库，本次运行已停止；请删除该会话后重新创建。`;
}

/** Uncommitted changes (including untracked files) in a worktree. */
export async function countWorktreeChanges(
  worktreePath: string,
): Promise<number> {
  const result = await runGit(
    worktreePath,
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      // `dirty` still reports a staged or moved gitlink (an embedded
      // repository, a submodule on a new commit) by reading its HEAD, and,
      // unlike `none` or `untracked`, never starts git inside it, where that
      // repository's own config would decide what runs.
      '--ignore-submodules=dirty',
    ],
    {
      maxBytes: 2 * 1024 * 1024,
      config: await neutralFilterArgs(worktreePath),
    },
  );
  // Renames carry their source as an extra NUL field; count entries only.
  let count = 0;
  const records = result.stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    count++;
    if (record[0] === 'R' || record[0] === 'C') i++;
  }
  return count;
}

async function detachWorktreeDirectory(
  repoRoot: string,
  worktreePath: string,
  deleteBranch?: string,
): Promise<void> {
  if (!isManagedWorktreePath(worktreePath)) {
    throw new Error(`refusing to remove unmanaged path: ${worktreePath}`);
  }
  // Found while the checkout is still there to match against.
  const adminDir = worktreeAdminDir(repoRoot, worktreePath);
  let removedByGit = false;
  try {
    await runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath], {
      timeoutMs: 60_000,
      maxBytes: 64 * 1024,
    });
    removedByGit = true;
  } catch (error) {
    // The repository may be gone or no longer know this worktree. Removing
    // the directory below data/worktrees is still safe.
    logger.warn(
      { err: error, worktreePath },
      'git worktree remove failed; removing the directory directly',
    );
  }
  if (fs.existsSync(worktreePath)) {
    if (!isManagedWorktreePath(worktreePath)) {
      throw new Error(`refusing to remove unmanaged path: ${worktreePath}`);
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
  if (!removedByGit && adminDir) {
    // Only this worktree's admin dir. `git worktree prune` would also drop
    // the user's own worktrees that are merely unreachable right now.
    fs.rmSync(adminDir, { recursive: true, force: true });
  }
  if (deleteBranch) {
    try {
      await runGit(repoRoot, ['branch', '-D', deleteBranch], {
        maxBytes: 64 * 1024,
      });
    } catch {
      /* branch was never created or already removed */
    }
  }
  removeEmptyManagedDir(path.dirname(worktreePath));
}

/**
 * Remove a directory below data/worktrees only if it is empty. rmdir refuses
 * a non-empty directory, so a folder that still holds anything stays.
 */
function removeEmptyManagedDir(dir: string): boolean {
  if (!isManagedWorktreePath(dir)) return false;
  try {
    fs.rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** What removing a session's worktree would lose. */
export interface DirtyWorktree {
  agentId: string;
  branch: string;
  /** Uncommitted changes, untracked files included. */
  dirtyFiles: number;
  /** Status could not be read (damaged checkout, git failure). */
  unreadable: boolean;
  /** Initialized submodules, whose local commits go with the worktree. */
  submodules: boolean;
  /**
   * Another repository anywhere inside the worktree (ignored paths included),
   * whose commits and changes go with it.
   */
  embeddedRepos: boolean;
  /** HEAD is detached at a commit that no branch or tag contains. */
  detachedCommits: boolean;
  /** A rebase, merge, cherry-pick, revert or bisect is under way. */
  operationInProgress: WorktreeOperation | null;
  /** Files marked skip-worktree or assume-unchanged hide their changes. */
  hiddenChanges: boolean;
}

export type WorktreeOperation =
  | 'rebase'
  | 'merge'
  | 'cherry-pick'
  | 'revert'
  | 'bisect';

/** The repository's common git dir (`.git` of the main checkout). */
function commonGitDir(repoRoot: string): string | null {
  const dotGit = path.join(repoRoot, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
    // repoRoot is itself a linked worktree: follow gitdir, then commondir.
    const gitdir = /^gitdir:\s*(.+)$/m
      .exec(fs.readFileSync(dotGit, 'utf8'))?.[1]
      ?.trim();
    if (!gitdir) return null;
    const adminDir = path.resolve(repoRoot, gitdir);
    const common = fs.readFileSync(path.join(adminDir, 'commondir'), 'utf8');
    return path.resolve(adminDir, common.trim());
  } catch {
    return null;
  }
}

/**
 * The worktree's administrative dir (`<common>/worktrees/<name>`), found from
 * the repository side so a missing `.git` file does not hide it. Git records
 * the worktree's real path there (relative to the admin dir with
 * worktree.useRelativePaths), so both sides are compared as real paths: data/
 * may be reached through a symlink, as /var is on macOS.
 */
function worktreeAdminDir(
  repoRoot: string,
  worktreePath: string,
): string | null {
  const common = commonGitDir(repoRoot);
  if (!common) return null;
  const expected = realpathBestEffort(path.join(worktreePath, '.git'));
  const worktreesDir = path.join(common, 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(worktreesDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const adminDir = path.join(worktreesDir, name);
    try {
      const gitdir = fs
        .readFileSync(path.join(adminDir, 'gitdir'), 'utf8')
        .trim();
      if (realpathBestEffort(path.resolve(adminDir, gitdir)) === expected) {
        return adminDir;
      }
    } catch {
      /* not a worktree entry */
    }
  }
  return null;
}

function hasInitializedSubmodules(adminDir: string): boolean {
  try {
    return fs.readdirSync(path.join(adminDir, 'modules')).length > 0;
  } catch {
    return false;
  }
}

/** Admin-dir entries git keeps while each operation is under way. */
const OPERATION_STATE: ReadonlyArray<[string, WorktreeOperation]> = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['sequencer', 'cherry-pick'],
  ['BISECT_START', 'bisect'],
];

function operationInProgress(adminDir: string): WorktreeOperation | null {
  for (const [entry, operation] of OPERATION_STATE) {
    if (fs.existsSync(path.join(adminDir, entry))) return operation;
  }
  return null;
}

/**
 * HEAD is detached at a commit no branch or tag contains (commits made on a
 * detached HEAD, a rebase stopped at `edit`): only the worktree's own HEAD
 * and reflog, in the admin dir that goes with it, still reach them.
 */
async function hasDetachedCommits(
  repoRoot: string,
  adminDir: string,
): Promise<boolean> {
  const head = fs.readFileSync(path.join(adminDir, 'HEAD'), 'utf8').trim();
  if (head.startsWith('ref: ')) return false;
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) {
    throw new Error('unreadable worktree HEAD');
  }
  const result = await runGit(
    repoRoot,
    [
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      `--contains=${head}`,
      'refs/heads',
      'refs/tags',
    ],
    { maxBytes: 64 * 1024 },
  );
  return result.stdout.trim() === '';
}

/** Index listing cap for the hidden-change scan (~300k entries). */
const INDEX_SCAN_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Files marked assume-unchanged, or skip-worktree while present on disk,
 * whose edits git status does not show. Sparse-checkout entries are
 * skip-worktree too but absent, so they hold nothing to lose.
 */
async function hasHiddenChanges(worktreePath: string): Promise<boolean> {
  const result = await runGit(worktreePath, ['ls-files', '-v', '-z'], {
    maxBytes: INDEX_SCAN_MAX_BYTES,
  });
  if (result.truncated) {
    throw new GitCommandError('git ls-files output exceeded the cap', null, '');
  }
  for (const entry of result.stdout.split('\0')) {
    const tag = entry[0];
    if (!tag) continue;
    // `<tag> <path>`: lowercase is assume-unchanged, `S` skip-worktree.
    if (tag >= 'a' && tag <= 'z') return true;
    if (tag === 'S' && fs.existsSync(path.join(worktreePath, entry.slice(2)))) {
      return true;
    }
  }
  return false;
}

/** Bounds of the nested-repository walk; past either the worktree is unreadable. */
const NESTED_GIT_SCAN_MAX_ENTRIES = 500_000;
const NESTED_GIT_SCAN_MAX_MS = 10_000;
const GIT_FILE_MAX_BYTES = 4096;

/**
 * Another repository's `.git` anywhere inside the worktree, ignored paths
 * included: a directory, a symlink, or a `.git` file pointing anywhere but
 * this worktree's admin modules (a submodule cloned by git, which
 * hasInitializedSubmodules reports). Walks the file system without following
 * symlinks and never runs git inside what it finds, whose own config would
 * decide what runs. A walk past its entry or time budget throws, so the
 * worktree counts as unreadable rather than clean.
 */
async function hasNestedRepository(
  worktreePath: string,
  adminDir: string,
): Promise<boolean> {
  const modulesDir = path.join(adminDir, 'modules');
  const deadline = Date.now() + NESTED_GIT_SCAN_MAX_MS;
  let entries = 0;
  const pending = [worktreePath];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of await fs.promises.readdir(dir, {
      withFileTypes: true,
    })) {
      if (++entries > NESTED_GIT_SCAN_MAX_ENTRIES || Date.now() > deadline) {
        throw new Error('worktree too large to scan for nested repositories');
      }
      const entryPath = path.join(dir, entry.name);
      if (entry.name === '.git') {
        // The worktree's own `.git` file.
        if (dir === worktreePath) continue;
        if (!(entry.isFile() && isSubmoduleGitFile(entryPath, modulesDir))) {
          return true;
        }
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return false;
}

function isSubmoduleGitFile(gitFile: string, modulesDir: string): boolean {
  try {
    if (fs.statSync(gitFile).size > GIT_FILE_MAX_BYTES) return false;
    const gitdir = /^gitdir:\s*(.+)$/m
      .exec(fs.readFileSync(gitFile, 'utf8'))?.[1]
      ?.trim();
    return (
      !!gitdir &&
      isRealpathInside(path.resolve(path.dirname(gitFile), gitdir), modulesDir)
    );
  } catch {
    return false;
  }
}

/**
 * What removing this worktree would lose, or null when nothing is at risk.
 * A damaged checkout is still checked while its directory exists, and a
 * status that cannot be read counts as at risk rather than clean.
 */
async function assessWorktreeRemoval(
  record: SessionWorktree,
): Promise<DirtyWorktree | null> {
  const adminDir = worktreeAdminDir(record.repo_path, record.worktree_path);
  const risk: DirtyWorktree = {
    agentId: record.agent_id,
    branch: record.branch,
    dirtyFiles: 0,
    unreadable: false,
    submodules: adminDir ? hasInitializedSubmodules(adminDir) : false,
    embeddedRepos: false,
    detachedCommits: false,
    operationInProgress: adminDir ? operationInProgress(adminDir) : null,
    hiddenChanges: false,
  };
  const checks: Promise<void>[] = [];
  if (adminDir) {
    checks.push(
      hasDetachedCommits(record.repo_path, adminDir).then((detached) => {
        risk.detachedCommits = detached;
      }),
    );
  }
  if (fs.existsSync(record.worktree_path)) {
    // Without its .git file git would walk up into an enclosing repository
    // (data/ lives in the HappyClaw checkout) and report that one.
    if (!adminDir || !fs.existsSync(path.join(record.worktree_path, '.git'))) {
      risk.unreadable = true;
    } else {
      const worktreePath = record.worktree_path;
      checks.push(
        countWorktreeChanges(worktreePath).then((count) => {
          risk.dirtyFiles = count;
        }),
        hasNestedRepository(worktreePath, adminDir).then((found) => {
          risk.embeddedRepos = found;
        }),
        hasHiddenChanges(worktreePath).then((hidden) => {
          risk.hiddenChanges = hidden;
        }),
      );
    }
  }
  try {
    await Promise.all(checks);
  } catch {
    risk.unreadable = true;
  }
  return risk.dirtyFiles > 0 ||
    risk.unreadable ||
    risk.submodules ||
    risk.embeddedRepos ||
    risk.detachedCommits ||
    risk.operationInProgress !== null ||
    risk.hiddenChanges
    ? risk
    : null;
}

export type RemoveSessionWorktreeResult =
  | { removed: true; branch: string }
  | { removed: false; risk: DirtyWorktree };

/**
 * Remove a session's worktree directory and record. The branch stays. When
 * the removal could lose work (uncommitted changes, unreadable status,
 * initialized submodules) the worktree is kept and the risk returned, unless
 * `force` confirms it.
 */
export async function removeSessionWorktree(
  agentId: string,
  options: {
    force?: boolean;
    /**
     * Keep the record, marked broken, for a caller that deletes the session
     * afterwards and then calls forgetSessionWorktree: if that fails midway,
     * the session still cannot run, in particular not in the main checkout.
     */
    keepRecord?: boolean;
  } = {},
): Promise<RemoveSessionWorktreeResult | null> {
  const worktree = getSessionWorktree(agentId);
  if (!worktree) return null;
  if (!options.force) {
    const risk = await assessWorktreeRemoval(worktree);
    if (risk) return { removed: false, risk };
  }
  await detachWorktreeDirectory(worktree.repo_path, worktree.worktree_path);
  if (options.keepRecord) {
    markSessionWorktreeBroken(agentId, 'worktree removed with its session');
  } else {
    deleteSessionWorktreeRecord(agentId);
  }
  logger.info(
    { agentId, worktreePath: worktree.worktree_path, branch: worktree.branch },
    'Session worktree removed; branch kept',
  );
  return { removed: true, branch: worktree.branch };
}

/** Drop the record removeSessionWorktree kept once its session is gone. */
export function forgetSessionWorktree(agentId: string): void {
  deleteSessionWorktreeRecord(agentId);
}

/** The 409 body of an operation refused because worktrees could lose work. */
export function dirtyWorktreesConflict(dirty: DirtyWorktree[]) {
  const files = dirty.reduce((sum, item) => sum + item.dirtyFiles, 0);
  const owner = dirty.length === 1 ? '会话' : `${dirty.length} 个会话`;
  const reasons = [
    ...(files > 0 ? [`有 ${files} 个未提交的改动`] : []),
    ...(dirty.some((item) => item.unreadable)
      ? ['无法读取状态，可能仍有未提交的改动']
      : []),
    ...(dirty.some((item) => item.submodules)
      ? ['有已初始化的子模块，其中的本地提交会一并丢失']
      : []),
    ...(dirty.some((item) => item.embeddedRepos)
      ? ['包含嵌入的 git 仓库，删除会一并删除其中的提交和改动']
      : []),
    ...(dirty.some((item) => item.detachedCommits)
      ? ['HEAD 不在任何分支上，当前提交无法从分支或标签到达，删除后会丢失']
      : []),
    ...[
      ...new Set(
        dirty.flatMap((item) =>
          item.operationInProgress ? [item.operationInProgress] : [],
        ),
      ),
    ].map(
      (operation) => `有进行中的 ${operation}，删除会丢失其状态和未完成的提交`,
    ),
    ...(dirty.some((item) => item.hiddenChanges)
      ? [
          '有标记为 skip-worktree 或 assume-unchanged 的文件，它们的改动不会显示在状态里',
        ]
      : []),
  ];
  return {
    error: `${owner}的 worktree ${reasons.join('；')}，确认后才会移除（分支会保留）`,
    code: 'WORKTREE_DIRTY',
    dirty_worktrees: dirty.map((item) => ({
      session_id: item.agentId,
      branch: item.branch,
      changed_files: item.dirtyFiles,
      unreadable: item.unreadable,
      submodules: item.submodules,
      embedded_repos: item.embeddedRepos,
      detached_commits: item.detachedCommits,
      operation_in_progress: item.operationInProgress,
      hidden_changes: item.hiddenChanges,
    })),
  };
}

/** Sessions of `records` whose worktree removal could lose work. */
export async function findDirtySessionWorktrees(
  records: SessionWorktree[],
): Promise<DirtyWorktree[]> {
  // Read-only status takes no index lock, so the checks run side by side.
  const risks = await Promise.all(records.map(assessWorktreeRemoval));
  return risks.filter((risk): risk is DirtyWorktree => risk !== null);
}

/**
 * Startup reconciliation: worktrees whose directory is gone or damaged become
 * broken, so their sessions fail clearly instead of running somewhere else;
 * ones that are back become active. Empty data/worktrees/<folder> directories
 * no record lives in are removed; anything with content stays.
 */
export function reconcileSessionWorktrees(): {
  broken: number;
  emptyFoldersRemoved: number;
} {
  let broken = 0;
  const recordFolders = new Set<string>();
  for (const record of listAllSessionWorktrees()) {
    recordFolders.add(path.resolve(path.dirname(record.worktree_path)));
    const refreshed = refreshSessionWorktreeStatus(record);
    if (refreshed.status === 'broken' && record.status !== 'broken') {
      broken++;
    }
  }
  if (broken > 0) {
    logger.warn({ broken }, 'Marked missing session worktrees as broken');
  }
  let emptyFoldersRemoved = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(WORKTREES_DIR, { withFileTypes: true });
  } catch {
    /* no worktree has been created yet */
  }
  for (const entry of entries) {
    const dir = path.resolve(WORKTREES_DIR, entry.name);
    if (!entry.isDirectory() || recordFolders.has(dir)) continue;
    if (removeEmptyManagedDir(dir)) emptyFoldersRemoved++;
  }
  if (emptyFoldersRemoved > 0) {
    logger.info(
      { emptyFoldersRemoved },
      'Removed empty worktree folders without sessions',
    );
  }
  return { broken, emptyFoldersRemoved };
}

/**
 * Public shape of a session's worktree in API responses. Only the creation
 * response carries `include_incomplete`.
 */
export function toSessionWorktreePayload(
  record:
    | (SessionWorktree &
        Partial<Pick<CreatedSessionWorktree, 'include_incomplete'>>)
    | undefined,
): SessionWorktreeInfo | null {
  if (!record) return null;
  return {
    branch: record.branch,
    base_commit: record.base_commit,
    status: record.status,
    broken_reason: record.broken_reason,
    include_incomplete: record.include_incomplete,
  };
}
