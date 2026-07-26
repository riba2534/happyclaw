import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Web logical-run refresh contract', () => {
  test('publishes query start separately from the warm process lifecycle', () => {
    const queue = read('src/group-queue.ts');
    const web = read('src/web.ts');
    const types = read('src/types.ts');

    expect(queue).toMatch(/setOnQueryStart/);
    expect(queue).toMatch(/setOnQueryFinish/);
    expect(queue).toMatch(/announceQueryStart/);
    expect(web).toMatch(/setOnQueryStart\(broadcastRunStarted\)/);
    expect(web).toMatch(/setOnQueryFinish\(broadcastRunFinished\)/);
    expect(types).toMatch(/type: 'run_started'/);
    expect(types).toMatch(/type: 'run_finished'/);
  });

  test('reconnect snapshot is based on logical work, not a merely warm process', () => {
    const web = read('src/web.ts');
    const types = read('src/types.ts');

    expect(web).toMatch(/!g\.queryInFlight \|\| !g\.queryId/);
    expect(web).toMatch(/type: 'active_run_snapshot'/);
    expect(types).toMatch(/type: 'active_run_snapshot'/);
    expect(types).toMatch(/runId: string/);
  });

  test('cross-tab delivery restores only terminal-capable exact attempts', () => {
    const store = read('web/src/stores/chat.ts');
    const layout = read('web/src/components/layout/AppLayout.tsx');

    expect(store).toMatch(/const startsDirectRun/);
    expect(store).toMatch(/hasExactQueryAttempt\(g\)/);
    expect(store).not.toMatch(/g\.queryInFlight \|\| g\.pendingMessages/);
    expect(store).not.toMatch(/const inferredWaiting/);
    expect(store).toMatch(/handleActiveRunSnapshot/);
    expect(layout).toMatch(/wsManager\.on\('run_started'/);
    expect(layout).toMatch(/wsManager\.on\('run_finished'/);
    expect(layout).toMatch(/'active_run_snapshot'/);
  });

  test('stream projections carry runId and reconnect publishes runs first', () => {
    const web = read('src/web.ts');
    const view = read('web/src/components/chat/ChatView.tsx');
    const activeSnapshot = web.indexOf("type: 'active_run_snapshot'");
    const streamSnapshot = web.indexOf("type: 'stream_snapshot'");

    expect(activeSnapshot).toBeGreaterThan(0);
    expect(streamSnapshot).toBeGreaterThan(activeSnapshot);
    expect(web).toMatch(/runId: decision\.runId/);
    expect(view).toMatch(
      /handleStreamEvent\(groupJid, data\.event, data\.agentId, data\.runId\)/,
    );
    expect(view).toMatch(/data\.snapshot,\s+snapshotAgentId,\s+data\.runId/);
  });

  test('A-late interrupted is fenced before main or agent terminal branches', () => {
    const store = read('web/src/stores/chat.ts');
    const handler = store.slice(
      store.indexOf('handleStreamEvent: (chatJid, event, agentId, runId)'),
      store.indexOf('handleWsNewMessage: (chatJid, wsMsg'),
    );
    const fence = handler.indexOf('shouldApplyRunScopedPayload');
    const firstInterrupted = handler.indexOf(
      "event.statusText === 'interrupted'",
    );
    const lastInterrupted = handler.lastIndexOf(
      "event.statusText === 'interrupted'",
    );

    expect(fence).toBeGreaterThan(0);
    expect(firstInterrupted).toBeGreaterThan(fence);
    expect(lastInterrupted).toBeGreaterThan(firstInterrupted);
  });

  test('exact terminal and explicit stop clear duration and run ownership', () => {
    const store = read('web/src/stores/chat.ts');
    const finished = store.slice(
      store.indexOf('handleRunFinished: (chatJid, runId)'),
      store.indexOf('handleActiveRunSnapshot: (runs)'),
    );
    const stopped = store.slice(
      store.indexOf('stopGroup: async (jid: string)'),
      store.indexOf('interruptQuery: async (jid: string)'),
    );

    expect(finished).toMatch(/delete nextPendingThinkingDuration\[chatJid\]/);
    expect(finished).toMatch(/cancelPendingDeltaForRuntime\(chatJid\)/);
    expect(stopped).toMatch(/delete activeRuns\[jid\]/);
    expect(stopped).toMatch(/preserveThinking: false/);
  });

  test('runner process state no longer owns query snapshot cleanup', () => {
    const web = read('src/web.ts');
    const store = read('web/src/stores/chat.ts');

    const runnerState = web.slice(
      web.indexOf('export function broadcastRunnerState'),
      web.indexOf('export function broadcastRunStarted'),
    );
    expect(runnerState).not.toMatch(/agentPrefix/);
    // Idle may still reap sub-agent snapshots that have no live logical run —
    // run_finished only deletes the exact JID whose runId matched, so a run
    // ending without one would otherwise stay resident until the 30-minute
    // sweep. What must never come back is the unconditional prefix wipe: any
    // delete here has to be guarded by activeLogicalRuns.
    if (/streamingSnapshots\.delete/.test(runnerState)) {
      expect(runnerState).toMatch(/activeLogicalRuns\.has/);
    }
    expect(store).toMatch(/activeRuns: ClientActiveRuns/);
    expect(store).toMatch(/applyRunFinished/);
    expect(store).toMatch(/exactRunActive \|\| holdsRunningWorkflow/);
  });
});
