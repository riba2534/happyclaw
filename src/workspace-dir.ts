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
 * only the parents of recorded directories count as roots.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { isValidWorkspaceFolderName } from './workspace-folder.js';

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

/** v89 -> v90: one row per workspace folder that has a recorded directory. */
export function initWorkspaceDirStore(db: SqliteDatabase | null): void {
  db?.exec(`
    CREATE TABLE IF NOT EXISTS workspace_workdirs (
      folder TEXT PRIMARY KEY,
      workdir TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  database = db;
  statements.clear();
}

export function getRecordedWorkdir(folder: string): string | null {
  const row = statement(
    'SELECT workdir FROM workspace_workdirs WHERE folder = ?',
  )?.get(folder) as { workdir: string } | undefined;
  return row?.workdir ?? null;
}

/** The workspace's directory: the recorded one, else data/groups/<folder>. */
export function workspaceDirOf(folder: string): string {
  return getRecordedWorkdir(folder) ?? path.join(GROUPS_DIR, folder);
}

/**
 * Run logs: data/groups/<folder>/logs as before, data/logs/<folder> for a
 * recorded directory, which belongs to the user and gets no system files.
 */
export function workspaceLogsDirOf(folder: string): string {
  return getRecordedWorkdir(folder)
    ? path.join(DATA_DIR, 'logs', folder)
    : path.join(GROUPS_DIR, folder, 'logs');
}

export function listRecordedWorkdirs(): Array<{
  folder: string;
  workdir: string;
}> {
  return (statement(
    'SELECT folder, workdir FROM workspace_workdirs ORDER BY folder',
  )?.all() ?? []) as Array<{ folder: string; workdir: string }>;
}

/**
 * Give a new Host workspace without a custom directory its directory in the
 * workspace root and create it. A folder that already has a directory keeps
 * it: a recorded one, or files already in data/groups/<folder> (a folder
 * re-registered from before). Returns the workspace's directory.
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
    'INSERT INTO workspace_workdirs (folder, workdir, created_at) VALUES (?, ?, ?)',
  );
  if (!insert || !rootResolver) return legacy;
  const root = rootResolver();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const workdir = path.join(root, folder);
  fs.mkdirSync(workdir, { recursive: true });
  insert.run(folder, workdir, new Date().toISOString());
  return workdir;
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

function realpathOrResolved(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Directories that hold recorded workspace directories: the effective root
 * and the parent of every recorded directory (roots used before a change).
 * Real paths. One workspace must never mount or browse into these.
 */
export function workspaceRootDirs(): string[] {
  const roots = new Set<string>(
    rootResolver ? [realpathOrResolved(rootResolver())] : [],
  );
  for (const { workdir } of listRecordedWorkdirs()) {
    roots.add(realpathOrResolved(path.dirname(workdir)));
  }
  return [...roots];
}

export class UnsafeWorkdirError extends Error {
  constructor(
    readonly folder: string,
    readonly workdir: string,
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
 * may be. Fails closed: anything that does not look exactly like a directory
 * HappyClaw made for this folder in a known root is refused. A missing
 * directory is fine (nothing to remove).
 */
export function checkRecordedWorkdirRemoval(
  folder: string,
  workdir: string,
): string | null {
  if (!isValidWorkspaceFolderName(folder)) return 'invalid_folder';
  if (!path.isAbsolute(workdir) || path.normalize(workdir) !== workdir) {
    return 'not_normalized';
  }
  if (path.basename(workdir) !== folder) return 'basename_mismatch';

  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(workdir);
  } catch {
    stat = null;
  }
  if (stat && !stat.isDirectory()) return 'not_directory';

  const realParent = realpathOrResolved(path.dirname(workdir));
  const realWorkdir = stat
    ? realpathOrResolved(workdir)
    : path.join(realParent, folder);
  if (realWorkdir !== path.join(realParent, folder)) return 'symlink_escape';

  const otherParents = listRecordedWorkdirs()
    .filter((row) => row.folder !== folder)
    .map((row) => realpathOrResolved(path.dirname(row.workdir)));
  const knownRoots = new Set([
    ...(rootResolver ? [realpathOrResolved(rootResolver())] : []),
    ...otherParents,
  ]);
  if (!knownRoots.has(realParent)) return 'outside_known_root';

  const installDir = realpathOrResolved(path.dirname(DATA_DIR));
  if (isWithin(installDir, realWorkdir) || isWithin(realWorkdir, installDir)) {
    return 'install_dir';
  }

  const customCwds = (statement(
    "SELECT custom_cwd FROM registered_groups WHERE custom_cwd IS NOT NULL AND custom_cwd != ''",
  )?.all() ?? []) as Array<{ custom_cwd: string }>;
  for (const { custom_cwd } of customCwds) {
    const real = realpathOrResolved(custom_cwd);
    if (isWithin(real, realWorkdir) || isWithin(realWorkdir, real)) {
      return 'custom_cwd';
    }
  }
  return null;
}

export function assertRecordedWorkdirRemovable(
  folder: string,
  workdir: string,
): void {
  const reason = checkRecordedWorkdirRemoval(folder, workdir);
  if (reason) throw new UnsafeWorkdirError(folder, workdir, reason);
}
