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

const { getWorkspaceLastAgent, setWorkspaceLastAgent } =
  await import('../web/src/utils/workspaceLastAgent');

const KEY = 'happyclaw-workspace-last-agent';

describe('workspaceLastAgent', () => {
  beforeEach(() => {
    memoryStorage.clear();
  });

  it('returns null for unknown workspace', () => {
    expect(getWorkspaceLastAgent('web:main')).toBeNull();
  });

  it('round-trips a value', () => {
    setWorkspaceLastAgent('web:main', 'agent-1');
    expect(getWorkspaceLastAgent('web:main')).toBe('agent-1');
  });

  it('keys are independent per workspace', () => {
    setWorkspaceLastAgent('web:main', 'agent-1');
    setWorkspaceLastAgent('web:home-abc', 'agent-2');
    expect(getWorkspaceLastAgent('web:main')).toBe('agent-1');
    expect(getWorkspaceLastAgent('web:home-abc')).toBe('agent-2');
  });

  it('null clears the entry', () => {
    setWorkspaceLastAgent('web:main', 'agent-1');
    setWorkspaceLastAgent('web:main', null);
    expect(getWorkspaceLastAgent('web:main')).toBeNull();
  });

  it('removes storage key entirely when last entry cleared', () => {
    setWorkspaceLastAgent('web:main', 'agent-1');
    setWorkspaceLastAgent('web:main', null);
    expect(memoryStorage.getItem(KEY)).toBeNull();
  });

  it('keeps other entries when one is cleared', () => {
    setWorkspaceLastAgent('web:main', 'agent-1');
    setWorkspaceLastAgent('web:home-abc', 'agent-2');
    setWorkspaceLastAgent('web:main', null);
    expect(getWorkspaceLastAgent('web:main')).toBeNull();
    expect(getWorkspaceLastAgent('web:home-abc')).toBe('agent-2');
  });

  it('handles corrupted storage gracefully', () => {
    memoryStorage.setItem(KEY, 'not-json');
    expect(getWorkspaceLastAgent('web:main')).toBeNull();
    // Subsequent writes should still work after auto-recovery
    setWorkspaceLastAgent('web:main', 'agent-1');
    expect(getWorkspaceLastAgent('web:main')).toBe('agent-1');
  });

  it('handles non-object stored values gracefully', () => {
    memoryStorage.setItem(KEY, JSON.stringify(['array', 'not', 'object']));
    expect(getWorkspaceLastAgent('web:main')).toBeNull();
  });
});
