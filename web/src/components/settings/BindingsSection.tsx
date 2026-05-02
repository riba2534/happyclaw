import { useState, useMemo, useCallback } from 'react';
import { Loader2, Link2, RefreshCw, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SearchInput } from '@/components/common/SearchInput';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useImBindings } from './hooks/useImBindings';
import { ImBindingRow } from './ImBindingRow';
import { BindingTargetDialog } from './BindingTargetDialog';
import type { AvailableImGroup } from '../../types';
import type { BindingTarget } from './hooks/useImBindings';

type ChannelFilter = 'all' | 'feishu' | 'telegram' | 'qq' | 'wechat' | 'dingtalk' | 'discord';

export function BindingsSection() {
  const { bindings, loading, targets, targetsLoading, reload, rebind, resetAllowlist, error: hookError, clearError: clearHookError } = useImBindings();
  const [localError, setLocalError] = useState<string | null>(null);
  const errorMsg = localError || hookError;
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');
  const [actioningJid, setActioningJid] = useState<string | null>(null);
  const [selectingKey, setSelectingKey] = useState<string | null>(null);

  // Dialog state
  const [rebindGroup, setRebindGroup] = useState<AvailableImGroup | null>(null);
  const [unbindGroup, setUnbindGroup] = useState<AvailableImGroup | null>(null);
  const [resetAllowlistGroup, setResetAllowlistGroup] = useState<AvailableImGroup | null>(null);

  const channels: { key: ChannelFilter; label: string }[] = useMemo(() => {
    const types = new Set(bindings.map((b) => b.channel_type));
    const all: { key: ChannelFilter; label: string }[] = [{ key: 'all', label: '全部' }];
    if (types.has('feishu')) all.push({ key: 'feishu', label: '飞书' });
    if (types.has('telegram')) all.push({ key: 'telegram', label: 'Telegram' });
    if (types.has('qq')) all.push({ key: 'qq', label: 'QQ' });
    if (types.has('wechat')) all.push({ key: 'wechat', label: '微信' });
    if (types.has('dingtalk')) all.push({ key: 'dingtalk', label: '钉钉' });
    if (types.has('discord')) all.push({ key: 'discord', label: 'Discord' });
    return all;
  }, [bindings]);

  const filtered = useMemo(() => {
    let list = bindings;
    if (channelFilter !== 'all') {
      list = list.filter((b) => b.channel_type === channelFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (b) =>
          b.name.toLowerCase().includes(q) ||
          b.jid.toLowerCase().includes(q) ||
          (b.bound_target_name && b.bound_target_name.toLowerCase().includes(q)),
      );
    }
    return list;
  }, [bindings, channelFilter, search]);

  const handleRebind = useCallback((group: AvailableImGroup) => {
    setRebindGroup(group);
  }, []);

  const handleUnbind = useCallback((group: AvailableImGroup) => {
    setUnbindGroup(group);
  }, []);

  const handleResetAllowlist = useCallback((group: AvailableImGroup) => {
    setResetAllowlistGroup(group);
  }, []);

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

  const handleActivationModeChange = useCallback(async (jid: string, mode: string) => {
    setActioningJid(jid);
    setLocalError(null);
    const err = await rebind(jid, { activation_mode: mode as 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled' });
    setActioningJid(null);
    if (err) setLocalError(err);
  }, [rebind]);

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

  const handleSelectTarget = useCallback(async (target: BindingTarget) => {
    if (!rebindGroup) return;
    const imJid = rebindGroup.jid;
    const key = target.agentId || `main:${target.groupJid}`;
    setSelectingKey(key);
    setLocalError(null);

    const hasBound = !!rebindGroup.bound_agent_id || !!rebindGroup.bound_main_jid;
    const payload: {
      target_agent_id?: string;
      target_main_jid?: string;
      force?: boolean;
    } = {};

    if (target.type === 'agent' && target.agentId) {
      payload.target_agent_id = target.agentId;
    } else {
      payload.target_main_jid = target.groupJid;
    }
    if (hasBound) payload.force = true;

    const err = await rebind(imJid, payload);
    setSelectingKey(null);
    if (!err) setRebindGroup(null);
    else setLocalError(err);
  }, [rebindGroup, rebind]);

  const [restoreConfirmGroup, setRestoreConfirmGroup] = useState<AvailableImGroup | null>(null);

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
    <div className="p-4 lg:p-8">
      <div className="max-w-3xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Link2 className="w-6 h-6" />
              IM 绑定管理
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              查看和管理所有 IM 渠道的消息路由。未绑定的渠道默认发送到你的主工作区。
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={loading}
          >
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="bg-error-bg border border-error/20 text-error text-sm rounded-lg px-4 py-2.5 flex items-center justify-between">
            <span>{errorMsg}</span>
            <button onClick={() => { setLocalError(null); clearHookError(); }} className="text-error hover:text-error ml-2 text-xs">✕</button>
          </div>
        )}

        {/* Toolbar: channel filter + search */}
        {bindings.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            {channels.length > 1 && (
              <div className="flex items-center gap-1">
                {channels.map((ch) => (
                  <button
                    key={ch.key}
                    onClick={() => setChannelFilter(ch.key)}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-colors cursor-pointer ${
                      channelFilter === ch.key
                        ? 'bg-primary text-white'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                    }`}
                  >
                    {ch.label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1 min-w-[200px]">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="搜索渠道名称..."
                debounce={200}
              />
            </div>
          </div>
        )}

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            加载中...
          </div>
        ) : bindings.length === 0 ? (
          <Card>
            <CardContent className="text-center">
            <MessageSquare className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">
              暂无 IM 渠道。在飞书、Telegram、QQ、微信、钉钉或 Discord 中向 Bot 发送消息后，渠道会自动出现在这里。
            </p>
            </CardContent>
          </Card>
        ) : filtered.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground text-sm">
            没有匹配的渠道
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((group) => (
              <ImBindingRow
                key={group.jid}
                group={group}
                isActioning={actioningJid === group.jid}
                onRebind={handleRebind}
                onUnbind={handleUnbind}
                onResetAllowlist={handleResetAllowlist}
                onActivationModeChange={handleActivationModeChange}
              />
            ))}
          </div>
        )}
      </div>

      {/* Rebind target dialog */}
      <BindingTargetDialog
        open={!!rebindGroup}
        imGroupName={rebindGroup?.name || ''}
        targets={targets}
        targetsLoading={targetsLoading}
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
        title="确认解绑"
        message={unbindGroup ? `解绑后，「${unbindGroup.name}」的消息将恢复默认路由到主工作区。确认解绑？` : ''}
        confirmText="解绑"
      />

      {/* Restore default confirm dialog */}
      <ConfirmDialog
        open={!!restoreConfirmGroup}
        onClose={() => setRestoreConfirmGroup(null)}
        onConfirm={confirmRestoreDefault}
        title="恢复默认路由"
        message={restoreConfirmGroup ? `确认将「${restoreConfirmGroup.name}」恢复为默认路由（消息发送到主工作区）？` : ''}
        confirmText="恢复默认"
      />

      {/* Reset sender allowlist confirm dialog */}
      <ConfirmDialog
        open={!!resetAllowlistGroup}
        onClose={() => setResetAllowlistGroup(null)}
        onConfirm={confirmResetAllowlist}
        title="重置发言者白名单"
        message={
          resetAllowlistGroup
            ? `「${resetAllowlistGroup.name}」当前白名单为空，没人能触发 bot。重置后白名单将被清空，群内所有成员都能触发 bot。继续？`
            : ''
        }
        confirmText="重置白名单"
      />
    </div>
  );
}
