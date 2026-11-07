/**
 * The workspace root: the directory new Host workspaces without a custom
 * directory are created in (`<root>/<folder>`). Existing workspaces keep the
 * directory recorded for them, so changing the root only affects new ones.
 *
 * Resolution, per key: the `workspaceRoot` system setting, then
 * `HAPPYCLAW_WORKSPACE_ROOT`, then `~/happyclaw`. A candidate that would let
 * Claude Code find a foreign CLAUDE.md (it walks every parent directory up to
 * `/`), that overlaps the home or install directory, or that already holds
 * someone's own files falls back to `~/happyclaw-workspaces`. When that has
 * a problem too, no root is used and new Host workspaces stay in
 * data/groups/<folder> (rootForNewWorkspaces). An explicit setting is
 * validated on save instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { getSystemSettings } from './runtime-config.js';
import {
  canonicalizePath,
  ensureMarkedWorkspaceRoot,
  isPathInside,
  pathsOverlap,
  workspaceRootDirState,
} from './workspace-root-fs.js';
import type { WorkspaceRootProblem } from './workspace-root-problems.js';

export {
  WORKSPACE_ROOT_PROBLEM_MESSAGES,
  type WorkspaceRootProblem,
} from './workspace-root-problems.js';

export const WORKSPACE_ROOT_ENV = 'HAPPYCLAW_WORKSPACE_ROOT';
export const DEFAULT_WORKSPACE_ROOT_NAME = 'happyclaw';
export const FALLBACK_WORKSPACE_ROOT_NAME = 'happyclaw-workspaces';

export type WorkspaceRootSource = 'settings' | 'env' | 'default';

export interface WorkspaceRootContext {
  home: string;
  installDir: string;
}

export interface WorkspaceRootResolution {
  /**
   * The candidate, or the fallback when the candidate has a problem. New
   * Host workspaces are created in it unless `fallbackWarning` is set
   * (rootForNewWorkspaces).
   */
  effective: string;
  source: WorkspaceRootSource;
  /** The stored setting, or null when unset. */
  configured: string | null;
  /** The candidate before any fallback (setting, env or default). */
  requested: string;
  /** Why the candidate was not used; null when it was. */
  fallbackReason: WorkspaceRootProblem | null;
  /**
   * A problem the fallback itself has. Then it is not used either: new Host
   * workspaces stay in data/groups/<folder>.
   */
  fallbackWarning: WorkspaceRootProblem | null;
}

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
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

/**
 * What existing workspaces already use, for checking a new root: their
 * directories, custom directories and mount sources must not overlap it
 * (one workspace's directory inside another's would be deleted with it),
 * and it must not sit inside or around another known root. Being one of
 * the known roots (switching back to an old root) is fine.
 */
export interface WorkspaceRootOccupancy {
  /** Custom directories of existing Host workspaces. */
  customDirs?: readonly string[];
  /** Additional mount sources of existing Container workspaces. */
  mountSources?: readonly string[];
  /** Recorded workspace directories and the root each was created in. */
  workdirs?: ReadonlyArray<{ workdir: string; root: string }>;
  knownRoots?: readonly string[];
}

/** The first reason `candidate` cannot be a workspace root, or null. */
export function checkWorkspaceRootCandidate(
  candidate: string,
  context: WorkspaceRootContext,
  occupancy: WorkspaceRootOccupancy = {},
): WorkspaceRootProblem | null {
  const expanded = expandHome(candidate.trim(), context.home);
  if (!expanded || !path.isAbsolute(expanded)) return 'not_absolute';
  const resolved = canonicalizePath(expanded);
  if (resolved === path.parse(resolved).root) return 'filesystem_root';
  const home = canonicalizePath(context.home);
  if (resolved === home) return 'home_dir';
  if (isPathInside(home, resolved)) return 'contains_home';
  const installDir = canonicalizePath(context.installDir);
  if (isPathInside(resolved, installDir)) return 'inside_install_dir';
  if (isPathInside(installDir, resolved)) return 'contains_install_dir';
  const state = workspaceRootDirState(resolved);
  // A link to nowhere is "present" for lstat but no directory to use.
  if (state === 'not_directory' || (state === 'missing' && exists(resolved))) {
    return 'not_directory';
  }
  // A root HappyClaw already recorded workspaces in is its own, even
  // without the marker (created before it, or the marker was removed).
  const isKnownRoot = (occupancy.knownRoots ?? []).some(
    (root) => canonicalizePath(root) === resolved,
  );
  if (state === 'foreign' && !isKnownRoot) return 'not_empty';
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
  const overlaps = (other: string) =>
    pathsOverlap(canonicalizePath(other), resolved);
  const isThisRoot = (root: string) => canonicalizePath(root) === resolved;
  // A custom directory inside the root would become a protected root's
  // content; one around it (such as ~) is not harmed by HappyClaw's own
  // directories appearing inside it. A mount source must not overlap the
  // root either way: the mount check (mount-security.ts) refuses any mount
  // overlapping a root, so that workspace would no longer start.
  const insideCandidate = (occupied: string) =>
    isPathInside(canonicalizePath(occupied), resolved);
  if (
    (occupancy.customDirs ?? []).some(insideCandidate) ||
    (occupancy.mountSources ?? []).some(overlaps) ||
    (occupancy.workdirs ?? []).some(
      ({ workdir, root }) => !isThisRoot(root) && overlaps(workdir),
    ) ||
    (occupancy.knownRoots ?? []).some(
      (root) => !isThisRoot(root) && overlaps(root),
    )
  ) {
    return 'overlaps_workspace_paths';
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
  occupancy?: WorkspaceRootOccupancy;
}): WorkspaceRootResolution {
  const { context, occupancy } = input;
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
  const fallbackReason = checkWorkspaceRootCandidate(
    requested,
    context,
    occupancy,
  );
  if (!fallbackReason) {
    return {
      effective: canonicalizePath(requested),
      source,
      configured,
      requested,
      fallbackReason: null,
      fallbackWarning: null,
    };
  }
  const fallback = path.join(context.home, FALLBACK_WORKSPACE_ROOT_NAME);
  return {
    effective: canonicalizePath(fallback),
    source,
    configured,
    requested,
    fallbackReason,
    fallbackWarning: checkWorkspaceRootCandidate(fallback, context, occupancy),
  };
}

export function workspaceRootContext(): WorkspaceRootContext {
  return { home: os.homedir(), installDir: path.dirname(DATA_DIR) };
}

/**
 * `occupancy` (what existing workspaces use, src/workspace-dir.ts
 * getWorkspaceRootOccupancy) lets the effective root avoid them; without it
 * only the path itself is checked.
 */
export function getWorkspaceRootResolution(
  occupancy?: WorkspaceRootOccupancy,
): WorkspaceRootResolution {
  return resolveWorkspaceRoot({
    configured: getSystemSettings().workspaceRoot,
    env: process.env[WORKSPACE_ROOT_ENV],
    context: workspaceRootContext(),
    occupancy,
  });
}

/**
 * Where new Host workspaces actually go: the effective root, or null when
 * even the fallback has a problem (they stay in data/groups/<folder>). The
 * server's resolver (index.ts) and every route reporting the root use this.
 */
export function rootForNewWorkspaces(
  resolution: WorkspaceRootResolution,
): string | null {
  return resolution.fallbackWarning ? null : resolution.effective;
}

/** rootForNewWorkspaces of the current resolution. */
export function getRootForNewWorkspaces(
  occupancy?: WorkspaceRootOccupancy,
): string | null {
  return rootForNewWorkspaces(getWorkspaceRootResolution(occupancy));
}

/**
 * Validate a value an admin wants to store. '' clears the setting. Returns
 * the problem, or null when the value can be saved.
 */
export function validateWorkspaceRootSetting(
  value: string,
  occupancy: WorkspaceRootOccupancy = {},
  context: WorkspaceRootContext = workspaceRootContext(),
): WorkspaceRootProblem | null {
  if (!value.trim()) return null;
  return checkWorkspaceRootCandidate(value, context, occupancy);
}

/** Create the effective root (0700, marked as HappyClaw's) and return it. */
export function ensureWorkspaceRootDir(
  resolution: WorkspaceRootResolution = getWorkspaceRootResolution(),
): string {
  return ensureMarkedWorkspaceRoot(resolution.effective);
}
