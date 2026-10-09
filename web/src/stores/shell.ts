import { create } from 'zustand';

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_DEFAULT_WIDTH = 256;

const WIDTH_KEY = 'happyclaw:sidebar-width';
const COLLAPSED_KEY = 'happyclaw:sidebar-collapsed';
// v2 holds only explicit toggles. The unversioned key also recorded every
// workspace ever opened as expanded, so long-lived accounts rendered (and
// fetched sessions for) their whole history of workspaces on every load.
const EXPANDED_KEY = 'happyclaw:sidebar-expanded-workspaces:v2';
const LEGACY_EXPANDED_KEY = 'happyclaw:sidebar-expanded-workspaces';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private browsing or hardened policies may disable persistent storage.
  }
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(
    Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)),
  );
}

function readExpanded(): Record<string, boolean> {
  if (read(LEGACY_EXPANDED_KEY) !== null) write(LEGACY_EXPANDED_KEY, null);
  try {
    const parsed = JSON.parse(read(EXPANDED_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/** A request from the sidebar or palette for ChatView to open IM binding. */
export interface BindingRequest {
  groupJid: string;
  /** `__main__`, `__workspace__`, or a session id. */
  target: string;
  nonce: number;
}

interface ShellState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /**
   * Explicit expand/collapse choices per workspace jid in the sidebar tree.
   * Without one, only the open workspace is expanded.
   */
  expandedWorkspaces: Record<string, boolean>;
  paletteOpen: boolean;
  createWorkspaceOpen: boolean;
  bindingRequest: BindingRequest | null;
  /** Incremented to ask the active composer to take focus. */
  composerFocusNonce: number;
  /** Text the active composer should insert (starter prompts), not send. */
  composerDraftRequest: { text: string; nonce: number } | null;

  setSidebarWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setWorkspaceExpanded: (jid: string, expanded: boolean) => void;
  /** Opening a workspace drops an explicit collapse so it shows its sessions. */
  revealWorkspace: (jid: string) => void;
  setPaletteOpen: (open: boolean) => void;
  setCreateWorkspaceOpen: (open: boolean) => void;
  requestBinding: (groupJid: string, target: string) => void;
  clearBindingRequest: () => void;
  requestComposerFocus: () => void;
  requestComposerDraft: (text: string) => void;
}

export const useShellStore = create<ShellState>((set, get) => ({
  sidebarWidth: clampSidebarWidth(
    Number(read(WIDTH_KEY) ?? SIDEBAR_DEFAULT_WIDTH),
  ),
  sidebarCollapsed: read(COLLAPSED_KEY) === '1',
  expandedWorkspaces: readExpanded(),
  paletteOpen: false,
  createWorkspaceOpen: false,
  bindingRequest: null,
  composerFocusNonce: 0,
  composerDraftRequest: null,

  setSidebarWidth: (width) => {
    const next = clampSidebarWidth(width);
    write(WIDTH_KEY, next === SIDEBAR_DEFAULT_WIDTH ? null : String(next));
    set({ sidebarWidth: next });
  },
  setSidebarCollapsed: (collapsed) => {
    write(COLLAPSED_KEY, collapsed ? '1' : null);
    set({ sidebarCollapsed: collapsed });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  setWorkspaceExpanded: (jid, expanded) => {
    const next = { ...get().expandedWorkspaces, [jid]: expanded };
    write(EXPANDED_KEY, JSON.stringify(next));
    set({ expandedWorkspaces: next });
  },
  revealWorkspace: (jid) => {
    const current = get().expandedWorkspaces;
    if (current[jid] !== false) return;
    const next = { ...current };
    delete next[jid];
    write(EXPANDED_KEY, JSON.stringify(next));
    set({ expandedWorkspaces: next });
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setCreateWorkspaceOpen: (open) => set({ createWorkspaceOpen: open }),
  requestBinding: (groupJid, target) =>
    set({ bindingRequest: { groupJid, target, nonce: Date.now() } }),
  clearBindingRequest: () => set({ bindingRequest: null }),
  requestComposerFocus: () =>
    set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
  requestComposerDraft: (text) =>
    set((state) => ({
      composerDraftRequest: {
        text,
        nonce: (state.composerDraftRequest?.nonce ?? 0) + 1,
      },
    })),
}));
