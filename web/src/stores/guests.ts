import { create } from 'zustand';
import { api } from '../api/client';
import { registerUserScopedReset } from './user-scope';

/** A workspace a guest can be (or is) granted read access to. */
export interface GuestWorkspaceRef {
  jid: string;
  name: string;
  is_home: boolean;
}

/** A read-only guest account created by the signed-in user. */
export interface GuestAccount {
  id: string;
  username: string;
  display_name: string;
  status: 'active' | 'disabled';
  created_at: string;
  last_login_at: string | null;
  workspaces: GuestWorkspaceRef[];
}

export interface CreateGuestInput {
  username: string;
  password: string;
  display_name?: string;
  workspace_jids: string[];
}

export interface UpdateGuestInput {
  display_name?: string;
  status?: 'active' | 'disabled';
  workspace_jids?: string[];
  password?: string;
}

interface GuestsState {
  guests: GuestAccount[];
  grantableWorkspaces: GuestWorkspaceRef[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  loadGuests: () => Promise<void>;
  createGuest: (input: CreateGuestInput) => Promise<GuestAccount>;
  updateGuest: (id: string, input: UpdateGuestInput) => Promise<GuestAccount>;
  deleteGuest: (id: string) => Promise<void>;
  reset: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

const INITIAL = {
  guests: [] as GuestAccount[],
  grantableWorkspaces: [] as GuestWorkspaceRef[],
  loading: false,
  loaded: false,
  error: null as string | null,
};

function upsert(list: GuestAccount[], guest: GuestAccount): GuestAccount[] {
  const index = list.findIndex((item) => item.id === guest.id);
  if (index === -1) return [...list, guest];
  const next = [...list];
  next[index] = guest;
  return next;
}

export const useGuestsStore = create<GuestsState>((set) => ({
  ...INITIAL,

  loadGuests: async () => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<{
        guests: GuestAccount[];
        grantable_workspaces: GuestWorkspaceRef[];
      }>('/api/guests');
      set({
        guests: data.guests ?? [],
        grantableWorkspaces: data.grantable_workspaces ?? [],
        loading: false,
        loaded: true,
      });
    } catch (err) {
      set({ loading: false, error: errorMessage(err, '访客列表加载失败') });
    }
  },

  createGuest: async (input) => {
    const data = await api.post<{ guest: GuestAccount }>('/api/guests', input);
    set((state) => ({ guests: upsert(state.guests, data.guest) }));
    return data.guest;
  },

  updateGuest: async (id, input) => {
    const data = await api.patch<{ guest: GuestAccount }>(
      `/api/guests/${encodeURIComponent(id)}`,
      input,
    );
    set((state) => ({ guests: upsert(state.guests, data.guest) }));
    return data.guest;
  },

  deleteGuest: async (id) => {
    await api.delete<{ success: boolean }>(
      `/api/guests/${encodeURIComponent(id)}`,
    );
    set((state) => ({
      guests: state.guests.filter((guest) => guest.id !== id),
    }));
  },

  reset: () => set({ ...INITIAL }),
}));

registerUserScopedReset(() => useGuestsStore.getState().reset());
