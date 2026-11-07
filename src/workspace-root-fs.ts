/**
 * File-system helpers shared by the workspace root (src/workspace-root.ts:
 * resolution and validation) and the recorded workspace directories
 * (src/workspace-dir.ts: assignment, removal, mount and browse denial). One
 * copy, so the checks cannot drift apart. No settings or database access.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Marker HappyClaw writes into a workspace root it created or adopted. */
export const WORKSPACE_ROOT_MARKER = '.happyclaw-workspace-root';

/** Real path of the nearest existing ancestor, plus the missing segments. */
export function canonicalizePath(target: string): string {
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

/** `target` is `base` or inside it. Compares path segments, not prefixes. */
export function isPathInside(target: string, base: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative === '' ||
    (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative))
  );
}

/** Either path is the other or inside it. */
export function pathsOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

export type WorkspaceRootDirState =
  | 'missing'
  | 'empty'
  | 'marked'
  | 'foreign'
  | 'not_directory';

/**
 * What is at a candidate root today. 'foreign' is a directory with content
 * HappyClaw did not put there: adopting it would make a person's own folder
 * a protected workspace root.
 */
export function workspaceRootDirState(dir: string): WorkspaceRootDirState {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return 'missing';
  }
  if (!stat.isDirectory()) return 'not_directory';
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 'foreign';
  }
  if (entries.length === 0) return 'empty';
  return entries.includes(WORKSPACE_ROOT_MARKER) ? 'marked' : 'foreign';
}

/** Create the root (0700) if needed and mark it as HappyClaw's. */
export function ensureMarkedWorkspaceRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = path.join(dir, WORKSPACE_ROOT_MARKER);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(
      marker,
      'HappyClaw creates workspace directories here. Do not delete this file.\n',
      { mode: 0o600 },
    );
  }
  return dir;
}
