/**
 * Administrator management of the mount allowlist's storage sources.
 *
 * The allowlist file stays the single source of truth: the Web settings page
 * edits its `storageSources` list in place, keeping every other field as it
 * was, and an SMB password goes to its own 0600 file under config/secrets/
 * that the source names by `passwordFile`. Responses only ever say whether a
 * password is set.
 *
 * Writes are serialized within the process and each one re-reads the file,
 * validates the complete result with the same parser the runtime uses, and
 * replaces the file atomically, so a hand edit made in between is kept and a
 * rejected change leaves the file untouched.
 */
import fs from 'node:fs';
import path from 'node:path';

import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { getAllRegisteredGroups } from './db.js';
import { loadMountAllowlist } from './mount-security.js';
import { writeSecretFile } from './runtime-config.js';
import {
  isStorageSourceMount,
  parseStorageSources,
} from './storage-sources.js';
import type { StorageSource } from './types.js';

export const STORAGE_SECRET_DIR = path.join(
  path.dirname(MOUNT_ALLOWLIST_PATH),
  'secrets',
);

/** What the settings page sees of a source: never the password. */
export type StorageSourceView = Omit<StorageSource, 'passwordFile'> & {
  hasPassword: boolean;
  /** Workspaces whose additional mounts name this source. */
  usedBy: number;
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
  ) {
    super(message);
    this.name = 'StorageSourceAdminError';
  }
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

function readAllowlistDocument(): Record<string, unknown> {
  let content: string;
  try {
    content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // No allowlist yet: start one that grants no host directories.
    return { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true };
  }
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StorageSourceAdminError('mount allowlist is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function writeAllowlistDocument(document: Record<string, unknown>): void {
  // The file is read by the service on every validation; keep its mode and
  // replace it atomically so a reader never sees a partial file.
  const tmp = `${MOUNT_ALLOWLIST_PATH}.tmp-${process.pid}`;
  let mode = 0o644;
  try {
    mode = fs.statSync(MOUNT_ALLOWLIST_PATH).mode & 0o777;
  } catch {
    fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true });
  }
  fs.writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`, { mode });
  fs.renameSync(tmp, MOUNT_ALLOWLIST_PATH);
}

function currentSources(document: Record<string, unknown>): StorageSource[] {
  try {
    return parseStorageSources(document.storageSources);
  } catch (err) {
    throw new StorageSourceAdminError(
      `mount allowlist storageSources is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function usageCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of Object.values(getAllRegisteredGroups())) {
    const seen = new Set<string>();
    for (const mount of group.containerConfig?.additionalMounts ?? []) {
      if (isStorageSourceMount(mount) && !seen.has(mount.source)) {
        seen.add(mount.source);
        counts.set(mount.source, (counts.get(mount.source) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function toView(source: StorageSource, counts: Map<string, number>) {
  const { passwordFile, ...rest } =
    source.type === 'cifs' ? source : { ...source, passwordFile: undefined };
  return {
    ...rest,
    hasPassword: !!passwordFile,
    usedBy: counts.get(source.id) ?? 0,
  } as StorageSourceView;
}

export function listStorageSources(): {
  sources: StorageSourceView[];
  allowlistPath: string;
  /** Workspaces other than the main one may only mount read-only. */
  nonMainReadOnly: boolean;
  allowlistError?: string;
} {
  const counts = usageCounts();
  const allowlistPath = relativeToProject(MOUNT_ALLOWLIST_PATH);
  if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
    return { sources: [], allowlistPath, nonMainReadOnly: true };
  }
  const allowlist = loadMountAllowlist();
  if (!allowlist) {
    return {
      sources: [],
      allowlistPath,
      nonMainReadOnly: true,
      allowlistError: 'mount allowlist is invalid; see the service log',
    };
  }
  return {
    sources: allowlist.storageSources.map((source) => toView(source, counts)),
    allowlistPath,
    nonMainReadOnly: allowlist.nonMainReadOnly,
  };
}

let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => T): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

/** Creates or replaces one source. */
export function saveStorageSource(
  id: string,
  input: StorageSourceInput,
  creating: boolean,
): Promise<StorageSourceView> {
  return serialized(() => {
    const document = readAllowlistDocument();
    const sources = currentSources(document);
    const index = sources.findIndex((source) => source.id === id);
    if (creating && index >= 0) {
      throw new StorageSourceAdminError(`存储源 ${id} 已存在`, 409);
    }
    if (!creating && index < 0) {
      throw new StorageSourceAdminError(`存储源 ${id} 不存在`, 404);
    }
    const previous = index >= 0 ? sources[index] : undefined;

    const raw: Record<string, unknown> = {
      id,
      type: input.type,
      server: input.server,
      allowReadWrite: input.allowReadWrite,
      ...(input.description?.trim()
        ? { description: input.description.trim() }
        : {}),
    };
    let secretToWrite: string | null | undefined;
    if (input.type === 'nfs') {
      raw.exportPath = input.exportPath;
      if (input.nfsVersion) raw.nfsVersion = input.nfsVersion;
      secretToWrite = previous?.type === 'cifs' ? null : undefined;
    } else {
      raw.share = input.share;
      if (input.username) raw.username = input.username;
      if (input.domain) raw.domain = input.domain;
      if (input.smbVersion) raw.smbVersion = input.smbVersion;
      const keptPassword =
        previous?.type === 'cifs' && previous.passwordFile ? previous : null;
      if (input.password === undefined) {
        if (keptPassword && input.username) {
          raw.passwordFile = keptPassword.passwordFile;
        } else if (keptPassword) {
          // A guest share has no password; drop the stored one.
          secretToWrite = null;
        }
      } else if (input.password === '') {
        secretToWrite = null;
      } else {
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

    const nextSources = [...sources];
    let parsed: StorageSource;
    try {
      parsed = parseStorageSources([raw])[0];
    } catch (err) {
      throw new StorageSourceAdminError(
        err instanceof Error ? err.message : String(err),
      );
    }
    if (index >= 0) nextSources[index] = parsed;
    else nextSources.push(parsed);
    // The full list must still parse (ids, size limit).
    try {
      parseStorageSources(nextSources);
    } catch (err) {
      throw new StorageSourceAdminError(
        err instanceof Error ? err.message : String(err),
      );
    }

    if (typeof secretToWrite === 'string') {
      fs.mkdirSync(STORAGE_SECRET_DIR, { recursive: true, mode: 0o700 });
      writeSecretFile(secretPathFor(id), `${secretToWrite}\n`);
    }
    writeAllowlistDocument({ ...document, storageSources: nextSources });
    if (secretToWrite === null) {
      fs.rmSync(secretPathFor(id), { force: true });
    }
    return toView(parsed, usageCounts());
  });
}

/** Removes a source and its password file. Workspaces using it stop starting. */
export function deleteStorageSource(id: string): Promise<void> {
  return serialized(() => {
    const document = readAllowlistDocument();
    const sources = currentSources(document);
    if (!sources.some((source) => source.id === id)) {
      throw new StorageSourceAdminError(`存储源 ${id} 不存在`, 404);
    }
    writeAllowlistDocument({
      ...document,
      storageSources: sources.filter((source) => source.id !== id),
    });
    fs.rmSync(secretPathFor(id), { force: true });
  });
}
