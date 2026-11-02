import { describe, expect, test } from 'vitest';
import { GroupQueue } from '../src/group-queue.js';

// Seed a GroupQueue's internal map directly. listDescendantJids reads
// state.active + state.pendingTasks and iterates entries, plus checks the
// private waitingGroups set; the rest of GroupState is irrelevant here, so we
// only provide those fields.
type SeedState = { active: boolean; pendingTasks: unknown[] };
function seed(q: GroupQueue, jid: string, state: Partial<SeedState>): void {
  const anyQ = q as unknown as { groups: Map<string, SeedState> };
  anyQ.groups.set(jid, { active: false, pendingTasks: [], ...state });
}

function seedActive(q: GroupQueue, jids: string[]) {
  for (const jid of jids) seed(q, jid, { active: true });
}

function seedIdle(q: GroupQueue, jids: string[]) {
  for (const jid of jids) seed(q, jid, { active: false });
}

// A capacity-blocked descendant: not active, but has a queued task. enqueueTask
// also adds it to waitingGroups, so cover that path too.
function seedQueued(q: GroupQueue, jid: string) {
  seed(q, jid, { active: false, pendingTasks: [{ id: 't', groupJid: jid }] });
  (q as unknown as { waitingGroups: Set<string> }).waitingGroups.add(jid);
}

// Mirror of src/index.ts setSerializationKeyResolver mapping, inlined so the
// test stays hermetic. If the real resolver changes, update both sides.
function seedResolver(
  q: GroupQueue,
  jidToFolder: Record<string, string>,
): void {
  q.setSerializationKeyResolver((groupJid: string) => {
    const agentSep = groupJid.indexOf('#agent:');
    if (agentSep >= 0) {
      const baseJid = groupJid.slice(0, agentSep);
      const agentId = groupJid.slice(agentSep + '#agent:'.length);
      const folder = jidToFolder[baseJid] || baseJid;
      return `${folder}#${agentId}`;
    }
    return jidToFolder[groupJid] || groupJid;
  });
}

describe('GroupQueue.listDescendantJids', () => {
  test('returns active sub-agent and session virtual JIDs in the same folder', () => {
    const q = new GroupQueue();
    seedResolver(q, {
      'web:main': 'main',
      'feishu:F1': 'main', // IM sibling on same folder
      'web:other': 'other',
    });
    seedActive(q, [
      'web:main', // main session, NOT a descendant
      'web:main#agent:a1', // sub-agent spawned from web:main
      'feishu:F1#agent:a2', // sub-agent spawned from IM sibling, same folder
      'web:main#agent:run1', // automation run session
      'web:other#agent:a3', // different folder — must NOT match
    ]);

    const out = q.listDescendantJids('web:main').sort();
    expect(out).toEqual(
      ['web:main#agent:a1', 'feishu:F1#agent:a2', 'web:main#agent:run1'].sort(),
    );
  });

  test('excludes idle runners with no queued work', () => {
    const q = new GroupQueue();
    seedResolver(q, { 'web:main': 'main' });
    seedActive(q, ['web:main#agent:a1']);
    seedIdle(q, ['web:main#agent:a2']);

    expect(q.listDescendantJids('web:main')).toEqual(['web:main#agent:a1']);
  });

  test('includes queued (capacity-blocked) descendants that are not yet active', () => {
    const q = new GroupQueue();
    seedResolver(q, { 'web:main': 'main' });
    seedQueued(q, 'web:main#agent:a1'); // queued sub-agent, not active
    seedIdle(q, ['web:main#agent:a2']); // idle, no pending → excluded

    // The queued descendant must be returned so delete/clear-history stop it
    // before wiping the folder (otherwise drainWaiting launches it post-wipe).
    expect(q.listDescendantJids('web:main')).toEqual(['web:main#agent:a1']);
  });

  test('includes a descendant present ONLY in waitingGroups (no pendingTasks)', () => {
    const q = new GroupQueue();
    seedResolver(q, { 'web:main': 'main' });
    // A lane drainGroup parked in waitingGroups (no slot yet) while its
    // pendingTasks is empty. This exercises the waitingGroups predicate branch
    // independently of pendingTasks, so a future regression that drops that
    // branch is caught here.
    seed(q, 'web:main#agent:a1', { active: false, pendingTasks: [] });
    (q as unknown as { waitingGroups: Set<string> }).waitingGroups.add(
      'web:main#agent:a1',
    );

    expect(q.listDescendantJids('web:main')).toEqual(['web:main#agent:a1']);
  });

  test('does not return the base JID itself, only descendants', () => {
    const q = new GroupQueue();
    seedResolver(q, { 'web:main': 'main' });
    seedActive(q, ['web:main']);

    expect(q.listDescendantJids('web:main')).toEqual([]);
  });

  test('handles jids without a serialization resolver mapping', () => {
    const q = new GroupQueue();
    // No resolver set — fallback returns the jid as its own key
    seedActive(q, ['raw:jid#agent:x']);

    // `raw:jid` as its own key → descendants are "raw:jid#..." family.
    // raw:jid#agent:x → `raw:jid#agent:x` → does it start with `raw:jid#`? Yes.
    expect(q.listDescendantJids('raw:jid')).toEqual(['raw:jid#agent:x']);
  });

  test('stopGroup invokes queued task drop callback before discarding it', async () => {
    const q = new GroupQueue();
    let dropped = 0;
    const jid = 'web:main#agent:queued';
    seed(q, jid, {
      active: false,
      pendingTasks: [
        {
          id: 'queued-task',
          groupJid: jid,
          fn: async () => {},
          onDropped: () => {
            dropped++;
          },
        },
      ],
    });
    (q as unknown as { waitingGroups: Set<string> }).waitingGroups.add(jid);

    await q.stopGroup(jid);

    expect(dropped).toBe(1);
    expect(q.listDescendantJids('web:main')).toEqual([]);
  });
});
