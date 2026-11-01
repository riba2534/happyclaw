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
// Automation session groups are collapsed unless opened.
const EXPANDED_AUTOMATIONS_KEY = 'happyclaw:sidebar-expanded-automations';

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

function readExpanded(key: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(read(key) || '{}');
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
  /** `__workspace__` (the workspace topic groups) or a session id. */
  target: string;
  nonce: number;
}

/** A request from the transcript for ChatView to open the workspace settings. */
export interface WorkspaceSettingsRequest {
  groupJid: string;
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
  /** Automation session groups opened in the session tree, by automation id. */
  expandedAutomationGroups: Record<string, boolean>;
  paletteOpen: boolean;
  /** The phone navigation drawer (phones have no sidebar or tab bar). */
  navDrawerOpen: boolean;
  createWorkspaceOpen: boolean;
  /** Agent preselected in the create-workspace dialog (null = default). */
  createWorkspaceAgentId: string | null;
  bindingRequest: BindingRequest | null;
  workspaceSettingsRequest: WorkspaceSettingsRequest | null;
  /** Incremented to ask the active composer to take focus. */
  composerFocusNonce: number;
  /** Text the active composer should insert (starter prompts), not send. */
  composerDraftRequest: ComposerDraftRequest | null;
  /**
   * By source (an AskUserQuestion card's `toolUseId`): the text it last
   * filled that the composer still holds. The composer drops an entry once
   * that text is edited away, cleared or sent.
   */
  composerFills: Record<string, string>;
  /**
   * A workspace the phone home list should expand and scroll to (the
   * `?sessions=1` link, a new workspace). Kept here rather than in the
   * history entry, so going back to the list never scrolls it.
   */
  phoneHomeReveal: { folder: string } | null;

  setSidebarWidth: (width: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setWorkspaceExpanded: (jid: string, expanded: boolean) => void;
  /** Opening a workspace drops an explicit collapse so it shows its sessions. */
  revealWorkspace: (jid: string) => void;
  setAutomationGroupExpanded: (automationId: string, expanded: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setNavDrawerOpen: (open: boolean) => void;
  setCreateWorkspaceOpen: (
    open: boolean,
    agentProfileId?: string | null,
  ) => void;
  requestBinding: (groupJid: string, target: string) => void;
  clearBindingRequest: () => void;
  requestWorkspaceSettings: (groupJid: string) => void;
  clearWorkspaceSettingsRequest: () => void;
  requestComposerFocus: () => void;
  /**
   * Insert `text` into the composer. With a `source`, it replaces what that
   * source filled last, when the composer still holds it unchanged.
   */
  requestComposerDraft: (text: string, source?: string) => void;
  forgetComposerFills: (sources: readonly string[]) => void;
  revealOnPhoneHome: (folder: string) => void;
  clearPhoneHomeReveal: () => void;
}

export interface ComposerDraftRequest {
  text: string;
  nonce: number;
  /** The text this one replaces, as its source filled it last. */
  replaces?: string;
}

export const useShellStore = create<ShellState>((set, get) => ({
  sidebarWidth: clampSidebarWidth(
    Number(read(WIDTH_KEY) ?? SIDEBAR_DEFAULT_WIDTH),
  ),
  sidebarCollapsed: read(COLLAPSED_KEY) === '1',
  expandedWorkspaces: (() => {
    if (read(LEGACY_EXPANDED_KEY) !== null) write(LEGACY_EXPANDED_KEY, null);
    return readExpanded(EXPANDED_KEY);
  })(),
  expandedAutomationGroups: readExpanded(EXPANDED_AUTOMATIONS_KEY),
  paletteOpen: false,
  navDrawerOpen: false,
  createWorkspaceOpen: false,
  createWorkspaceAgentId: null,
  bindingRequest: null,
  workspaceSettingsRequest: null,
  composerFocusNonce: 0,
  composerDraftRequest: null,
  composerFills: {},
  phoneHomeReveal: null,

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
  setAutomationGroupExpanded: (automationId, expanded) => {
    const next = { ...get().expandedAutomationGroups };
    if (expanded) next[automationId] = true;
    else delete next[automationId];
    write(EXPANDED_AUTOMATIONS_KEY, JSON.stringify(next));
    set({ expandedAutomationGroups: next });
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setNavDrawerOpen: (open) => set({ navDrawerOpen: open }),
  setCreateWorkspaceOpen: (open, agentProfileId = null) =>
    set({
      createWorkspaceOpen: open,
      createWorkspaceAgentId: open ? agentProfileId : null,
    }),
  requestBinding: (groupJid, target) =>
    set({ bindingRequest: { groupJid, target, nonce: Date.now() } }),
  clearBindingRequest: () => set({ bindingRequest: null }),
  requestWorkspaceSettings: (groupJid) =>
    set({ workspaceSettingsRequest: { groupJid, nonce: Date.now() } }),
  clearWorkspaceSettingsRequest: () => set({ workspaceSettingsRequest: null }),
  requestComposerFocus: () =>
    set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
  requestComposerDraft: (text, source) =>
    set((state) => {
      const request: ComposerDraftRequest = {
        text,
        nonce: (state.composerDraftRequest?.nonce ?? 0) + 1,
      };
      if (!source) return { composerDraftRequest: request };
      request.replaces = state.composerFills[source];
      return {
        composerDraftRequest: request,
        composerFills: { ...state.composerFills, [source]: text },
      };
    }),
  forgetComposerFills: (sources) => {
    if (sources.length === 0) return;
    const next = { ...get().composerFills };
    for (const source of sources) delete next[source];
    set({ composerFills: next });
  },
  revealOnPhoneHome: (folder) => set({ phoneHomeReveal: { folder } }),
  clearPhoneHomeReveal: () => set({ phoneHomeReveal: null }),
}));
