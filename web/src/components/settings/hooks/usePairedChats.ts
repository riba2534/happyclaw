import { useCallback, useState } from 'react';
import { api } from '../../../api/client';
import { getErrorMessage } from '../types';

export interface PairedChat {
  jid: string;
  name: string;
  addedAt: string;
}

interface UsePairedChatsOptions {
  /** Base API path, e.g. '/api/config/user-im/telegram/paired-chats' */
  endpoint: string;
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function usePairedChats({ endpoint, setNotice, setError }: UsePairedChatsOptions) {
  const [chats, setChats] = useState<PairedChat[]>([]);
  const [loading, setLoading] = useState(false);
  const [removingJid, setRemovingJid] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ chats: PairedChat[] }>(endpoint);
      setChats(data.chats);
    } catch {
      setChats([]);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  const remove = useCallback(
    async (jid: string) => {
      setRemovingJid(jid);
      setNotice(null);
      setError(null);
      try {
        await api.delete(`${endpoint}/${encodeURIComponent(jid)}`);
        setChats((prev) => prev.filter((c) => c.jid !== jid));
        setNotice('已移除配对聊天');
      } catch (err) {
        setError(getErrorMessage(err, '移除配对聊天失败'));
      } finally {
        setRemovingJid(null);
      }
    },
    [endpoint, setNotice, setError],
  );

  return { chats, loading, removingJid, load, remove };
}
