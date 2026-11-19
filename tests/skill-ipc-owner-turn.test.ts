import fs from 'node:fs';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import {
  AgentBuilderTurnRegistry,
  agentBuilderTurnScope,
  type AgentBuilderPersistedInput,
} from '../src/agent-builder-turn-auth.js';
import {
  SKILL_MUTATION_NON_OWNER_REJECTION,
  skillMutationTurnRejection,
} from '../src/skill-ipc-authorization.js';
import { isWorkspaceMemoryOwnerTurn } from '../src/workspace-memory-ipc.js';

const FOLDER = 'home-owner';
const OWNER = 'owner-1';
const GROUP_JID = 'feishu:oc_team';
const WEB_JID = `web:${FOLDER}`;

const groups: Record<string, Record<string, string>> = {
  [GROUP_JID]: {
    folder: FOLDER,
    created_by: OWNER,
    owner_im_id: 'ou_owner',
    owner_claim_source: 'configured',
  },
  [WEB_JID]: { folder: FOLDER, created_by: OWNER },
  // A second workspace. Discovery and pairing register every chat under the
  // account's default workspace (Home); binding one to a session of ws-b only
  // sets target_agent_id, so these rows keep the Home folder.
  'web:ws-b': { folder: 'ws-b', created_by: OWNER },
  'telegram:111#account:tg-a': {
    folder: FOLDER,
    created_by: OWNER,
    channel_account_id: 'tg-a',
    owner_im_id: '111',
    owner_claim_source: 'trusted_direct',
    target_agent_id: 'session-b',
  },
  'telegram:-1001#account:tg-a': {
    folder: FOLDER,
    created_by: OWNER,
    channel_account_id: 'tg-a',
    target_agent_id: 'session-b',
  },
  // The owner's second bot, with no owner recorded on it.
  'telegram:-1002#account:tg-b': {
    folder: FOLDER,
    created_by: OWNER,
    channel_account_id: 'tg-b',
    target_agent_id: 'session-b',
  },
  // Another user's paired direct chat.
  'telegram:222#account:tg-x': {
    folder: 'home-user-2',
    created_by: 'user-2',
    channel_account_id: 'tg-x',
    owner_im_id: '222',
    owner_claim_source: 'trusted_direct',
  },
};

const lookup = {
  getGroup: (jid: string) => groups[jid],
  getGroupsByOwner: (userId: string) =>
    Object.entries(groups)
      .filter(([, row]) => row.created_by === userId)
      .map(([jid, row]) => ({ jid, ...row })),
};

function check(
  messages: Record<string, AgentBuilderPersistedInput>,
  options: { agentId?: string | null; folder?: string } = {},
) {
  const registry = new AgentBuilderTurnRegistry();
  const scope = agentBuilderTurnScope(
    options.folder ?? FOLDER,
    options.agentId ?? null,
  );
  const ids = Object.keys(messages);
  if (ids.length > 0) {
    registry.startBatch(
      scope,
      ids.map((messageId) => ({
        chatJid: WEB_JID,
        messageId,
        runtimeTurnId: ids[ids.length - 1],
        automationRunId: null,
      })),
    );
  }
  return skillMutationTurnRejection({
    registry,
    turnScope: scope,
    ownerUserId: OWNER,
    loadPersistedInput: (_chatJid, messageId) => messages[messageId] ?? null,
    ...lookup,
  });
}

const input = (
  sender: string,
  sourceJid: string | null,
  extra: Partial<AgentBuilderPersistedInput> = {},
): AgentBuilderPersistedInput => ({
  content: 'install it',
  sender,
  source_jid: sourceJid,
  is_from_me: 0,
  source_kind: null,
  automation_run_id: null,
  ...extra,
});

describe('install_skill / uninstall_skill only from the owner’s own turn', () => {
  test('the owner on the Web and in a group chat may install', () => {
    expect(check({ m1: input(OWNER, WEB_JID) })).toBeNull();
    expect(check({ m1: input('ou_owner', GROUP_JID) })).toBeNull();
    expect(
      check({ m1: input('ou_owner', GROUP_JID) }, { agentId: 'session-a' }),
    ).toBeNull();
  });

  test('a group member’s turn is refused with a clear reason', () => {
    expect(check({ m1: input('ou_member', GROUP_JID) })).toBe(
      SKILL_MUTATION_NON_OWNER_REJECTION,
    );
    // An owner message batched with a member's message does not lend authority.
    expect(
      check({
        m1: input('ou_owner', GROUP_JID),
        m2: input('ou_member', GROUP_JID),
      }),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    expect(SKILL_MUTATION_NON_OWNER_REJECTION).toContain('工作区主人');
  });

  test('a team-mode input the host composed never counts as the owner', () => {
    // Even carrying the owner's sender and source, a host-composed team input
    // (assignment, follow-up copy, report) is unattended.
    const composed = input(OWNER, WEB_JID, { source_kind: 'work_item_input' });
    expect(check({ m1: composed })).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    expect(
      check({ m1: input(OWNER, WEB_JID), m2: composed }, { agentId: 'w-1' }),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    // Workspace Memory classifies the turn as unattended, so a write only
    // proposes.
    const registry = new AgentBuilderTurnRegistry();
    const scope = agentBuilderTurnScope(FOLDER, 'w-1');
    registry.startBatch(scope, [
      {
        chatJid: WEB_JID,
        messageId: 'm1',
        runtimeTurnId: 'm1',
        automationRunId: null,
      },
    ]);
    expect(registry.classifyActiveTurn(scope, 'm1', () => composed)).toBe(
      'automation',
    );
    expect(
      registry.classifyActiveTurn(scope, 'm1', () => input(OWNER, WEB_JID)),
    ).toBe('interactive');
  });

  test('the owner’s own direct chat bound to a session of another workspace may install', () => {
    const inWsB = { folder: 'ws-b', agentId: 'session-b' };
    const dm = 'telegram:111#account:tg-a';
    expect(check({ m1: input('tg:111', dm) }, inWsB)).toBeNull();
    // The owner speaking in a group of the same bot, bound there too.
    expect(
      check({ m1: input('tg:111', 'telegram:-1001#account:tg-a') }, inWsB),
    ).toBeNull();
    // A member of that group is not the owner.
    expect(
      check({ m1: input('tg:999', 'telegram:-1001#account:tg-a') }, inWsB),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    // The same IM id under the owner's other bot is not the owner.
    expect(
      check({ m1: input('tg:111', 'telegram:-1002#account:tg-b') }, inWsB),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    // Another user's paired direct chat never is.
    expect(
      check({ m1: input('tg:222', 'telegram:222#account:tg-x') }, inWsB),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    // A host-composed input carrying the owner's own sender and chat neither.
    for (const extra of [
      { source_kind: 'work_item_input' },
      { source_kind: 'automation_prompt', automation_run_id: 'run-1' },
      { is_from_me: 1 },
    ]) {
      expect(check({ m1: input('tg:111', dm, extra) }, inWsB)).toBe(
        SKILL_MUTATION_NON_OWNER_REJECTION,
      );
    }
  });

  test('an owner claimed only by /owner_mention is not trusted', () => {
    groups['feishu:oc_claimed'] = {
      created_by: OWNER,
      owner_im_id: 'ou_claimer',
      owner_claim_source: 'explicit',
    };
    expect(check({ m1: input('ou_claimer', 'feishu:oc_claimed') })).toBe(
      SKILL_MUTATION_NON_OWNER_REJECTION,
    );
  });

  test('agrees with Workspace Memory writes on who the owner is', () => {
    const chat = 'feishu:oc_claims';
    for (const claim of [
      'configured',
      'trusted_direct',
      'auto_feishu',
      'explicit',
    ]) {
      groups[chat] = {
        created_by: OWNER,
        owner_im_id: 'ou_claimed',
        owner_claim_source: claim,
      };
      for (const message of [
        input('ou_claimed', chat),
        input('ou_member', chat),
        input(OWNER, WEB_JID),
        input('someone-else', WEB_JID),
      ]) {
        const registry = new AgentBuilderTurnRegistry();
        const scope = agentBuilderTurnScope(FOLDER, null);
        registry.startBatch(scope, [
          {
            chatJid: WEB_JID,
            messageId: 'm1',
            runtimeTurnId: 'm1',
            automationRunId: null,
          },
        ]);
        const load = () => message;
        const skillAllowed =
          skillMutationTurnRejection({
            registry,
            turnScope: scope,
            ownerUserId: OWNER,
            loadPersistedInput: load,
            ...lookup,
          }) === null;
        const memoryWrites = isWorkspaceMemoryOwnerTurn({
          ownerUserId: OWNER,
          registration: lookup.getGroup,
          ownerRegistrations: () => lookup.getGroupsByOwner(OWNER),
          requireActiveOwnerTurn: (isOwnerInput) =>
            registry.requireOwnerHumanTurn(scope, load, isOwnerInput),
        });
        expect([claim, message.sender, skillAllowed]).toEqual([
          claim,
          message.sender,
          memoryWrites,
        ]);
      }
    }
    delete groups[chat];
  });

  test('automation-run and turn-less requests are refused', () => {
    expect(
      check({
        m1: input(OWNER, WEB_JID, {
          automation_run_id: 'run-1',
          source_kind: 'automation_prompt',
        }),
      }),
    ).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
    expect(check({})).toBe(SKILL_MUTATION_NON_OWNER_REJECTION);
  });

  test('both IPC handlers check the turn before touching the Skill set', () => {
    const source = fs.readFileSync('src/index.ts', 'utf8');
    const file = ts.createSourceFile(
      'index.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const clauses: Record<string, string> = {};
    const visit = (node: ts.Node): void => {
      if (
        ts.isCaseClause(node) &&
        ts.isStringLiteral(node.expression) &&
        ['install_skill', 'uninstall_skill'].includes(node.expression.text)
      ) {
        clauses[node.expression.text] = node.getText(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const [name, mutate] of [
      ['install_skill', 'installSkillForUser('],
      ['uninstall_skill', 'deleteSkillForUser('],
    ]) {
      const body = clauses[name];
      expect(body).toBeDefined();
      const guard = body.indexOf('refuseSkillMutationFromNonOwnerTurn(');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(body.indexOf(mutate));
    }
  });
});
