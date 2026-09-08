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
  getJidsByFolderMock,
  storeMessageDirectMock,
  ensureChatExistsMock,
} = vi.hoisted(() => ({
  deleteSessionMock: vi.fn(),
  clearSessionChannelOwnerMock: vi.fn(),
  getJidsByFolderMock: vi.fn(),
  storeMessageDirectMock: vi.fn(),
  ensureChatExistsMock: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  deleteSession: deleteSessionMock,
  clearSessionChannelOwner: clearSessionChannelOwnerMock,
  getJidsByFolder: getJidsByFolderMock,
  storeMessageDirect: storeMessageDirectMock,
  ensureChatExists: ensureChatExistsMock,
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
    getJidsByFolderMock.mockReset();
    storeMessageDirectMock.mockReset();
    ensureChatExistsMock.mockReset();
    vi.useRealTimers();
  });

  test('resets a bound conversation agent under the real workspace jid', async () => {
    const { executeSessionReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();
    const sessions = { 'flow-graduation': 'session-1' } as Record<
      string,
      string
    >;

    await executeSessionReset(
      'web:graduation-jid',
      'flow-graduation',
      {
        queue: { stopGroup },
        sessions,
        broadcast,
        setLastAgentTimestamp,
      },
      'agent-1234',
    );

    // Agent path: only the virtual JID is stopped (no sibling fan-out).
    expect(stopGroup).toHaveBeenCalledTimes(1);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      { force: true },
    );
    expect(ensureChatExistsMock).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
    );
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(broadcast).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      expect.objectContaining({
        chat_jid: 'web:graduation-jid#agent:agent-1234',
      }),
    );
    // Agent path must NOT delete the main session's cached session ID —
    // sub-agent /clear should not corrupt the parent workspace's session.
    expect(sessions).toHaveProperty('flow-graduation', 'session-1');
  });

  test('resets a main session by stopping all sibling JIDs and clearing the folder cache', async () => {
    const { executeSessionReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();
    const sessions = {
      'home-u1': 'session-main',
      'other-folder': 'session-other',
    } as Record<string, string>;

    getJidsByFolderMock.mockReturnValue(['web:foo', 'feishu:bar']);

    await executeSessionReset(
      'web:foo',
      'home-u1',
      {
        queue: { stopGroup },
        sessions,
        broadcast,
        setLastAgentTimestamp,
      },
      // agentId omitted (undefined) — main session branch
    );

    // stopGroup called once per sibling JID, all with { force: true }
    expect(stopGroup).toHaveBeenCalledTimes(2);
    expect(stopGroup).toHaveBeenCalledWith('web:foo', { force: true });
    expect(stopGroup).toHaveBeenCalledWith('feishu:bar', { force: true });

    // setLastAgentTimestamp called once per sibling JID
    expect(setLastAgentTimestamp).toHaveBeenCalledTimes(2);
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'web:foo',
      expect.objectContaining({ id: expect.any(String) }),
    );
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'feishu:bar',
      expect.objectContaining({ id: expect.any(String) }),
    );

    // sessions[folder] entry removed (in-memory cache)
    expect(sessions).not.toHaveProperty('home-u1');
    // unrelated entries preserved
    expect(sessions).toHaveProperty('other-folder', 'session-other');

    // ensureChatExists / broadcast use the baseChatJid (not a virtual agent JID)
    expect(ensureChatExistsMock).toHaveBeenCalledWith('web:foo');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'web:foo',
      expect.objectContaining({
        chat_jid: 'web:foo',
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
    getJidsByFolderMock.mockReset();
    storeMessageDirectMock.mockReset();
    ensureChatExistsMock.mockReset();
    vi.useRealTimers();
  });

  test('advances cursor to the divider, stores handoff after it, and clears the folder cache', async () => {
    const { executeFreshWindowReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();
    const sessions = {
      'home-u1': 'session-main',
      'other-folder': 'session-other',
    } as Record<string, string>;

    getJidsByFolderMock.mockReturnValue(['web:foo', 'feishu:bar']);

    const handoff = '[HAPPYCLAW_FRESH_WINDOW_HANDOFF]\n\n## Notes\n已修好登录';
    await executeFreshWindowReset(
      'web:foo',
      'home-u1',
      {
        queue: { stopGroup },
        sessions,
        broadcast,
        setLastAgentTimestamp,
      },
      { handoff },
    );

    expect(storeMessageDirectMock).toHaveBeenCalledTimes(2);
    const dividerCall = storeMessageDirectMock.mock.calls[0];
    const handoffCall = storeMessageDirectMock.mock.calls[1];
    expect(dividerCall[4]).toBe('context_fresh_window');
    expect(dividerCall[6]).toBe(true);
    expect(handoffCall[4]).toBe(handoff);
    expect(handoffCall[6]).toBe(false);
    expect(handoffCall[5] > dividerCall[5]).toBe(true);

    const dividerId = dividerCall[0];
    expect(setLastAgentTimestamp).toHaveBeenCalledTimes(2);
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'web:foo',
      expect.objectContaining({ id: dividerId }),
    );
    expect(setLastAgentTimestamp).toHaveBeenCalledWith(
      'feishu:bar',
      expect.objectContaining({ id: dividerId }),
    );

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenNthCalledWith(
      1,
      'web:foo',
      expect.objectContaining({ content: 'context_fresh_window' }),
    );
    expect(broadcast).toHaveBeenNthCalledWith(
      2,
      'web:foo',
      expect.objectContaining({ content: handoff, is_from_me: false }),
    );

    expect(sessions).not.toHaveProperty('home-u1');
    expect(sessions).toHaveProperty('other-folder', 'session-other');
  });

  test('agent path does not dirty the parent workspace session cache', async () => {
    const { executeFreshWindowReset } = await import('../src/commands.js');
    const stopGroup = vi.fn(async () => {});
    const broadcast = vi.fn();
    const setLastAgentTimestamp = vi.fn();
    const sessions = { 'flow-graduation': 'session-1' } as Record<
      string,
      string
    >;

    await executeFreshWindowReset(
      'web:graduation-jid',
      'flow-graduation',
      {
        queue: { stopGroup },
        sessions,
        broadcast,
        setLastAgentTimestamp,
      },
      {
        agentId: 'agent-1234',
        handoff: '[HAPPYCLAW_FRESH_WINDOW_HANDOFF]\nnotes',
      },
    );

    expect(stopGroup).toHaveBeenCalledWith(
      'web:graduation-jid#agent:agent-1234',
      { force: true },
    );
    expect(storeMessageDirectMock.mock.calls[0][4]).toBe(
      'context_fresh_window',
    );
    expect(sessions).toHaveProperty('flow-graduation', 'session-1');
  });
});
