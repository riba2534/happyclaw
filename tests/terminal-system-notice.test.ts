import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import {
  resolveTerminalNoticeImJid,
  settleTerminalSystemNotice,
} from '../src/terminal-system-notice.js';

const root = process.cwd();
const indexSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');

function regionAround(noticeKey: string, before = 900, after = 700): string {
  const needle = `noticeKey: '${noticeKey}'`;
  const i = indexSource.indexOf(needle);
  expect(i, `missing ${needle}`).toBeGreaterThanOrEqual(0);
  return indexSource.slice(Math.max(0, i - before), i + after);
}

describe('settleTerminalSystemNotice (billing-denied mirror)', () => {
  test('IM route + ACK: web audit runs, returns committed', async () => {
    const calls: string[] = [];
    const result = await settleTerminalSystemNotice({
      hasImReplyRoute: true,
      deliverImNotice: async () => {
        calls.push('im');
        return true;
      },
      webAudit: () => {
        calls.push('web');
      },
    });
    expect(result).toBe('committed');
    expect(calls).toEqual(['im', 'web']);
  });

  test('IM route + NACK: preserve cursor, skip web audit', async () => {
    const web = vi.fn();
    const result = await settleTerminalSystemNotice({
      hasImReplyRoute: true,
      deliverImNotice: async () => false,
      webAudit: web,
    });
    expect(result).toBe('preserve-cursor');
    expect(web).not.toHaveBeenCalled();
  });

  test('web-only (no IM route): web audit + committed without IM deliver', async () => {
    const deliver = vi.fn(async () => true);
    const calls: string[] = [];
    const result = await settleTerminalSystemNotice({
      hasImReplyRoute: false,
      deliverImNotice: deliver,
      webAudit: () => {
        calls.push('web');
      },
    });
    expect(result).toBe('committed');
    expect(deliver).not.toHaveBeenCalled();
    expect(calls).toEqual(['web']);
  });
});

describe('resolveTerminalNoticeImJid', () => {
  const isIm = (jid: string) =>
    jid.startsWith('telegram:') || jid.startsWith('whatsapp:');

  test('prefers latest message source_jid', () => {
    expect(
      resolveTerminalNoticeImJid({
        messageSourceJids: ['web:1', 'telegram:chat/9'],
        activeReplyRouteJid: 'whatsapp:1',
        chatJid: 'web:home',
        isImJid: isIm,
      }),
    ).toBe('telegram:chat/9');
  });

  test('falls back to active reply route then chat jid', () => {
    expect(
      resolveTerminalNoticeImJid({
        messageSourceJids: [null, 'web:x'],
        activeReplyRouteJid: 'whatsapp:wa/1',
        chatJid: 'telegram:t/1',
        isImJid: isIm,
      }),
    ).toBe('whatsapp:wa/1');

    expect(
      resolveTerminalNoticeImJid({
        messageSourceJids: [],
        activeReplyRouteJid: null,
        chatJid: 'telegram:t/1',
        isImJid: isIm,
      }),
    ).toBe('telegram:t/1');
  });
});

describe('index.ts — 7 terminal notice sites (batch-115+116 fold)', () => {
  const sites = [
    'context-overflow',
    'context-budget',
    'agent-profile-unavailable',
    'oom-context-reset',
    'unrecoverable-transcript',
    'unrecoverable-transcript-agent',
    'agent-max-retries',
  ] as const;

  test('all 7 noticeKeys present exactly once in deliver calls', () => {
    for (const key of sites) {
      // each key appears in deliver call + warn log (=2); at least one deliver
      expect(indexSource).toContain(`noticeKey: '${key}'`);
      expect(
        indexSource.split(`noticeKey: '${key}'`).length - 1,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(indexSource.split('settleTerminalSystemNotice(').length - 1).toBe(7);
  });

  test.each([...sites])(
    '%s: settle + independent notice + preserve-cursor + projectToWeb:false',
    (key) => {
      const region = regionAround(key);
      expect(region).toContain('settleTerminalSystemNotice');
      expect(region).toContain('deliverIndependentChannelSystemNotice');
      expect(region).toContain('projectToWeb: false');
      expect(region).toContain("settle === 'preserve-cursor'");
      // settle must precede sendSystemMessage web audit in the region
      const settleIdx = region.indexOf('settleTerminalSystemNotice');
      const sendIdx = region.indexOf('sendSystemMessage');
      expect(settleIdx).toBeGreaterThanOrEqual(0);
      expect(sendIdx).toBeGreaterThan(settleIdx);
    },
  );

  test('agent_max_retries: advanceCursors only after settle ACK', () => {
    const start = indexSource.indexOf('setOnMaxRetriesExceeded(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = indexSource.indexOf('clearTrackedProcessingIndicators', start);
    const wide = indexSource.slice(start, end + 80);
    expect(wide).toContain('resolveTerminalNoticeImJid');
    const settleIdx = wide.indexOf('settleTerminalSystemNotice');
    const advanceIdx = wide.lastIndexOf('advanceCursors');
    expect(settleIdx).toBeGreaterThanOrEqual(0);
    expect(advanceIdx).toBeGreaterThan(settleIdx);
  });

  test('unrecoverable-transcript-agent uses virtualChatJid + agent scope', () => {
    const region = regionAround('unrecoverable-transcript-agent', 1200, 900);
    expect(region).toContain('virtualChatJid');
    expect(region).toContain(
      'channelTurnScope(effectiveGroup.folder, agentId)',
    );
    expect(region).toContain('activeAgentInputTurnId');
  });

  test('solo scope: no empty-complete / dispose fence restack', () => {
    expect(indexSource).not.toMatch(/empty-complete/);
    expect(indexSource).not.toContain('abortBeforeDisposeEmptyComplete');
  });
});
