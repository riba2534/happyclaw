import { describe, expect, test } from 'vitest';
import { planTeamCandidateIntake } from '../src/team-candidate-intake.js';
import {
  candidateInputItem,
  withTeamInputAttachment,
} from '../src/team-gate.js';
import { DEFAULT_TEAM_SETTINGS } from '../src/work-items.js';
import type { NewMessage } from '../src/types.js';

const now = Date.parse('2026-11-06T08:00:00Z');
const options = {
  enabled: true,
  quietMs: 6000,
  maxWaitMs: 30000,
  maxMessages: 10,
  keywords: ['跟进', '下班前'],
  prioritySenderIds: ['ou_lead'],
};
function message(
  id: string,
  content: string,
  age = 0,
  sender = 'ou_member',
  source = 'feishu:oc_a',
): NewMessage {
  return {
    id,
    chat_jid: 'web:ws#agent:router',
    source_jid: source,
    sender,
    sender_name: sender,
    content,
    timestamp: new Date(now - age).toISOString(),
    attachments: withTeamInputAttachment(
      null,
      candidateInputItem({
        triggerMessageId: id,
        strength: 'inferred',
        listed: false,
        addressed: false,
        senderImId: sender,
        settings: DEFAULT_TEAM_SETTINGS,
        threadItems: [],
      }),
    ),
  };
}
describe('inferred candidate intake', () => {
  test('resets the quiet window when another fragment arrives', () => {
    const first = message('1', '刚才那个客户诉求', 4000);
    expect(planTeamCandidateIntake([first], options, now)).toMatchObject({
      kind: 'wait',
      waitMs: 2000,
    });
    const second = message('2', '谁去跟进一下', 1000);
    expect(
      planTeamCandidateIntake([first, second], options, now),
    ).toMatchObject({ kind: 'wait', waitMs: 5000 });
    expect(
      planTeamCandidateIntake([first, second], options, now + 5000),
    ).toMatchObject({
      kind: 'admit',
      reason: 'keyword',
      messages: [first, second],
    });
  });
  test('filters only the complete quiet batch, including noisy fragments', () => {
    expect(
      planTeamCandidateIntake(
        [message('1', '收到', 10000), message('2', '👍', 9000)],
        options,
        now,
      ),
    ).toMatchObject({ kind: 'discard', reason: 'noise' });
    expect(
      planTeamCandidateIntake(
        [message('1', '午饭吃什么', 10000)],
        options,
        now,
      ),
    ).toMatchObject({ kind: 'discard', reason: 'no_signal' });
    expect(
      planTeamCandidateIntake(
        [message('1', '今天下班前搞定', 10000)],
        options,
        now,
      ),
    ).toMatchObject({ kind: 'admit' });
  });
  test('priority is an exact sender id and never lets noise through', () => {
    expect(
      planTeamCandidateIntake(
        [message('1', '这件事情需要你们注意', 10000, 'ou_lead')],
        options,
        now,
      ),
    ).toMatchObject({ kind: 'admit', reason: 'priority_sender' });
    expect(
      planTeamCandidateIntake(
        [message('1', '收到', 10000, 'ou_lead')],
        options,
        now,
      ),
    ).toMatchObject({ kind: 'discard' });
    expect(
      planTeamCandidateIntake(
        [message('1', '这件事情需要注意', 10000, 'ou_lead_fake')],
        options,
        now,
      ),
    ).toMatchObject({ kind: 'discard' });
  });
  test('bounds busy chats by count and maximum age', () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      message(String(i), '跟进一下'),
    );
    expect(planTeamCandidateIntake(ten, options, now)).toMatchObject({
      kind: 'admit',
      messages: ten,
    });
    expect(
      planTeamCandidateIntake(
        [message('1', '跟进一下', 31000), message('2', '今天')],
        options,
        now,
      ),
    ).toMatchObject({ kind: 'admit' });
  });
  test('never batches across accounts, chats, explicit requests, or follow-ups', () => {
    const a = message('1', '跟进', 1000);
    const b = message('2', '跟进', 0, 'ou_member', 'feishu:oc_b');
    expect(planTeamCandidateIntake([a, b], options, now)).toMatchObject({
      kind: 'admit',
      messages: [a],
    });
    const explicit = { ...b, attachments: undefined };
    expect(planTeamCandidateIntake([explicit], options, now)).toMatchObject({
      kind: 'bypass',
    });
    expect(planTeamCandidateIntake([a, explicit], options, now)).toMatchObject({
      kind: 'admit',
      messages: [a],
    });
    expect(planTeamCandidateIntake([a], undefined, now)).toMatchObject({
      kind: 'bypass',
    });
  });
  test('native topics in the same group remain separate', () => {
    const a = message('a', '跟进');
    const b = message('b', '下班前');
    for (const [row, thread] of [
      [a, 'thread-a'],
      [b, 'thread-b'],
    ] as const) {
      row.channel_context = {
        schemaVersion: 1,
        provider: 'feishu',
        channelAccountId: 'bot-a',
        sourceJid: 'feishu:oc_a',
        chat: { id: 'oc_a', type: 'group' },
        message: { id: row.id, threadId: thread },
      };
    }
    expect(planTeamCandidateIntake([a, b], options, now)).toMatchObject({
      kind: 'admit',
      messages: [a],
    });
  });
  test('a replay never widens its frozen batch with a later message', () => {
    const a = message('a', '跟进', 9000);
    const b = message('b', '下班前', 8000);
    const c = message('c', '新请求', 0);
    for (const row of [a, b]) {
      const header = JSON.parse(row.attachments!)[0];
      header.facts.candidateBatchIds = ['a', 'b'];
      row.attachments = JSON.stringify([header]);
    }
    expect(planTeamCandidateIntake([a, b, c], options, now)).toMatchObject({
      kind: 'admit',
      reason: 'replay',
      messages: [a, b],
    });
  });
  test('a literal custom keyword cannot become a regular expression', () => {
    expect(
      planTeamCandidateIntake(
        [message('1', '普通聊天', 9000)],
        { ...options, keywords: ['.*'] },
        now,
      ),
    ).toMatchObject({ kind: 'discard' });
  });
});
