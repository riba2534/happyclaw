import { Loader2, MoreHorizontal, PlugZap, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { ResponsiveMenu } from '@/components/common/ResponsiveMenu';
import { effectiveProviderModels } from '@/lib/model-providers';
import {
  connectionKind,
  connectionKindLabel,
  connectionStatus,
} from './model-connections';
import type { UnifiedProviderPublic } from './types';
import { UsageBars } from './UsageBars';
import { vendorOfConnection } from '../brand/vendor';
import { VendorTile } from '../brand/VendorTile';

interface ProviderListProps {
  providers: UnifiedProviderPublic[];
  /** Open the connection's detail: credentials, models, environment. */
  onEdit: (provider: UnifiedProviderPublic) => void;
  onTest: (provider: UnifiedProviderPublic) => void;
  onDelete: (provider: UnifiedProviderPublic) => void;
  onAdd: () => void;
  deletingId: string | null;
  testingId: string | null;
  disabled: boolean;
}

function ProviderMedia({ provider }: { provider: UnifiedProviderPublic }) {
  const vendor = vendorOfConnection({
    kind: provider.hasCodexOAuthCredentials
      ? 'codex'
      : provider.hasGeminiOAuthCredentials
        ? 'gemini'
        : provider.type === 'official'
          ? 'official'
          : 'third_party',
    presetId: provider.presetId,
    baseUrl: provider.anthropicBaseUrl,
    model: provider.anthropicModel,
  });
  return (
    <VendorTile
      vendor={vendor}
      name={provider.name}
      className="size-8 rounded-lg"
    />
  );
}

function hasCredential(provider: UnifiedProviderPublic): boolean {
  return (
    provider.hasClaudeOAuthCredentials ||
    provider.hasCodexOAuthCredentials ||
    provider.hasGeminiOAuthCredentials ||
    provider.hasClaudeCodeOauthToken ||
    provider.hasAnthropicApiKey ||
    provider.hasAnthropicAuthToken
  );
}

/** Where the connection's models come from, in one short line. */
function sourceText(provider: UnifiedProviderPublic): string | null {
  const kind = connectionKind(provider);
  if (kind === 'chatgpt') {
    return (
      provider.codexOAuthCredentialsEmail ?? 'ChatGPT 订阅网关（服务内嵌）'
    );
  }
  if (kind === 'gemini') {
    return (
      provider.geminiOAuthCredentialsEmail ?? 'Gemini 订阅网关（服务内嵌）'
    );
  }
  if (kind === 'claude_subscription') {
    return provider.claudeOAuthAccountEmail ?? null;
  }
  return kind === 'anthropic_api' ? null : provider.anthropicBaseUrl || null;
}

/** Settings › 模型连接: each connection with its address and model count. */
export function ProviderList({
  providers,
  onEdit,
  onTest,
  onDelete,
  onAdd,
  deletingId,
  testingId,
  disabled,
}: ProviderListProps) {
  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-surface-border px-6 py-10 text-center">
        <p className="text-body text-muted-foreground">
          还没有模型连接。添加一个 Claude / ChatGPT 订阅、API Key
          或兼容地址即可开始对话。
        </p>
        <Button onClick={onAdd} disabled={disabled}>
          <Plus />
          添加模型连接
        </Button>
      </div>
    );
  }

  return (
    <ListGroup>
      {providers.map((provider) => {
        const deleting = deletingId === provider.id;
        const testing = testingId === provider.id;
        const kind = connectionKind(provider);
        const status = connectionStatus(provider);
        const modelCount =
          kind === 'chatgpt' ? null : effectiveProviderModels(provider).length;
        const source = sourceText(provider);

        return (
          <div key={provider.id} className="min-w-0">
            <ListRow
              media={<ProviderMedia provider={provider} />}
              onClick={() => onEdit(provider)}
              aria-label={`编辑「${provider.name}」`}
              title={provider.name}
              badges={
                <Badge variant="neutral" className="max-sm:hidden">
                  {connectionKindLabel(provider)}
                </Badge>
              }
              description={
                <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <Badge
                    variant="outline"
                    dot={status.tone}
                    title={status.hint}
                  >
                    {testing ? '测试中…' : status.label}
                  </Badge>
                  {/* Touch has no hover title, so the hint is spelled out. */}
                  {status.hint && !testing && (
                    <span className="pointer-fine:hidden">{status.hint}</span>
                  )}
                  {source && (
                    <span
                      className="max-w-60 min-w-0 truncate font-mono"
                      title={source}
                    >
                      {source}
                    </span>
                  )}
                  {modelCount !== null && <span>{modelCount} 个模型</span>}
                  {!hasCredential(provider) && (
                    <span className="text-warning">未配置凭据</span>
                  )}
                </span>
              }
              actions={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(provider)}
                    disabled={disabled}
                    className="max-sm:hidden"
                  >
                    编辑
                  </Button>
                  <ResponsiveMenu
                    title={`「${provider.name}」的操作`}
                    groups={[
                      [
                        {
                          label: '测试连接',
                          icon: PlugZap,
                          disabled: testing,
                          onSelect: () => onTest(provider),
                        },
                      ],
                      [
                        {
                          label: '删除',
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => onDelete(provider),
                        },
                      ],
                    ]}
                    trigger={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="更多操作"
                        disabled={disabled}
                      >
                        {deleting || testing ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <MoreHorizontal />
                        )}
                      </Button>
                    }
                  />
                </>
              }
            />

            {/* 订阅用量：Claude OAuth、ChatGPT 订阅与 magpie 的各个账号 */}
            {(provider.type === 'official' ||
              provider.hasCodexOAuthCredentials ||
              provider.gateway === 'magpie') && (
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
