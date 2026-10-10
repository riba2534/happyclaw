import { describe, expect, test } from 'vitest';
import {
  resolveBatchChannelReplySource,
  resolveInputChannelReplySource,
  resolveOutputChannelReplySource,
  selectChannelReplyBatch,
} from '../src/channel-reply-source.js';
import {
  resolveCompatibleChannelBatchAnchor,
  resolveForwardBundleBatchAnchor,
} from '../src/forward-bundle-batch.js';
import type { NewMessage } from '../src/types.js';

function message(
  id: string,
  sourceJid?: string,
  threadId?: string,
  account = 'bot-a',
): NewMessage {
  return {
    id,
    chat_jid: 'web:shared',
    sender: 'owner',
    sender_name: 'Owner',
    timestamp: '2026-09-06T00:00:00.000Z',
    content: id,
    is_from_me: false,
    ...(sourceJid
      ? {
          source_jid: sourceJid,
          channel_context: {
            schemaVersion: 1,
            provider: 'feishu',
            channelAccountId: account,
            sourceJid,
            chat: { id: 'chat', type: 'group' },
            message: {
              id,
              ...(threadId ? { threadId, rootId: `root-${threadId}` } : {}),
            },
          },
        }
      : {}),
  };
}

describe('reply destination belongs to the current input', () => {
  test('a Web input has no IM recipient', () => {
    expect(resolveInputChannelReplySource('web:shared')).toBeNull();
    expect(resolveInputChannelReplySource(undefined)).toBeNull();
    expect(resolveBatchChannelReplySource([message('web')])).toBeNull();
  });

  test('keeps interleaved private, group and Web inputs in FIFO turns', () => {
    const pending = [
      message('private-1', 'feishu:private'),
      message('private-2', 'feishu:private'),
      message('group', 'feishu:group'),
      message('web'),
      message('private-3', 'feishu:private'),
    ];
    const batches: string[][] = [];
    const recipients: Array<string | null> = [];
    while (pending.length) {
      const batch = selectChannelReplyBatch(pending);
      batches.push(batch.map((row) => row.id));
      recipients.push(resolveBatchChannelReplySource(batch));
      pending.splice(0, batch.length);
    }
    expect(batches).toEqual([
      ['private-1', 'private-2'],
      ['group'],
      ['web'],
      ['private-3'],
    ]);
    expect(recipients).toEqual([
      'feishu:private',
      'feishu:group',
      null,
      'feishu:private',
    ]);
  });

  test('cannot merge sibling topics or distinct bot accounts even on the same chat JID', () => {
    for (const next of [
      message('b', 'feishu:chat', 'topic-b'),
      message('b', 'feishu:chat', 'topic-a', 'bot-b'),
    ]) {
      const input = [message('a', 'feishu:chat', 'topic-a'), next];
      expect(selectChannelReplyBatch(input).map((row) => row.id)).toEqual([
        'a',
      ]);
      expect(resolveBatchChannelReplySource(input)).toBeNull();
    }
  });

  test('preserves a structurally verified forward bundle and its authored note', () => {
    const root = message('root', 'feishu:chat');
    const note = message('note', 'feishu:chat#root:root');
    root.channel_context!.message.contentLink = {
      kind: 'forward_bundle',
      bundleId: 'root',
      role: 'forwarded_content',
    };
    note.channel_context!.message.contentLink = {
      kind: 'forward_bundle',
      bundleId: 'root',
      role: 'forwarder_comment',
    };
    note.channel_context!.message.rootId = 'root';
    expect(selectChannelReplyBatch([root, note, message('web')])).toEqual([
      root,
      note,
    ]);
    expect(resolveBatchChannelReplySource([root, note])).toBe(note.source_jid);
    note.channel_context!.channelAccountId = 'different-bot';
    expect(selectChannelReplyBatch([root, note])).toEqual([root]);
  });
});

describe('delayed output source', () => {
  const initial = {
    initialInputTurnId: 'im-a',
    initialSourceJid: 'feishu:private-a',
  };
  test('an IM-started runner accepts a Web final answer without inheriting its IM route', () => {
    expect(
      resolveOutputChannelReplySource({
        ...initial,
        inputTurnId: 'web-b',
        admittedInput: { imJid: null },
      }),
    ).toBeNull();
    expect(
      resolveOutputChannelReplySource({ ...initial, inputTurnId: 'unknown' }),
    ).toBeNull();
  });
  test('a missing scope for the original IM still identifies the required delivery fence', () => {
    expect(
      resolveOutputChannelReplySource({ ...initial, inputTurnId: 'im-a' }),
    ).toBe('feishu:private-a');
  });
  test('a late IM A result keeps A after B arrives, and a late Web B result stays Web after C', () => {
    expect(
      resolveOutputChannelReplySource({
        ...initial,
        inputTurnId: 'im-a',
        scopeSourceJid: 'feishu:private-a',
      }),
    ).toBe('feishu:private-a');
    expect(
      resolveOutputChannelReplySource({
        ...initial,
        inputTurnId: 'web-b',
        admittedInput: { imJid: null },
      }),
    ).toBeNull();
    expect(
      resolveOutputChannelReplySource({
        ...initial,
        inputTurnId: 'im-c',
        admittedInput: { imJid: 'feishu:group-c' },
      }),
    ).toBe('feishu:group-c');
  });
});

/** The pre-optimization quadratic selector, kept as the behavioral oracle. */
function referenceSelect<T extends NewMessage>(messages: T[]): T[] {
  if (messages.length < 2) return messages;
  const key = (m: NewMessage) => {
    const context = m.channel_context;
    return [
      m.source_jid || m.chat_jid,
      context?.provider || '',
      context?.channelAccountId || '',
      context?.chat.id || '',
      context?.message.threadId || '',
      context?.message.rootId || '',
    ].join('\u0000');
  };
  const firstRoute = key(messages[0]);
  let end = 1;
  while (end < messages.length) {
    const candidate = messages.slice(0, end + 1);
    if (
      candidate.every((m) => key(m) === firstRoute) ||
      resolveForwardBundleBatchAnchor(candidate) ||
      resolveCompatibleChannelBatchAnchor(candidate)
    ) {
      end += 1;
    } else {
      break;
    }
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

describe('selectChannelReplyBatch scaling', () => {
  test('matches the reference selector on mixed routes and forward bundles', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const routes: Array<[string | undefined, string | undefined]> = [
      ['feishu:chat', undefined],
      ['feishu:chat', 'topic-a'],
      ['feishu:other', undefined],
      [undefined, undefined],
    ];
    for (let round = 0; round < 300; round += 1) {
      const length = 1 + Math.floor(random() * 12);
      const head = Math.floor(random() * routes.length);
      const batch = Array.from({ length }, (_, index) => {
        const [source, thread] =
          random() < 0.7 ? routes[head] : routes[Math.floor(random() * 4)];
        const row = message(`m${round}-${index}`, source, thread);
        if (source && random() < 0.25) {
          row.channel_context!.message.contentLink = {
            kind: 'forward_bundle',
            bundleId: 'bundle',
            role: random() < 0.5 ? 'forwarded_content' : 'forwarder_comment',
          };
        }
        return row;
      });
      expect(selectChannelReplyBatch(batch)).toEqual(referenceSelect(batch));
    }
  });

  test('is linear in a same-route backlog', () => {
    const backlog = Array.from({ length: 20_000 }, (_, index) =>
      message(`backlog-${index}`, 'feishu:chat'),
    );
    const started = performance.now();
    const selected = selectChannelReplyBatch(backlog);
    const elapsed = performance.now() - started;
    expect(selected).toBe(backlog);
    // The quadratic version needed ~1.5s for only 4k rows.
    expect(elapsed).toBeLessThan(500);
  });
});
