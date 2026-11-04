/**
 * Where a workspace's files live. A Host workspace created without a custom
 * directory since v90 records its directory here (`<workspace root>/<folder>`,
 * src/workspace-root.ts); every other workspace (Container workspaces and
 * everything created before v90) has no record and keeps using
 * data/groups/<folder>. The record is what keeps a workspace in place when
 * the workspace root changes later.
 *
 * db.ts binds the connection (like session-worktree-store.ts); while unbound
 * nothing is recorded, so every workspace resolves to data/groups/<folder>.
 * The workspace root comes from a resolver the server binds at startup
 * (setWorkspaceRootResolver): db.ts, which creates home workspaces, must not
 * import runtime-config.ts. While unbound no new directory is recorded and
 * only the roots of recorded directories count as roots.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { isValidWorkspaceFolderName } from './workspace-folder.js';
import type { WorkspaceRootOccupancy } from './workspace-root.js';
import {
  canonicalizePath,
  ensureMarkedWorkspaceRoot,
  isPathInside,
  pathsOverlap,
} from './workspace-root-fs.js';

/** A workspace's recorded directory and the root it was created in. */
export interface RecordedWorkdir {
  folder: string;
  workdir: string;
  root: string;
}

let rootResolver: (() => string) | null = null;

/** Bind how the effective workspace root is resolved (workspace-root.ts). */
export function setWorkspaceRootResolver(
  resolver: (() => string) | null,
): void {
  rootResolver = resolver;
}

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

let database: SqliteDatabase | null = null;
const statements = new Map<string, SqliteStatement>();

function statement(sql: string): SqliteStatement | null {
  if (!database) return null;
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = database.prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
}

/**
 * v89 -> v90: one row per workspace folder that has a recorded directory,
 * with the workspace root it was created in (`workdir` = `root`/`folder`).
 * The root is what a delete is checked against, and what keeps an old root
 * protected after the setting changes.
 */
export function initWorkspaceDirStore(db: SqliteDatabase | null): void {
  db?.exec(`
    CREATE TABLE IF NOT EXISTS workspace_workdirs (
      folder TEXT PRIMARY KEY,
      workdir TEXT NOT NULL UNIQUE,
      root TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  database = db;
  statements.clear();
}

export function getRecordedWorkdirRecord(
  folder: string,
): RecordedWorkdir | null {
  const row = statement(
    'SELECT folder, workdir, root FROM workspace_workdirs WHERE folder = ?',
  )?.get(folder) as RecordedWorkdir | undefined;
  return row ?? null;
}

export function getRecordedWorkdir(folder: string): string | null {
  return getRecordedWorkdirRecord(folder)?.workdir ?? null;
}

/** The workspace's directory: the recorded one, else data/groups/<folder>. */
export function workspaceDirOf(folder: string): string {
  return getRecordedWorkdir(folder) ?? path.join(GROUPS_DIR, folder);
}

/** Where the run logs of a workspace with a recorded directory go. */
export function recordedWorkdirLogsDir(folder: string): string {
  return path.join(DATA_DIR, 'logs', folder);
}

/**
 * Run logs: data/groups/<folder>/logs as before, data/logs/<folder> for a
 * recorded directory, which belongs to the user and gets no system files.
 */
export function workspaceLogsDirOf(folder: string): string {
  return getRecordedWorkdir(folder)
    ? recordedWorkdirLogsDir(folder)
    : path.join(GROUPS_DIR, folder, 'logs');
}

/** Create the workspace's directory and its logs directory. */
export function ensureWorkspaceDirs(folder: string): void {
  const recorded = getRecordedWorkdir(folder);
  fs.mkdirSync(recorded ?? path.join(GROUPS_DIR, folder, 'logs'), {
    recursive: true,
  });
  if (recorded) {
    fs.mkdirSync(recordedWorkdirLogsDir(folder), { recursive: true });
  }
}

function listRecordedRoots(): string[] {
  return (
    (statement('SELECT DISTINCT root FROM workspace_workdirs')?.all() ??
      []) as Array<{ root: string }>
  ).map((row) => row.root);
}

function listRecordedWorkdirs(): RecordedWorkdir[] {
  return (statement(
    'SELECT folder, workdir, root FROM workspace_workdirs ORDER BY folder',
  )?.all() ?? []) as RecordedWorkdir[];
}

/** Host paths existing workspaces use as their custom directory or mounts. */
function listOccupiedHostPaths(): string[] {
  const rows = (statement(
    `SELECT custom_cwd, container_config FROM registered_groups
     WHERE (custom_cwd IS NOT NULL AND custom_cwd != '')
        OR container_config IS NOT NULL`,
  )?.all() ?? []) as Array<{
    custom_cwd: string | null;
    container_config: string | null;
  }>;
  const paths: string[] = [];
  for (const row of rows) {
    if (row.custom_cwd) paths.push(row.custom_cwd);
    if (!row.container_config) continue;
    try {
      const config = JSON.parse(row.container_config) as {
        additionalMounts?: Array<{ hostPath?: unknown }>;
      };
      for (const mount of config.additionalMounts ?? []) {
        if (typeof mount?.hostPath === 'string') paths.push(mount.hostPath);
      }
    } catch {
      /* unreadable config: it mounts nothing */
    }
  }
  return paths;
}

/**
 * What existing workspaces use, for choosing or validating a workspace root
 * (workspace-root.ts): a root overlapping any of it would put one
 * workspace's directory inside another's, deleted along with it.
 */
export function getWorkspaceRootOccupancy(): WorkspaceRootOccupancy {
  return {
    occupiedPaths: listOccupiedHostPaths(),
    workdirs: listRecordedWorkdirs().map(({ workdir, root }) => ({
      workdir,
      root,
    })),
    knownRoots: listRecordedRoots(),
  };
}

/** An existing, real (not linked) directory with nothing in it. */
function isEmptyDirectory(target: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return stat.isDirectory() && fs.readdirSync(target).length === 0;
  } catch {
    return false;
  }
}

/**
 * Give a new Host workspace without a custom directory its directory in the
 * workspace root and create it. A folder that already has a directory keeps
 * it: a recorded one, or files already in data/groups/<folder> (a folder
 * re-registered from before). `<root>/<folder>` is created exclusively; one
 * that already exists is adopted only while it is an empty directory, since
 * deleting the workspace later deletes it. Otherwise nothing is recorded and
 * the workspace uses data/groups/<folder>. Returns the workspace's directory.
 */
export function assignWorkspaceRootDir(folder: string): string {
  if (!isValidWorkspaceFolderName(folder)) {
    throw new Error(`Invalid workspace folder: ${folder}`);
  }
  const existing = getRecordedWorkdir(folder);
  if (existing) return existing;
  const legacy = path.join(GROUPS_DIR, folder);
  if (fs.existsSync(legacy)) return legacy;
  const insert = statement(
    'INSERT INTO workspace_workdirs (folder, workdir, root, created_at) VALUES (?, ?, ?, ?)',
  );
  if (!insert || !rootResolver) return legacy;
  // Creating a workspace never fails over its directory: anything wrong
  // with the root leaves the workspace in data/groups/<folder>.
  let root = '';
  let workdir = '';
  try {
    root = ensureMarkedWorkspaceRoot(rootResolver());
    workdir = path.join(root, folder);
    fs.mkdirSync(workdir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' || !isEmptyDirectory(workdir)) {
      logger.warn(
        { folder, workdir, err },
        code === 'EEXIST'
          ? 'The workspace root already has this path with content; the workspace stays in data/groups'
          : 'Could not create the workspace directory in the workspace root; the workspace stays in data/groups',
      );
      return legacy;
    }
  }
  insert.run(folder, workdir, root, new Date().toISOString());
  return workdir;
}

/**
 * The one rule for who gets a directory in the workspace root: a Web
 * workspace (not an IM chat row sharing its folder) running on the host
 * without a custom directory.
 */
export function assignWorkspaceRootDirIfNew(
  jid: string,
  group: { folder: string; executionMode?: string; customCwd?: string },
): void {
  if (
    jid.startsWith('web:') &&
    group.executionMode === 'host' &&
    !group.customCwd
  ) {
    assignWorkspaceRootDir(group.folder);
  }
}

export function deleteRecordedWorkdir(folder: string): void {
  statement('DELETE FROM workspace_workdirs WHERE folder = ?')?.run(folder);
}

/**
 * Undo assignWorkspaceRootDir for a workspace whose creation failed: forget
 * the record and remove the directory only while it is still empty.
 */
export function releaseUnusedWorkdir(folder: string): void {
  const workdir = getRecordedWorkdir(folder);
  if (!workdir) return;
  deleteRecordedWorkdir(folder);
  try {
    fs.rmdirSync(workdir);
  } catch {
    /* not empty or already gone: leave it */
  }
}

/**
 * The known workspace roots: the effective one and every root a recorded
 * directory was created in (roots used before a change). Real paths. One
 * workspace must never mount or browse into these.
 */
export function workspaceRootDirs(): string[] {
  const roots = new Set(listRecordedRoots());
  if (rootResolver) roots.add(rootResolver());
  return [...new Set([...roots].map(canonicalizePath))];
}

/** The workspace root (or one of them) `realPath` is in, or undefined. */
export function workspaceRootContaining(
  realPath: string,
  roots: string[] = workspaceRootDirs(),
): string | undefined {
  return roots.find((root) => isPathInside(realPath, root));
}

/**
 * The workspace root or recorded workspace directory `realPath` overlaps
 * either way (inside it, or containing it like `~`), or undefined. A custom
 * directory or copy source overlapping one would expose other workspaces and
 * make their directories undeletable.
 */
export function workspacePathConflict(realPath: string): string | undefined {
  return [
    ...workspaceRootDirs(),
    ...listRecordedWorkdirs().map((row) => canonicalizePath(row.workdir)),
  ].find((known) => pathsOverlap(known, realPath));
}

export class UnsafeWorkdirError extends Error {
  constructor(
    workdir: string,
    readonly reason: string,
  ) {
    super(
      `工作区目录 ${workdir} 未通过安全检查（${reason}），没有删除任何文件。`,
    );
    this.name = 'UnsafeWorkdirError';
  }
}

/**
 * Why a recorded directory must not be deleted or moved, or null when it
 * may be. Fails closed: anything that does not look exactly like the
 * directory HappyClaw made for this folder in the root it recorded is
 * refused. A missing directory is fine (nothing to remove).
 */
export function checkRecordedWorkdirRemoval(
  record: RecordedWorkdir,
): string | null {
  const { folder, workdir, root } = record;
  if (!isValidWorkspaceFolderName(folder)) return 'invalid_folder';
  if (!path.isAbsolute(workdir) || path.normalize(workdir) !== workdir) {
    return 'not_normalized';
  }
  if (path.basename(workdir) !== folder) return 'basename_mismatch';
  if (workdir !== path.join(root, folder)) return 'root_mismatch';

  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(workdir);
  } catch {
    stat = null;
  }
  // The directory itself must be a real directory, never a link to one; a
  // link in a parent is resolved here and judged by where it really points.
  if (stat?.isSymbolicLink()) return 'symlink';
  if (stat && !stat.isDirectory()) return 'not_directory';

  const realParent = canonicalizePath(path.dirname(workdir));
  const realWorkdir = path.join(realParent, folder);

  // Roots are recorded as real paths; one that resolves elsewhere now is a
  // link planted (or swapped in) since, and judged as foreign.
  if (canonicalizePath(root) !== root) return 'root_not_real';
  if (realParent !== root) return 'root_mismatch';

  const installDir = canonicalizePath(path.dirname(DATA_DIR));
  if (pathsOverlap(installDir, realWorkdir)) return 'install_dir';

  // Another workspace's directory inside this one (or around it) would go
  // with it.
  if (
    listRecordedWorkdirs().some(
      (other) =>
        other.folder !== folder &&
        pathsOverlap(canonicalizePath(other.workdir), realWorkdir),
    )
  ) {
    return 'overlaps_other_workspace';
  }

  const customCwds = (statement(
    "SELECT custom_cwd FROM registered_groups WHERE custom_cwd IS NOT NULL AND custom_cwd != ''",
  )?.all() ?? []) as Array<{ custom_cwd: string }>;
  for (const { custom_cwd } of customCwds) {
    if (pathsOverlap(canonicalizePath(custom_cwd), realWorkdir)) {
      return 'custom_cwd';
    }
  }
  return null;
}

export function assertRecordedWorkdirRemovable(record: RecordedWorkdir): void {
  const reason = checkRecordedWorkdirRemoval(record);
  if (reason) throw new UnsafeWorkdirError(record.workdir, reason);
}
