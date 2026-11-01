import { describe, it, expect, beforeEach, vi } from 'vitest';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

const memoryStorage = new MemoryStorage();
vi.stubGlobal('localStorage', memoryStorage);

const { getLastOpenedSession, getWorkspaceLastAgent, rememberOpenedSession } =
  await import('../web/src/utils/workspaceLastAgent');

const KEY = 'happyclaw-workspace-last-agent';
const LAST_KEY = 'happyclaw-last-session';
const alpha = { jid: 'web:alpha', folder: 'alpha' };
const home = { jid: 'web:home-abc', folder: 'home-abc' };

describe('the session last opened', () => {
  beforeEach(() => {
    memoryStorage.clear();
  });

  it('is unknown until one is opened', () => {
    expect(getWorkspaceLastAgent('web:alpha')).toBeNull();
    expect(getLastOpenedSession()).toBeNull();
  });

  it('is remembered in its workspace and overall', () => {
    rememberOpenedSession(alpha, 'session-1');
    expect(getWorkspaceLastAgent('web:alpha')).toBe('session-1');
    expect(getLastOpenedSession()).toEqual({
      folder: 'alpha',
      sessionId: 'session-1',
    });
  });

  it('is kept per workspace; overall, the latest wins', () => {
    rememberOpenedSession(alpha, 'session-1');
    rememberOpenedSession(home, 'session-2');
    expect(getWorkspaceLastAgent('web:alpha')).toBe('session-1');
    expect(getWorkspaceLastAgent('web:home-abc')).toBe('session-2');
    expect(getLastOpenedSession()?.sessionId).toBe('session-2');
  });

  it('survives corrupted storage', () => {
    memoryStorage.setItem(KEY, 'not-json');
    memoryStorage.setItem(LAST_KEY, '{"folder":1}');
    expect(getWorkspaceLastAgent('web:alpha')).toBeNull();
    expect(getLastOpenedSession()).toBeNull();
    rememberOpenedSession(alpha, 'session-1');
    expect(getWorkspaceLastAgent('web:alpha')).toBe('session-1');
  });

  it('ignores a stored value that is not a map', () => {
    memoryStorage.setItem(KEY, JSON.stringify(['array', 'not', 'object']));
    expect(getWorkspaceLastAgent('web:alpha')).toBeNull();
  });
});
