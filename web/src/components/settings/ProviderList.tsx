import {
  Activity,
  Copy,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { Badge, type BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { cn } from '@/lib/utils';
import type { ProviderWithHealth, ProviderHealthStatus } from './types';
import { UsageBars } from './UsageBars';

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

/** 健康指示灯颜色 */
function healthDotClass(
  health: ProviderHealthStatus | null,
  enabled: boolean,
): string {
  if (!enabled || !health) return 'bg-faint-foreground';
  if (health.healthy) return 'bg-success';
  return health.consecutiveErrors > 0 ? 'bg-error' : 'bg-warning';
}

/** 类型图标 + 健康指示灯 */
function ProviderMedia({ provider }: { provider: ProviderWithHealth }) {
  const Icon =
    provider.type === 'official'
      ? ShieldCheck
      : provider.hasCodexOAuthCredentials
        ? MessageSquareText
        : Server;
  return (
    <span className="relative flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden="true" />
      <span
        aria-hidden="true"
        className={cn(
          'absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface-raised',
          healthDotClass(provider.health, provider.enabled),
        )}
      />
    </span>
  );
}

/** 格式化 OAuth 过期时间 */
function formatOAuthExpiry(expiresAt: number | null): string | null {
  if (expiresAt == null) return null;
  if (expiresAt <= Date.now()) return '已过期';
  return (
    '过期时间: ' +
    new Date(expiresAt).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  );
}

/** 凭据标签：显示认证方式 + OAuth 过期时间 */
function CredentialBadges({ provider }: { provider: ProviderWithHealth }) {
  const badges: { label: string; dot: BadgeDot; detail?: string }[] = [];

  if (provider.hasClaudeOAuthCredentials) {
    const expired =
      provider.claudeOAuthCredentialsExpiresAt != null &&
      provider.claudeOAuthCredentialsExpiresAt <= Date.now();
    const expiry = formatOAuthExpiry(provider.claudeOAuthCredentialsExpiresAt);
    badges.push({
      label: 'OAuth',
      dot: expired ? 'error' : 'success',
      detail: expiry ?? undefined,
    });
  }
  if (provider.hasCodexOAuthCredentials) {
    const expired =
      provider.codexOAuthCredentialsExpiresAt != null &&
      provider.codexOAuthCredentialsExpiresAt <= Date.now();
    const expiry = formatOAuthExpiry(provider.codexOAuthCredentialsExpiresAt);
    badges.push({
      label: provider.codexOAuthCredentialsPlanType
        ? `ChatGPT ${provider.codexOAuthCredentialsPlanType}`
        : 'ChatGPT',
      dot: expired ? 'error' : 'success',
      detail: expiry ?? undefined,
    });
  }
  if (provider.hasClaudeCodeOauthToken) {
    badges.push({ label: 'Setup Token', dot: 'muted' });
  }
  if (provider.hasAnthropicApiKey) {
    badges.push({ label: 'API Key', dot: 'muted' });
  }
  if (provider.hasAnthropicAuthToken) {
    badges.push({ label: 'Auth Token', dot: 'muted' });
  }

  if (badges.length === 0) {
    return <span className="text-warning">未配置凭据</span>;
  }

  return (
    <>
      {badges.map((b) => (
        <span key={b.label} className="inline-flex items-center gap-1">
          <Badge variant="outline" dot={b.dot}>
            {b.label}
          </Badge>
          {b.detail && (
            <span className="text-micro text-faint-foreground">{b.detail}</span>
          )}
        </span>
      ))}
    </>
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
  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-surface-border px-6 py-10 text-center">
        <p className="text-body text-muted-foreground">
          暂无模型配置，请点击下方按钮添加。
        </p>
        <Button onClick={onAdd} disabled={disabled}>
          <Plus />
          添加模型配置
        </Button>
      </div>
    );
  }

  return (
    <ListGroup>
      {providers.map((provider) => {
        const toggling = togglingId === provider.id;
        const deleting = deletingId === provider.id;
        const rowDisabled = disabled || toggling || deleting;
        const health = provider.health;
        const canDuplicate =
          provider.type === 'third_party' && !provider.hasCodexOAuthCredentials;
        const canResetHealth = !!health && !health.healthy && provider.enabled;

        return (
          <div key={provider.id} className="min-w-0">
            <ListRow
              media={<ProviderMedia provider={provider} />}
              title={
                <span
                  className={cn(!provider.enabled && 'text-muted-foreground')}
                >
                  {provider.name}
                </span>
              }
              badges={
                <>
                  <Badge variant="neutral">
                    {provider.type === 'official'
                      ? '官方'
                      : provider.hasCodexOAuthCredentials
                        ? 'ChatGPT 订阅'
                        : '第三方'}
                  </Badge>
                  {health && provider.enabled && !health.healthy && (
                    <Badge variant="error">不健康</Badge>
                  )}
                </>
              }
              description={
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {provider.hasCodexOAuthCredentials ? (
                    <span>ChatGPT 订阅网关（服务内嵌）</span>
                  ) : (
                    provider.type === 'third_party' &&
                    provider.anthropicBaseUrl && (
                      <span
                        className="max-w-60 truncate font-mono"
                        title={provider.anthropicBaseUrl}
                      >
                        {provider.anthropicBaseUrl}
                      </span>
                    )
                  )}
                  {provider.anthropicModel && (
                    <span className="font-mono">{provider.anthropicModel}</span>
                  )}
                  <CredentialBadges provider={provider} />
                  {health &&
                    provider.enabled &&
                    health.consecutiveErrors > 0 && (
                      <span className="text-error">
                        连续错误 {health.consecutiveErrors}
                      </span>
                    )}
                </span>
              }
              meta={
                health &&
                provider.enabled &&
                health.activeSessionCount > 0 && (
                  <span className="hidden items-center gap-1 sm:inline-flex">
                    <Activity className="size-3.5" aria-hidden="true" />
                    {health.activeSessionCount} 活跃会话
                  </span>
                )
              }
              actions={
                <>
                  {canResetHealth && (
                    <IconButton
                      label="重置健康状态"
                      icon={<RotateCcw />}
                      onClick={() => onResetHealth(provider)}
                      disabled={disabled}
                      className="max-sm:hidden"
                    />
                  )}
                  <Switch
                    checked={provider.enabled}
                    disabled={rowDisabled}
                    onCheckedChange={() => onToggle(provider)}
                    aria-label={
                      provider.enabled ? '禁用模型配置' : '启用模型配置'
                    }
                    className="mx-1.5"
                  />
                  <IconButton
                    label="编辑"
                    icon={<Pencil />}
                    onClick={() => onEdit(provider)}
                    disabled={rowDisabled}
                    className="max-sm:hidden"
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="更多操作"
                        disabled={rowDisabled}
                      >
                        {deleting ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <MoreHorizontal />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-36">
                      {/* 窄屏把行内按钮收进菜单，给名称留出空间 */}
                      <DropdownMenuItem
                        className="sm:hidden"
                        onSelect={() => onEdit(provider)}
                      >
                        <Pencil />
                        编辑
                      </DropdownMenuItem>
                      {canResetHealth && (
                        <DropdownMenuItem
                          className="sm:hidden"
                          disabled={disabled}
                          onSelect={() => onResetHealth(provider)}
                        >
                          <RotateCcw />
                          重置健康状态
                        </DropdownMenuItem>
                      )}
                      {canDuplicate && (
                        <DropdownMenuItem
                          onSelect={() => onDuplicate(provider)}
                        >
                          <Copy />
                          复制
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => onDelete(provider)}
                      >
                        <Trash2 />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            />

            {/* OAuth 用量 */}
            {provider.type === 'official' && (
              <UsageBars
                providerId={provider.id}
                providerVersion={provider.updatedAt}
                className="-mt-1 px-4 pb-3 sm:pl-15"
              />
            )}
          </div>
        );
      })}
    </ListGroup>
  );
}
