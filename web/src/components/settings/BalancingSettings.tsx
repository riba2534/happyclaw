import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Input } from '@/components/ui/input';
import type { BalancingConfig } from './types';

interface BalancingSettingsProps {
  balancing: BalancingConfig;
  onChange: (updates: Partial<BalancingConfig>) => void;
  disabled: boolean;
}

export function BalancingSettings({ balancing, onChange, disabled }: BalancingSettingsProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/50 hover:bg-muted transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">负载均衡设置</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-800">
            {balancing.strategy === 'round-robin'
              ? '轮询'
              : balancing.strategy === 'weighted-round-robin'
                ? '加权轮询'
                : '故障转移'}
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="p-4 space-y-4">
          <div className="text-xs text-muted-foreground mb-2">
            启用多个提供商后，系统会根据以下策略自动分配会话请求。
          </div>

          {/* 策略选择 */}
          <div>
            <label className="text-sm font-medium block mb-1">策略</label>
            <select
              className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-background"
              value={balancing.strategy}
              disabled={disabled}
              onChange={(e) =>
                onChange({ strategy: e.target.value as BalancingConfig['strategy'] })
              }
            >
              <option value="round-robin">轮询</option>
              <option value="weighted-round-robin">加权轮询</option>
              <option value="failover">故障转移</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {balancing.strategy === 'round-robin'
                ? '按顺序轮流分配给每个启用的提供商'
                : balancing.strategy === 'weighted-round-robin'
                  ? '根据提供商的权重值按比例分配请求'
                  : '优先使用第一个健康的提供商，失败时自动切换到下一个'}
            </p>
          </div>

          {/* 高级参数 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                不健康阈值（连续失败次数）
              </label>
              <Input
                type="number"
                min={1}
                max={20}
                value={balancing.unhealthyThreshold}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    unhealthyThreshold: Math.max(
                      1,
                      Math.min(20, parseInt(e.target.value) || 3),
                    ),
                  })
                }
                className="h-8 text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                连续失败达到该次数后，提供商标记为不健康。
              </p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                自动恢复间隔（秒）
              </label>
              <Input
                type="number"
                min={30}
                max={3600}
                value={Math.round(balancing.recoveryIntervalMs / 1000)}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    recoveryIntervalMs:
                      Math.max(30, Math.min(3600, parseInt(e.target.value) || 300)) * 1000,
                  })
                }
                className="h-8 text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                不健康提供商经过该时间后自动恢复为健康状态，重新接受请求。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
