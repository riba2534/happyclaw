import fs from 'node:fs';
import path from 'node:path';

import type { IpcRuntimeNamespace } from './ipc-watcher-manager.js';

/** Session states whose IPC namespace no longer needs to exist on disk. */
const RETIRED_AGENT_STATUSES = new Set(['completed', 'error']);
const DEFAULT_MIN_IDLE_MS = 10 * 60 * 1000;
const MAX_EMPTY_CHECK_DEPTH = 4;

export interface PruneIdleIpcNamespacesDeps {
  ipcBaseDir: string;
  /** A live runner holds this namespace; never remove it. */
  isWatched: (folder: string, namespace: IpcRuntimeNamespace) => boolean;
  /**
   * Current status of every session row, keyed by agent id. A namespace
   * whose id is absent belongs to a deleted session.
   */
  agentStatuses: () => Map<string, string>;
  /** Fresh single-row status read used right before removal. */
  currentStatus?: (agentId: string) => string | undefined;
  now?: () => number;
  /** Skip namespaces touched more recently than this. */
  minIdleMs?: number;
}

export interface PruneIdleIpcNamespacesResult {
  removed: number;
  scanned: number;
}

async function newestMtimeMs(root: string): Promise<number> {
  let newest = (await fs.promises.stat(root)).mtimeMs;
  for (const entry of await fs.promises.readdir(root, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    try {
      const stat = await fs.promises.stat(path.join(root, entry.name));
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      /* raced with removal */
    }
  }
  return newest;
}

/** True when no non-directory entry exists anywhere below `dir`. */
async function containsNoFiles(dir: string, depth = 0): Promise<boolean> {
  if (depth > MAX_EMPTY_CHECK_DEPTH) return false;
  for (const entry of await fs.promises.readdir(dir, {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) return false;
    if (!(await containsNoFiles(path.join(dir, entry.name), depth + 1))) {
      return false;
    }
  }
  return true;
}

/**
 * Remove `agents/{id}` IPC namespaces of deleted, archived or finished
 * sessions. Every fallback sweep reads each namespace directory, so retired
 * ones cost a few directory reads per sweep forever. Runners recreate their
 * namespace before spawning, so a revived session is unaffected.
 *
 * A namespace is kept when a runner watches it, when it still contains any
 * file (unprocessed requests must drain first), or when it changed recently.
 */
export async function pruneIdleIpcNamespaces(
  deps: PruneIdleIpcNamespacesDeps,
): Promise<PruneIdleIpcNamespacesResult> {
  const now = deps.now?.() ?? Date.now();
  const minIdleMs = deps.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
  const statuses = deps.agentStatuses();
  let removed = 0;
  let scanned = 0;
  let folders: fs.Dirent[];
  try {
    folders = await fs.promises.readdir(deps.ipcBaseDir, {
      withFileTypes: true,
    });
  } catch {
    return { removed, scanned };
  }
  for (const folderEntry of folders) {
    if (!folderEntry.isDirectory() || folderEntry.name === 'errors') continue;
    const folder = folderEntry.name;
    const agentsDir = path.join(deps.ipcBaseDir, folder, 'agents');
    let agentEntries: fs.Dirent[];
    try {
      agentEntries = await fs.promises.readdir(agentsDir, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      scanned += 1;
      const agentId = agentEntry.name;
      const status = statuses.get(agentId);
      if (status !== undefined && !RETIRED_AGENT_STATUSES.has(status)) {
        continue;
      }
      if (deps.isWatched(folder, { agentId })) continue;
      const root = path.join(agentsDir, agentId);
      try {
        if (now - (await newestMtimeMs(root)) < minIdleMs) continue;
        if (!(await containsNoFiles(root))) continue;
        // Re-check right before removal: a session revived during the scan
        // leaves the retired state and takes its watcher before it writes.
        if (deps.isWatched(folder, { agentId })) continue;
        const fresh = deps.currentStatus?.(agentId);
        if (fresh !== undefined && !RETIRED_AGENT_STATUSES.has(fresh)) {
          continue;
        }
        await fs.promises.rm(root, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* raced with a runner or another cleanup; retry next pass */
      }
    }
  }
  return { removed, scanned };
}
