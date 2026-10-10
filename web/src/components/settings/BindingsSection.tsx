import { useState, useMemo, useCallback } from 'react';
import { Loader2, RefreshCw, MessageSquare, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { EmptyState } from '@/components/common/EmptyState';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup } from '@/components/common/ListRow';
import { SettingsGroup, SettingsSection } from './SettingsLayout';
import { useImBindings } from './hooks/useImBindings';
import { ImBindingRow } from './ImBindingRow';
import { BindingTargetDialog } from './BindingTargetDialog';
import { api } from '../../api/client';
import type { AvailableImGroup } from '../../types';
import type { BindingTarget } from './hooks/useImBindings';
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
  hasBindingPolicyMismatch,
  resolveBindingTargetType,
} from '../../utils/im-binding-policy';

type ChannelFilter = 'all' | ImChannelType;

export function BindingsSection() {
  const {
    bindings,
    loading,
    syncing,
    syncError,
    bindingsLoadError,
    targets,
    targetsLoading,
    reload,
    rebind,
    bindTarget,
    resetAllowlist,
    error: hookError,
    clearError: clearHookError,
  } = useImBindings();
  const [localError, setLocalError] = useState<string | null>(null);
  const errorMsg = localError || hookError;
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [actioningJid, setActioningJid] = useState<string | null>(null);
  const [selectingKey, setSelectingKey] = useState<string | null>(null);

  // Dialog state
  const [rebindGroup, setRebindGroup] = useState<AvailableImGroup | null>(null);
  const [unbindGroup, setUnbindGroup] = useState<AvailableImGroup | null>(null);
  const [resetAllowlistGroup, setResetAllowlistGroup] =
    useState<AvailableImGroup | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<AvailableImGroup | null>(null);

  const channels: { key: ChannelFilter; label: string; count: number }[] =
    useMemo(() => {
      const counts = new Map<string, number>();
      for (const binding of bindings) {
        counts.set(
          binding.channel_type,
          (counts.get(binding.channel_type) ?? 0) + 1,
        );
      }
      return [
        { key: 'all', label: '全部', count: bindings.length },
        ...IM_CHANNEL_ORDER.map((type) => ({
          key: type,
          label: getImChannelCapabilities(type)?.label ?? type,
          count: counts.get(type) ?? 0,
        })),
      ];
    }, [bindings]);

  const filtered = useMemo(() => {
    let list = bindings;
    if (accountFilter !== 'all') {
      list = list.filter(
        (binding) => channelAccountKey(binding) === accountFilter,
      );
    }
    if (channelFilter !== 'all') {
      list = list.filter((b) => b.channel_type === channelFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.jid.toLowerCase().includes(q) ||
          (b.bound_target_name &&
            b.bound_target_name.toLowerCase().includes(q)) ||
          b.channel_account_name?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [accountFilter, bindings, channelFilter, search]);
  const accountOptions = useMemo(
    () => buildChannelAccountFilterOptions(bindings),
    [bindings],
  );

  const bindingSections = useMemo(
    () => [
      {
        key: 'needs-migration',
        title: '需要迁移',
        description: '历史绑定与当前规则不一致，请换绑到正确目标',
        items: filtered.filter(hasBindingPolicyMismatch),
      },
      {
        key: 'workspace',
        title: '工作区绑定',
        description: '话题群绑定工作区，每个话题使用独立会话',
        items: filtered.filter(
          (item) =>
            resolveBindingTargetType(item) === 'workspace' &&
            !(item.bound_session_id ?? item.bound_agent_id) &&
            !!(item.bound_workspace_jid ?? item.bound_main_jid),
        ),
      },
      {
        key: 'main-session',
        title: '主会话绑定',
        description: '私聊和普通群使用目标工作区的主会话',
        items: filtered.filter(
          (item) =>
            resolveBindingTargetType(item) === 'session' &&
            !hasBindingPolicyMismatch(item) &&
            !(item.bound_session_id ?? item.bound_agent_id) &&
            !!(item.bound_workspace_jid ?? item.bound_main_jid),
        ),
      },
      {
        key: 'session',
        title: '会话绑定',
        description: '私聊和普通群使用指定会话',
        items: filtered.filter(
          (item) =>
            resolveBindingTargetType(item) === 'session' &&
            !hasBindingPolicyMismatch(item) &&
            Boolean(item.bound_session_id ?? item.bound_agent_id),
        ),
      },
      {
        key: 'unbound',
        title: '未绑定',
        description: '未绑定的渠道不会响应消息',
        items: filtered.filter(
          (item) =>
            !(item.bound_session_id ?? item.bound_agent_id) &&
            !(item.bound_workspace_jid ?? item.bound_main_jid),
        ),
      },
    ],
    [filtered],
  );

  const selectedChannelLabel =
    channelFilter === 'all'
      ? null
      : (getImChannelCapabilities(channelFilter)?.label ?? channelFilter);

  const selectableTargets = useMemo(() => {
    if (!rebindGroup) return [];
    const targetType = resolveBindingTargetType(rebindGroup);
    return targets.filter((target) => target.type === targetType);
  }, [rebindGroup, targets]);

  const handleRebind = useCallback((group: AvailableImGroup) => {
    setRebindGroup(group);
  }, []);

  const handleUnbind = useCallback((group: AvailableImGroup) => {
    setUnbindGroup(group);
  }, []);

  const handleResetAllowlist = useCallback((group: AvailableImGroup) => {
    setResetAllowlistGroup(group);
  }, []);

  const handleDelete = useCallback((group: AvailableImGroup) => {
    setDeleteGroup(group);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteGroup) return;
    const jid = deleteGroup.jid;
    setDeleteGroup(null);
    setActioningJid(jid);
    setLocalError(null);
    try {
      await api.delete(`/api/groups/${encodeURIComponent(jid)}`);
      reload();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setActioningJid(null);
    }
  }, [deleteGroup, reload]);

  const confirmResetAllowlist = useCallback(async () => {
    if (!resetAllowlistGroup) return;
    const jid = resetAllowlistGroup.jid;
    setResetAllowlistGroup(null);
    setActioningJid(jid);
    setLocalError(null);
    const err = await resetAllowlist(jid);
    setActioningJid(null);
    if (err) setLocalError(err);
  }, [resetAllowlistGroup, resetAllowlist]);

  const handleActivationModeChange = useCallback(
    async (jid: string, mode: string) => {
      setActioningJid(jid);
      setLocalError(null);
      const err = await rebind(jid, {
        activation_mode: mode as
          | 'auto'
          | 'always'
          | 'when_mentioned'
          | 'owner_mentioned'
          | 'disabled',
      });
      setActioningJid(null);
      if (err) setLocalError(err);
    },
    [rebind],
  );

  const handleAudienceModeChange = useCallback(
    async (jid: string, mode: 'everyone' | 'owner_only') => {
      setActioningJid(jid);
      setLocalError(null);
      const err = await rebind(jid, { audience_mode: mode });
      setActioningJid(null);
      if (err) setLocalError(err);
    },
    [rebind],
  );

  const confirmUnbind = useCallback(async () => {
    if (!unbindGroup) return;
    const jid = unbindGroup.jid;
    setUnbindGroup(null);
    setActioningJid(jid);
    setLocalError(null);
    const err = await rebind(jid, { unbind: true });
    setActioningJid(null);
    if (err) setLocalError(err);
  }, [unbindGroup, rebind]);

  const handleSelectTarget = useCallback(
    async (target: BindingTarget) => {
      if (!rebindGroup) return;
      const key = `${target.groupJid}:${target.type}:${target.sessionId ?? ''}`;
      setSelectingKey(key);
      setLocalError(null);

      const hasBound =
        !!(rebindGroup.bound_session_id ?? rebindGroup.bound_agent_id) ||
        !!(rebindGroup.bound_workspace_jid ?? rebindGroup.bound_main_jid);
      const err = await bindTarget(rebindGroup, target, hasBound);
      setSelectingKey(null);
      if (!err) setRebindGroup(null);
      else setLocalError(err);
    },
    [rebindGroup, bindTarget],
  );

  const [restoreConfirmGroup, setRestoreConfirmGroup] =
    useState<AvailableImGroup | null>(null);

  const handleRestoreDefault = useCallback(() => {
    if (!rebindGroup) return;
    setRestoreConfirmGroup(rebindGroup);
    setRebindGroup(null);
  }, [rebindGroup]);

  const confirmRestoreDefault = useCallback(async () => {
    if (!restoreConfirmGroup) return;
    const imJid = restoreConfirmGroup.jid;
    setRestoreConfirmGroup(null);
    setActioningJid(imJid);
    setLocalError(null);
    const err = await rebind(imJid, { unbind: true });
    setActioningJid(null);
    if (err) setLocalError(err);
  }, [restoreConfirmGroup, rebind]);

  return (
    <div>
      <SettingsSection
        title="渠道绑定"
        description="私聊和普通群绑定会话，话题群绑定工作区。回复返回当前消息所在渠道或话题；未绑定时不响应。"
        actions={
          <Button
            variant="outline"
            onClick={reload}
            disabled={loading || syncing}
          >
            <RefreshCw
              className={`size-4 ${loading || syncing ? 'motion-safe:animate-spin' : ''}`}
            />
            {syncing ? '正在同步 Bot 聊天' : '同步聊天'}
          </Button>
        }
      >
        {syncError && bindings.length > 0 && (
          <div
            role="status"
            className="rounded-lg bg-warning/10 px-3 py-2 text-caption text-warning"
          >
            同步未完成，当前显示本地记录：{syncError}
          </div>
        )}

        {/* Error banner */}
        {errorMsg && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-lg bg-error/10 py-1.5 pr-1.5 pl-3 text-caption text-error"
          >
            <span>{errorMsg}</span>
            <IconButton
              label="关闭"
              size="icon-xs"
              className="text-error hover:text-error"
              onClick={() => {
                setLocalError(null);
                clearHookError();
              }}
              icon={<X />}
            />
          </div>
        )}

        {/* Toolbar: channel filter + search */}
        {bindings.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[200px] flex-1">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="搜索渠道名称..."
                  debounce={200}
                />
              </div>
              {accountOptions.length > 1 && (
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="settings-binding-bot-account"
                    className="text-caption text-muted-foreground"
                  >
                    机器人身份
                  </label>
                  <NativeSelect
                    id="settings-binding-bot-account"
                    value={accountFilter}
                    onChange={(event) => setAccountFilter(event.target.value)}
                    aria-label="筛选机器人身份"
                  >
                    <NativeSelectOption value="all">
                      全部机器人
                    </NativeSelectOption>
                    {accountOptions.map((account) => (
                      <NativeSelectOption key={account.id} value={account.id}>
                        {account.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              )}
            </div>
            <div
              role="group"
              aria-label="按渠道筛选"
              className="flex flex-wrap items-center gap-1"
            >
              {channels.map((ch) => (
                <Button
                  key={ch.key}
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={channelFilter === ch.key}
                  onClick={() => setChannelFilter(ch.key)}
                  className={
                    channelFilter === ch.key
                      ? 'bg-surface-selected text-foreground hover:bg-surface-selected'
                      : 'text-muted-foreground'
                  }
                >
                  {ch.label}
                  <span className="text-faint-foreground tabular-nums">
                    {ch.count}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-body text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载中...
          </div>
        ) : bindingsLoadError ? (
          <SettingsGroup>
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span className="flex size-9 items-center justify-center rounded-lg bg-error/10 text-error">
                <MessageSquare className="size-4.5" />
              </span>
              <p className="text-body text-error">
                消息渠道加载失败：{bindingsLoadError}
              </p>
              <Button variant="outline" size="sm" onClick={reload}>
                <RefreshCw className="size-3.5" />
                重试
              </Button>
            </div>
          </SettingsGroup>
        ) : bindings.length === 0 ? (
          <SettingsGroup>
            <EmptyState
              icon={MessageSquare}
              title="暂无 IM 渠道"
              description="在飞书、Telegram、QQ、微信、钉钉、Discord 或 WhatsApp 中向 Bot 发送消息后，渠道会自动出现在这里。"
              className="py-10"
            />
          </SettingsGroup>
        ) : filtered.length === 0 ? (
          <SettingsGroup>
            {selectedChannelLabel && !search.trim() ? (
              <EmptyState
                title={`暂无 ${selectedChannelLabel} 渠道`}
                description="请先完成该渠道配置，并向 Bot 发送一条消息。"
                className="py-10"
              />
            ) : (
              <EmptyState title="没有匹配的渠道" className="py-10" />
            )}
          </SettingsGroup>
        ) : (
          <div className="space-y-6 pt-2">
            {bindingSections.map((section) =>
              section.items.length > 0 ? (
                <section key={section.key} className="space-y-2">
                  <div className="px-1">
                    <h4 className="flex items-baseline gap-1.5 text-title-sm text-foreground">
                      {section.title}
                      <span className="text-caption font-normal text-muted-foreground tabular-nums">
                        {section.items.length}
                      </span>
                    </h4>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      {section.description}
                    </p>
                  </div>
                  <ListGroup>
                    {section.items.map((group) => (
                      <ImBindingRow
                        key={group.jid}
                        group={group}
                        isActioning={actioningJid === group.jid}
                        onRebind={handleRebind}
                        onUnbind={handleUnbind}
                        onResetAllowlist={handleResetAllowlist}
                        onActivationModeChange={handleActivationModeChange}
                        onAudienceModeChange={handleAudienceModeChange}
                        onDelete={handleDelete}
                      />
                    ))}
                  </ListGroup>
                </section>
              ) : null,
            )}
          </div>
        )}
      </SettingsSection>

      {/* Rebind target dialog */}
      <BindingTargetDialog
        open={!!rebindGroup}
        imGroupName={rebindGroup?.name || ''}
        targets={selectableTargets}
        targetsLoading={targetsLoading}
        targetType={
          rebindGroup
            ? (resolveBindingTargetType(rebindGroup) ?? 'session')
            : 'session'
        }
        canUnbind={
          !!(
            (rebindGroup?.bound_session_id ?? rebindGroup?.bound_agent_id) ||
            (rebindGroup?.bound_workspace_jid ?? rebindGroup?.bound_main_jid)
          )
        }
        onSelect={handleSelectTarget}
        onRestoreDefault={handleRestoreDefault}
        onClose={() => setRebindGroup(null)}
        selecting={selectingKey}
      />

      {/* Unbind confirm dialog */}
      <ConfirmDialog
        open={!!unbindGroup}
        onClose={() => setUnbindGroup(null)}
        onConfirm={confirmUnbind}
        title="解除渠道绑定"
        message={
          unbindGroup
            ? `「${unbindGroup.name}」解除绑定后不再响应消息。已有会话和历史不会被删除。`
            : ''
        }
        confirmText="解除绑定"
      />

      {/* Unbind target confirm dialog */}
      <ConfirmDialog
        open={!!restoreConfirmGroup}
        onClose={() => setRestoreConfirmGroup(null)}
        onConfirm={confirmRestoreDefault}
        title="解除渠道绑定"
        message={
          restoreConfirmGroup
            ? `「${restoreConfirmGroup.name}」解除绑定后不再响应消息。已有会话和历史不会被删除。`
            : ''
        }
        confirmText="解除绑定"
      />

      {/* Release sender restriction confirm dialog */}
      <ConfirmDialog
        open={!!resetAllowlistGroup}
        onClose={() => setResetAllowlistGroup(null)}
        onConfirm={confirmResetAllowlist}
        title="解除发言者限制"
        message={
          resetAllowlistGroup
            ? `「${resetAllowlistGroup.name}」当前没有可触发机器人的成员。解除限制后，群内允许成员将可以触发机器人。继续？`
            : ''
        }
        confirmText="解除限制"
      />

      {/* Delete IM group confirm dialog */}
      <ConfirmDialog
        open={!!deleteGroup}
        onClose={() => setDeleteGroup(null)}
        onConfirm={confirmDelete}
        title="删除接入记录与本地历史"
        message={
          deleteGroup
            ? `确认删除「${deleteGroup.name}」的接入记录？此操作会删除它在 HappyClaw 中的渠道绑定、本地消息、关联会话及运行数据，且不可撤销；不会删除 IM 平台上的群聊。如果机器人之后再次收到该群消息，它可能会重新注册。若只是更换路由，请使用“换绑”或“解除绑定”。`
            : ''
        }
        confirmText="删除接入记录"
        confirmVariant="danger"
      />
    </div>
  );
}
