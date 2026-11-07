/**
 * Host directories that live on an NFS share can be mounted into containers
 * by Docker straight from the NFS server instead of as a bind of the host's
 * own NFS mount. This is opt-in per allowlist root (`nfsDirectMount`); every
 * other host directory stays a plain bind.
 *
 * A bind holds the host mount that existed when the container started. When
 * the host remounts the share (NAS reboot, network recovery, a health-check
 * script), Docker Desktop and OrbStack, whose daemon runs in a VM behind
 * virtiofs, have no mount propagation, so every lookup inside the container
 * fails with EBADF until the container exits; a Linux bind goes stale the same
 * way. A Docker NFS volume is mounted by the daemon's own kernel for the
 * lifetime of the container, independent of the host mount.
 *
 * Only the location changes: the host path has already passed the mount
 * allowlist, and the volume addresses exactly the export subdirectory behind
 * that path. The protocol follows the host mount: an NFSv4 mount stays on v4
 * with the same (pseudo-root) path, NFSv3 stays on v3. Options:
 * - `proto=tcp`, and `hard` because nfs(5) warns that soft timeouts can
 *   silently corrupt writes.
 * - `nolock` only for NFSv3 where the daemon cannot run NLM: NFSv4 carries
 *   locks in the protocol, and on Linux the daemon shares the host kernel's
 *   lockd and rpc.statd, so it locks the way the host mount does. The VM of
 *   Docker Desktop and OrbStack runs no rpc.statd, so a v3 lock there would
 *   fail with ENOLCK; with `nolock` locks stay local to the container.
 * Anything the daemon cannot reproduce (Kerberos, an unknown version, an
 * unreadable mount table) fails the launch instead of falling back silently.
 *
 * Nothing here touches a mount point on the filesystem: the mount table is
 * matched against the (already canonical) host path literally, so an
 * unrelated hard NFS mount whose server is gone cannot block the process.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** One entry of the host mount table, of any filesystem type. */
export interface HostMount {
  fstype: string;
  /** Mount source as listed, e.g. `nas:/export` for NFS. */
  source: string;
  /** Mount point as listed; Linux lists canonical paths. */
  mountPoint: string;
  /** Directory of the filesystem this mount shows (mountinfo field 4). */
  root: string;
  /** Super options (Linux); null where the table has none (macOS). */
  options: string[] | null;
}

export interface HostMountTable {
  /** In mount order: a later entry on the same mount point covers earlier ones. */
  mounts: HostMount[];
  /** Negotiated parameters of an NFS mount whose entry carries no options. */
  nfsParameters?: (mountPoint: string) => string[] | null;
}

export interface NfsVolumeSource {
  server: string;
  /** Export subdirectory that corresponds to the host path. */
  device: string;
  options: string;
}

export type NfsDirectMountResolution =
  | { kind: 'bind' }
  | { kind: 'nfs'; source: NfsVolumeSource }
  | { kind: 'error'; reason: string };

const NFS_FSTYPES = new Set(['nfs', 'nfs4']);
const DIRECT_MOUNT_VERSION_RE = /^(?:3|4(?:\.[0-2])?)$/;

/**
 * Options for a Docker NFS volume. `nolock` is for NFSv3 only (see the module
 * comment); NFSv4 locking needs no side protocol.
 */
export function nfsVolumeOptions(version: string, nolock: boolean): string {
  return [
    `nfsvers=${version}`,
    'proto=tcp',
    'hard',
    ...(nolock ? ['nolock'] : []),
  ].join(',');
}

/** Splits `server:/export` (IPv6 servers are bracketed) into its parts. */
export function parseNfsSource(
  source: string,
): { server: string; exportPath: string } | null {
  const match = /^(\[[^\]]+\]|[^:/[\]]+):(\/.*)$/.exec(source);
  if (!match) return null;
  const server = match[1].replace(/^\[|\]$/g, '');
  if (!server) return null;
  return { server, exportPath: match[2] };
}

/**
 * Parses the BSD `mount` listing (macOS):
 * `server:/export on /mount/point (nfs, nodev, nosuid, mounted by user)`.
 * Sources and mount points may contain spaces, so the point runs up to the
 * last ` (` that starts the attribute list.
 */
export function parseBsdMountTable(output: string): HostMount[] {
  const mounts: HostMount[] = [];
  for (const line of output.split('\n')) {
    const match = /^(.+?) on (\/.*) \(([^,()]+)(?:,[^()]*)?\)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    mounts.push({
      fstype: match[3].trim(),
      source: match[1],
      mountPoint: match[2],
      root: '/',
      options: null,
    });
  }
  return mounts;
}

function unescapeMountInfo(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/**
 * Parses Linux /proc/self/mountinfo. Field 4 is the root of the mount within
 * its filesystem and field 5 the mount point; after the ` - ` separator come
 * fstype, source and super options.
 */
export function parseLinuxMountInfo(content: string): HostMount[] {
  const mounts: HostMount[] = [];
  for (const line of content.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const head = line.slice(0, separator).split(' ');
    const tail = line.slice(separator + 3).split(' ');
    if (head.length < 5 || tail.length < 2) continue;
    mounts.push({
      fstype: tail[0],
      source: unescapeMountInfo(tail[1]),
      mountPoint: unescapeMountInfo(head[4]),
      root: unescapeMountInfo(head[3]),
      options: tail[2] ? tail[2].split(',') : [],
    });
  }
  return mounts;
}

/**
 * Parses macOS `nfsstat -m`: per mount point, the NFS parameters of the
 * "Current mount parameters" section (the negotiated ones), falling back to
 * the original options.
 */
export function parseDarwinNfsStat(output: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let mountPoint: string | null = null;
  let section: 'original' | 'current' | null = null;
  for (const line of output.split('\n')) {
    if (line && !/^\s/.test(line)) {
      const at = line.lastIndexOf(' from ');
      mountPoint = at > 0 && line.startsWith('/') ? line.slice(0, at) : null;
      section = null;
      continue;
    }
    if (!mountPoint) continue;
    const trimmed = line.trim();
    if (/^-- Original mount options/.test(trimmed)) section = 'original';
    else if (/^-- Current mount parameters/.test(trimmed)) section = 'current';
    const params = /^NFS parameters:\s*(.*)$/.exec(trimmed);
    if (!params || !section) continue;
    if (section === 'current' || !result.has(mountPoint)) {
      result.set(
        mountPoint,
        params[1]
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }
  }
  return result;
}

/**
 * A host path without macOS aliases: the data volume is reached through
 * firmlinks (`/System/Volumes/Data/Users` is `/Users`) and `/tmp`, `/var`
 * and `/etc` through `/private`.
 */
function withoutDarwinAliases(value: string): string {
  let stripped = value;
  const data = '/System/Volumes/Data';
  if (stripped === data) stripped = '/';
  else if (stripped.startsWith(`${data}/`)) {
    stripped = stripped.slice(data.length);
  }
  if (/^\/private\/(?:tmp|var|etc)(?:\/|$)/.test(stripped)) {
    stripped = stripped.slice('/private'.length);
  }
  return stripped;
}

function pathContains(
  point: string,
  target: string,
  ignoreCase: boolean,
): boolean {
  if (point === '/') return true;
  const head = target.slice(0, point.length);
  const same = ignoreCase
    ? head.toLowerCase() === point.toLowerCase()
    : head === point;
  return (
    same && (target.length === point.length || target[point.length] === '/')
  );
}

/**
 * The mount that holds a canonical host path: the innermost mount point
 * containing it, the last one listed when several share a mount point. The
 * comparison is literal (ignoring case and aliases on macOS, whose default
 * volumes ignore case); no mount point is looked up on the filesystem.
 */
export function findInnermostMount(
  hostPath: string,
  mounts: HostMount[],
  platform: NodeJS.Platform = process.platform,
): { mount: HostMount; relative: string } | null {
  const darwin = platform === 'darwin';
  const target = darwin ? withoutDarwinAliases(hostPath) : hostPath;
  let best: { mount: HostMount; length: number } | null = null;
  for (const mount of mounts) {
    const point = darwin
      ? withoutDarwinAliases(mount.mountPoint)
      : mount.mountPoint;
    if (!pathContains(point, target, darwin)) continue;
    const length = point === '/' ? 0 : point.length;
    if (!best || length >= best.length) best = { mount, length };
  }
  if (!best) return null;
  return {
    mount: best.mount,
    relative: target.slice(best.length).replace(/^\/+/, ''),
  };
}

function parameterValue(parameters: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  return parameters
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length);
}

function directMountOptions(
  mount: HostMount,
  parameters: string[] | null,
  platform: NodeJS.Platform,
): { options: string } | { error: string } {
  const params = parameters ?? [];
  const version =
    parameterValue(params, 'vers') ??
    parameterValue(params, 'nfsvers') ??
    (mount.fstype === 'nfs4' ? '4' : undefined);
  if (!version) {
    return {
      error: `the NFS version of ${mount.mountPoint} is not listed${platform === 'darwin' ? ' by nfsstat -m' : ' in the mount table'}`,
    };
  }
  if (!DIRECT_MOUNT_VERSION_RE.test(version)) {
    return {
      error: `${mount.mountPoint} uses NFS version ${version}; direct mounts support versions 3 and 4.x`,
    };
  }
  const security = parameterValue(params, 'sec');
  if (security && security !== 'sys') {
    return {
      error: `${mount.mountPoint} uses sec=${security}; Docker mounts NFS with sec=sys only`,
    };
  }
  const nolock =
    version === '3' &&
    (platform === 'darwin' ||
      params.includes('nolock') ||
      parameterValue(params, 'local_lock') === 'all');
  return { options: nfsVolumeOptions(version, nolock) };
}

/** How a canonical host path is mounted when its root opts into NFS. */
export function resolveNfsDirectMount(
  hostPath: string,
  table: HostMountTable,
  platform: NodeJS.Platform = process.platform,
): NfsDirectMountResolution {
  const found = findInnermostMount(hostPath, table.mounts, platform);
  if (!found || !NFS_FSTYPES.has(found.mount.fstype)) return { kind: 'bind' };
  const { mount, relative } = found;
  const source = parseNfsSource(mount.source);
  if (!source) {
    return {
      kind: 'error',
      reason: `NFS mount ${mount.mountPoint} has a source "${mount.source}" that is not server:/export`,
    };
  }
  let parameters = mount.options;
  if (parameters === null && table.nfsParameters) {
    try {
      parameters = table.nfsParameters(mount.mountPoint);
    } catch (err) {
      return {
        kind: 'error',
        reason: `could not read the parameters of NFS mount ${mount.mountPoint}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const options = directMountOptions(mount, parameters, platform);
  if ('error' in options) return { kind: 'error', reason: options.error };
  const device = path.posix.join(
    source.exportPath,
    mount.root,
    ...(relative ? relative.split('/') : []),
  );
  return {
    kind: 'nfs',
    source: {
      server: source.server,
      device: device.length > 1 ? device.replace(/\/+$/, '') : device,
      options: options.options,
    },
  };
}

function readHostMountTable(): HostMountTable {
  if (process.platform === 'linux') {
    return {
      mounts: parseLinuxMountInfo(
        fs.readFileSync('/proc/self/mountinfo', 'utf8'),
      ),
    };
  }
  if (process.platform === 'darwin') {
    const mounts = parseBsdMountTable(
      execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5_000 }),
    );
    let parameters: Map<string, string[]> | undefined;
    return {
      mounts,
      nfsParameters: (mountPoint) => {
        parameters ??= parseDarwinNfsStat(
          execFileSync('/usr/bin/nfsstat', ['-m'], {
            encoding: 'utf8',
            timeout: 5_000,
          }),
        );
        return parameters.get(mountPoint) ?? null;
      },
    };
  }
  throw new Error(`no mount table reader for ${process.platform}`);
}

/** Reads the host mount table once and resolves each opted-in host path. */
export function resolveNfsDirectMounts(
  realHostPaths: string[],
  readTable: () => HostMountTable = readHostMountTable,
  platform: NodeJS.Platform = process.platform,
): NfsDirectMountResolution[] {
  if (realHostPaths.length === 0) return [];
  let table: HostMountTable;
  try {
    table = readTable();
  } catch (err) {
    const reason = `could not read the host mount table: ${err instanceof Error ? err.message : String(err)}`;
    return realHostPaths.map(() => ({ kind: 'error', reason }));
  }
  return realHostPaths.map((hostPath) =>
    resolveNfsDirectMount(hostPath, table, platform),
  );
}
