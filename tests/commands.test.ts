import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  isClearCommand,
  isFreshCommand,
  parseFreshCommand,
} from '../src/commands.js';

// Hoisted so mock factories below can reference these before module evaluation.
const {
  deleteSessionMock,
  clearSessionChannelOwnerMock,
  storeMessageDirectMock,
  ensureChatExistsMock,
  getMessageCursorMock,
} = vi.hoisted(() => ({
  deleteSessionMock: vi.fn(),
  clearSessionChannelOwnerMock: vi.fn(),
  storeMessageDirectMock: vi.fn(),
  ensureChatExistsMock: vi.fn(),
  getMessageCursorMock: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  deleteSession: deleteSessionMock,
  clearSessionChannelOwner: clearSessionChannelOwnerMock,
  storeMessageDirect: storeMessageDirectMock,
  ensureChatExists: ensureChatExistsMock,
  getMessageCursor: getMessageCursorMock,
}));

vi.mock('../src/config.js', () => ({
  DATA_DIR: '/tmp/happyclaw-test',
}));

describe('isClearCommand', () => {
  test('exact match', () => {
    expect(isClearCommand('/clear')).toBe(true);
  });

  test('case insensitive', () => {
    expect(isClearCommand('/Clear')).toBe(true);
  });

  test('whitespace tolerant', () => {
    expect(isClearCommand('  /clear  ')).toBe(true);
  });

  test('rejects trailing args', () => {
    expect(isClearCommand('/clear hello')).toBe(false);
  });

  test('rejects embedded substring', () => {
    expect(isClearCommand('hi /clear')).toBe(false);
  });

  // Pin behavior: full-width slash is a different codepoint, must not match.
  test('rejects full-width slash', () => {
    expect(isClearCommand('／clear')).toBe(false);
  });
});

describe('executeSessionReset', () => {
  beforeEach(() => {
    deleteSessionMock.mockReset();
    clearSessionChannelOwnerMock.mockReset();
    storeMessageDirectMock.mockReset();
    ensureChatExistsMock.mockReset();
    getMessageCursorMock.mockReset();
    getMessageCursorMock.mockImplementation(
      (jid: string, messageId: string) => ({
        timestamp: '2026-09-10T00:00:00.000Z',
        id: messageId,
        sequence: jid === 'feishu:bar' ? 20 : 10,
      }),
    );
    vi.useRealTimers();
  });

  test('resets one session under the real workspace jid', async () => {
    const { executeSessionReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();

    await executeSessionReset(
      'web:graduation-jid',
      'flow-graduation',
      { queue: { stopGroup }, broadcast, setLastAgentTimestamp },
      'agent-1234',
    );

    // Only the session's own runner stops; its siblings keep running.
    expect(stopGroup).toHaveBeenCalledTimes(1);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      { force: true },
    );
    expect(deleteSessionMock).toHaveBeenCalledWith(
      'flow-graduation',
      'agent-1234',
    );
    expect(clearSessionChannelOwnerMock).toHaveBeenCalledWith(
      'flow-graduation',
      'agent-1234',
    );
    expect(ensureChatExistsMock).toHaveBeenCalledTimes(1);
    expect(ensureChatExistsMock).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
    );
    expect(setLastAgentTimestamp).toHaveBeenCalledTimes(1);
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      expect.objectContaining({ id: expect.any(String), sequence: 10 }),
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      expect.objectContaining({
        chat_jid: 'web:graduation-jid#agent:agent-1234',
        content: 'context_reset',
      }),
    );
  });
});

describe('parseFreshCommand', () => {
  test('exact match with empty notes', () => {
    expect(isFreshCommand('/fresh')).toBe(true);
    expect(parseFreshCommand('/fresh')).toEqual({ notes: '' });
  });

  test('case insensitive with trailing notes', () => {
    expect(parseFreshCommand('  /Fresh 已修好登录；下一步做支付  ')).toEqual({
      notes: '已修好登录；下一步做支付',
    });
  });

  test('rejects lookalikes and embedded substring', () => {
    expect(parseFreshCommand('/freshness')).toBeNull();
    expect(parseFreshCommand('/refresh')).toBeNull();
    expect(parseFreshCommand('hi /fresh')).toBeNull();
    expect(parseFreshCommand('／fresh')).toBeNull();
    expect(isFreshCommand('/clear')).toBe(false);
  });
});

describe('executeFreshWindowReset', () => {
  beforeEach(() => {
    deleteSessionMock.mockReset();
    clearSessionChannelOwnerMock.mockReset();
    storeMessageDirectMock.mockReset();
    ensureChatExistsMock.mockReset();
    getMessageCursorMock.mockReset();
    getMessageCursorMock.mockImplementation(
      (jid: string, messageId: string) => ({
        timestamp: '2026-09-10T00:00:00.000Z',
        id: messageId,
        sequence: jid === 'feishu:bar' ? 20 : 10,
      }),
    );
    vi.useRealTimers();
  });

  test('advances the session cursor to the divider and stores the handoff after it', async () => {
    const { executeFreshWindowReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();
    const sessionJid = 'web:graduation-jid#agent:agent-1234';

    const handoff = '[HAPPYCLAW_FRESH_WINDOW_HANDOFF]\n\n## Notes\n已修好登录';
    await executeFreshWindowReset(
      'web:graduation-jid',
      'flow-graduation',
      { queue: { stopGroup }, broadcast, setLastAgentTimestamp },
      { agentId: 'agent-1234', handoff },
    );

    expect(stopGroup).toHaveBeenCalledTimes(1);
    expect(stopGroup).toHaveBeenCalledWith(sessionJid, { force: true });
    expect(storeMessageDirectMock).toHaveBeenCalledTimes(2);
    const [divider, stored] = storeMessageDirectMock.mock.calls;
    expect(divider[1]).toBe(sessionJid);
    expect(divider[4]).toBe('context_fresh_window');
    expect(divider[6]).toBe(true);
    expect(stored[1]).toBe(sessionJid);
    expect(stored[4]).toBe(handoff);
    expect(stored[6]).toBe(false);
    expect(stored[5] > divider[5]).toBe(true);

    expect(setLastAgentTimestamp).toHaveBeenCalledTimes(1);
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      sessionJid,
      expect.objectContaining({ id: divider[0], sequence: 10 }),
    );
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith(
      sessionJid,
      expect.objectContaining({ content: 'context_fresh_window' }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      sessionJid,
      expect.objectContaining({ content: handoff, is_from_me: false }),
    );
  });
});
