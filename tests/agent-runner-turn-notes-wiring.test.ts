import fs from 'node:fs';

import { describe, expect, test, vi } from 'vitest';

import { resolveAgentTurnAnchor } from '../container/agent-runner/src/agent-turn-contract.js';
import {
  TurnNoteLedger,
  type TurnNoteSources,
} from '../container/agent-runner/src/turn-notes.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

/**
 * The Runner's result path, run from index.ts with a real TurnNoteLedger:
 * a turn's notes count as sent only when its result completes the input.
 */
const anchor = resolveAgentTurnAnchor(
  {
    id: 'agent',
    name: 'Agent',
    version: 1,
    identityHash: 'hash',
    identityPrompt: 'Follow the contract.',
  },
  'custom',
);
const sources: TurnNoteSources = {
  memory: null,
  ownerProfile: null,
  channelContext: undefined,
  anchor,
};

function resultPath(turnNotes: TurnNoteLedger) {
  const globals: Record<string, unknown> = {
    turnNotes,
    clearBackgroundProtocolDebtWatchdog: vi.fn(),
    compactionAwaitingCompletion: false,
    silentStopContinues: 0,
    toolLoops: { reset: vi.fn() },
    ipcDeliveryTracker: {
      completeAnsweredTurns: () => [],
      hasPendingTurns: false,
      currentTurnReceipts: [],
      currentTurnMessages: [],
    },
    durableInputCompletion: { publishResult: vi.fn(), activateInput: vi.fn() },
    emit: vi.fn(),
    proactiveInteractiveContract: false,
    newSessionId: 's1',
    sessionId: 's1',
    sourceKindOverride: undefined,
    containerInput: {},
    generateTurnId: () => 'turn-next',
    providerFallbackTurns: { completeHealthyTurn: vi.fn() },
    resultReceivedAt: null,
    backgroundHandoff: { hold: vi.fn(), release: vi.fn() },
    sawPendingBackgroundTasks: false,
    backgroundSummaryForceAttempts: 0,
    activateCurrentInputTurn: vi.fn(),
    log: vi.fn(),
  };
  const harness = createRuntimeSourceHarness(
    globals,
    new URL('../container/agent-runner/src/index.ts', import.meta.url),
  );
  harness.install('publishResultCandidate', 'runQueryAttempt');
  return globals.publishResultCandidate as (
    candidate: Record<string, unknown>,
    inputTurnCompleted: boolean,
  ) => void;
}

describe('turn notes on the Runner result path', () => {
  test('a result that does not complete its input commits nothing', () => {
    const ledger = new TurnNoteLedger();
    const publish = resultPath(ledger);
    ledger.beginQuery(undefined);
    ledger.stage('u1', sources);
    ledger.bindSession('s1');
    ledger.observeAnswered(['u1']);
    // Background work still pending: the input stays replayable.
    publish(
      {
        finalText: 'working on it',
        suspectTruncated: false,
        pendingBgTasks: 1,
        completedAssistantUuid: 'a1',
      },
      false,
    );
    ledger.beginQuery('s1');
    expect(ledger.stage('u1-again', sources).anchor).toBe(anchor);

    ledger.observeAnswered(['u1-again']);
    publish(
      {
        finalText: 'done',
        suspectTruncated: false,
        pendingBgTasks: 0,
        completedAssistantUuid: 'a2',
      },
      true,
    );
    ledger.beginQuery('s1', 'a2');
    expect(ledger.stage('u2', sources).anchor).toBeUndefined();
  });

  test('the compaction hook restores the turn being continued, not a queued one', async () => {
    const turnNotes = new TurnNoteLedger();
    const harness = createRuntimeSourceHarness(
      { turnNotes },
      new URL('../container/agent-runner/src/index.ts', import.meta.url),
    );
    harness.install('restoreTurnNotesAfterCompaction');
    const hook = harness.globals.restoreTurnNotesAfterCompaction as (
      input: Record<string, unknown>,
    ) => Promise<{
      hookSpecificOutput?: { additionalContext?: string };
    }>;
    const context = (id: string) => ({
      schemaVersion: 1 as const,
      provider: 'feishu',
      sourceJid: 'feishu:oc',
      message: { id },
    });
    turnNotes.beginQuery(undefined);
    turnNotes.stage('in-flight', {
      ...sources,
      channelContext: context('om_in_flight'),
    });
    turnNotes.stage('queued', {
      ...sources,
      channelContext: context('om_queued'),
    });
    turnNotes.beginCompaction();
    const restored = (
      await hook({ hook_event_name: 'SessionStart', source: 'compact' })
    ).hookSpecificOutput?.additionalContext;
    expect(restored).toContain('om_in_flight');
    expect(restored).not.toContain('om_queued');
    // A sub-agent's compaction restores nothing.
    expect(
      await hook({
        hook_event_name: 'SessionStart',
        source: 'compact',
        agent_id: 'sub',
      }),
    ).toEqual({});
  });

  test('the prompt hook gives a prompt planned for another session its notes in full', async () => {
    const turnNotes = new TurnNoteLedger();
    const harness = createRuntimeSourceHarness(
      { turnNotes },
      new URL('../container/agent-runner/src/index.ts', import.meta.url),
    );
    harness.install('restoreTurnNotesOnSessionChange');
    const hook = harness.globals.restoreTurnNotesOnSessionChange as (
      input: Record<string, unknown>,
    ) => Promise<{
      hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
      };
    }>;
    turnNotes.beginQuery(undefined);
    turnNotes.stage('u1', sources);
    turnNotes.bindSession('s1');
    turnNotes.observeAnswered(['u1']);
    turnNotes.commitAnswered('a1');
    turnNotes.beginQuery('s1', 'a1');
    expect(turnNotes.stage('u2', sources).anchor).toBeUndefined();
    expect(
      await hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: 's1',
        prompt: 'x',
      }),
    ).toEqual({});
    const output = await hook({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's2',
      prompt: 'x',
    });
    expect(output.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput?.additionalContext).toContain(
      '<active-agent-turn-contract',
    );
  });

  test('both hooks are registered on every query', () => {
    const runner = fs.readFileSync(
      new URL('../container/agent-runner/src/index.ts', import.meta.url),
      'utf8',
    );
    expect(runner).toContain(
      "{ matcher: 'compact', hooks: [restoreTurnNotesAfterCompaction] },",
    );
    expect(runner).toContain(
      'UserPromptSubmit: [{ hooks: [restoreTurnNotesOnSessionChange] }],',
    );
  });
});
