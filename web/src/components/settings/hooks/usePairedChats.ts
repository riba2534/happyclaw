import { useCallback, useState } from 'react';
import { toast } from 'sonner';
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
}

export function usePairedChats({ endpoint }: UsePairedChatsOptions) {
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
      try {
        await api.delete(`${endpoint}/${encodeURIComponent(jid)}`);
        setChats((prev) => prev.filter((c) => c.jid !== jid));
        toast.success('已移除配对聊天');
      } catch (err) {
        toast.error(getErrorMessage(err, '移除配对聊天失败'));
      } finally {
        setRemovingJid(null);
      }
    },
    [endpoint],
  );

  return { chats, loading, removingJid, load, remove };
}
