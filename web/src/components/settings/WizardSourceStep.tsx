import { useState, type ReactNode } from 'react';
import {
  ChevronRight,
  ExternalLink,
  Key,
  MessageSquareText,
  Server,
  ShieldCheck,
  Terminal,
} from 'lucide-react';

import { SearchInput } from '@/components/common/SearchInput';
import { sortPresetsForRegion } from '@/lib/model-providers';
import { cn } from '@/lib/utils';
import {
  CONNECTION_KIND_LABELS,
  type ConnectionKind,
} from './model-connections';

/** Where a new connection's models come from. */
export type WizardSource =
  | { kind: Exclude<ConnectionKind, 'preset'> }
  | { kind: 'preset'; presetId: string };

const RECOMMENDED: ReadonlyArray<{
  kind: 'claude_subscription' | 'chatgpt' | 'agy' | 'anthropic_api';
  description: string;
  icon: typeof ShieldCheck;
}> = [
  {
    kind: 'claude_subscription',
    description: '用 Claude Pro / Max 账号登录，或粘贴 setup-token',
    icon: ShieldCheck,
  },
  {
    kind: 'chatgpt',
    description: '用 ChatGPT Plus / Pro 账号登录，经内嵌网关运行',
    icon: MessageSquareText,
  },
  {
    kind: 'agy',
    description: '复用宿主机 AGY CLI 订阅，通过 agy-runner 运行 Gemini 4 Neon 等模型',
    icon: Terminal,
  },
  {
    kind: 'anthropic_api',
    description: '按量计费的 Anthropic 官方 API',
    icon: Key,
  },
];

const PRESETS = sortPresetsForRegion('cn');

export function hostnameOf(url: string): string {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return '';
  }
}

/** Step 1 of the wizard: subscriptions, vendor presets, or any address. */
export function WizardSourceStep({
  onChoose,
}: {
  onChoose: (source: WizardSource) => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const presets = needle
    ? PRESETS.filter((preset) =>
        [preset.name, preset.nameEn, preset.baseUrl].some((text) =>
          text.toLowerCase().includes(needle),
        ),
      )
    : PRESETS;
  return (
    <div className="space-y-5">
      <section className="space-y-2" aria-labelledby="wizard-recommended">
        <h3
          id="wizard-recommended"
          className="text-label font-medium text-muted-foreground"
        >
          推荐
        </h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {RECOMMENDED.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.kind}
                type="button"
                onClick={() => onChoose({ kind: item.kind })}
                className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-3 text-left ring-1 ring-surface-border transition-colors duration-100 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none sm:flex-col sm:gap-2"
              >
                <Icon
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block text-label text-foreground">
                    {CONNECTION_KIND_LABELS[item.kind]}
                  </span>
                  <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
                    {item.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="wizard-presets">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3
            id="wizard-presets"
            className="text-label font-medium text-muted-foreground"
          >
            {CONNECTION_KIND_LABELS.preset}
          </h3>
          <SearchInput
            value={query}
            onChange={setQuery}
            debounce={0}
            placeholder="搜索服务商"
            className="w-full sm:w-56"
          />
        </div>
        <div className="max-h-[min(18rem,40dvh)] divide-y divide-surface-border overflow-y-auto overscroll-contain rounded-lg ring-1 ring-surface-border">
          {presets.map((preset) => (
            <div key={preset.id} className="flex items-center gap-2 pr-3">
              <button
                type="button"
                onClick={() =>
                  onChoose({ kind: 'preset', presetId: preset.id })
                }
                className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors duration-100 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label text-foreground">
                    {preset.name}
                  </span>
                  <span className="block truncate font-mono text-micro text-muted-foreground">
                    {hostnameOf(preset.baseUrl)}
                  </span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-faint-foreground"
                  aria-hidden="true"
                />
              </button>
              {preset.keyUrl && (
                <ExternalAnchor
                  href={preset.keyUrl}
                  className="shrink-0 text-caption"
                  label={`获取 ${preset.name} 的 API Key`}
                >
                  获取 API Key
                </ExternalAnchor>
              )}
            </div>
          ))}
          {presets.length === 0 && (
            <p className="px-3 py-4 text-caption text-muted-foreground">
              没有匹配的服务商，可以用下方的自定义兼容地址。
            </p>
          )}
        </div>
      </section>

      <button
        type="button"
        onClick={() => onChoose({ kind: 'custom' })}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-left ring-1 ring-surface-border transition-colors duration-100 hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Server
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-label text-foreground">
            自定义兼容地址
          </span>
          <span className="block text-caption text-muted-foreground">
            任何 Anthropic Messages 兼容接口，例如自建中转
          </span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-faint-foreground"
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

/** A link that opens in a new tab, marked with the external-link icon. */
export function ExternalAnchor({
  href,
  children,
  className,
  label,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1 text-primary-text underline-offset-2 hover:underline',
        className,
      )}
    >
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}
