import {
  Activity,
  Copy,
  Edit3,
  Key,
  Loader2,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { ProviderWithHealth, ProviderHealthStatus } from './types';

interface ProviderListProps {
  providers: ProviderWithHealth[];
  onEdit: (provider: ProviderWithHealth) => void;
  onDelete: (provider: ProviderWithHealth) => void;
  onToggle: (provider: ProviderWithHealth) => void;
  onResetHealth: (provider: ProviderWithHealth) => void;
  onDuplicate: (provider: ProviderWithHealth) => void;
  onAdd: () => void;
  togglingId: string | null;
  deletingId: string | null;
  disabled: boolean;
}

/** 健康指示灯 */
function HealthDot({ health, enabled }: { health: ProviderHealthStatus | null; enabled: boolean }) {
  if (!enabled) return <div className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/50" />;
  if (!health) return <div className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/50" />;

  const color = health.healthy
    ? 'bg-emerald-400'
    : health.consecutiveErrors > 0
      ? 'bg-red-400'
      : 'bg-amber-400';

  return <div className={`w-2 h-2 rounded-full shrink-0 ${color}`} />;
}

/** 格式化 OAuth 过期时间 */
function formatOAuthExpiry(expiresAt: number | null): string | null {
  if (expiresAt == null) return null;
  if (expiresAt <= Date.now()) return '已过期';
  return '过期时间: ' + new Date(expiresAt).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

/** 凭据标签：显示认证方式 + OAuth 过期时间 */
function CredentialBadges({ provider }: { provider: ProviderWithHealth }) {
  const badges: { label: string; color: string; detail?: string }[] = [];

  if (provider.hasClaudeOAuthCredentials) {
    const expired =
      provider.claudeOAuthCredentialsExpiresAt != null &&
      provider.claudeOAuthCredentialsExpiresAt <= Date.now();
    const expiry = formatOAuthExpiry(provider.claudeOAuthCredentialsExpiresAt);
    badges.push({
      label: 'OAuth',
      color: expired ? 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800' : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
      detail: expiry ?? undefined,
    });
  }
  if (provider.hasClaudeCodeOauthToken) {
    badges.push({ label: 'Setup Token', color: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800' });
  }
  if (provider.hasAnthropicApiKey) {
    badges.push({ label: 'API Key', color: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-800' });
  }
  if (provider.hasAnthropicAuthToken) {
    badges.push({ label: 'Auth Token', color: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800' });
  }

  if (badges.length === 0) {
    return <span className="text-xs text-muted-foreground italic">未配置凭据</span>;
  }

  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <Key className="w-3 h-3 text-muted-foreground shrink-0" />
      {badges.map((b) => (
        <span key={b.label} className="inline-flex items-center gap-1">
          <span className={`text-[11px] px-1.5 py-0.5 rounded border ${b.color}`}>
            {b.label}
          </span>
          {b.detail && (
            <span className="text-[10px] text-muted-foreground">{b.detail}</span>
          )}
        </span>
      ))}
    </span>
  );
}

export function ProviderList({
  providers,
  onEdit,
  onDelete,
  onToggle,
  onResetHealth,
  onDuplicate,
  onAdd,
  togglingId,
  deletingId,
  disabled,
}: ProviderListProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/50">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">提供商列表</div>
            <span className="text-xs text-muted-foreground">{providers.length} 个提供商</span>
          </div>
        </div>

        {providers.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            暂无提供商，请点击下方按钮添加。
          </div>
        ) : (
          <div className="divide-y divide-border">
            {providers.map((provider) => {
              const toggling = togglingId === provider.id;
              const deleting = deletingId === provider.id;
              const health = provider.health;

              return (
                <div
                  key={provider.id}
                  className={`px-4 py-3 transition-colors ${
                    !provider.enabled ? 'bg-muted/50 opacity-60' : ''
                  }`}
                >
                  {/* 第一行：名称 + 类型 + 操作 */}
                  <div className="flex items-center gap-2 justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <HealthDot health={health} enabled={provider.enabled} />
                      <span className="text-sm font-medium text-foreground truncate">
                        {provider.name}
                      </span>
                      <span
                        className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${
                          provider.type === 'official'
                            ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                            : 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        {provider.type === 'official' ? '官方' : '第三方'}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Switch
                        checked={provider.enabled}
                        disabled={disabled || toggling || deleting}
                        onCheckedChange={() => onToggle(provider)}
                        aria-label={provider.enabled ? '禁用提供商' : '启用提供商'}
                      />
                      {health && !health.healthy && provider.enabled && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onResetHealth(provider)}
                          disabled={disabled}
                          title="重置健康状态"
                          className="h-7 w-7 p-0"
                        >
                          <RotateCcw className="size-3.5" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onEdit(provider)}
                        disabled={disabled || toggling || deleting}
                        className="h-7 px-2 text-xs"
                      >
                        <Edit3 className="size-3.5" />
                        编辑
                      </Button>
                      {provider.type === 'third_party' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDuplicate(provider)}
                          disabled={disabled || toggling || deleting}
                          className="h-7 px-2 text-xs"
                        >
                          <Copy className="size-3.5" />
                          复制
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onDelete(provider)}
                        disabled={disabled || toggling || deleting}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-red-600"
                      >
                        {deleting ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* 第二行：关键信息摘要 */}
                  <div className="mt-1.5 ml-4 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                    {provider.type === 'third_party' && provider.anthropicBaseUrl && (
                      <span className="font-mono truncate max-w-[200px]" title={provider.anthropicBaseUrl}>
                        {provider.anthropicBaseUrl}
                      </span>
                    )}
                    {provider.anthropicModel && (
                      <span className="font-mono text-muted-foreground">
                        {provider.anthropicModel}
                      </span>
                    )}
                    <CredentialBadges provider={provider} />
                  </div>

                  {/* 第三行：健康异常信息（仅异常时显示） */}
                  {health && provider.enabled && (!health.healthy || health.consecutiveErrors > 0) && (
                    <div className="mt-1.5 ml-4 flex items-center gap-3 text-xs flex-wrap">
                      {health.activeSessionCount > 0 && (
                        <span className="text-teal-600">
                          <Activity className="w-3 h-3 inline mr-0.5" />
                          {health.activeSessionCount} 活跃会话
                        </span>
                      )}
                      {health.consecutiveErrors > 0 && (
                        <span className="text-red-500">
                          连续错误 {health.consecutiveErrors}
                        </span>
                      )}
                      {!health.healthy && (
                        <span className="text-red-500 font-medium">
                          <Shield className="w-3 h-3 inline mr-0.5" />
                          不健康
                        </span>
                      )}
                    </div>
                  )}

                  {/* 活跃会话（健康正常时） */}
                  {health && provider.enabled && health.healthy && health.activeSessionCount > 0 && (
                    <div className="mt-1 ml-4 text-xs text-teal-600">
                      <Activity className="w-3 h-3 inline mr-0.5" />
                      {health.activeSessionCount} 活跃会话
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-start">
        <Button variant="outline" size="sm" onClick={onAdd} disabled={disabled}>
          <Plus className="size-4" />
          添加提供商
        </Button>
      </div>
    </div>
  );
}
