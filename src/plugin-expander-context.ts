/**
 * plugin-expander-context.ts
 *
 * Pure types + helpers describing the ExpandContext for plugin slash-command
 * expansion. Split out of (former) plugin-command-expander.ts (#487 follow-up #6).
 *
 * Zero internal deps — the only external import is `path` for cwd resolution.
 * Specifically does NOT import DATA_DIR: makeExpandContext receives groupsDir
 * via its args and uses path.resolve only. DATA_DIR is consumed by
 * resolvePluginRoot in plugin-expander-core.ts.
 */

import path from 'path';

export type ExecutionMode = 'host' | 'container';

export interface ExpandContext {
  userId: string;
  groupJid: string;
  groupFolder: string;
  /** host: absolute path; container: '/workspace/group'. */
  cwd: string;
  executionMode: ExecutionMode;
  /** Active container name (docker mode only). null when no runner is up. */
  containerName: string | null;
}

/**
 * Pure helper that assembles an ExpandContext from already-resolved inputs.
 *
 * Host mode honors `customCwd` (when present) so inline `!` commands run
 * against the user's real repo rather than the synthetic data/groups path
 * (#18 P2-bug-4). Returns null when there is no resolvable owner — plugins
 * are per-user config so an ownerless group has no plugins to expand.
 */
export function makeExpandContext(args: {
  chatJid: string;
  groupFolder: string;
  ownerId: string | null | undefined;
  executionMode: 'host' | 'container' | string | null | undefined;
  customCwd?: string | null;
  groupsDir: string;
  containerName: string | null;
}): ExpandContext | null {
  if (!args.ownerId) return null;
  const executionMode: ExecutionMode =
    (args.executionMode || 'container') === 'host' ? 'host' : 'container';
  let cwd: string;
  if (executionMode === 'host') {
    cwd = args.customCwd
      ? path.resolve(args.customCwd)
      : path.resolve(args.groupsDir, args.groupFolder);
  } else {
    cwd = '/workspace/group';
  }
  return {
    userId: args.ownerId,
    groupJid: args.chatJid,
    groupFolder: args.groupFolder,
    cwd,
    executionMode,
    containerName: args.containerName,
  };
}
