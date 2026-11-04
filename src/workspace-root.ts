/**
 * The workspace root: the directory new Host workspaces without a custom
 * directory are created in (`<root>/<folder>`). Existing workspaces keep the
 * directory recorded for them, so changing the root only affects new ones.
 *
 * Resolution, per key: the `workspaceRoot` system setting, then
 * `HAPPYCLAW_WORKSPACE_ROOT`, then `~/happyclaw`. A candidate that would let
 * Claude Code find a foreign CLAUDE.md (it walks every parent directory up to
 * `/`) or that sits inside the HappyClaw install falls back to
 * `~/happyclaw-workspaces`. An explicit setting is validated on save instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { getSystemSettings } from './runtime-config.js';

export const WORKSPACE_ROOT_ENV = 'HAPPYCLAW_WORKSPACE_ROOT';
export const DEFAULT_WORKSPACE_ROOT_NAME = 'happyclaw';
export const FALLBACK_WORKSPACE_ROOT_NAME = 'happyclaw-workspaces';

export type WorkspaceRootSource = 'settings' | 'env' | 'default';

export type WorkspaceRootProblem =
  | 'not_absolute'
  | 'filesystem_root'
  | 'home_dir'
  | 'inside_install_dir'
  | 'not_directory'
  | 'claude_md_ancestor'
  | 'inside_git_repo'
  | 'not_writable';

export const WORKSPACE_ROOT_PROBLEM_MESSAGES: Record<
  WorkspaceRootProblem,
  string
> = {
  not_absolute: '工作区根目录必须是绝对路径（可以用 ~ 开头）。',
  filesystem_root: '工作区根目录不能是文件系统根目录。',
  home_dir: '工作区根目录不能是用户主目录本身，请用它下面的一个子目录。',
  inside_install_dir:
    '工作区根目录不能放在 HappyClaw 安装目录里，否则 Agent 会读到项目自己的 CLAUDE.md。',
  not_directory: '这个路径已存在，但不是目录。',
  claude_md_ancestor:
    '这个目录或它的上层目录里有 CLAUDE.md，工作区里的 Agent 会读到它。',
  inside_git_repo:
    '这个目录位于另一个 git 仓库里，工作区会混进那个仓库的未跟踪文件。',
  not_writable: '没有权限在这个位置创建目录。',
};

export interface WorkspaceRootContext {
  home: string;
  installDir: string;
}

export interface WorkspaceRootResolution {
  /** The directory new Host workspaces are created in. */
  effective: string;
  source: WorkspaceRootSource;
  /** The stored setting, or null when unset. */
  configured: string | null;
  /** The candidate before any fallback (setting, env or default). */
  requested: string;
  /** Why the candidate was not used; null when it was. */
  fallbackReason: WorkspaceRootProblem | null;
  /** A problem the fallback itself has; it is still used. */
  fallbackWarning: WorkspaceRootProblem | null;
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/** Real path of the nearest existing ancestor, plus the missing segments. */
function canonicalize(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(target: string, base: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function nearestExisting(target: string): string {
  let current = target;
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** Every directory from `dir` up to the filesystem root. */
function selfAndAncestors(dir: string): string[] {
  const dirs: string[] = [];
  let current = dir;
  for (;;) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

/** The first reason `candidate` cannot be a workspace root, or null. */
export function checkWorkspaceRootCandidate(
  candidate: string,
  context: WorkspaceRootContext,
): WorkspaceRootProblem | null {
  const expanded = expandHome(candidate.trim(), context.home);
  if (!expanded || !path.isAbsolute(expanded)) return 'not_absolute';
  const resolved = canonicalize(expanded);
  if (resolved === path.parse(resolved).root) return 'filesystem_root';
  const home = canonicalize(context.home);
  if (resolved === home) return 'home_dir';
  if (isInside(resolved, canonicalize(context.installDir))) {
    return 'inside_install_dir';
  }
  if (exists(resolved) && !fs.statSync(resolved).isDirectory()) {
    return 'not_directory';
  }
  const homeUserMemory = path.join(home, '.claude', 'CLAUDE.md');
  for (const dir of selfAndAncestors(resolved)) {
    const memories = [
      path.join(dir, 'CLAUDE.md'),
      path.join(dir, 'CLAUDE.local.md'),
      path.join(dir, '.claude', 'CLAUDE.md'),
    ];
    // ~/.claude/CLAUDE.md is the host user's own memory, governed by the
    // Agent's context source, not something a root choice should avoid.
    if (memories.some((file) => file !== homeUserMemory && exists(file))) {
      return 'claude_md_ancestor';
    }
  }
  if (
    selfAndAncestors(resolved).some((dir) => exists(path.join(dir, '.git')))
  ) {
    return 'inside_git_repo';
  }
  try {
    fs.accessSync(nearestExisting(resolved), fs.constants.W_OK);
  } catch {
    return 'not_writable';
  }
  return null;
}

/** Pure apart from file-system checks: the root a setting and env resolve to. */
export function resolveWorkspaceRoot(input: {
  configured: string;
  env: string | undefined;
  context: WorkspaceRootContext;
}): WorkspaceRootResolution {
  const { context } = input;
  const configured = input.configured.trim() || null;
  const fromEnv = input.env?.trim() || null;
  const source: WorkspaceRootSource = configured
    ? 'settings'
    : fromEnv
      ? 'env'
      : 'default';
  const requested = expandHome(
    configured ??
      fromEnv ??
      path.join(context.home, DEFAULT_WORKSPACE_ROOT_NAME),
    context.home,
  );
  const fallbackReason = checkWorkspaceRootCandidate(requested, context);
  if (!fallbackReason) {
    return {
      effective: canonicalize(requested),
      source,
      configured,
      requested,
      fallbackReason: null,
      fallbackWarning: null,
    };
  }
  const fallback = path.join(context.home, FALLBACK_WORKSPACE_ROOT_NAME);
  return {
    effective: canonicalize(fallback),
    source,
    configured,
    requested,
    fallbackReason,
    fallbackWarning: checkWorkspaceRootCandidate(fallback, context),
  };
}

export function workspaceRootContext(): WorkspaceRootContext {
  return { home: os.homedir(), installDir: path.dirname(DATA_DIR) };
}

export function getWorkspaceRootResolution(): WorkspaceRootResolution {
  return resolveWorkspaceRoot({
    configured: getSystemSettings().workspaceRoot,
    env: process.env[WORKSPACE_ROOT_ENV],
    context: workspaceRootContext(),
  });
}

/**
 * Validate a value an admin wants to store. '' clears the setting. Returns
 * the problem, or null when the value can be saved.
 */
export function validateWorkspaceRootSetting(
  value: string,
  context: WorkspaceRootContext = workspaceRootContext(),
): WorkspaceRootProblem | null {
  if (!value.trim()) return null;
  return checkWorkspaceRootCandidate(value, context);
}

/** Create the effective root (0700) and return it. */
export function ensureWorkspaceRootDir(
  resolution: WorkspaceRootResolution = getWorkspaceRootResolution(),
): string {
  fs.mkdirSync(resolution.effective, { recursive: true, mode: 0o700 });
  return resolution.effective;
}
