import { describe, expect, test } from 'vitest';

import {
  AgentBuilderTurnRegistry,
  type AgentBuilderPersistedInput,
} from '../src/agent-builder-turn-auth.js';
import { skillMutationTurnRejection } from '../src/skill-ipc-authorization.js';
import {
  classifyWorkspaceTurnPrincipal,
  isDelegateCapableConversation,
  isWorkspaceDelegateInput,
  type WorkspaceDelegateContext,
  type WorkspaceDelegateMount,
} from '../src/workspace-delegate-auth.js';
import { workspaceTurnPrincipal } from '../src/workspace-memory-ipc.js';

const OWNER = 'u1';
const FOLDER = 'flow-x';
const DM = 'qq:c2c:AAAA';
const ACCOUNT_DM = 'qq:c2c:CCCC#account:acc-1';
const GROUP = 'qq:group:GGGG';

const trusted = (
  overrides: Partial<WorkspaceDelegateMount> = {},
): WorkspaceDelegateMount => ({
  delegate_enabled: true,
  workspace_folder: FOLDER,
  owner_user_id: OWNER,
  session_id: null,
  routing_mode: 'single_session',
  ...overrides,
});

function context(
  mounts: Record<string, WorkspaceDelegateMount>,
  overrides: Partial<WorkspaceDelegateContext> = {},
): WorkspaceDelegateContext {
  return {
    ownerUserId: OWNER,
    workspaceFolder: FOLDER,
    runtimeAgentId: null,
    hostWorkspace: false,
    getMount: (jid) => mounts[jid],
    ...overrides,
  };
}

const said = (
  sender: string | null,
  sourceJid: string | null,
  extra: Partial<AgentBuilderPersistedInput> = {},
): AgentBuilderPersistedInput => ({
  content: 'hi',
  sender,
  source_jid: sourceJid,
  is_from_me: 0,
  source_kind: null,
  automation_run_id: null,
  ...extra,
});

describe('which conversations can hold a delegate', () => {
  test.each([
    [DM, true],
    [ACCOUNT_DM, true],
    ['telegram:12345', true],
    ['discord:dm:12345', true],
    ['wechat:wx-user', true],
    ['whatsapp:15550001111@s.whatsapp.net', true],
    [GROUP, false],
    ['telegram:-100123', false],
    ['discord:98765', false],
    ['whatsapp:123-456@g.us', false],
    // Feishu P2P and group chats share one opaque id: never guessed.
    ['feishu:oc_x', false],
    ['web:flow-x', false],
  ])('%s → %s', (jid, expected) => {
    expect(isDelegateCapableConversation(jid)).toBe(expected);
  });
});

describe('isWorkspaceDelegateInput', () => {
  const mounts = { [DM]: trusted(), [ACCOUNT_DM]: trusted() };

  test('the counterpart of a trusted direct chat of this workspace', () => {
    expect(isWorkspaceDelegateInput(said('qq:AAAA', DM), context(mounts))).toBe(
      true,
    );
    expect(
      isWorkspaceDelegateInput(said('qq:CCCC', ACCOUNT_DM), context(mounts)),
    ).toBe(true);
  });

  test('a sender other than the chat counterpart is not the delegate', () => {
    expect(isWorkspaceDelegateInput(said('qq:ZZZZ', DM), context(mounts))).toBe(
      false,
    );
    expect(isWorkspaceDelegateInput(said(null, DM), context(mounts))).toBe(
      false,
    );
  });

  test('the switch off, or a group chat with the switch somehow on, never counts', () => {
    expect(
      isWorkspaceDelegateInput(
        said('qq:AAAA', DM),
        context({ [DM]: trusted({ delegate_enabled: false }) }),
      ),
    ).toBe(false);
    expect(
      isWorkspaceDelegateInput(
        said('qq:GGGG', GROUP),
        context({ [GROUP]: trusted() }),
      ),
    ).toBe(false);
    expect(isWorkspaceDelegateInput(said('qq:AAAA', DM), context({}))).toBe(
      false,
    );
  });

  test('another folder, owner or session than the runner is not this workspace', () => {
    const input = said('qq:AAAA', DM);
    expect(
      isWorkspaceDelegateInput(
        input,
        context({ [DM]: trusted({ workspace_folder: 'flow-y' }) }),
      ),
    ).toBe(false);
    expect(
      isWorkspaceDelegateInput(
        input,
        context({ [DM]: trusted({ owner_user_id: 'u2' }) }),
      ),
    ).toBe(false);
    expect(
      isWorkspaceDelegateInput(
        input,
        context({ [DM]: trusted() }, { runtimeAgentId: 'session-2' }),
      ),
    ).toBe(false);
    expect(
      isWorkspaceDelegateInput(
        input,
        context(
          { [DM]: trusted({ session_id: 'session-2' }) },
          { runtimeAgentId: 'session-2' },
        ),
      ),
    ).toBe(true);
  });

  test('a Host workspace never has a delegate, even with the flag still on', () => {
    expect(
      isWorkspaceDelegateInput(
        said('qq:AAAA', DM),
        context(mounts, { hostWorkspace: true }),
      ),
    ).toBe(false);
  });

  test('Web inputs are never a delegate', () => {
    expect(
      isWorkspaceDelegateInput(said(OWNER, 'web:flow-x'), context(mounts)),
    ).toBe(false);
  });
});

describe('classifying a turn', () => {
  const SCOPE = FOLDER;
  const mounts = { [DM]: trusted() };
  const ownerInput = said(OWNER, 'web:flow-x');
  const delegateInput = said('qq:AAAA', DM);
  const strangerInput = said('qq:ZZZZ', 'qq:c2c:ZZZZ');

  function classify(
    inputs: Record<string, AgentBuilderPersistedInput>,
    automationRunId: string | null = null,
  ) {
    const registry = new AgentBuilderTurnRegistry();
    registry.startBatch(
      SCOPE,
      Object.keys(inputs).map((messageId) => ({
        chatJid: 'web:flow-x',
        messageId,
        runtimeTurnId: 'turn-1',
        automationRunId,
      })),
    );
    return classifyWorkspaceTurnPrincipal({
      isOwnerInput: (input) =>
        input.source_jid === 'web:flow-x' && input.sender === OWNER,
      delegate: context(mounts),
      requireTurn: (predicate) =>
        registry.requireExactActiveOwnerHumanTurn(
          SCOPE,
          'turn-1',
          (_chat, id) => inputs[id] ?? null,
          predicate,
        ),
    });
  }

  test('owner-only stays owner', () => {
    expect(classify({ a: ownerInput })).toEqual({ kind: 'owner' });
  });

  test('delegate alone, or mixed with the owner, is the delegate', () => {
    expect(classify({ d: delegateInput })).toEqual({
      kind: 'delegate',
      conversationJids: [DM],
    });
    expect(classify({ a: ownerInput, d: delegateInput })).toEqual({
      kind: 'delegate',
      conversationJids: [DM],
    });
  });

  test('anyone else in the batch makes it other', () => {
    expect(classify({ d: delegateInput, s: strangerInput })).toEqual({
      kind: 'other',
    });
  });

  test('an automation run is never the delegate, whatever sender it carries', () => {
    expect(
      classify({
        r: said('qq:AAAA', DM, {
          source_kind: 'automation_prompt',
          automation_run_id: 'run-1',
        }),
      }),
    ).toEqual({ kind: 'other' });
    expect(classify({ d: delegateInput }, 'run-1')).toEqual({ kind: 'other' });
  });

  test('a stale turn id is other', () => {
    const registry = new AgentBuilderTurnRegistry();
    registry.set(SCOPE, 'web:flow-x', 'd');
    expect(
      classifyWorkspaceTurnPrincipal({
        isOwnerInput: () => false,
        delegate: context(mounts),
        requireTurn: (predicate) =>
          registry.requireExactActiveOwnerHumanTurn(
            SCOPE,
            'turn-old',
            () => delegateInput,
            predicate,
          ),
      }),
    ).toEqual({ kind: 'other' });
  });
});

describe('the delegate tier does not leak into owner-only capabilities', () => {
  const registrations: Record<string, Record<string, unknown>> = {
    'web:flow-x': { folder: FOLDER, created_by: OWNER },
    [DM]: { folder: FOLDER, created_by: OWNER },
  };
  const inputs: Record<string, AgentBuilderPersistedInput> = {
    d: said('qq:AAAA', DM),
  };

  function registry() {
    const turns = new AgentBuilderTurnRegistry();
    turns.startBatch(FOLDER, [
      {
        chatJid: DM,
        messageId: 'd',
        runtimeTurnId: 'turn-1',
        automationRunId: null,
      },
    ]);
    return turns;
  }

  test('a delegate turn is recognised for memory and automations', () => {
    const turns = registry();
    expect(
      workspaceTurnPrincipal({
        ownerUserId: OWNER,
        workspaceJids: Object.keys(registrations),
        channelType: (jid) => (jid.startsWith('qq:') ? 'qq' : null),
        registration: (jid) => registrations[jid],
        delegate: {
          workspaceFolder: FOLDER,
          runtimeAgentId: null,
          hostWorkspace: false,
          getMount: (jid) => (jid === DM ? trusted() : undefined),
        },
        requireTurn: (predicate) =>
          turns.requireOwnerHumanTurn(
            FOLDER,
            (_chat, id) => inputs[id] ?? null,
            predicate,
          ),
      }).kind,
    ).toBe('delegate');
  });

  test('but install/uninstall Skill still rejects it', () => {
    expect(
      skillMutationTurnRejection({
        registry: registry(),
        sourceFolder: FOLDER,
        turnScope: FOLDER,
        ownerUserId: OWNER,
        loadPersistedInput: (_chat, id) => inputs[id] ?? null,
        getGroup: (jid) => registrations[jid],
        getFolderJids: () => Object.keys(registrations),
        getChannelType: (jid) => (jid.startsWith('qq:') ? 'qq' : null),
      }),
    ).not.toBeNull();
  });
});
