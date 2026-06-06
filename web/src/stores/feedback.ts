import { create } from 'zustand';
import { apiFetch } from '@/api/client';

export interface FeedbackStats {
  total: number;
  byType: Array<{ feedback_type: string; count: number }>;
  byUser: Array<{ user_id: string; username: string | null; count: number }>;
  byChat: Array<{ chat_jid: string; count: number }>;
  dailyTrend: Array<{ date: string; feedback_type: string; count: number }>;
}

export interface FeedbackRecord {
  id: string;
  message_id: string;
  chat_jid: string;
  user_id: string | null;
  username: string | null;
  feedback_type: string;
  user_message_preview: string | null;
  ai_response_preview: string | null;
  created_at: string;
}

export interface FeedbackDetail {
  id: string;
  message_id: string;
  chat_jid: string;
  user_id: string | null;
  username: string | null;
  feedback_type: string;
  user_message: string | null;
  ai_response: string | null;
  created_at: string;
}

export interface FeedbackListResponse {
  records: FeedbackRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface FeedbackStore {
  stats: FeedbackStats | null;
  records: FeedbackRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  feedbackType: 'like' | 'dislike' | 'all';
  selectedDetail: FeedbackDetail | null;
  loading: boolean;
  error: string | null;

  fetchStats: () => Promise<void>;
  fetchList: (page?: number, feedbackType?: 'like' | 'dislike' | 'all') => Promise<void>;
  fetchDetail: (id: string) => Promise<void>;
  setFeedbackType: (type: 'like' | 'dislike' | 'all') => void;
  clearDetail: () => void;
}

export const useFeedbackStore = create<FeedbackStore>((set, get) => ({
  stats: null,
  records: [],
  total: 0,
  page: 1,
  pageSize: 20,
  totalPages: 0,
  feedbackType: 'all',
  selectedDetail: null,
  loading: false,
  error: null,

  fetchStats: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch<FeedbackStats>('/api/feedback/stats');
      set({ stats: data, loading: false });
    } catch (err: any) {
      const errorMessage = err instanceof Error
        ? err.message
        : (err?.message || err?.body?.error || JSON.stringify(err));
      set({ error: errorMessage, loading: false });
    }
  },

  fetchList: async (page = 1, feedbackType = get().feedbackType) => {
    set({ loading: true, error: null, page, feedbackType });
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(get().pageSize),
      });
      if (feedbackType !== 'all') {
        params.set('feedbackType', feedbackType);
      }
      const data = await apiFetch<FeedbackListResponse>(`/api/feedback/list?${params}`);
      set({
        records: data.records,
        total: data.total,
        totalPages: data.totalPages,
        loading: false,
      });
    } catch (err: any) {
      const errorMessage = err instanceof Error
        ? err.message
        : (err?.message || err?.body?.error || JSON.stringify(err));
      set({ error: errorMessage, loading: false });
    }
  },

  fetchDetail: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const data = await apiFetch<FeedbackDetail>(`/api/feedback/${id}`);
      set({ selectedDetail: data, loading: false });
    } catch (err: any) {
      const errorMessage = err instanceof Error
        ? err.message
        : (err?.message || err?.body?.error || JSON.stringify(err));
      set({ error: errorMessage, loading: false });
    }
  },

  setFeedbackType: (type: 'like' | 'dislike' | 'all') => {
    set({ feedbackType: type });
    get().fetchList(1, type);
  },

  clearDetail: () => {
    set({ selectedDetail: null });
  },
}));
