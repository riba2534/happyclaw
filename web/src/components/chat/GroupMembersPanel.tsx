import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, LogOut, Trash2, UserPlus } from 'lucide-react';
import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../api/client';

interface GroupMembersPanelProps {
  groupJid: string;
}

interface UserOption {
  id: string;
  username: string;
  display_name: string;
}

export function GroupMembersPanel({ groupJid }: GroupMembersPanelProps) {
  const navigate = useNavigate();
  const group = useChatStore(s => s.groups[groupJid]);
  const currentUser = useAuthStore(s => s.user);
  const members = useGroupsStore(s => s.members[groupJid]);
  const membersLoading = useGroupsStore(s => s.membersLoading);
  const membersList = members ?? [];

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const isOwner = group?.member_role === 'owner';
  const isAdmin = currentUser?.role === 'admin';
  const canManage = isOwner || isAdmin;

  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedRef.current === groupJid) return;
    loadedRef.current = groupJid;
    useGroupsStore.getState().loadMembers(groupJid).catch(() => {});
  }, [groupJid]);

  // Search users when typing
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await api.get<{ users: UserOption[] }>(
          `/api/groups/${encodeURIComponent(groupJid)}/members/search?q=${encodeURIComponent(searchQuery.trim())}`,
        );
        // Filter out users already in the group
        const memberIds = new Set(membersList.map(m => m.user_id));
        setSearchResults(data.users.filter(u => !memberIds.has(u.id)));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, membersList]);

  const handleAdd = async (userId: string) => {
    setAdding(true);
    setError(null);
    try {
      await useGroupsStore.getState().addMember(groupJid, userId);
      setSearchQuery('');
      setSearchResults([]);
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加成员失败');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (userId: string) => {
    setRemoving(userId);
    setError(null);
    try {
      await useGroupsStore.getState().removeMember(groupJid, userId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '移除成员失败');
    } finally {
      setRemoving(null);
    }
  };

  const handleLeave = async () => {
    if (!currentUser) return;
    if (!confirm('确定要退出该工作区吗？退出后将无法访问此工作区的消息和文件。')) return;
    setRemoving(currentUser.id);
    setError(null);
    try {
      await useGroupsStore.getState().removeMember(groupJid, currentUser.id);
      navigate('/chat');
    } catch (err) {
      setError(err instanceof Error ? err.message : '退出失败');
    } finally {
      setRemoving(null);
    }
  };

  if (membersLoading && membersList.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-slate-400">
        加载中...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 bg-red-50 text-red-600 text-xs border-b border-red-100">
          {error}
        </div>
      )}

      {/* Add member button / form */}
      {canManage && (
        <div className="px-4 pt-3 pb-2 border-b border-slate-100">
          {showAddForm ? (
            <div className="space-y-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索用户名..."
                className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400"
                autoFocus
              />
              {searching && (
                <div className="text-xs text-slate-400 px-1">搜索中...</div>
              )}
              {searchResults.length > 0 && (
                <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {searchResults.map((user) => (
                    <button
                      key={user.id}
                      onClick={() => handleAdd(user.id)}
                      disabled={adding}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-50 text-left"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-900 truncate">
                          {user.display_name || user.username}
                        </div>
                        {user.display_name && (
                          <div className="text-xs text-slate-400 truncate">@{user.username}</div>
                        )}
                      </div>
                      <UserPlus className="w-4 h-4 text-brand-500 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}
              {searchQuery.trim() && !searching && searchResults.length === 0 && (
                <div className="text-xs text-slate-400 px-1">未找到可添加的用户</div>
              )}
              <button
                onClick={() => { setShowAddForm(false); setSearchQuery(''); setSearchResults([]); }}
                className="text-xs text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-brand-600 hover:bg-brand-50 rounded-lg transition-colors cursor-pointer"
            >
              <UserPlus className="w-4 h-4" />
              添加成员
            </button>
          )}
        </div>
      )}

      {/* Member list */}
      <div className="flex-1 overflow-y-auto">
        {membersList.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-slate-400">
            暂无成员
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {membersList.map((member) => {
              const isSelf = member.user_id === currentUser?.id;
              const isMemberOwner = member.role === 'owner';
              return (
                <div
                  key={member.user_id}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  {/* Avatar placeholder */}
                  <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600 flex-shrink-0">
                    {(member.display_name || member.username).charAt(0).toUpperCase()}
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-slate-900 truncate">
                        {member.display_name || member.username}
                      </span>
                      {isSelf && (
                        <span className="text-[10px] text-slate-400">(我)</span>
                      )}
                      {isMemberOwner && (
                        <Crown className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-slate-400 truncate">
                      @{member.username}
                    </div>
                  </div>
                  {/* Actions */}
                  {!isMemberOwner && (
                    <>
                      {canManage && !isSelf && (
                        <button
                          onClick={() => handleRemove(member.user_id)}
                          disabled={removing === member.user_id}
                          className="p-1.5 rounded-md hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors cursor-pointer disabled:opacity-50"
                          title="移除成员"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {isSelf && !canManage && (
                        <button
                          onClick={handleLeave}
                          disabled={removing === member.user_id}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-500 hover:bg-red-50 hover:text-red-500 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          退出
                        </button>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
