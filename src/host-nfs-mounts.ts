/**
 * Host directories that live on an NFS share are mounted into containers by
 * Docker straight from the NFS server instead of as a bind of the host's own
 * NFS mount.
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
 * that path. Mount options are fixed rather than copied from the host: NFSv3
 * over TCP (what the host mount table shows cannot be trusted to name the
 * negotiated version), `hard` because nfs(5) warns that soft timeouts can
 * silently corrupt writes, and `nolock` because the daemon's VM runs no
 * rpc.statd (locks stay local to the container).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from './logger.js';

export interface HostNfsMount {
  /** NFS server host name or address, without IPv6 brackets. */
  server: string;
  /** Exported directory on the server, absolute. */
  exportPath: string;
  /** Canonical host mount point. */
  mountPoint: string;
}

export interface NfsVolumeSource {
  server: string;
  /** Export subdirectory that corresponds to the host path. */
  device: string;
}

export const NFS_VOLUME_OPTIONS = 'nfsvers=3,proto=tcp,hard,nolock';

const NFS_FSTYPES = new Set(['nfs', 'nfs4']);

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
 * Mount points may contain spaces, so the point runs up to the last
 * ` (nfs` that starts the attribute list.
 */
export function parseBsdMountTable(output: string): HostNfsMount[] {
  const mounts: HostNfsMount[] = [];
  for (const line of output.split('\n')) {
    const match = /^(\S+) on (\/.*) \((nfs4?)(?:,[^)]*)?\)$/.exec(line.trim());
    if (!match) continue;
    const source = parseNfsSource(match[1]);
    if (!source) continue;
    mounts.push({ ...source, mountPoint: match[2] });
  }
  return mounts;
}

function unescapeMountInfo(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/**
 * Parses Linux /proc/self/mountinfo. Fields after the ` - ` separator are
 * fstype, source and super options; the mount point is field 5.
 */
export function parseLinuxMountInfo(content: string): HostNfsMount[] {
  const mounts: HostNfsMount[] = [];
  for (const line of content.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const head = line.slice(0, separator).split(' ');
    const tail = line.slice(separator + 3).split(' ');
    if (head.length < 5 || tail.length < 2) continue;
    if (!NFS_FSTYPES.has(tail[0])) continue;
    const source = parseNfsSource(unescapeMountInfo(tail[1]));
    if (!source) continue;
    mounts.push({ ...source, mountPoint: unescapeMountInfo(head[4]) });
  }
  return mounts;
}

function readHostNfsMounts(): HostNfsMount[] {
  if (process.platform === 'darwin') {
    const output = execFileSync('/sbin/mount', [], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return parseBsdMountTable(output);
  }
  if (process.platform === 'linux') {
    return parseLinuxMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
  }
  return [];
}

function canonicalMountPoint(mount: HostNfsMount): HostNfsMount | null {
  try {
    return { ...mount, mountPoint: fs.realpathSync(mount.mountPoint) };
  } catch {
    // An unreachable share cannot hold the (already resolved) host path.
    return null;
  }
}

/**
 * Finds the NFS export behind a canonical host path: the innermost NFS mount
 * whose mount point contains it, with the path below the mount point appended
 * to the export.
 */
export function resolveNfsVolumeSource(
  realHostPath: string,
  mounts: HostNfsMount[],
): NfsVolumeSource | null {
  let best: HostNfsMount | null = null;
  for (const mount of mounts) {
    const relative = path.relative(mount.mountPoint, realHostPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!best || mount.mountPoint.length > best.mountPoint.length) {
      best = mount;
    }
  }
  if (!best) return null;
  const relative = path.relative(best.mountPoint, realHostPath);
  const device = relative
    ? path.posix.join(best.exportPath, ...relative.split(path.sep))
    : best.exportPath;
  return { server: best.server, device };
}

/**
 * Reads the host mount table once and resolves each host path. A failure to
 * read the table keeps every path a bind, as before this module existed.
 */
export function resolveNfsVolumeSources(
  realHostPaths: string[],
  readMounts: () => HostNfsMount[] = readHostNfsMounts,
): Array<NfsVolumeSource | null> {
  if (realHostPaths.length === 0) return [];
  let mounts: HostNfsMount[];
  try {
    mounts = readMounts()
      .map(canonicalMountPoint)
      .filter((mount): mount is HostNfsMount => mount !== null);
  } catch (err) {
    logger.warn(
      { err },
      'Could not read the host mount table; additional mounts stay binds',
    );
    return realHostPaths.map(() => null);
  }
  return realHostPaths.map((hostPath) =>
    resolveNfsVolumeSource(hostPath, mounts),
  );
}
