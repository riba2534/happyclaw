import { useEffect, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { cn } from '@/lib/utils';
import { SettingsGroup, SettingsRow } from './SettingsLayout';
import type { BalancingConfig } from './types';

interface BalancingSettingsProps {
  balancing: BalancingConfig;
  onChange: (updates: Partial<BalancingConfig>) => void;
  disabled: boolean;
  saving: boolean;
}

function clampInteger(
  value: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(
    min,
    Math.min(max, Number.isFinite(parsed) ? parsed : fallback),
  );
}

export function BalancingSettings({
  balancing,
  onChange,
  disabled,
  saving,
}: BalancingSettingsProps) {
  const [expanded, setExpanded] = useState(false);
  const [unhealthyDraft, setUnhealthyDraft] = useState(
    String(balancing.unhealthyThreshold),
  );
  const [recoveryDraft, setRecoveryDraft] = useState(
    String(Math.round(balancing.recoveryIntervalMs / 1000)),
  );

  useEffect(() => {
    setUnhealthyDraft(String(balancing.unhealthyThreshold));
  }, [balancing.unhealthyThreshold]);

  useEffect(() => {
    setRecoveryDraft(String(Math.round(balancing.recoveryIntervalMs / 1000)));
  }, [balancing.recoveryIntervalMs]);

  const commitUnhealthyThreshold = () => {
    const next = clampInteger(
      unhealthyDraft,
      balancing.unhealthyThreshold,
      1,
      20,
    );
    setUnhealthyDraft(String(next));
    if (next !== balancing.unhealthyThreshold) {
      onChange({ unhealthyThreshold: next });
    }
  };

  const commitRecoveryInterval = () => {
    const currentSeconds = Math.round(balancing.recoveryIntervalMs / 1000);
    const nextSeconds = clampInteger(recoveryDraft, currentSeconds, 30, 3600);
    setRecoveryDraft(String(nextSeconds));
    if (nextSeconds !== currentSeconds) {
      onChange({ recoveryIntervalMs: nextSeconds * 1000 });
    }
  };

  const strategyLabel =
    balancing.strategy === 'round-robin'
      ? '轮询'
      : balancing.strategy === 'weighted-round-robin'
        ? '加权轮询'
        : '故障转移';

  return (
    <SettingsGroup aria-busy={saving}>
      <button
        type="button"
        className="flex w-full cursor-pointer items-center justify-between gap-4 px-4 py-3 text-left outline-none transition-colors duration-100 hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls="balancing-settings-panel"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-body font-medium text-foreground">
            负载均衡设置
          </span>
          <Badge variant="neutral">{strategyLabel}</Badge>
          {saving && (
            <Loader2
              className="size-3.5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-150',
            !expanded && '-rotate-90',
          )}
          aria-hidden="true"
        />
      </button>

      {expanded && (
        <div
          id="balancing-settings-panel"
          className="divide-y divide-surface-border"
          role="region"
          aria-label="负载均衡设置"
        >
          <p className="px-4 py-3 text-caption text-muted-foreground">
            启用多个提供商后，系统会根据以下策略自动分配会话请求。
          </p>

          <SettingsRow
            label="策略"
            htmlFor="balancing-strategy"
            description={
              balancing.strategy === 'round-robin'
                ? '按顺序轮流分配给每个启用的提供商'
                : balancing.strategy === 'weighted-round-robin'
                  ? '根据提供商的权重值按比例分配请求'
                  : '优先使用第一个健康的提供商，失败时自动切换到下一个'
            }
            control={
              <NativeSelect
                id="balancing-strategy"
                className="w-full sm:w-48"
                value={balancing.strategy}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    strategy: e.target.value as BalancingConfig['strategy'],
                  })
                }
              >
                <NativeSelectOption value="round-robin">
                  轮询
                </NativeSelectOption>
                <NativeSelectOption value="weighted-round-robin">
                  加权轮询
                </NativeSelectOption>
                <NativeSelectOption value="failover">
                  故障转移
                </NativeSelectOption>
              </NativeSelect>
            }
          >
            {balancing.strategy === 'weighted-round-robin' && (
              <div className="rounded-lg bg-muted/60 px-3 py-2 text-caption leading-5 text-muted-foreground">
                💡
                上方提供商列表已显示每家的「权重」徽标。点击对应提供商的「编辑」按钮可调整。
                所有提供商默认权重为 1（均匀分配），调整权重后流量按比例分配。
              </div>
            )}
          </SettingsRow>

          <SettingsRow
            label="不健康阈值（连续失败次数）"
            htmlFor="balancing-unhealthy-threshold"
            description="连续失败达到该次数后，提供商标记为不健康。"
            control={
              <Input
                id="balancing-unhealthy-threshold"
                type="number"
                min={1}
                max={20}
                value={unhealthyDraft}
                disabled={disabled}
                onChange={(e) => setUnhealthyDraft(e.target.value)}
                onBlur={commitUnhealthyThreshold}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="w-full tabular-nums sm:w-48"
              />
            }
          />

          <SettingsRow
            label="自动恢复间隔（秒）"
            htmlFor="balancing-recovery-interval"
            description="不健康提供商经过该时间后自动恢复为健康状态，重新接受请求。"
            control={
              <Input
                id="balancing-recovery-interval"
                type="number"
                min={30}
                max={3600}
                value={recoveryDraft}
                disabled={disabled}
                onChange={(e) => setRecoveryDraft(e.target.value)}
                onBlur={commitRecoveryInterval}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
                className="w-full tabular-nums sm:w-48"
              />
            }
          />

          {saving && (
            <p
              className="px-4 py-2 text-caption text-muted-foreground"
              role="status"
            >
              正在保存负载均衡设置…
            </p>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}
