import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Loader2,
  Link2,
  RotateCcw,
  MessageSquare,
  Users,
  ArrowRightLeft,
  Info,
  RefreshCw,
  X,
  AlertTriangle,
} from 'lucide-react';
import { Callout } from '@/components/capabilities/capability-ui';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useChatStore } from '../../stores/chat';
import { api } from '../../api/client';
import { showToast } from '../../utils/toast';
import type { AgentInfo, AvailableImGroup } from '../../types';
import { ChannelAccountBadge, ChannelBadge } from '../settings/channel-meta';
import {
  ACTIVATION_MODE_OPTIONS,
  AUDIENCE_MODE_OPTIONS,
} from '../../constants/im';
import {
  getImChannelCapabilities,
  IM_CHANNEL_ORDER,
  type ImChannelType,
} from '../../constants/im-capabilities';
import {
  buildChannelAccountFilterOptions,
  channelAccountKey,
} from '../../utils/channel-accounts';
import {
  buildImBindingRequest,
  isBoundToImDestination,
  resolveBindingTargetType,
  resolveBindingActivationMode,
  resolveBindingAudienceMode,
} from '../../utils/im-binding-policy';

interface ImBindingDialogProps {
  open: boolean;
  groupJid: string;
  /** session id for workspace-session binding; null for main session binding */
  agentId: string | null;
  agent?: AgentInfo;
  targetMode?: 'workspace' | 'session';
  onClose: () => void;
}

type ChannelFilter = 'all' | ImChannelType;

function ImGroupAvatar({ group }: { group: AvailableImGroup }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const avatarUrl = group.avatar?.trim() || null;

  if (avatarUrl && failedUrl !== avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(avatarUrl)}
        className="size-8 shrink-0 rounded-lg bg-surface-selected object-cover"
      />
    );
  }

  const initial = Array.from(group.name.trim())[0];
  return (
    <div
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-selected text-caption font-medium text-muted-foreground"
    >
      {initial || <MessageSquare className="size-4" />}
    </div>
  );
}

function supportsActivationModes(
  channelType: string | null | undefined,
): boolean {
  return (
    getImChannelCapabilities(channelType)?.supports_activation_modes === true
  );
}

function isFeishuDirectChat(group: AvailableImGroup): boolean {
  return group.conversation_kind === 'direct';
}

function conversationKindLabel(group: AvailableImGroup): string {
  if (group.conversation_kind === 'direct') return '私聊';
  if (group.conversation_kind === 'group') return '普通群';
  if (group.conversation_kind === 'topic') return '话题群';
  return '类型待确认';
}

function isNativeFeishuTopicGroup(group: AvailableImGroup): boolean {
  return (
    group.channel_type === 'feishu' &&
    (group.chat_mode === 'topic' || group.group_message_type === 'thread')
  );
}

function activationOptionsFor(group: AvailableImGroup) {
  if (group.channel_type !== 'feishu') return ACTIVATION_MODE_OPTIONS;
  return ACTIVATION_MODE_OPTIONS.filter((option) => {
    if (option.value === 'owner_mentioned') return false;
    if (!isFeishuDirectChat(group)) return true;
    return (
      option.value === 'always' ||
      option.value === 'auto' ||
      option.value === 'disabled'
    );
  });
}

function activationDescription(
  group: AvailableImGroup,
  mode: string,
): string | null {
  const resolvedMode =
    mode === 'auto'
      ? group.require_mention
        ? 'when_mentioned'
        : 'always'
      : mode;
  if (isFeishuDirectChat(group)) {
    return resolvedMode === 'disabled'
      ? null
      : '绑定后，私聊使用所选会话，并按响应对象设置回复。';
  }
  if (group.channel_type !== 'feishu') return null;
  if (resolvedMode === 'when_mentioned' || resolvedMode === 'owner_mentioned') {
    return isNativeFeishuTopicGroup(group)
      ? '每个新话题首次需要 @，激活后话题内无需再次 @。'
      : '每条消息需要 @机器人，均使用已绑定会话，不创建新会话。';
  }
  if (resolvedMode === 'always') {
    return isNativeFeishuTopicGroup(group)
      ? '所有话题自动响应，每个话题使用独立上下文。'
      : '群内消息免 @，使用已绑定会话。';
  }
  return null;
}

export function ImBindingDialog({
  open,
  groupJid,
  agentId,
  agent,
  targetMode = 'session',
  onClose,
}: ImBindingDialogProps) {
  const [imGroups, setImGroups] = useState<AvailableImGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [syncedFeishuAccounts, setSyncedFeishuAccounts] = useState<
    number | null
  >(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [rebindTarget, setRebindTarget] = useState<{
    imJid: string;
    group: AvailableImGroup;
  } | null>(null);
  const [activationModes, setActivationModes] = useState<
    Record<string, string>
  >({});
  const [audienceModes, setAudienceModes] = useState<
    Record<string, 'everyone' | 'owner_only'>
  >({});
  const syncGeneration = useRef(0);

  const loadAvailableImGroups = useChatStore((s) => s.loadAvailableImGroups);
  const syncAvailableImGroups = useChatStore((s) => s.syncAvailableImGroups);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const loadAgents = useChatStore((s) => s.loadAgents);
  const unbindImGroup = useChatStore((s) => s.unbindImGroup);
  const unbindMainImGroup = useChatStore((s) => s.unbindMainImGroup);
  const unbindWorkspaceImGroup = useChatStore((s) => s.unbindWorkspaceImGroup);

  const isMainMode = agentId === null;
  const isWorkspaceMode = targetMode === 'workspace';

  const destination = useMemo(
    () => ({
      type: isWorkspaceMode ? ('workspace' as const) : ('session' as const),
      groupJid,
      ...(!isWorkspaceMode ? { sessionId: agentId ?? 'main' } : {}),
    }),
    [isWorkspaceMode, groupJid, agentId],
  );

  const compatibleGroups = useMemo(
    () =>
      imGroups.filter(
        (group) =>
          resolveBindingTargetType(group) === destination.type ||
          isBoundToImDestination(group, destination),
      ),
    [imGroups, destination],
  );

  const loadGroupsForDialog = useCallback(
    async (generation?: number) => {
      setLoading(true);
      setLoadError(null);
      try {
        const groups = await loadAvailableImGroups(groupJid);
        if (generation !== undefined && generation !== syncGeneration.current) {
          return false;
        }
        setImGroups(groups);
        return true;
      } catch (err) {
        if (generation !== undefined && generation !== syncGeneration.current) {
          return false;
        }
        setImGroups([]);
        setLoadError(err instanceof Error ? err.message : '消息渠道加载失败');
        return false;
      } finally {
        if (generation === undefined || generation === syncGeneration.current) {
          setLoading(false);
        }
      }
    },
    [groupJid, loadAvailableImGroups],
  );

  const syncGroupsForDialog = useCallback(
    async (notifyOnError = false) => {
      const generation = ++syncGeneration.current;
      setSyncing(true);
      setSyncError(null);
      try {
        const result = await syncAvailableImGroups(groupJid);
        const groups = await loadAvailableImGroups(groupJid);
        if (generation !== syncGeneration.current) return;
        setImGroups(groups);
        setLastSyncedAt(new Date());
        setSyncedFeishuAccounts(result.feishuAccounts);
      } catch (err) {
        if (generation !== syncGeneration.current) return;
        const message = err instanceof Error ? err.message : '渠道聊天同步失败';
        setSyncError(message);
        if (notifyOnError) {
          showToast('同步失败', '已保留本地聊天列表');
        }
      } finally {
        if (generation === syncGeneration.current) setSyncing(false);
      }
    },
    [groupJid, loadAvailableImGroups, syncAvailableImGroups],
  );

  useEffect(() => {
    if (!open) {
      syncGeneration.current += 1;
      setLoading(false);
      setSyncing(false);
      setActionLoading(null);
      setFilter('');
      setChannelFilter('all');
      setAccountFilter('all');
      setRebindTarget(null);
      setActivationModes({});
      setAudienceModes({});
      setLoadError(null);
      setSyncError(null);
      setLastSyncedAt(null);
      setSyncedFeishuAccounts(null);
      return;
    }

    setActionLoading(null);
    setRebindTarget(null);
    setActivationModes({});
    setAudienceModes({});
    setFilter('');
    setChannelFilter('all');
    setAccountFilter('all');
    const generation = ++syncGeneration.current;
    void loadGroupsForDialog(generation).then((loaded) => {
      if (loaded && generation === syncGeneration.current) {
        void syncGroupsForDialog(false);
      }
    });
    return () => {
      if (generation === syncGeneration.current) {
        syncGeneration.current += 1;
      }
    };
  }, [open, groupJid, agentId, loadGroupsForDialog, syncGroupsForDialog]);

  const channelFilters: { key: ChannelFilter; label: string; count: number }[] =
    useMemo(() => {
      const counts = new Map<string, number>();
      for (const group of compatibleGroups) {
        counts.set(
          group.channel_type,
          (counts.get(group.channel_type) ?? 0) + 1,
        );
      }
      return [
        { key: 'all', label: '全部', count: compatibleGroups.length },
        ...IM_CHANNEL_ORDER.map((type) => ({
          key: type,
          label: getImChannelCapabilities(type)?.label ?? type,
          count: counts.get(type) ?? 0,
        })).filter((item) => item.count > 0),
      ];
    }, [compatibleGroups]);

  const selectedChannelLabel =
    channelFilter === 'all'
      ? null
      : (getImChannelCapabilities(channelFilter)?.label ?? channelFilter);
  const accountOptions = useMemo(
    () => buildChannelAccountFilterOptions(compatibleGroups),
    [compatibleGroups],
  );

  const filteredGroups = useMemo(() => {
    let groups = compatibleGroups;
    if (accountFilter !== 'all') {
      groups = groups.filter(
        (group) => channelAccountKey(group) === accountFilter,
      );
    }
    if (channelFilter !== 'all') {
      groups = groups.filter((g) => g.channel_type === channelFilter);
    }
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      groups = groups.filter(
        (g) =>
          g.name.toLowerCase().includes(q) || g.jid.toLowerCase().includes(q),
      );
    }

    const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const priority = (group: AvailableImGroup): number => {
      const boundToCurrent = isBoundToImDestination(group, destination);
      if (boundToCurrent) return 0;
      const addedAt = Date.parse(group.added_at);
      if (Number.isFinite(addedAt) && addedAt >= recentCutoff) return 1;
      const isUnbound =
        !(group.bound_session_id ?? group.bound_agent_id) &&
        !(group.bound_workspace_jid ?? group.bound_main_jid);
      return isUnbound ? 2 : 3;
    };
    return [...groups].sort((a, b) => {
      const priorityDiff = priority(a) - priority(b);
      if (priorityDiff !== 0) return priorityDiff;
      const dateDiff = Date.parse(b.added_at) - Date.parse(a.added_at);
      if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
      const nameDiff = a.name.localeCompare(b.name, 'zh-CN');
      return nameDiff !== 0 ? nameDiff : a.jid.localeCompare(b.jid);
    });
  }, [
    accountFilter,
    agentId,
    compatibleGroups,
    destination,
    channelFilter,
    filter,
    groupJid,
    isMainMode,
  ]);

  const isBoundToThis = (group: AvailableImGroup): boolean =>
    isBoundToImDestination(group, destination);

  const isBoundToOther = (group: AvailableImGroup): boolean => {
    if (isBoundToThis(group)) return false;
    return (
      !!(group.bound_session_id ?? group.bound_agent_id) ||
      !!(group.bound_workspace_jid ?? group.bound_main_jid)
    );
  };

  const reloadGroups = async () => {
    try {
      const groups = await loadAvailableImGroups(groupJid);
      setImGroups(groups);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '消息渠道刷新失败');
      showToast('刷新失败', '消息渠道列表可能已过期');
    }
  };

  const bindCurrentTarget = async (group: AvailableImGroup, force = false) => {
    const request = buildImBindingRequest(group, destination, {
      force,
      activationMode: activationModes[group.jid],
      audienceMode: audienceModes[group.jid],
    });
    await api.put(request.url, request.body);
    await Promise.all([loadGroups(), loadAgents(groupJid, { force: true })]);
    await reloadGroups();
  };

  const handleBind = async (imJid: string) => {
    const group = imGroups.find((item) => item.jid === imJid);
    if (!group) return;
    setActionLoading(imJid);
    try {
      await bindCurrentTarget(group);
    } catch {
      showToast('绑定失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnbind = async (imJid: string) => {
    setActionLoading(imJid);
    try {
      let ok: boolean;
      if (isWorkspaceMode || isMainMode) {
        ok = isWorkspaceMode
          ? await unbindWorkspaceImGroup(groupJid, imJid)
          : await unbindMainImGroup(groupJid, imJid);
      } else {
        ok = await unbindImGroup(groupJid, agentId!, imJid);
      }
      if (ok) {
        await reloadGroups();
      } else {
        showToast('解除绑定失败');
      }
    } catch {
      showToast('解除绑定失败');
    }
    setActionLoading(null);
  };

  const handleActivationModeChange = useCallback(
    async (imJid: string, mode: string) => {
      const target = imGroups.find((group) => group.jid === imJid);
      if (!target) return;
      const previousMode = resolveBindingActivationMode(
        target,
        activationModes[imJid],
      );
      setActivationModes((prev) => ({ ...prev, [imJid]: mode }));
      // Update activation without changing the binding destination.
      try {
        await api.put(
          `/api/config/user-im/bindings/${encodeURIComponent(imJid)}`,
          {
            activation_mode: mode,
          },
        );
        await reloadGroups();
      } catch {
        setActivationModes((prev) => ({
          ...prev,
          [imJid]: previousMode,
        }));
        showToast('更新触发模式失败');
      }
    },
    [activationModes, imGroups],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAudienceModeChange = useCallback(
    async (imJid: string, audienceMode: 'everyone' | 'owner_only') => {
      const target = imGroups.find((group) => group.jid === imJid);
      if (!target) return;
      const previousAudience = resolveBindingAudienceMode(
        target,
        audienceModes[imJid],
      );
      setAudienceModes((prev) => ({ ...prev, [imJid]: audienceMode }));
      try {
        await api.put(
          `/api/config/user-im/bindings/${encodeURIComponent(imJid)}`,
          {
            audience_mode: audienceMode,
          },
        );
        await reloadGroups();
      } catch {
        setAudienceModes((prev) => ({
          ...prev,
          [imJid]: previousAudience,
        }));
        showToast('更新响应对象失败');
      }
    },
    [audienceModes, imGroups],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const describeBindTarget = (group: AvailableImGroup): string => {
    if (
      (group.bound_session_id ?? group.bound_agent_id) &&
      group.bound_target_name
    ) {
      return group.bound_workspace_name &&
        group.bound_workspace_name !== group.bound_target_name
        ? `会话「${group.bound_workspace_name} / ${group.bound_target_name}」`
        : `会话「${group.bound_target_name}」`;
    }
    if (group.bound_main_jid && group.bound_target_name) {
      return resolveBindingTargetType(group) === 'session'
        ? `主会话「${group.bound_target_name}」`
        : `工作区「${group.bound_target_name}」`;
    }
    return '其他对话';
  };

  const confirmRebind = async () => {
    if (!rebindTarget) return;
    const { imJid, group: rebindGroup } = rebindTarget;
    setRebindTarget(null);
    setActionLoading(imJid);
    try {
      await bindCurrentTarget(rebindGroup, true);
    } catch {
      showToast('换绑失败');
    }
    setActionLoading(null);
  };

  const title = isWorkspaceMode
    ? '工作区绑定'
    : `会话绑定${agent ? ` — ${agent.name}` : ' — 主会话'}`;

  const renderThreadCapability = (group: AvailableImGroup) => {
    if (group.conversation_kind !== 'topic') return null;
    return <Badge variant="outline">原生话题</Badge>;
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[min(calc(100dvh-2rem),52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        >
          <DialogHeader className="shrink-0 border-b border-surface-border px-4 pt-4 pr-12 pb-3 sm:px-5 sm:pr-12">
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="size-4 text-muted-foreground" />
              {title}
            </DialogTitle>
            <DialogDescription className="text-left text-caption leading-5">
              {isWorkspaceMode
                ? '话题群绑定工作区，每个话题使用独立会话。回复返回当前话题；未绑定时不响应。'
                : '私聊和普通群绑定当前会话。回复返回当前消息所在渠道；未绑定时不响应。'}
            </DialogDescription>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-2 right-2 text-muted-foreground"
              >
                <X />
                <span className="sr-only">关闭</span>
              </Button>
            </DialogClose>
          </DialogHeader>

          <div className="shrink-0 space-y-3 px-4 pt-3 sm:px-5">
            <div className="flex min-h-8 items-center justify-between gap-3">
              <div
                className="min-w-0 text-caption text-muted-foreground"
                aria-live="polite"
              >
                {syncing ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin" />
                    正在从已连接 Bot 同步聊天…
                  </span>
                ) : syncError ? (
                  <span className="text-warning">
                    同步未完成，当前显示本地记录
                  </span>
                ) : lastSyncedAt ? (
                  syncedFeishuAccounts === 0 ? (
                    '已检查 · 当前没有已连接的飞书 Bot'
                  ) : (
                    `已同步 ${syncedFeishuAccounts ?? 0} 个飞书 Bot · ${lastSyncedAt.toLocaleTimeString(
                      [],
                      {
                        hour: '2-digit',
                        minute: '2-digit',
                      },
                    )}`
                  )
                ) : (
                  '先显示本地记录，再同步 Bot 聊天'
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={loading || syncing}
                onClick={() => void syncGroupsForDialog(true)}
              >
                <RefreshCw className={cn(syncing && 'animate-spin')} />
                同步聊天
              </Button>
            </div>

            {syncError && !loading && (
              <Callout tone="warning" role="alert">
                {syncError}
              </Callout>
            )}

            {!loading && !loadError && compatibleGroups.length > 0 && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div
                    role="group"
                    aria-label="按渠道筛选"
                    className="-mx-1 flex min-w-0 gap-0.5 overflow-x-auto px-1"
                  >
                    {channelFilters.map((ch) => {
                      const selected = channelFilter === ch.key;
                      return (
                        <Button
                          key={ch.key}
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-pressed={selected}
                          onClick={() => setChannelFilter(ch.key)}
                          className={cn(
                            'text-caption',
                            selected
                              ? 'bg-surface-selected text-foreground hover:bg-surface-selected'
                              : 'font-normal text-muted-foreground',
                          )}
                        >
                          <span>{ch.label}</span>
                          <span className="text-faint-foreground tabular-nums">
                            {ch.count}
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                  <span className="hidden shrink-0 text-caption text-muted-foreground sm:block">
                    {filteredGroups.length} 个聊天
                  </span>
                </div>

                <div
                  className={cn(
                    'grid gap-2',
                    accountOptions.length > 1 &&
                      'sm:grid-cols-[minmax(0,1fr)_auto]',
                  )}
                >
                  <SearchInput
                    value={filter}
                    onChange={setFilter}
                    placeholder="搜索名称或聊天 ID"
                    ariaLabel="搜索渠道聊天"
                    debounce={150}
                  />
                  {accountOptions.length > 1 && (
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor="binding-bot-account"
                        className="shrink-0 text-caption text-muted-foreground"
                      >
                        机器人身份
                      </label>
                      <NativeSelect
                        id="binding-bot-account"
                        value={accountFilter}
                        onChange={(event) =>
                          setAccountFilter(event.target.value)
                        }
                        aria-label="筛选机器人身份"
                        className="min-w-0"
                      >
                        <NativeSelectOption value="all">
                          全部机器人
                        </NativeSelectOption>
                        {accountOptions.map((account) => (
                          <NativeSelectOption
                            key={account.id}
                            value={account.id}
                          >
                            {account.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 sm:px-5"
            aria-live="polite"
          >
            {loading && (
              <div className="flex items-center justify-center gap-2 py-12 text-caption text-muted-foreground">
                <Spinner />
                正在加载渠道聊天…
              </div>
            )}

            {!loading && loadError && (
              <div className="space-y-3 py-8 text-center">
                <div className="text-caption text-error" role="alert">
                  消息渠道加载失败：{loadError}
                </div>
                <Button
                  variant="outline"
                  onClick={() => void loadGroupsForDialog()}
                >
                  重试
                </Button>
              </div>
            )}

            {!loading && !loadError && compatibleGroups.length === 0 && (
              <div className="py-12 text-center text-caption text-muted-foreground">
                {isWorkspaceMode
                  ? '暂无可绑定话题群。请确认 Bot 已加入话题群，然后点击“同步聊天”。'
                  : '暂无可绑定私聊或普通群。请确认 Bot 已加入群聊或收到私聊消息，然后点击“同步聊天”。'}
              </div>
            )}

            {!loading &&
              !loadError &&
              compatibleGroups.length > 0 &&
              filteredGroups.length === 0 && (
                <div className="py-10 text-center text-caption text-muted-foreground">
                  {selectedChannelLabel && !filter.trim()
                    ? `暂无 ${selectedChannelLabel} 可绑定渠道。请先完成该渠道配置，并向 Bot 发送一条消息。`
                    : '没有匹配的聊天'}
                </div>
              )}

            {!loading && !loadError && filteredGroups.length > 0 && (
              <div className="divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border">
                {filteredGroups.map((group) => {
                  const boundToThis = isBoundToThis(group);
                  const boundToOther = isBoundToOther(group);
                  const isActioning = actionLoading === group.jid;
                  const supportsActivation =
                    (group.conversation_kind === 'group' ||
                      group.conversation_kind === 'topic') &&
                    supportsActivationModes(group.channel_type);
                  const effectiveMode = resolveBindingActivationMode(
                    group,
                    activationModes[group.jid],
                  );
                  const activationOptions = activationOptionsFor(group);
                  const supportsAudience =
                    (group.conversation_kind === 'group' ||
                      group.conversation_kind === 'topic') &&
                    group.channel_type === 'feishu';
                  const policyMismatch =
                    resolveBindingTargetType(group) !== destination.type;
                  const effectiveAudience = resolveBindingAudienceMode(
                    group,
                    audienceModes[group.jid],
                  );
                  const modeDescription = activationDescription(
                    group,
                    effectiveMode,
                  );

                  return (
                    <article
                      key={group.jid}
                      className={cn(
                        'grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5 px-3 py-3 sm:px-4',
                        boundToThis && 'bg-surface-selected',
                      )}
                    >
                      {/* Group avatar */}
                      <ImGroupAvatar group={group} />

                      {/* Group info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <div className="min-w-0 truncate text-body font-medium text-foreground">
                            {group.name}
                          </div>
                          {renderThreadCapability(group)}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-caption text-muted-foreground">
                          <ChannelBadge channelType={group.channel_type} />
                          <Badge variant="outline">
                            {conversationKindLabel(group)}
                          </Badge>
                          <ChannelAccountBadge
                            accountId={group.channel_account_id}
                            accountName={group.channel_account_name}
                          />
                          {group.member_count != null &&
                            group.member_count > 0 && (
                              <span className="ml-0.5 flex items-center gap-0.5 tabular-nums">
                                <Users className="size-3" />
                                {group.member_count}
                              </span>
                            )}
                        </div>
                      </div>

                      {(boundToThis || policyMismatch || boundToOther) && (
                        <div className="col-span-2 col-start-2 flex min-w-0 flex-col items-start gap-1.5">
                          {boundToThis && (
                            <Badge variant="success">
                              <Link2 />
                              已绑定当前{isWorkspaceMode ? '工作区' : '会话'}
                            </Badge>
                          )}
                          {policyMismatch && (
                            <div className="flex items-start gap-1 text-caption leading-5 text-warning">
                              <AlertTriangle className="mt-1 size-3 shrink-0" />
                              <span>
                                此绑定与渠道类型不符：私聊和普通群应绑定会话，话题群应绑定工作区。请解除绑定后重新配置。
                              </span>
                            </div>
                          )}
                          {boundToOther && (
                            <div className="flex max-w-full min-w-0 items-center gap-1 text-caption text-warning">
                              <ArrowRightLeft className="size-3 shrink-0" />
                              <span className="truncate">
                                已绑定至{describeBindTarget(group)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Action button — three states: unbind / rebind / bind */}
                      <div className="col-start-3 row-start-1 flex justify-end">
                        {boundToThis ? (
                          <Button
                            variant="outline"
                            onClick={() => handleUnbind(group.jid)}
                            disabled={isActioning}
                          >
                            {isActioning ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <RotateCcw />
                            )}
                            解除绑定
                          </Button>
                        ) : boundToOther ? (
                          <Button
                            variant="outline"
                            onClick={() =>
                              setRebindTarget({ imJid: group.jid, group })
                            }
                            disabled={isActioning}
                          >
                            {isActioning ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <ArrowRightLeft />
                            )}
                            换绑
                          </Button>
                        ) : (
                          <Button
                            onClick={() => handleBind(group.jid)}
                            disabled={isActioning}
                            className="min-w-16"
                          >
                            {isActioning ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Link2 />
                            )}
                            绑定
                          </Button>
                        )}
                      </div>

                      {/* Response policy — applied on bind, or saved immediately once bound here. */}
                      {supportsActivation && !boundToOther && (
                        <div className="col-span-2 col-start-2 min-w-0">
                          <div
                            className={cn(
                              'grid gap-2',
                              supportsAudience && 'min-[460px]:grid-cols-2',
                            )}
                          >
                            {supportsAudience && (
                              <div className="min-w-0">
                                <label
                                  htmlFor={`audience-${group.jid}`}
                                  className="mb-1 block text-micro font-medium text-muted-foreground"
                                >
                                  响应对象
                                </label>
                                <NativeSelect
                                  id={`audience-${group.jid}`}
                                  value={effectiveAudience}
                                  onChange={(e) => {
                                    const audienceMode = e.target.value as
                                      | 'everyone'
                                      | 'owner_only';
                                    if (boundToThis) {
                                      void handleAudienceModeChange(
                                        group.jid,
                                        audienceMode,
                                      );
                                    } else {
                                      setAudienceModes((prev) => ({
                                        ...prev,
                                        [group.jid]: audienceMode,
                                      }));
                                    }
                                  }}
                                  aria-label={
                                    boundToThis
                                      ? `${group.name} 的响应对象`
                                      : undefined
                                  }
                                  className="w-full"
                                >
                                  {AUDIENCE_MODE_OPTIONS.map((option) => (
                                    <NativeSelectOption
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </NativeSelectOption>
                                  ))}
                                </NativeSelect>
                              </div>
                            )}
                            <div className="min-w-0">
                              <label
                                htmlFor={`activation-${group.jid}`}
                                className="mb-1 block text-micro font-medium text-muted-foreground"
                              >
                                触发方式
                              </label>
                              <NativeSelect
                                id={`activation-${group.jid}`}
                                value={effectiveMode}
                                onChange={(e) => {
                                  const mode = e.target.value;
                                  if (boundToThis) {
                                    void handleActivationModeChange(
                                      group.jid,
                                      mode,
                                    );
                                  } else {
                                    setActivationModes((prev) => ({
                                      ...prev,
                                      [group.jid]: mode,
                                    }));
                                  }
                                }}
                                aria-label={
                                  boundToThis
                                    ? `${group.name} 的消息触发策略`
                                    : undefined
                                }
                                className="w-full"
                              >
                                {activationOptions.map((o) => (
                                  <NativeSelectOption
                                    key={o.value}
                                    value={o.value}
                                  >
                                    {o.value === 'auto'
                                      ? `${o.label}（当前：${group.require_mention ? '仅 @机器人' : '所有允许成员'}）`
                                      : o.label}
                                  </NativeSelectOption>
                                ))}
                              </NativeSelect>
                            </div>
                          </div>
                          {effectiveAudience === 'owner_only' &&
                            !group.owner_im_id && (
                              <p className="mt-1.5 flex items-start gap-1 text-caption text-warning">
                                <Info className="mt-0.5 size-3 shrink-0" />
                                请先私聊机器人，让系统识别主人身份
                              </p>
                            )}
                          {modeDescription && (
                            <p className="mt-1.5 text-caption text-muted-foreground">
                              {modeDescription}
                            </p>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {!loading && !loadError && filteredGroups.length > 5 && (
            <p className="shrink-0 border-t border-surface-border px-4 py-2 text-center text-caption text-muted-foreground sm:px-5">
              列表可滚动 · 已按当前绑定、最近接入和未绑定优先排序
            </p>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!rebindTarget}
        onClose={() => setRebindTarget(null)}
        onConfirm={confirmRebind}
        title="确认换绑"
        message={
          rebindTarget
            ? `该渠道当前已绑定到${describeBindTarget(rebindTarget.group)}，确认换绑到当前${isWorkspaceMode ? '工作区' : '会话'}吗？`
            : ''
        }
        confirmText="换绑"
      />
    </>
  );
}
