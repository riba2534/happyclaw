import { describe, expect, test, vi } from 'vitest';

import { signWorkspaceMemoryMutation } from '../container/agent-runner/src/workspace-memory-auth.js';
import {
  agentBuilderTurnScope,
  AgentBuilderTurnRegistry,
  type AgentBuilderPersistedInput,
} from '../src/agent-builder-turn-auth.js';
import { WorkspaceMemoryServiceError } from '../src/memory-service.js';
import {
  issueWorkspaceMemoryWriteCapability,
  revokeWorkspaceMemoryWriteCapability,
  verifyAndConsumeWorkspaceMemoryMutation,
} from '../src/workspace-memory-capability.js';
import {
  isWorkspaceMemoryMutation,
  isWorkspaceMemoryOwnerTurn,
  workspaceMemoryWriteRejection,
} from '../src/workspace-memory-ipc.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const FOLDER = 'team';
const OWNER = 'owner-1';
const SESSION = 'team-session';

const registrations: Record<string, Record<string, unknown>> = {
  'web:team': { folder: FOLDER, created_by: OWNER },
  'feishu:oc_group': {
    folder: FOLDER,
    created_by: OWNER,
    owner_im_id: 'ou_owner',
    owner_claim_source: 'auto_feishu',
  },
};

/**
 * The host's Workspace Memory IPC case, run from index.ts: what a create
 * becomes for the turn that asked for it.
 */
function host(inputs: Record<string, AgentBuilderPersistedInput>) {
  const results: Array<Record<string, unknown>> = [];
  const createWorkspaceMemory = vi.fn((input: Record<string, unknown>) => ({
    storeRevision: 1,
    item: { id: 'wmi_1', revision: 1 },
    replayed: false,
    proposal: input.proposal,
  }));
  const activeAgentBuilderTurns = new AgentBuilderTurnRegistry();
  const globals: Record<string, unknown> = {
    getUserHomeGroup: () => undefined,
    resolveBroadcastFolder: () => FOLDER,
    registeredGroups: registrations,
    getRegisteredGroup: (jid: string) => registrations[jid],
    getUserById: (id: string) =>
      id === OWNER ? { id, role: 'member', status: 'active' } : undefined,
    canAccessGroup: vi.fn(),
    SAFE_REQUEST_ID_RE: /^[A-Za-z0-9_-]+$/,
    WorkspaceMemoryServiceError,
    getJidsByFolder: () => Object.keys(registrations),
    getChannelType: (jid: string) =>
      jid.startsWith('feishu:') ? 'feishu' : null,
    activeAgentBuilderTurns,
    agentBuilderTurnScope,
    getAgentBuilderInputMessage: (_chatJid: string, messageId: string) =>
      inputs[messageId] ?? null,
    getAgent: (id: string) =>
      id === SESSION
        ? {
            id,
            kind: 'conversation',
            group_folder: FOLDER,
            chat_jid: 'web:team',
          }
        : undefined,
    isWorkspaceMemoryMutation,
    isWorkspaceMemoryOwnerTurn,
    workspaceMemoryWriteRejection,
    verifyAndConsumeWorkspaceMemoryMutation,
    createWorkspaceMemory,
    writeTaskResult: (
      _dir: string,
      _type: string,
      _id: string,
      payload: Record<string, unknown>,
    ) => results.push(payload),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('processTaskIpc');
  /**
   * A signed create naming `turnId`, from a runner whose launch admitted
   * `admittedTurnId` as its first turn.
   */
  const create = async (
    turnId: string,
    sign = true,
    admittedTurnId: string | null = turnId,
  ) => {
    const scope = { groupFolder: FOLDER, agentId: SESSION };
    const capability = issueWorkspaceMemoryWriteCapability(
      scope,
      admittedTurnId,
    );
    const request: Record<string, unknown> = {
      type: 'workspace_memory',
      operation: 'create',
      requestId: `req-${turnId}`,
      inputTurnId: turnId,
      kind: 'fact',
      content: 'Deploys go through launchd.',
      runnerInstanceId: capability.runnerInstanceId,
    };
    if (sign) {
      request.mutationSignature = signWorkspaceMemoryMutation(
        capability.signingSecret,
        scope,
        request,
      );
    }
    try {
      await (globals.processTaskIpc as (...args: unknown[]) => Promise<void>)(
        request,
        FOLDER,
        false,
        false,
        registrations['web:team'],
        '/tmp/unused',
        SESSION,
      );
    } finally {
      revokeWorkspaceMemoryWriteCapability(scope, capability.runnerInstanceId);
    }
    return results.at(-1);
  };
  const start = (
    chatJid: string,
    messageId: string,
    automationRunId: string | null = null,
  ) =>
    activeAgentBuilderTurns.set(
      agentBuilderTurnScope(FOLDER, SESSION),
      chatJid,
      messageId,
      automationRunId,
    );
  return { create, start, createWorkspaceMemory };
}

const human = (
  sender: string,
  sourceJid: string,
): AgentBuilderPersistedInput => ({
  content: 'remember this',
  sender,
  source_jid: sourceJid,
  is_from_me: 0,
  source_kind: null,
  automation_run_id: null,
});

const automationInput = (runId: string): AgentBuilderPersistedInput => ({
  content: 'check the build',
  sender: 'automation',
  source_jid: 'web:team',
  is_from_me: 0,
  source_kind: 'automation_prompt',
  automation_run_id: runId,
});

describe('what a Workspace Memory write becomes on the host', () => {
  test("the owner's own turn writes; a group member's turn proposes", async () => {
    const { create, start } = host({
      'om-owner': human('ou_owner', 'feishu:oc_group'),
      'om-member': human('ou_member', 'feishu:oc_group'),
      'web-owner': human(OWNER, 'web:team'),
    });
    start('web:team', 'web-owner');
    expect(await create('web-owner')).toMatchObject({
      success: true,
      proposal: false,
    });
    start('feishu:oc_group', 'om-owner');
    expect(await create('om-owner')).toMatchObject({
      success: true,
      proposal: false,
    });
    start('feishu:oc_group', 'om-member');
    expect(await create('om-member')).toMatchObject({
      success: true,
      proposal: true,
    });
  });

  test('an automation run proposes, and only with its signed capability', async () => {
    const { create, start, createWorkspaceMemory } = host({
      'automation-run-r1': automationInput('r1'),
      'automation-run-r2': automationInput('r2'),
    });
    start('web:team', 'automation-run-r1', 'r1');
    expect(await create('automation-run-r1')).toMatchObject({
      success: true,
      proposal: true,
    });
    expect(createWorkspaceMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        proposal: true,
        sourceType: 'scheduled_task',
        provenance: expect.objectContaining({
          sourceId: 'automation-run-r1',
        }),
      }),
    );
    start('web:team', 'automation-run-r2', 'r2');
    expect(await create('automation-run-r2', false)).toMatchObject({
      success: false,
      code: 'workspace_memory_invalid_capability',
    });
    expect(createWorkspaceMemory).toHaveBeenCalledTimes(1);
  });
});
