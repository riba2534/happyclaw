import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { createConversationLoop } from './helpers/conversation-loop.js';
import type { NewMessage } from '../src/types.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-input-backlog-'));
  for (const dir of ['store', 'groups', 'data']) {
    fs.mkdirSync(path.join(paths.root, dir), { recursive: true });
  }
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    STORE_DIR: path.join(paths.root, 'store'),
    GROUPS_DIR: path.join(paths.root, 'groups'),
    DATA_DIR: path.join(paths.root, 'data'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

const chatJid = 'web:backlog-main';
const agentId = 'agent-backlog';
const agentJid = `${chatJid}#agent:${agentId}`;
const BACKLOG = 1_234;

function seedBacklog(jid: string): void {
  db.ensureChatExists(jid);
  for (let i = 0; i < BACKLOG; i += 1) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString();
    db.storeMessageDirect(
      `${jid}/in-${i}`,
      jid,
      'u',
      'U',
      `input ${i}`,
      ts,
      false,
    );
    if (i % 100 === 0) {
      db.storeMessageDirect(
        `${jid}/out-${i}`,
        jid,
        'bot',
        'Bot',
        'r',
        ts,
        true,
      );
    }
  }
}

beforeAll(() => {
  db.initDatabase();
  seedBacklog(chatJid);
  seedBacklog(agentJid);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

/**
 * Runs the production processAgentConversation from the group lookup
 * through input selection against a real database. A run
 * stops when its batch is published for IPC admission; a successful turn is
 * then settled with that function's own commitCursor for the batch.
 */
function createLane() {
  const loop = createConversationLoop({
    chatJid,
    agentId,
    folder: 'backlog-main',
    globals: {
      getMessagesSinceBounded: db.getMessagesSinceBounded,
      // No lane here waits for a usage-limit reset.
      releaseUsageLimitWaitForNewInput: () => false,
      getUsageLimitWait: () => null,
      getMessagesSince: db.getMessagesSince,
      resolveMessageCursorSequence: db.resolveMessageCursorSequence,
      routerCursorPersistence: { markDirty: vi.fn() },
      saveState: vi.fn(),
      flushAcknowledgedIpcForJid: vi.fn(),
      chatJid,
      virtualChatJid: agentJid,
    },
  });
  const { globals, harness, queue, owner } = loop;
  harness.install('advanceCursors');
  harness.install('isCursorCommitted', owner);
  harness.install('commitCursor', owner);

  const followUpCount = () =>
    queue.enqueueTask.mock.calls.filter(
      ([jid, taskId]) =>
        jid === agentJid && taskId === `agent-channel-next:${agentId}`,
    ).length;

  /** One scheduler round: the batch the turn would take, or null. */
  async function round(): Promise<NewMessage[] | null> {
    const batch = await loop.round();
    if (batch) {
      // The turn succeeded for this batch (lastProcessed is its last input).
      const lastProcessed = batch[batch.length - 1];
      globals.lastProcessed = lastProcessed;
      globals.activeAgentInputTurnId = lastProcessed.id;
      globals.cursorCommittedInputTurns = new Set<string>();
      globals.commitCursor();
    }
    return batch;
  }

  return {
    round,
    followUpCount,
    globals,
    jid: agentJid,
  };
}

describe('cold-start backlog beyond one turn', () => {
  test('consumed in bounded turns with no skipped or repeated input', async () => {
    const lane = createLane();
    const seen: string[] = [];
    const sizes: number[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      const before = lane.followUpCount();
      const batch = await lane.round();
      if (!batch) break;
      sizes.push(batch.length);
      seen.push(...batch.map((message) => message.id));
      // A follow-up turn is requested exactly while input remains.
      expect(lane.followUpCount() - before).toBe(seen.length < BACKLOG ? 1 : 0);
    }

    expect(sizes).toEqual([
      db.MAX_TURN_INPUT_MESSAGES,
      db.MAX_TURN_INPUT_MESSAGES,
      BACKLOG - 2 * db.MAX_TURN_INPUT_MESSAGES,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      Array.from({ length: BACKLOG }, (_, index) => `${lane.jid}/in-${index}`),
    );
    expect(lane.globals.lastCommittedCursor[lane.jid]).toMatchObject({
      id: `${lane.jid}/in-${BACKLOG - 1}`,
    });
    // Once drained, a further check takes nothing.
    expect(await lane.round()).toBeNull();
  });
});
