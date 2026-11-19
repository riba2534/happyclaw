import type {
  AgentBuilderPersistedInput,
  AgentBuilderTurnRegistry,
} from './agent-builder-turn-auth.js';
import { isWorkspaceMemoryOwnerTurn } from './workspace-memory-ipc.js';
import type { WorkspaceOwnerIdentityLookup } from './workspace-owner-identity.js';

export const SKILL_MUTATION_NON_OWNER_REJECTION =
  '本轮对话不是由工作区主人发起的（群成员、自动化或系统触发），不能安装或卸载 Skill。请由工作区主人亲自在对话中发起。';

/**
 * Why an Agent's install_skill / uninstall_skill request must be refused, or
 * null when the turn that issued it belongs to the workspace owner.
 *
 * Installing changes every workspace of the owner and runs third-party code,
 * so the workspace owning the runner is not enough: in a group chat any
 * member's message can start the turn. The executing batch (and everything
 * queued behind it) must be the owner's own human input — decided exactly as
 * for a direct Workspace Memory write.
 */
export function skillMutationTurnRejection(input: {
  registry: Pick<AgentBuilderTurnRegistry, 'requireOwnerHumanTurn'>;
  /** Folder of the verified IPC namespace. */
  sourceFolder: string;
  /** Turn-registry scope of the requesting runtime (agentBuilderTurnScope). */
  turnScope: string;
  ownerUserId: string;
  loadPersistedInput: (
    chatJid: string,
    messageId: string,
  ) => AgentBuilderPersistedInput | null;
  getGroup: WorkspaceOwnerIdentityLookup['registration'];
  /** Every chat registration the user created, in any workspace. */
  getGroupsByOwner: (
    userId: string,
  ) => ReturnType<WorkspaceOwnerIdentityLookup['ownerRegistrations']>;
  getUserHomeGroup: (userId: string) => { folder: string } | undefined;
}): string | null {
  const ownerTurn = isWorkspaceMemoryOwnerTurn({
    ownerUserId: input.ownerUserId,
    workspaceFolder: input.sourceFolder,
    homeFolder: input.getUserHomeGroup(input.ownerUserId)?.folder,
    registration: input.getGroup,
    ownerRegistrations: () => input.getGroupsByOwner(input.ownerUserId),
    requireActiveOwnerTurn: (isOwnerInput) =>
      input.registry.requireOwnerHumanTurn(
        input.turnScope,
        input.loadPersistedInput,
        isOwnerInput,
      ),
  });
  return ownerTurn ? null : SKILL_MUTATION_NON_OWNER_REJECTION;
}
