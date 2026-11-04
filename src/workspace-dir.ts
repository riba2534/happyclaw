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
  const root = rootResolver();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const workdir = path.join(root, folder);
  try {
    fs.mkdirSync(workdir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!isEmptyDirectory(workdir)) {
      logger.warn(
        { folder, workdir },
        'The workspace root already has this path with content; the workspace stays in data/groups',
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
 * Real path of the nearest existing ancestor plus the missing segments, so a
 * root that does not exist yet compares the same way workspace-root.ts
 * validated it (macOS /var -> /private/var included).
 */
function realpathOrResolved(target: string): string {
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

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative === '' ||
    (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative))
  );
}

/**
 * The known workspace roots: the effective one and every root a recorded
 * directory was created in (roots used before a change). Real paths. One
 * workspace must never mount or browse into these.
 */
export function workspaceRootDirs(): string[] {
  const roots = new Set(listRecordedRoots());
  if (rootResolver) roots.add(rootResolver());
  return [...new Set([...roots].map(realpathOrResolved))];
}

/** The workspace root (or one of them) `realPath` is in, or undefined. */
export function workspaceRootContaining(
  realPath: string,
  roots: string[] = workspaceRootDirs(),
): string | undefined {
  return roots.find((root) => isWithin(root, realPath));
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

  const realParent = realpathOrResolved(path.dirname(workdir));
  const realWorkdir = path.join(realParent, folder);

  // Roots are recorded as real paths; one that resolves elsewhere now is a
  // link planted (or swapped in) since, and judged as foreign.
  if (realpathOrResolved(root) !== root) return 'root_not_real';
  if (realParent !== root) return 'root_mismatch';

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

export function assertRecordedWorkdirRemovable(record: RecordedWorkdir): void {
  const reason = checkRecordedWorkdirRemoval(record);
  if (reason) throw new UnsafeWorkdirError(record.workdir, reason);
}
