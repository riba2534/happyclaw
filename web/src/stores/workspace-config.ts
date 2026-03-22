/**
 * Workspace-level Skills and MCP Servers store.
 * Manages project-level configs under the workspace's .claude/ directory.
 */
import { create } from 'zustand';
import { api } from '../api/client';
import { extractErrorMessage } from '../utils/error';

// --- Skills ---

export interface WorkspaceSkill {
  id: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

// --- MCP Servers ---

export interface WorkspaceMcpServer {
  id: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  description?: string;
  addedAt: string;
}

// --- Store ---

interface WorkspaceConfigState {
  // Skills
  skills: WorkspaceSkill[];
  skillsLoading: boolean;
  skillsError: string | null;
  skillsInstalling: boolean;

  loadWorkspaceSkills: (jid: string) => Promise<void>;
  installWorkspaceSkill: (jid: string, pkg: string) => Promise<void>;
  toggleWorkspaceSkill: (jid: string, id: string, enabled: boolean) => Promise<void>;
  deleteWorkspaceSkill: (jid: string, id: string) => Promise<void>;

  // MCP Servers
  mcpServers: WorkspaceMcpServer[];
  mcpLoading: boolean;
  mcpError: string | null;

  loadWorkspaceMcp: (jid: string) => Promise<void>;
  addWorkspaceMcp: (jid: string, server: {
    id: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    type?: 'http' | 'sse';
    url?: string;
    headers?: Record<string, string>;
    description?: string;
  }) => Promise<void>;
  updateWorkspaceMcp: (jid: string, id: string, updates: Partial<WorkspaceMcpServer>) => Promise<void>;
  toggleWorkspaceMcp: (jid: string, id: string, enabled: boolean) => Promise<void>;
  deleteWorkspaceMcp: (jid: string, id: string) => Promise<void>;
}

function groupBase(jid: string): string {
  return `/api/groups/${encodeURIComponent(jid)}/workspace-config`;
}

export const useWorkspaceConfigStore = create<WorkspaceConfigState>((set, get) => ({
  // --- Skills state ---
  skills: [],
  skillsLoading: false,
  skillsError: null,
  skillsInstalling: false,

  loadWorkspaceSkills: async (jid) => {
    set({ skills: [], skillsLoading: true, skillsError: null });
    try {
      const data = await api.get<{ skills: WorkspaceSkill[] }>(`${groupBase(jid)}/skills`);
      set({ skills: data.skills, skillsLoading: false, skillsError: null });
    } catch (err) {
      set({ skillsLoading: false, skillsError: extractErrorMessage(err) });
    }
  },

  installWorkspaceSkill: async (jid, pkg) => {
    set({ skillsInstalling: true, skillsError: null });
    try {
      await api.post(`${groupBase(jid)}/skills/install`, { package: pkg }, 60_000);
      await get().loadWorkspaceSkills(jid);
    } catch (err: any) {
      set({ skillsError: err?.message || '安装失败' });
      throw err;
    } finally {
      set({ skillsInstalling: false });
    }
  },

  toggleWorkspaceSkill: async (jid, id, enabled) => {
    try {
      await api.patch(`${groupBase(jid)}/skills/${encodeURIComponent(id)}`, { enabled });
      await get().loadWorkspaceSkills(jid);
    } catch (err) {
      set({ skillsError: extractErrorMessage(err) });
    }
  },

  deleteWorkspaceSkill: async (jid, id) => {
    try {
      await api.delete(`${groupBase(jid)}/skills/${encodeURIComponent(id)}`);
      await get().loadWorkspaceSkills(jid);
    } catch (err) {
      set({ skillsError: extractErrorMessage(err) });
      throw err;
    }
  },

  // --- MCP Servers state ---
  mcpServers: [],
  mcpLoading: false,
  mcpError: null,

  loadWorkspaceMcp: async (jid) => {
    set({ mcpServers: [], mcpLoading: true, mcpError: null });
    try {
      const data = await api.get<{ servers: WorkspaceMcpServer[] }>(`${groupBase(jid)}/mcp-servers`);
      set({ mcpServers: data.servers, mcpLoading: false, mcpError: null });
    } catch (err) {
      set({ mcpLoading: false, mcpError: extractErrorMessage(err) });
    }
  },

  addWorkspaceMcp: async (jid, server) => {
    try {
      await api.post(`${groupBase(jid)}/mcp-servers`, server);
      set({ mcpError: null });
      await get().loadWorkspaceMcp(jid);
    } catch (err) {
      set({ mcpError: extractErrorMessage(err) });
      throw err;
    }
  },

  updateWorkspaceMcp: async (jid, id, updates) => {
    try {
      await api.patch(`${groupBase(jid)}/mcp-servers/${encodeURIComponent(id)}`, updates);
      set({ mcpError: null });
      await get().loadWorkspaceMcp(jid);
    } catch (err) {
      set({ mcpError: extractErrorMessage(err) });
      throw err;
    }
  },

  toggleWorkspaceMcp: async (jid, id, enabled) => {
    try {
      await api.patch(`${groupBase(jid)}/mcp-servers/${encodeURIComponent(id)}`, { enabled });
      set({ mcpError: null });
      await get().loadWorkspaceMcp(jid);
    } catch (err) {
      set({ mcpError: extractErrorMessage(err) });
    }
  },

  deleteWorkspaceMcp: async (jid, id) => {
    try {
      await api.delete(`${groupBase(jid)}/mcp-servers/${encodeURIComponent(id)}`);
      set({ mcpError: null });
      await get().loadWorkspaceMcp(jid);
    } catch (err) {
      set({ mcpError: extractErrorMessage(err) });
      throw err;
    }
  },
}));
