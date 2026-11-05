/**
 * Network storage sources: NFS exports and SMB shares that the deployment's
 * mount allowlist declares, and that workspaces mount by id.
 *
 * The split follows the usual storage-class model: an administrator owns the
 * server, export or share, credentials and the read-write ceiling; a workspace
 * only picks a source, an optional directory inside it and read-only or not.
 * Docker's own `local` volume driver performs the mount inside the daemon's
 * kernel, so the container never needs CAP_SYS_ADMIN and a remount on the host
 * cannot leave it with a stale handle.
 *
 * Credentials never enter this config, the database, docker argv or logs: an
 * SMB password is read from a 0600 file only when a container starts, and
 * handed to the Docker Engine API in a request body (see storage-volumes.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

import { NFS_VOLUME_OPTIONS } from './host-nfs-mounts.js';
import type {
  AdditionalMount,
  CifsStorageSource,
  MountAllowlist,
  NfsStorageSource,
  StorageSource,
  StorageSourceMount,
} from './types.js';

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Host names, IPv4 and bare IPv6 addresses; nothing that could end an option.
const SERVER_RE =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:.]{2,45})$/;
const SHARE_RE = /^[^\\/:*?"<>|,\u0000-\u001f\u007f]{1,80}$/;
const CREDENTIAL_NAME_RE = /^[^,=\s\u0000-\u001f\u007f]{1,256}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const NFS_VERSIONS = new Set(['3', '4', '4.1', '4.2']);
const SMB_VERSIONS = new Set(['2.1', '3.0', '3.1.1']);
const MAX_STORAGE_SOURCES = 32;
const MAX_PASSWORD_FILE_BYTES = 4096;

export function isStorageSourceMount(
  mount: AdditionalMount,
): mount is StorageSourceMount {
  return 'source' in mount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  entry: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${where}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredString(
  entry: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = optionalString(entry, key, where);
  if (value === undefined) throw new Error(`${where}.${key} is required`);
  return value;
}

function checkAbsoluteExport(value: string, where: string): string {
  if (
    !value.startsWith('/') ||
    CONTROL_CHARS_RE.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(
      `${where}.exportPath must be an absolute path without . or .. components`,
    );
  }
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function parseStorageSource(raw: unknown, index: number): StorageSource {
  const where = `storageSources[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  const common = ['id', 'type', 'allowReadWrite', 'description'];
  const allowedKeys =
    raw.type === 'nfs'
      ? [...common, 'server', 'exportPath', 'nfsVersion']
      : raw.type === 'cifs'
        ? [
            ...common,
            'server',
            'share',
            'username',
            'domain',
            'passwordFile',
            'smbVersion',
          ]
        : null;
  if (!allowedKeys) throw new Error(`${where}.type must be "nfs" or "cifs"`);
  const unknown = Object.keys(raw).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${where} contains unknown fields: ${unknown.join(', ')}`);
  }

  const id = requiredString(raw, 'id', where);
  if (!SOURCE_ID_RE.test(id)) {
    throw new Error(
      `${where}.id must be 1-63 lowercase letters, digits or hyphens`,
    );
  }
  if (typeof raw.allowReadWrite !== 'boolean') {
    throw new Error(`${where}.allowReadWrite must be a boolean`);
  }
  const description = raw.description;
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(`${where}.description must be a string`);
  }
  const server = requiredString(raw, 'server', where);
  if (!SERVER_RE.test(server)) {
    throw new Error(`${where}.server must be a host name or IP address`);
  }
  const base = { id, allowReadWrite: raw.allowReadWrite, description, server };

  if (raw.type === 'nfs') {
    const nfsVersion = optionalString(raw, 'nfsVersion', where);
    if (nfsVersion !== undefined && !NFS_VERSIONS.has(nfsVersion)) {
      throw new Error(`${where}.nfsVersion must be one of 3, 4, 4.1, 4.2`);
    }
    return {
      ...base,
      type: 'nfs',
      exportPath: checkAbsoluteExport(
        requiredString(raw, 'exportPath', where),
        where,
      ),
      ...(nfsVersion
        ? { nfsVersion: nfsVersion as NfsStorageSource['nfsVersion'] }
        : {}),
    };
  }

  const share = requiredString(raw, 'share', where);
  if (!SHARE_RE.test(share)) {
    throw new Error(`${where}.share must be a plain SMB share name`);
  }
  const username = optionalString(raw, 'username', where);
  const domain = optionalString(raw, 'domain', where);
  for (const [key, value] of [
    ['username', username],
    ['domain', domain],
  ] as const) {
    if (value !== undefined && !CREDENTIAL_NAME_RE.test(value)) {
      throw new Error(
        `${where}.${key} must not contain commas, equals signs or spaces`,
      );
    }
  }
  const passwordFile = optionalString(raw, 'passwordFile', where);
  if (passwordFile !== undefined && !username) {
    throw new Error(`${where}.passwordFile requires a username`);
  }
  const smbVersion = optionalString(raw, 'smbVersion', where);
  if (smbVersion !== undefined && !SMB_VERSIONS.has(smbVersion)) {
    throw new Error(`${where}.smbVersion must be one of 2.1, 3.0, 3.1.1`);
  }
  return {
    ...base,
    type: 'cifs',
    share,
    ...(username ? { username } : {}),
    ...(domain ? { domain } : {}),
    ...(passwordFile ? { passwordFile } : {}),
    ...(smbVersion
      ? { smbVersion: smbVersion as CifsStorageSource['smbVersion'] }
      : {}),
  };
}

/** Validates the allowlist's optional `storageSources` list. */
export function parseStorageSources(raw: unknown): StorageSource[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('storageSources must be an array');
  if (raw.length > MAX_STORAGE_SOURCES) {
    throw new Error(`storageSources exceeds ${MAX_STORAGE_SOURCES} entries`);
  }
  const sources = raw.map(parseStorageSource);
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) {
      throw new Error(`storageSources has a duplicate id "${source.id}"`);
    }
    seen.add(source.id);
  }
  return sources;
}

/**
 * Normalizes the directory a workspace picks inside a source. Empty means the
 * export or share itself.
 */
export function normalizeStorageSubPath(input: string | undefined): string {
  if (input === undefined || input === '') return '';
  if (input !== input.trim()) {
    throw new Error('subPath must not have leading or trailing whitespace');
  }
  if (input.length > 1024) throw new Error('subPath exceeds 1024 characters');
  if (CONTROL_CHARS_RE.test(input) || input.includes('\\')) {
    throw new Error(
      'subPath must not contain control characters or backslashes',
    );
  }
  if (input.startsWith('/')) throw new Error('subPath must be relative');
  const components = input.replace(/\/+$/, '').split('/');
  if (components.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('subPath contains an empty or traversal component');
  }
  return components.join('/');
}

/** What Docker mounts for one validated storage-source mount. */
export type ResolvedStorage =
  | {
      type: 'nfs';
      server: string;
      /** Export subdirectory, e.g. `/export/sub`. */
      device: string;
      options: string;
    }
  | {
      type: 'cifs';
      sourceId: string;
      server: string;
      /** UNC path with the subdirectory, e.g. `//server/share/sub`. */
      device: string;
      username?: string;
      domain?: string;
      passwordFile?: string;
      smbVersion: string;
    };

export function nfsMountOptions(version: string | undefined): string {
  return version && version !== '3'
    ? NFS_VOLUME_OPTIONS.replace('nfsvers=3', `nfsvers=${version}`)
    : NFS_VOLUME_OPTIONS;
}

export function resolveStorage(
  source: StorageSource,
  subPath: string,
): ResolvedStorage {
  if (source.type === 'nfs') {
    return {
      type: 'nfs',
      server: source.server,
      device: subPath
        ? path.posix.join(source.exportPath, subPath)
        : source.exportPath,
      options: nfsMountOptions(source.nfsVersion),
    };
  }
  return {
    type: 'cifs',
    sourceId: source.id,
    server: source.server,
    device: `//${source.server}/${source.share}${subPath ? `/${subPath}` : ''}`,
    ...(source.username ? { username: source.username } : {}),
    ...(source.domain ? { domain: source.domain } : {}),
    ...(source.passwordFile ? { passwordFile: source.passwordFile } : {}),
    smbVersion: source.smbVersion ?? '3.0',
  };
}

/** A log- and UI-safe label for a resolved mount. */
export function describeStorage(storage: ResolvedStorage): string {
  return storage.type === 'nfs'
    ? `nfs://${storage.server}${storage.device}`
    : `smb:${storage.device}`;
}

export interface StorageMountResolution {
  allowed: boolean;
  reason: string;
  storage?: ResolvedStorage;
  subPath?: string;
  effectiveReadonly?: boolean;
}

/** Checks one storage-source mount against the current allowlist. */
export function resolveStorageSourceMount(
  mount: StorageSourceMount,
  allowlist: MountAllowlist,
  isMain: boolean,
): StorageMountResolution {
  const source = allowlist.storageSources.find(
    (candidate) => candidate.id === mount.source,
  );
  if (!source) {
    return {
      allowed: false,
      reason: `Storage source "${mount.source}" is not in the mount allowlist`,
    };
  }
  let subPath: string;
  try {
    subPath = normalizeStorageSubPath(mount.subPath);
  } catch (err) {
    return {
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const requestedReadWrite = mount.readonly === false;
  if (requestedReadWrite && !isMain && allowlist.nonMainReadOnly) {
    return {
      allowed: false,
      reason: 'Read-write mounts are disabled for non-main workspaces',
    };
  }
  if (requestedReadWrite && !source.allowReadWrite) {
    return {
      allowed: false,
      reason: `Storage source "${source.id}" does not permit read-write mounts`,
    };
  }
  return {
    allowed: true,
    reason: `Allowed storage source "${source.id}"`,
    storage: resolveStorage(source, subPath),
    subPath,
    effectiveReadonly: !requestedReadWrite,
  };
}

/**
 * Reads an SMB password file. It must be a regular file owned by this
 * process's user and unreadable by group and others, like an SSH key.
 */
export function readPasswordFile(
  passwordFile: string,
  projectRoot: string = process.cwd(),
): string {
  const resolved = path.isAbsolute(passwordFile)
    ? passwordFile
    : path.join(projectRoot, passwordFile);
  const fd = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('is not a regular file');
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('must not be readable by group or others (chmod 600)');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('must be owned by the HappyClaw service user');
    }
    if (stat.size > MAX_PASSWORD_FILE_BYTES) throw new Error('is too large');
    const password = fs.readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (/[\r\n\u0000]/.test(password)) {
      throw new Error('must hold a single line');
    }
    // The kernel would take a doubled comma, but Docker redacts a failed
    // mount's password only up to the first comma and returns the rest in
    // the error that reaches HappyClaw's logs.
    if (password.includes(',')) {
      throw new Error('must not contain a comma');
    }
    return password;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`SMB password file ${resolved} ${reason}`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The `local` driver options for an SMB share (the password has no comma, see
 * readPasswordFile). Files
 * are opened up to every container user (the share's own ACL still applies to
 * the SMB account): CIFS without Unix extensions has no owner to map.
 */
export function cifsDriverOptions(
  storage: Extract<ResolvedStorage, { type: 'cifs' }>,
  password: string | undefined,
): { type: string; device: string; o: string } {
  const options = [`addr=${storage.server}`];
  if (storage.username) {
    options.push(`username=${storage.username}`);
    if (password !== undefined) {
      options.push(`password=${password}`);
    }
    if (storage.domain) options.push(`domain=${storage.domain}`);
  } else {
    options.push('guest');
  }
  options.push(`vers=${storage.smbVersion}`, 'file_mode=0777', 'dir_mode=0777');
  return { type: 'cifs', device: storage.device, o: options.join(',') };
}
