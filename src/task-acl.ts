import type { RegisteredGroup, UserRole, UserStatus } from './types.js';

/**
 * Scheduled-task authorization for the IPC/MCP surface.
 *
 * The REST surface (`src/routes/tasks.ts`) resolves task ACL through
 * `canAccessGroup`, which deliberately has no admin bypass — CLAUDE.md
 * section 8 states that workspace and channel resources are isolated by
 * `created_by`. This surface must reach the same verdict for the same row,
 * otherwise one rule contradicts itself depending on which entrypoint asks.
 *
 * `isAdminHome` intentionally does not appear here. An admin home Agent is an
 * LLM exposed to untrusted content, and a schedule's `prompt` is replayed on a
 * timer under the Bot's identity in the target chat and billed to the target
 * workspace. A global bypass would let injected content plant, rewrite or
 * immediately run cron jobs in another tenant's workspace.
 *
 * Privilege checks that are not about workspace scope — script tasks and host
 * execution mode requiring admin — stay at the call sites; they gate *what*
 * may be scheduled, not *whose* workspace it lands in.
 */

export interface TaskAclActor {
  id: string;
  role: UserRole;
  status: UserStatus;
}

export interface TaskAclDeps {
  /** Resolve a registered group by JID. */
  lookupGroup: (jid: string) => RegisteredGroup | undefined;
  /** The workspace owner behind this IPC root, if one is resolvable. */
  resolveActor: () => TaskAclActor | undefined;
  /** Injected so this module stays pure and unit-testable. */
  canAccessGroup: (
    user: { id: string; role: UserRole },
    group: RegisteredGroup & { jid: string },
  ) => boolean;
}

/**
 * Two paths are allowed:
 *  - the target is the agent's own workspace folder, which is definitionally
 *    inside its scope; or
 *  - the workspace owner behind this IPC root also owns the target group.
 */
export function canIpcActorAccessGroup(
  sourceFolder: string,
  targetJid: string,
  deps: TaskAclDeps,
): boolean {
  const targetGroup = deps.lookupGroup(targetJid);
  if (!targetGroup) return false;
  if (targetGroup.folder === sourceFolder) return true;
  const actor = deps.resolveActor();
  if (!actor || actor.status !== 'active') return false;
  return deps.canAccessGroup(
    { id: actor.id, role: actor.role },
    { ...targetGroup, jid: targetJid },
  );
}

/**
 * Same verdict for an existing task, addressed through its bound chat. Mirrors
 * the REST `canViewTask` shape, which resolves the group from `task.chat_jid`,
 * so both surfaces agree on a given row.
 */
export function canIpcActorManageTask(
  sourceFolder: string,
  task: { group_folder: string; chat_jid: string },
  deps: TaskAclDeps,
): boolean {
  if (task.group_folder === sourceFolder) return true;
  return canIpcActorAccessGroup(sourceFolder, task.chat_jid, deps);
}
