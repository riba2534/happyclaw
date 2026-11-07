/**
 * Administrator management of storage sources from the settings page.
 *
 * Sources added here live in data/config/storage-sources.json, and an SMB
 * password in its own 0600 file under data/config/secrets/ that the source
 * names by `passwordFile`: runtime data stays out of the git worktree and in
 * `make backup`. The service never rewrites config/mount-allowlist.json; the
 * runtime merges both lists (see loadMountAllowlist), and a source the
 * allowlist file declares is read-only here and cannot be shadowed: a Web
 * source the file takes over later is dropped on the next write.
 * Responses only ever say whether a password is set.
 *
 * Writes are serialized within the process and each one re-reads both files
 * and validates the complete merged list with the runtime parser before it
 * replaces the managed file atomically, so a rejected change leaves it as it
 * was.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, MOUNT_ALLOWLIST_PATH } from './config.js';
import { getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';
import {
  loadManagedStorageSources,
  loadMountAllowlist,
  loadMountAllowlistFile,
  MANAGED_STORAGE_SOURCES_PATH,
  parseManagedStorageSources,
} from './mount-security.js';
import { writeSecretFile } from './runtime-config.js';
import {
  isStorageSourceMount,
  parseStorageSources,
} from './storage-sources.js';
import type { StorageSource } from './types.js';

export const STORAGE_SECRET_DIR = path.join(DATA_DIR, 'config', 'secrets');

/** Where a source is defined: the allowlist file (read-only here) or Web. */
export type StorageSourceOrigin = 'allowlist' | 'web';

/** What the settings page sees of a source: never the password. */
export type StorageSourceView = Omit<StorageSource, 'passwordFile'> & {
  hasPassword: boolean;
  origin: StorageSourceOrigin;
  /** Workspaces whose additional mounts name this source. */
  usedBy: number;
  /** Of those, the ones that mount it read-write. */
  readWriteUsedBy: number;
};

export interface StorageSourceInput {
  type: 'nfs' | 'cifs';
  server: string;
  exportPath?: string;
  nfsVersion?: string;
  share?: string;
  username?: string;
  domain?: string;
  smbVersion?: string;
  allowReadWrite: boolean;
  description?: string;
  /** Write-only. Omitted keeps the current password; '' removes it. */
  password?: string;
}

export class StorageSourceAdminError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code?: string,
    /** Extra response fields, e.g. how many workspaces a change affects. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StorageSourceAdminError';
  }
}

/** A workspace whose additional mounts name a source. */
export interface StorageSourceUser {
  jid: string;
  folder: string;
  readWrite: boolean;
}

function secretPathFor(id: string): string {
  return path.join(STORAGE_SECRET_DIR, `storage-${id}`);
}

function relativeToProject(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith('..') || path.isAbsolute(relative)
    ? file
    : relative;
}

/** The allowlist file's own sources; refuses to go on when it is broken. */
function allowlistFileSources(): StorageSource[] {
  const state = loadMountAllowlistFile();
  if (state.status === 'invalid') {
    throw new StorageSourceAdminError(
      `${relativeToProject(MOUNT_ALLOWLIST_PATH)} 无法解析，修好后再管理存储源：${state.error}`,
      409,
    );
  }
  return state.status === 'ok' ? state.allowlist.storageSources : [];
}

function readManagedSources(): StorageSource[] {
  let content: string;
  try {
    content = fs.readFileSync(MANAGED_STORAGE_SOURCES_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  try {
    return parseManagedStorageSources(content);
  } catch (err) {
    throw new StorageSourceAdminError(
      `${relativeToProject(MANAGED_STORAGE_SOURCES_PATH)} 无法解析：${err instanceof Error ? err.message : String(err)}`,
      409,
    );
  }
}

/**
 * The managed sources a write keeps. An id the allowlist file declares too is
 * ignored at runtime (the file wins); the next write drops that stale copy.
 */
function readLiveManagedSources(fileSources: StorageSource[]): {
  sources: StorageSource[];
  shadowed: StorageSource[];
} {
  const fileIds = new Set(fileSources.map((source) => source.id));
  const all = readManagedSources();
  return {
    sources: all.filter((source) => !fileIds.has(source.id)),
    shadowed: all.filter((source) => fileIds.has(source.id)),
  };
}

/**
 * Deletes the managed password files of dropped stale copies, unless the
 * allowlist file's own source now names that file.
 */
function removeShadowedSecrets(
  shadowed: StorageSource[],
  fileSources: StorageSource[],
): void {
  const inUse = new Set(
    fileSources.flatMap((source) =>
      source.type === 'cifs' && source.passwordFile
        ? [path.resolve(process.cwd(), source.passwordFile)]
        : [],
    ),
  );
  for (const source of shadowed) {
    const secret = secretPathFor(source.id);
    if (!inUse.has(path.resolve(secret))) fs.rmSync(secret, { force: true });
  }
  if (shadowed.length > 0) {
    logger.info(
      { ids: shadowed.map((source) => source.id) },
      'Dropped managed storage sources the mount allowlist now declares',
    );
  }
}

function writeManagedSources(sources: StorageSource[]): void {
  // Replace the file atomically so a reader never sees a partial file.
  fs.mkdirSync(path.dirname(MANAGED_STORAGE_SOURCES_PATH), {
    recursive: true,
  });
  const tmp = `${MANAGED_STORAGE_SOURCES_PATH}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ storageSources: sources }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(tmp, MANAGED_STORAGE_SOURCES_PATH);
}

/** Every workspace that mounts a source, keyed by source id. */
function usersBySource(): Map<string, StorageSourceUser[]> {
  const users = new Map<string, StorageSourceUser[]>();
  const seen = new Set<string>();
  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    for (const mount of group.containerConfig?.additionalMounts ?? []) {
      if (!isStorageSourceMount(mount)) continue;
      const key = `${mount.source}\u0000${group.folder}`;
      const list = users.get(mount.source) ?? [];
      const readWrite = mount.readonly === false;
      if (!seen.has(key)) {
        seen.add(key);
        list.push({ jid, folder: group.folder, readWrite });
        users.set(mount.source, list);
      } else if (readWrite) {
        const existing = list.find((user) => user.folder === group.folder);
        if (existing) existing.readWrite = true;
      }
    }
  }
  return users;
}

/** Workspaces (one entry per folder) whose additional mounts name `id`. */
export function listStorageSourceUsers(id: string): StorageSourceUser[] {
  return usersBySource().get(id) ?? [];
}

function toView(
  source: StorageSource,
  origin: StorageSourceOrigin,
  users: Map<string, StorageSourceUser[]>,
): StorageSourceView {
  const { passwordFile, ...rest } =
    source.type === 'cifs' ? source : { ...source, passwordFile: undefined };
  const sourceUsers = users.get(source.id) ?? [];
  return {
    ...rest,
    hasPassword: !!passwordFile,
    origin,
    usedBy: sourceUsers.length,
    readWriteUsedBy: sourceUsers.filter((user) => user.readWrite).length,
  } as StorageSourceView;
}

export function listStorageSources(): {
  sources: StorageSourceView[];
  allowlistPath: string;
  /** Where sources added here are stored. */
  managedPath: string;
  /** Workspaces other than the main one may only mount read-only. */
  nonMainReadOnly: boolean;
  allowlistError?: string;
  managedError?: string;
} {
  const users = usersBySource();
  const allowlistPath = relativeToProject(MOUNT_ALLOWLIST_PATH);
  const managedPath = relativeToProject(MANAGED_STORAGE_SOURCES_PATH);
  const file = loadMountAllowlistFile();
  if (file.status === 'invalid') {
    return {
      sources: [],
      allowlistPath,
      managedPath,
      nonMainReadOnly: true,
      allowlistError: 'mount allowlist is invalid; see the service log',
    };
  }
  const managedError =
    loadManagedStorageSources().status === 'invalid'
      ? 'managed storage sources file is invalid; see the service log'
      : undefined;
  const allowlist = loadMountAllowlist();
  const fileIds = new Set(
    file.status === 'ok'
      ? file.allowlist.storageSources.map((source) => source.id)
      : [],
  );
  return {
    sources: (allowlist?.storageSources ?? []).map((source) =>
      toView(source, fileIds.has(source.id) ? 'allowlist' : 'web', users),
    ),
    allowlistPath,
    managedPath,
    nonMainReadOnly: allowlist?.nonMainReadOnly ?? true,
    ...(managedError ? { managedError } : {}),
  };
}

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` while no other storage source write runs in this process. The
 * task may await (for example to stop the runners that use a source) before
 * it commits.
 */
export function withStorageSourceWriteLock<T>(
  task: () => Promise<T> | T,
): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

function readOnlyError(id: string): StorageSourceAdminError {
  return new StorageSourceAdminError(
    `存储源 ${id} 在 ${relativeToProject(MOUNT_ALLOWLIST_PATH)} 中定义，只能编辑该文件`,
    409,
    'STORAGE_SOURCE_READ_ONLY',
  );
}

/** What a save does to the stored password. */
export type StoragePasswordAction = 'set' | 'removed' | 'kept' | 'none';

export interface StorageSourceSavePlan {
  source: StorageSource;
  passwordAction: StoragePasswordAction;
  /**
   * Whether a container that mounts the source keeps a mount the change no
   * longer allows (server, share, credentials, read-write revoked, ...).
   * A description-only edit does not.
   */
  changesMounts: boolean;
  /** Workspaces mounting it read-write that the change makes unstartable. */
  revokedReadWriteUsers: number;
  /** Writes the change. Call it under withStorageSourceWriteLock. */
  commit(): StorageSourceView;
}

function mountShape(source: StorageSource): string {
  const { description: _description, ...rest } = source;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Validates a create or replace of one source and returns what it would do.
 * Nothing is written until `commit()`. Call it under withStorageSourceWriteLock.
 */
export function planStorageSourceSave(
  id: string,
  input: StorageSourceInput,
  creating: boolean,
): StorageSourceSavePlan {
  const fileSources = allowlistFileSources();
  if (fileSources.some((source) => source.id === id)) {
    throw creating
      ? new StorageSourceAdminError(
          `存储源 ${id} 已在 ${relativeToProject(MOUNT_ALLOWLIST_PATH)} 中定义`,
          409,
          'STORAGE_SOURCE_READ_ONLY',
        )
      : readOnlyError(id);
  }
  const { sources, shadowed } = readLiveManagedSources(fileSources);
  const index = sources.findIndex((source) => source.id === id);
  if (creating && index >= 0) {
    throw new StorageSourceAdminError(`存储源 ${id} 已存在`, 409);
  }
  if (!creating && index < 0) {
    throw new StorageSourceAdminError(`存储源 ${id} 不存在`, 404);
  }
  const previous = index >= 0 ? sources[index] : undefined;
  const previousPasswordFile =
    previous?.type === 'cifs' ? previous.passwordFile : undefined;

  const raw: Record<string, unknown> = {
    id,
    type: input.type,
    server: input.server,
    allowReadWrite: input.allowReadWrite,
    ...(input.description?.trim()
      ? { description: input.description.trim() }
      : {}),
  };
  // The new password to write; undefined leaves the secret file alone.
  let secretToWrite: string | undefined;
  if (input.type === 'nfs') {
    raw.exportPath = input.exportPath;
    if (input.nfsVersion) raw.nfsVersion = input.nfsVersion;
  } else {
    raw.share = input.share;
    if (input.username) raw.username = input.username;
    if (input.domain) raw.domain = input.domain;
    if (input.smbVersion) raw.smbVersion = input.smbVersion;
    if (input.password === undefined) {
      // A guest share (no username) has no password; drop the stored one.
      if (previousPasswordFile && input.username) {
        raw.passwordFile = previousPasswordFile;
      }
    } else if (input.password !== '') {
      if (/[\r\n\u0000,]/.test(input.password)) {
        throw new StorageSourceAdminError('SMB 密码不能包含逗号或换行');
      }
      if (!input.username) {
        throw new StorageSourceAdminError('设置密码时必须填写用户名');
      }
      secretToWrite = input.password;
      raw.passwordFile = relativeToProject(secretPathFor(id));
    }
  }

  let parsed: StorageSource;
  try {
    parsed = parseStorageSources([raw])[0];
  } catch (err) {
    throw new StorageSourceAdminError(
      err instanceof Error ? err.message : String(err),
    );
  }
  const nextSources = [...sources];
  if (index >= 0) nextSources[index] = parsed;
  else nextSources.push(parsed);
  // The merged list must still parse (unique ids, size limit).
  try {
    parseStorageSources([...fileSources, ...nextSources]);
  } catch (err) {
    throw new StorageSourceAdminError(
      err instanceof Error ? err.message : String(err),
    );
  }

  const nextPasswordFile =
    parsed.type === 'cifs' ? parsed.passwordFile : undefined;
  const passwordAction: StoragePasswordAction =
    secretToWrite !== undefined
      ? 'set'
      : previousPasswordFile && !nextPasswordFile
        ? 'removed'
        : previousPasswordFile
          ? 'kept'
          : 'none';
  const users = listStorageSourceUsers(id);
  const revokesReadWrite = !!previous?.allowReadWrite && !parsed.allowReadWrite;
  const changesMounts =
    !!previous &&
    (revokesReadWrite ||
      passwordAction === 'set' ||
      passwordAction === 'removed' ||
      mountShape({ ...previous, allowReadWrite: parsed.allowReadWrite }) !==
        mountShape(parsed));

  return {
    source: parsed,
    passwordAction,
    changesMounts,
    revokedReadWriteUsers: revokesReadWrite
      ? users.filter((user) => user.readWrite).length
      : 0,
    commit: () => {
      if (secretToWrite !== undefined) {
        fs.mkdirSync(STORAGE_SECRET_DIR, { recursive: true, mode: 0o700 });
        fs.chmodSync(STORAGE_SECRET_DIR, 0o700);
        writeSecretFile(secretPathFor(id), `${secretToWrite}\n`);
      }
      writeManagedSources(nextSources);
      // Only the file this page manages is removed; a hand-written
      // passwordFile elsewhere stays where it is.
      if (passwordAction === 'removed') {
        fs.rmSync(secretPathFor(id), { force: true });
      }
      removeShadowedSecrets(shadowed, fileSources);
      return toView(parsed, 'web', usersBySource());
    },
  };
}

/** Creates or replaces one source without stopping any runner. */
export function saveStorageSource(
  id: string,
  input: StorageSourceInput,
  creating: boolean,
): Promise<StorageSourceView> {
  return withStorageSourceWriteLock(() =>
    planStorageSourceSave(id, input, creating).commit(),
  );
}

export interface StorageSourceDeletePlan {
  source: StorageSource;
  /** Removes the source and its password file. */
  commit(): void;
}

/**
 * Validates removing a source. Workspaces using it stop starting. Call it
 * under withStorageSourceWriteLock.
 */
export function planStorageSourceDelete(id: string): StorageSourceDeletePlan {
  const fileSources = allowlistFileSources();
  if (fileSources.some((source) => source.id === id)) {
    throw readOnlyError(id);
  }
  const { sources, shadowed } = readLiveManagedSources(fileSources);
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) {
    throw new StorageSourceAdminError(`存储源 ${id} 不存在`, 404);
  }
  return {
    source,
    commit: () => {
      writeManagedSources(sources.filter((candidate) => candidate.id !== id));
      fs.rmSync(secretPathFor(id), { force: true });
      removeShadowedSecrets(shadowed, fileSources);
    },
  };
}

/** Removes a source without stopping any runner. */
export function deleteStorageSource(id: string): Promise<StorageSource> {
  return withStorageSourceWriteLock(() => {
    const plan = planStorageSourceDelete(id);
    plan.commit();
    return plan.source;
  });
}
