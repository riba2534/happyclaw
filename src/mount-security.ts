/**
 * Security boundary for host directories exposed to Docker workspaces.
 *
 * The deployment-owned allowlist controls which host roots are eligible. Every
 * configured mount is validated both when the workspace is created and again
 * immediately before `docker run`, so persisted configuration is never treated
 * as a durable authorization grant.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { DATA_DIR, MOUNT_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import {
  describeStorage,
  isStorageSourceMount,
  parseStorageSources,
  resolveStorageSourceMount,
  type ResolvedStorage,
} from './storage-sources.js';
import { workspaceRootDirs } from './workspace-dir.js';
import type {
  AdditionalMount,
  AllowedRoot,
  ContainerConfig,
  HostDirectoryMount,
  MountAllowlist,
  StorageSource,
} from './types.js';

export const MAX_ADDITIONAL_MOUNTS = 8;
export const ADDITIONAL_MOUNT_CONTAINER_ROOT = '/workspace/extra';

const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  '.claude',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
];

const RESERVED_CONTAINER_COMPONENTS = new Set(['.npm-global']);
const CONTAINER_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const SOCKET_COMPONENT_RE =
  /^(?:docker|podman|containerd|cri-dockerd)(?:[-._][^/]*)?\.sock$/i;

let cachedAllowlistSignature: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  const allow = new Set(allowed);
  return Object.keys(value).filter((key) => !allow.has(key));
}

function validateAllowlistShape(raw: unknown): MountAllowlist {
  if (!isRecord(raw)) throw new Error('allowlist must be an object');
  if (!Array.isArray(raw.allowedRoots)) {
    throw new Error('allowedRoots must be an array');
  }
  if (!Array.isArray(raw.blockedPatterns)) {
    throw new Error('blockedPatterns must be an array');
  }
  if (typeof raw.nonMainReadOnly !== 'boolean') {
    throw new Error('nonMainReadOnly must be a boolean');
  }

  const allowedRoots: AllowedRoot[] = raw.allowedRoots.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`allowedRoots[${index}] must be an object`);
    }
    if (typeof entry.path !== 'string' || !entry.path.trim()) {
      throw new Error(`allowedRoots[${index}].path must be a non-empty string`);
    }
    if (typeof entry.allowReadWrite !== 'boolean') {
      throw new Error(
        `allowedRoots[${index}].allowReadWrite must be a boolean`,
      );
    }
    if (
      entry.description !== undefined &&
      typeof entry.description !== 'string'
    ) {
      throw new Error(`allowedRoots[${index}].description must be a string`);
    }
    if (
      entry.nfsDirectMount !== undefined &&
      typeof entry.nfsDirectMount !== 'boolean'
    ) {
      throw new Error(
        `allowedRoots[${index}].nfsDirectMount must be a boolean`,
      );
    }
    return {
      path: entry.path.trim(),
      allowReadWrite: entry.allowReadWrite,
      description: entry.description,
      ...(entry.nfsDirectMount === true ? { nfsDirectMount: true } : {}),
    };
  });

  if (!raw.blockedPatterns.every((item) => typeof item === 'string')) {
    throw new Error('blockedPatterns must contain only strings');
  }

  return {
    allowedRoots,
    blockedPatterns: [
      ...new Set([
        ...DEFAULT_BLOCKED_PATTERNS,
        ...(raw.blockedPatterns as string[]).filter(Boolean),
      ]),
    ],
    nonMainReadOnly: raw.nonMainReadOnly,
    storageSources: parseStorageSources(raw.storageSources),
  };
}

type FileRead =
  | { signature: string; content: string }
  | { signature: string; content?: undefined; missing: boolean };

/** Reads a small config file and a signature that changes with its bytes. */
function readSignedFile(filePath: string): FileRead {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { signature: 'missing', missing: true };
  }
  const meta = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    return { signature: `${meta}:${digest}`, content };
  } catch {
    return { signature: `${meta}:unreadable`, missing: false };
  }
}

export type MountAllowlistFileState =
  | { status: 'missing' }
  | { status: 'invalid'; error: string }
  | { status: 'ok'; allowlist: MountAllowlist };

let cachedFileState: MountAllowlistFileState = { status: 'missing' };

/**
 * The deployment's own allowlist file, without the storage sources managed
 * from the settings page. Reloads when the file changes.
 */
export function loadMountAllowlistFile(): MountAllowlistFileState {
  const read = readSignedFile(MOUNT_ALLOWLIST_PATH);
  // Each state change is logged once.
  if (read.signature === cachedAllowlistSignature) return cachedFileState;
  cachedAllowlistSignature = read.signature;
  if (read.content === undefined && read.missing) {
    logger.warn(
      { path: MOUNT_ALLOWLIST_PATH },
      'Mount allowlist not found - host directory mounts are blocked',
    );
    cachedFileState = { status: 'missing' };
    return cachedFileState;
  }
  try {
    if (read.content === undefined) throw new Error('file is unreadable');
    const allowlist = validateAllowlistShape(JSON.parse(read.content));
    cachedFileState = { status: 'ok', allowlist };
    logger.info(
      {
        path: MOUNT_ALLOWLIST_PATH,
        allowedRoots: allowlist.allowedRoots.length,
        storageSources: allowlist.storageSources.length,
        blockedPatterns: allowlist.blockedPatterns.length,
      },
      'Mount allowlist loaded successfully',
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    cachedFileState = { status: 'invalid', error };
    logger.error(
      { path: MOUNT_ALLOWLIST_PATH, error },
      'Failed to load mount allowlist - host directory mounts are blocked',
    );
  }
  return cachedFileState;
}

/**
 * Storage sources added on the settings page. They live under data/ (never in
 * the git worktree) and are merged with the allowlist file's own sources.
 */
export const MANAGED_STORAGE_SOURCES_PATH = path.join(
  DATA_DIR,
  'config',
  'storage-sources.json',
);

export type ManagedStorageSourcesState =
  | { status: 'ok'; sources: StorageSource[] }
  | { status: 'invalid'; error: string };

let cachedManagedSignature: string | null = null;
let cachedManagedState: ManagedStorageSourcesState = {
  status: 'ok',
  sources: [],
};

/** Parses the managed storage source file (`{ "storageSources": [...] }`). */
export function parseManagedStorageSources(content: string): StorageSource[] {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error('file must hold a JSON object');
  const unknown = unknownKeys(parsed, ['storageSources']);
  if (unknown.length > 0) {
    throw new Error(`unknown fields: ${unknown.join(', ')}`);
  }
  return parseStorageSources(parsed.storageSources);
}

export function loadManagedStorageSources(): ManagedStorageSourcesState {
  const read = readSignedFile(MANAGED_STORAGE_SOURCES_PATH);
  if (read.signature === cachedManagedSignature) return cachedManagedState;
  cachedManagedSignature = read.signature;
  if (read.content === undefined && read.missing) {
    cachedManagedState = { status: 'ok', sources: [] };
    return cachedManagedState;
  }
  try {
    if (read.content === undefined) throw new Error('file is unreadable');
    cachedManagedState = {
      status: 'ok',
      sources: parseManagedStorageSources(read.content),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    cachedManagedState = { status: 'invalid', error };
    logger.error(
      { path: MANAGED_STORAGE_SOURCES_PATH, error },
      'Failed to load managed storage sources - they cannot be mounted',
    );
  }
  return cachedManagedState;
}

let cachedMerged: {
  file: MountAllowlistFileState;
  managed: ManagedStorageSourcesState;
  value: MountAllowlist | null;
} | null = null;

/**
 * Load the deployment policy, reloading automatically when its metadata or
 * contents change. Invalid/missing policy is fail-closed, but a later file
 * update is observed without restarting the service.
 *
 * Storage sources from the settings page are appended to the file's own; an
 * id the file declares always wins. Without an allowlist file they still
 * apply, under a policy that grants no host directories and mounts only
 * read-only outside the main workspace. A broken managed file fails closed
 * for its sources only.
 */
export function loadMountAllowlist(): MountAllowlist | null {
  const file = loadMountAllowlistFile();
  const managed = loadManagedStorageSources();
  if (cachedMerged?.file === file && cachedMerged.managed === managed) {
    return cachedMerged.value;
  }
  let value: MountAllowlist | null;
  const managedSources = managed.status === 'ok' ? managed.sources : [];
  if (file.status === 'invalid') {
    value = null;
  } else if (file.status === 'missing' && managedSources.length === 0) {
    value = null;
  } else {
    const base: MountAllowlist =
      file.status === 'ok'
        ? file.allowlist
        : {
            allowedRoots: [],
            blockedPatterns: [...DEFAULT_BLOCKED_PATTERNS],
            nonMainReadOnly: true,
            storageSources: [],
          };
    const fileIds = new Set(base.storageSources.map((source) => source.id));
    const shadowed = managedSources.filter((source) => fileIds.has(source.id));
    if (shadowed.length > 0) {
      logger.warn(
        {
          path: MANAGED_STORAGE_SOURCES_PATH,
          ids: shadowed.map((source) => source.id),
        },
        'Managed storage sources ignored: the mount allowlist declares the same id',
      );
    }
    value = {
      ...base,
      storageSources: [
        ...base.storageSources,
        ...managedSources.filter((source) => !fileIds.has(source.id)),
      ],
    };
  }
  cachedMerged = { file, managed, value };
  return value;
}

export function expandPath(value: string): string {
  const homeDir = os.homedir();
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  if (value === '~') return homeDir;
  return path.resolve(value);
}

function getRealPath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

const CASE_INSENSITIVE_FS =
  process.platform === 'darwin' || process.platform === 'win32';

export function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[],
): string | null {
  const pathParts = realPath.split(path.sep);
  if (CASE_INSENSITIVE_FS) {
    const partsLower = pathParts.map((part) => part.toLowerCase());
    const lowerPatterns = blockedPatterns.map((item) => item.toLowerCase());
    for (let i = 0; i < lowerPatterns.length; i += 1) {
      if (partsLower.includes(lowerPatterns[i])) return blockedPatterns[i];
    }
    return null;
  }
  for (const pattern of blockedPatterns) {
    if (pathParts.includes(pattern)) return pattern;
  }
  return null;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

/**
 * Select the most-specific matching root. This prevents a broad writable root
 * from overriding a nested read-only root merely because it appears first.
 */
export function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[],
): AllowedRoot | null {
  let selected: { root: AllowedRoot; realRoot: string } | null = null;
  for (const root of allowedRoots) {
    const realRoot = getRealPath(expandPath(root.path));
    if (!realRoot || !isPathWithin(realRoot, realPath)) continue;
    if (!selected || realRoot.length > selected.realRoot.length) {
      selected = { root, realRoot };
    }
  }
  return selected?.root ?? null;
}

/**
 * Real paths no mount may overlap. Building it resolves the workspace roots,
 * so a caller checking many paths (the directory browser) builds it once and
 * passes it to validateMount / isHostMountNavigationPathAllowed.
 */
export function getProtectedHostPaths(
  workspaceRoots: string[] = workspaceRootDirs(),
): string[] {
  return (
    [
      '/proc',
      '/sys',
      '/dev',
      '/run',
      '/var/run',
      '/var/lib/docker',
      '/var/lib/containerd',
      '/var/lib/containers',
      DATA_DIR,
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), '.git'),
      ...[
        '.ssh',
        '.gnupg',
        '.aws',
        '.azure',
        '.gcloud',
        '.kube',
        '.docker',
        '.claude',
      ].map((name) => path.join(os.homedir(), name)),
    ]
      .map((item) => {
        const resolved = path.resolve(item);
        // DATA_DIR and other protected locations may themselves be symlinks.
        // Compare against their canonical target whenever it exists.
        return getRealPath(resolved) ?? resolved;
      })
      // Other workspaces' directories: the workspace root and every root a
      // recorded workspace directory still lives in (already real paths).
      .concat(workspaceRoots)
  );
}

function hardDeniedHostPath(
  realPath: string,
  protectedPaths: string[] = getProtectedHostPaths(),
): string | null {
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(realPath, protectedPath)) return protectedPath;
  }

  const socketComponent = realPath
    .split(path.sep)
    .find((component) => SOCKET_COMPONENT_RE.test(component));
  return socketComponent ? `container socket "${socketComponent}"` : null;
}

/**
 * Browsing may traverse an ancestor of a protected path (for example HOME)
 * even though that ancestor itself cannot be selected as a mount. It must
 * never enter the protected path or anything beneath it.
 */
export function isHostMountNavigationPathAllowed(
  realPath: string,
  protectedPaths: string[] = getProtectedHostPaths(),
): boolean {
  for (const protectedPath of protectedPaths) {
    if (isPathWithin(protectedPath, realPath)) return false;
  }
  return !realPath
    .split(path.sep)
    .some((component) => SOCKET_COMPONENT_RE.test(component));
}

export function normalizeAdditionalMountContainerPath(input: string): string {
  if (input !== input.trim()) {
    throw new Error(
      'containerPath must not have leading or trailing whitespace',
    );
  }
  if (!input) throw new Error('containerPath must not be empty');
  if (input.length > 512) {
    throw new Error('containerPath exceeds 512 characters');
  }
  if (CONTAINER_CONTROL_CHARS_RE.test(input)) {
    throw new Error('containerPath must not contain control characters');
  }
  if (input.includes('\\') || input.includes(':')) {
    throw new Error('containerPath must not contain backslashes or colons');
  }
  if (input.startsWith('/') || input.endsWith('/')) {
    throw new Error('containerPath must be a relative suffix');
  }

  const components = input.split('/');
  if (
    components.some(
      (component) =>
        !component ||
        component === '.' ||
        component === '..' ||
        RESERVED_CONTAINER_COMPONENTS.has(component),
    )
  ) {
    throw new Error(
      'containerPath contains an empty, traversal, or reserved component',
    );
  }

  const normalized = path.posix.normalize(input);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error('containerPath escapes the additional mount root');
  }
  return normalized;
}

export interface ContainerConfigParseResult {
  config?: ContainerConfig;
  error?: string;
}

/**
 * Validate untrusted IPC/SQLite JSON shape without touching the filesystem.
 * Legacy timeout-only configs remain readable; path policy is enforced later
 * by validateAdditionalMountsStrict.
 */
export function parseContainerConfig(raw: unknown): ContainerConfigParseResult {
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) return { error: 'container_config must be an object' };

  const configUnknown = unknownKeys(raw, [
    'version',
    'timeout',
    'additionalMounts',
  ]);
  if (configUnknown.length > 0) {
    return {
      error: `container_config contains unknown fields: ${configUnknown.join(', ')}`,
    };
  }
  if (raw.version !== undefined && raw.version !== 1) {
    return { error: 'container_config.version must be 1' };
  }
  if (
    raw.timeout !== undefined &&
    (typeof raw.timeout !== 'number' ||
      !Number.isFinite(raw.timeout) ||
      raw.timeout <= 0)
  ) {
    return { error: 'container_config.timeout must be a positive number' };
  }

  let additionalMounts: AdditionalMount[] | undefined;
  if (raw.additionalMounts !== undefined) {
    if (!Array.isArray(raw.additionalMounts)) {
      return { error: 'container_config.additionalMounts must be an array' };
    }
    if (raw.additionalMounts.length > MAX_ADDITIONAL_MOUNTS) {
      return {
        error: `container_config.additionalMounts exceeds ${MAX_ADDITIONAL_MOUNTS} entries`,
      };
    }
    additionalMounts = [];
    for (let index = 0; index < raw.additionalMounts.length; index += 1) {
      const item = raw.additionalMounts[index];
      if (!isRecord(item)) {
        return {
          error: `container_config.additionalMounts[${index}] must be an object`,
        };
      }
      const isSource = item.source !== undefined;
      const itemUnknown = unknownKeys(
        item,
        isSource
          ? ['source', 'subPath', 'containerPath', 'readonly']
          : ['hostPath', 'containerPath', 'readonly'],
      );
      if (itemUnknown.length > 0) {
        return {
          error: `container_config.additionalMounts[${index}] contains unknown fields: ${itemUnknown.join(', ')}`,
        };
      }
      if (isSource) {
        if (typeof item.source !== 'string' || !item.source.trim()) {
          return {
            error: `container_config.additionalMounts[${index}].source must be a non-empty string`,
          };
        }
        if (item.subPath !== undefined && typeof item.subPath !== 'string') {
          return {
            error: `container_config.additionalMounts[${index}].subPath must be a string`,
          };
        }
      } else if (
        typeof item.hostPath !== 'string' ||
        !item.hostPath.trim() ||
        item.hostPath.length > 4096
      ) {
        return {
          error: `container_config.additionalMounts[${index}].hostPath must be a non-empty string`,
        };
      }
      if (typeof item.containerPath !== 'string' || !item.containerPath) {
        return {
          error: `container_config.additionalMounts[${index}].containerPath must be a non-empty string`,
        };
      }
      if (item.readonly !== undefined && typeof item.readonly !== 'boolean') {
        return {
          error: `container_config.additionalMounts[${index}].readonly must be a boolean`,
        };
      }
      const readonly = item.readonly ?? true;
      additionalMounts.push(
        isSource
          ? {
              source: (item.source as string).trim(),
              ...(item.subPath ? { subPath: item.subPath as string } : {}),
              containerPath: item.containerPath,
              readonly,
            }
          : {
              hostPath: (item.hostPath as string).trim(),
              containerPath: item.containerPath,
              readonly,
            },
      );
    }
  }

  return {
    config: {
      ...(raw.version === 1 ? { version: 1 as const } : {}),
      ...(raw.timeout !== undefined ? { timeout: raw.timeout as number } : {}),
      ...(additionalMounts !== undefined ? { additionalMounts } : {}),
    },
  };
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
  /** The allowed root (as configured) that opts this path into NFS direct mounting. */
  nfsDirectMountRoot?: string;
}

export function validateMount(
  mount: HostDirectoryMount,
  isMain: boolean,
  protectedPaths?: string[],
): MountValidationResult {
  const allowlist = loadMountAllowlist();
  if (!allowlist || allowlist.allowedRoots.length === 0) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    };
  }

  let containerPath: string;
  try {
    containerPath = normalizeAdditionalMountContainerPath(
      mount.containerPath ?? '',
    );
  } catch (err) {
    return {
      allowed: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (!path.isAbsolute(mount.hostPath)) {
    return {
      allowed: false,
      reason: `Host path must be absolute: "${mount.hostPath}"`,
    };
  }
  if (
    CONTAINER_CONTROL_CHARS_RE.test(mount.hostPath) ||
    mount.hostPath.includes(':')
  ) {
    return {
      allowed: false,
      reason: 'Host path must not contain control characters or colons',
    };
  }

  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);
  if (!realPath) {
    return {
      allowed: false,
      reason: `Host path does not exist: "${mount.hostPath}"`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return {
      allowed: false,
      reason: `Host path cannot be inspected: "${realPath}"`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      allowed: false,
      reason: `Host path must be a directory: "${realPath}"`,
    };
  }

  const hardDenied = hardDeniedHostPath(realPath, protectedPaths);
  if (hardDenied) {
    return {
      allowed: false,
      reason: `Host path overlaps protected path ${hardDenied}: "${realPath}"`,
    };
  }

  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  );
  if (blockedMatch) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    };
  }

  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (!allowedRoot) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root`,
    };
  }

  const requestedReadWrite = mount.readonly === false;
  if (requestedReadWrite && !isMain && allowlist.nonMainReadOnly) {
    return {
      allowed: false,
      reason: 'Read-write mounts are disabled for non-main workspaces',
    };
  }
  if (requestedReadWrite && !allowedRoot.allowReadWrite) {
    return {
      allowed: false,
      reason: `Allowed root "${allowedRoot.path}" does not permit read-write mounts`,
    };
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly: !requestedReadWrite,
    ...(allowedRoot.nfsDirectMount
      ? { nfsDirectMountRoot: allowedRoot.path }
      : {}),
  };
}

export interface ValidatedAdditionalMount {
  /** Canonical host path, or a display label for a storage source. */
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  /** Set for storage-source mounts: what Docker mounts instead of a bind. */
  storage?: ResolvedStorage;
  /** Host directories only: the allowed root that opts into NFS direct mounting. */
  nfsDirectMountRoot?: string;
  persisted: AdditionalMount;
}

export class AdditionalMountValidationError extends Error {
  readonly code = 'INVALID_ADDITIONAL_MOUNTS';
  readonly issues: string[];
  readonly conflict: boolean;

  constructor(issues: string[], conflict = false) {
    super(issues.join('; '));
    this.name = 'AdditionalMountValidationError';
    this.issues = issues;
    this.conflict = conflict;
  }
}

/**
 * Strict, atomic resolver used by both workspace creation and container start.
 * It throws if any item is invalid; callers must never partially apply output.
 */
export function validateAdditionalMountsStrict(
  mounts: unknown,
  groupName: string,
  isMain: boolean,
): ValidatedAdditionalMount[] {
  const shape = parseContainerConfig({ additionalMounts: mounts });
  if (shape.error) throw new AdditionalMountValidationError([shape.error]);
  const parsedMounts = shape.config?.additionalMounts ?? [];
  const issues: string[] = [];
  const conflictIssues: string[] = [];
  const validated: ValidatedAdditionalMount[] = [];
  const normalizedTargets = parsedMounts.map((mount) => {
    try {
      return normalizeAdditionalMountContainerPath(mount.containerPath);
    } catch {
      // validateMount below records the field-specific normalization failure.
      return undefined;
    }
  });

  // Resolving the protected paths resolves the workspace roots: once.
  const protectedPaths = parsedMounts.length > 0 ? getProtectedHostPaths() : [];
  for (let index = 0; index < parsedMounts.length; index += 1) {
    const mount = parsedMounts[index];
    if (isStorageSourceMount(mount)) {
      const allowlist = loadMountAllowlist();
      let containerSuffix: string;
      try {
        containerSuffix = normalizeAdditionalMountContainerPath(
          mount.containerPath,
        );
      } catch (err) {
        issues.push(
          `additionalMounts[${index}]: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const result = allowlist
        ? resolveStorageSourceMount(mount, allowlist, isMain)
        : {
            allowed: false,
            reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
          };
      if (
        !result.allowed ||
        !('storage' in result) ||
        !result.storage ||
        result.effectiveReadonly === undefined
      ) {
        issues.push(`additionalMounts[${index}]: ${result.reason}`);
        continue;
      }
      // Same blocked names as host directories (.ssh, credentials, ...).
      const blockedMatch =
        allowlist && result.subPath
          ? matchesBlockedPattern(result.subPath, allowlist.blockedPatterns)
          : null;
      if (blockedMatch) {
        issues.push(
          `additionalMounts[${index}]: subPath matches blocked pattern "${blockedMatch}": "${result.subPath}"`,
        );
        continue;
      }
      validated.push({
        hostPath: describeStorage(result.storage),
        containerPath: `${ADDITIONAL_MOUNT_CONTAINER_ROOT}/${containerSuffix}`,
        readonly: result.effectiveReadonly,
        storage: result.storage,
        persisted: {
          source: mount.source,
          ...(result.subPath ? { subPath: result.subPath } : {}),
          containerPath: containerSuffix,
          readonly: result.effectiveReadonly,
        },
      });
      continue;
    }
    const result = validateMount(mount, isMain, protectedPaths);
    if (
      !result.allowed ||
      !result.realHostPath ||
      !result.resolvedContainerPath ||
      result.effectiveReadonly === undefined
    ) {
      issues.push(`additionalMounts[${index}]: ${result.reason}`);
      continue;
    }
    const suffix = result.resolvedContainerPath;
    validated.push({
      hostPath: result.realHostPath,
      containerPath: `${ADDITIONAL_MOUNT_CONTAINER_ROOT}/${suffix}`,
      readonly: result.effectiveReadonly,
      ...(result.nfsDirectMountRoot
        ? { nfsDirectMountRoot: result.nfsDirectMountRoot }
        : {}),
      persisted: {
        hostPath: result.realHostPath,
        containerPath: suffix,
        readonly: result.effectiveReadonly,
      },
    });
  }

  for (let left = 0; left < normalizedTargets.length; left += 1) {
    const leftPath = normalizedTargets[left];
    if (!leftPath) continue;
    for (let right = left + 1; right < normalizedTargets.length; right += 1) {
      const rightPath = normalizedTargets[right];
      if (!rightPath) continue;
      if (
        leftPath === rightPath ||
        leftPath.startsWith(`${rightPath}/`) ||
        rightPath.startsWith(`${leftPath}/`)
      ) {
        conflictIssues.push(
          `additionalMounts[${left}] and additionalMounts[${right}] have duplicate or overlapping container paths`,
        );
      }
    }
  }

  if (issues.length > 0 || conflictIssues.length > 0) {
    const allIssues = [...issues, ...conflictIssues];
    logger.warn(
      { group: groupName, issueCount: allIssues.length },
      'Additional mount configuration rejected',
    );
    throw new AdditionalMountValidationError(
      allIssues,
      conflictIssues.length > 0,
    );
  }
  return validated;
}

/** Compatibility wrapper for callers that only need Docker volume records. */
export function validateAdditionalMounts(
  mounts: unknown,
  groupName: string,
  isMain: boolean,
): Array<{
  hostPath: string;
  containerPath: string;
  readonly: boolean;
  storage?: ResolvedStorage;
  nfsDirectMountRoot?: string;
}> {
  return validateAdditionalMountsStrict(mounts, groupName, isMain).map(
    ({ hostPath, containerPath, readonly, storage, nfsDirectMountRoot }) => ({
      hostPath,
      containerPath,
      readonly,
      ...(storage ? { storage } : {}),
      ...(nfsDirectMountRoot ? { nfsDirectMountRoot } : {}),
    }),
  );
}
