import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore, type BillingPlan } from '../../stores/billing';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { SystemSettings } from './types';
import { getErrorMessage } from './types';

interface FieldConfig {
  key: keyof SystemSettings;
  label: string;
  description: string;
  unit: string;
  /** Convert stored value to display value */
  toDisplay: (v: number) => number;
  /** Convert display value to stored value */
  toStored: (v: number) => number;
  min: number;
  max: number;
  step: number;
}

const fields: FieldConfig[] = [
  {
    key: 'containerTimeout',
    label: '容器最大运行时间',
    description: '单个容器/进程的最长运行时间',
    unit: '分钟',
    toDisplay: (v) => Math.round(v / 60000),
    toStored: (v) => v * 60000,
    min: 1,
    max: 1440,
    step: 1,
  },
  {
    key: 'idleTimeout',
    label: '容器空闲超时',
    description: '最后一次输出后无新消息则关闭容器',
    unit: '分钟',
    toDisplay: (v) => Math.round(v / 60000),
    toStored: (v) => v * 60000,
    min: 1,
    max: 1440,
    step: 1,
  },
  {
    key: 'containerMaxOutputSize',
    label: '单次输出上限',
    description: '单次容器运行的最大输出大小',
    unit: 'MB',
    toDisplay: (v) => Math.round(v / 1048576),
    toStored: (v) => v * 1048576,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'maxConcurrentContainers',
    label: '最大并发容器数',
    description: '同时运行的 Docker 容器数量上限',
    unit: '个',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'maxConcurrentHostProcesses',
    label: '最大并发宿主机进程数',
    description: '同时运行的宿主机模式进程数量上限',
    unit: '个',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: 'maxLoginAttempts',
    label: '登录失败锁定次数',
    description: '连续失败该次数后锁定账户',
    unit: '次',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'loginLockoutMinutes',
    label: '锁定时间',
    description: '账户被锁定后的等待时间',
    unit: '分钟',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 1440,
    step: 1,
  },
  {
    key: 'maxConcurrentScripts',
    label: '脚本任务最大并发数',
    description: '同时运行的脚本任务数量上限',
    unit: '个',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: 'scriptTimeout',
    label: '脚本执行超时',
    description: '单个脚本任务的最长执行时间',
    unit: '秒',
    toDisplay: (v) => Math.round(v / 1000),
    toStored: (v) => v * 1000,
    min: 5,
    max: 600,
    step: 5,
  },
  {
    key: 'autoCompactWindow',
    label: '对话自动压缩阈值',
    description:
      '达到该 token 数时主动触发 SDK 对话压缩。0 = 保留 SDK 默认（约 1M）。'
      + '经验值：Opus 1M 建议 300-500，Sonnet/Haiku 200K 建议 80-120。'
      + '压缩前会通过 PreCompact hook 归档对话',
    unit: 'K tokens',
    toDisplay: (v) => Math.round(v / 1000),
    toStored: (v) => v * 1000,
    min: 0,
    max: 2000,
    step: 10,
  },
];

export function SystemSettingsSection() {
  const { hasPermission } = useAuthStore();

  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [displayValues, setDisplayValues] = useState<Record<string, number>>({});
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [billingMinStartBalanceUsd, setBillingMinStartBalanceUsd] = useState(0.01);
  const [billingCurrency, setBillingCurrency] = useState('USD');
  const [billingCurrencyRate, setBillingCurrencyRate] = useState(1);
  const [externalClaudeDir, setExternalClaudeDir] = useState('');
  const [disableMemoryLayerForAdminHost, setDisableMemoryLayerForAdminHost] = useState(false);
  const [containerNetworkMode, setContainerNetworkMode] = useState<'bridge' | 'host'>('bridge');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadBillingStatus = useBillingStore((s) => s.loadBillingStatus);
  const { plans, loadPlans, updatePlan } = useBillingStore();
  const [defaultPlanId, setDefaultPlanId] = useState('');
  const [settingDefault, setSettingDefault] = useState(false);
  const canManage = hasPermission('manage_system_config');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await api.get<SystemSettings>('/api/config/system');
        setSettings(data);
        const display: Record<string, number> = {};
        for (const f of fields) {
          display[f.key] = f.toDisplay(data[f.key] as number);
        }
        setDisplayValues(display);
        setBillingEnabled(data.billingEnabled ?? false);
        setBillingMinStartBalanceUsd(data.billingMinStartBalanceUsd ?? 0.01);
        setBillingCurrency(data.billingCurrency ?? 'USD');
        setBillingCurrencyRate(data.billingCurrencyRate ?? 1);
        setExternalClaudeDir(data.externalClaudeDir ?? '');
        setDisableMemoryLayerForAdminHost(data.disableMemoryLayerForAdminHost ?? false);
        setContainerNetworkMode(data.containerNetworkMode ?? 'bridge');
      } catch (err) {
        toast.error(getErrorMessage(err, '加载系统参数失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load plans when billing is enabled (for default plan picker)
  useEffect(() => {
    if (billingEnabled) {
      loadPlans();
    }
  }, [billingEnabled, loadPlans]);

  // Sync default plan ID from loaded plans
  useEffect(() => {
    const def = plans.find((p: BillingPlan) => p.is_default);
    setDefaultPlanId(def?.id ?? '');
  }, [plans]);

  const handleSetDefaultPlan = async (planId: string) => {
    if (!planId || planId === defaultPlanId) return;
    setSettingDefault(true);
    try {
      await updatePlan(planId, { is_default: true });
      setDefaultPlanId(planId);
      toast.success('默认套餐已更新');
    } catch (err) {
      toast.error(getErrorMessage(err, '设置默认套餐失败'));
    } finally {
      setSettingDefault(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: Partial<SystemSettings> = {
        billingEnabled,
        billingMode: 'wallet_first',
        billingMinStartBalanceUsd,
        billingCurrency,
        billingCurrencyRate,
        externalClaudeDir,
        disableMemoryLayerForAdminHost,
        containerNetworkMode,
      };
      for (const f of fields) {
        const val = displayValues[f.key];
        if (val !== undefined) {
          (payload as Record<string, number>)[f.key] = f.toStored(val);
        }
      }
      const data = await api.put<SystemSettings>('/api/config/system', payload);
      setSettings(data);
      const display: Record<string, number> = {};
      for (const f of fields) {
        display[f.key] = f.toDisplay(data[f.key] as number);
      }
      setDisplayValues(display);
      setBillingEnabled(data.billingEnabled ?? false);
      setBillingMinStartBalanceUsd(data.billingMinStartBalanceUsd ?? 0.01);
      setBillingCurrency(data.billingCurrency ?? 'USD');
      setBillingCurrencyRate(data.billingCurrencyRate ?? 1);
      setExternalClaudeDir(data.externalClaudeDir ?? '');
      setDisableMemoryLayerForAdminHost(data.disableMemoryLayerForAdminHost ?? false);
      setContainerNetworkMode(data.containerNetworkMode ?? 'bridge');
      // 刷新计费状态，更新导航栏可见性
      loadBillingStatus();
      toast.success('系统参数已保存，新参数将对后续启动的容器/进程生效');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存系统参数失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return <div className="text-sm text-muted-foreground">需要系统配置权限才能修改系统参数。</div>;
  }

  if (!settings) return null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        调整容器运行参数和安全限制。修改后无需重启，新参数对后续创建的容器/进程立即生效。
      </p>

      <div className="space-y-5">
        {fields.map((f) => (
          <div key={f.key}>
            <Label className="mb-1">
              {f.label}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={displayValues[f.key] ?? ''}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setDisplayValues((prev) => ({
                    ...prev,
                    [f.key]: Number.isFinite(val) ? val : 0,
                  }));
                }}
                min={f.min}
                max={f.max}
                step={f.step}
                className="max-w-32"
              />
              <span className="text-sm text-muted-foreground">{f.unit}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {f.description}（范围：{f.min} - {f.max} {f.unit}）
            </p>
          </div>
        ))}
      </div>

      {/* 计费设置 */}
      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-semibold text-foreground">计费系统</h3>

        <div className="flex items-center justify-between">
          <div>
            <Label>启用计费</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              开启后普通用户必须先有余额才能使用，管理员可在后台进行充扣和套餐分配
            </p>
          </div>
          <Switch
            checked={billingEnabled}
            onCheckedChange={setBillingEnabled}
            aria-label="启用计费系统"
          />
        </div>

        {billingEnabled && (
          <>
          <div>
              <Label className="mb-1">
                计费模式
              </Label>
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                钱包优先（固定）
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                普通用户必须先有余额才能使用，套餐只决定费率和资源上限。
              </p>
            </div>

            <div>
              <Label className="mb-1">
                最低起用余额
              </Label>
              <Input
                type="number"
                value={billingMinStartBalanceUsd}
                onChange={(e) => setBillingMinStartBalanceUsd(Number(e.target.value) || 0)}
                min={0}
                step={0.01}
                className="max-w-32"
              />
              <p className="text-xs text-muted-foreground mt-1">
                普通用户余额低于该值时，消息和任务都会被阻断。
              </p>
            </div>

            <div>
              <Label className="mb-1">
                显示货币符号
              </Label>
              <Input
                type="text"
                value={billingCurrency}
                onChange={(e) => setBillingCurrency(e.target.value)}
                className="max-w-32"
                placeholder="USD"
              />
              <p className="text-xs text-muted-foreground mt-1">
                前端显示的货币符号（如 USD、CNY、EUR）
              </p>
            </div>

            <div>
              <Label className="mb-1">
                汇率乘数
              </Label>
              <Input
                type="number"
                value={billingCurrencyRate}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setBillingCurrencyRate(Number.isFinite(val) ? val : 1);
                }}
                min={0.01}
                max={1000}
                step={0.01}
                className="max-w-32"
              />
              <p className="text-xs text-muted-foreground mt-1">
                将 USD 转为显示货币的乘数（如 CNY 约 7.2）
              </p>
            </div>

            <div>
              <Label className="mb-1">
                默认套餐
              </Label>
              <select
                value={defaultPlanId}
                onChange={(e) => handleSetDefaultPlan(e.target.value)}
                disabled={settingDefault || plans.filter((p: BillingPlan) => p.is_active).length === 0}
                className="h-9 px-3 text-sm border border-border rounded-md bg-transparent max-w-64"
              >
                <option value="" disabled>
                  {plans.filter((p: BillingPlan) => p.is_active).length === 0
                    ? '请先创建可用套餐'
                    : '请选择默认套餐'}
                </option>
                {plans
                  .filter((p: BillingPlan) => p.is_active)
                  .map((p: BillingPlan) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.is_default ? ' (当前默认)' : ''}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                新用户注册时自动分配的套餐
              </p>
            </div>
          </>
        )}
      </div>

      {/* Docker 容器网络模式 */}
      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-semibold text-foreground">Docker 容器网络</h3>
        <div className="flex items-center justify-between">
          <div className="flex-1 pr-4">
            <Label>容器网络模式</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              bridge（默认）：容器使用独立网络，通过 host.docker.internal 访问宿主机。
              host：容器直接共享宿主机网络栈，容器内 localhost 即宿主机，可直接使用宿主机代理。
            </p>
          </div>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={containerNetworkMode}
            onChange={(e) => setContainerNetworkMode(e.target.value as 'bridge' | 'host')}
          >
            <option value="bridge">bridge（默认）</option>
            <option value="host">host</option>
          </select>
        </div>
      </div>

      {/* 禁用 HappyClaw 记忆层（admin 主容器专用） */}
      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-semibold text-foreground">禁用 HappyClaw 记忆层（admin 主容器）</h3>

        <div className="flex items-center justify-between">
          <div className="flex-1 pr-4">
            <Label>禁用后按本机 ~/.claude/ Playbook 运行</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              启用后 admin 主容器（folder=main）不再注入 memory_append/search/get MCP 工具、
              不注入 WORKSPACE_GLOBAL/MEMORY 环境变量、不注入 HappyClaw 记忆系统提示、
              PreCompact 钩子不触发 memory flush，让 Agent 完全按本机
              ~/.claude/ 下的 Playbook（CLAUDE.md + rules/ + memory/）行事。
            </p>
            <p className="text-xs text-destructive mt-2">
              <strong>前置要求</strong>：必须先在 admin 主容器配置 customCwd
              指向真实项目目录。未配置时 CLAUDE_CONFIG_DIR 仍会指向 data/sessions/main/.claude，
              SDK 既读不到 HappyClaw 记忆层也读不到 ~/.claude/，Agent 会变成空白沙箱。
              后端会在保存时校验，未配置则拒绝启用。
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              <strong>仅作用范围</strong>：admin 的主容器（is_home=1，folder=main）。admin
              创建的其他 host 子群组、member 容器、Docker 容器模式均不受影响。
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              <strong>数据迁移提示</strong>：启用后 Agent 不再读取 data/groups/user-global/
              下的模板 CLAUDE.md 和 data/memory/ 下 memory_append 累积的日记。
              若有有价值的内容，建议迁移到 ~/.claude/memory/ 下再启用。
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              <strong>Auto-memory 共享</strong>：启用后 SDK auto-memory 会写入
              ~/.claude/projects/{'{cwd-slug}'}/memory/，与本机原生 Claude Code 共享。
              如果 HappyClaw Agent 和你本人的风格/语言偏好不同，两边会互相污染 —
              介意就不要开这个开关。
            </p>
          </div>
          <Switch
            checked={disableMemoryLayerForAdminHost}
            onCheckedChange={setDisableMemoryLayerForAdminHost}
            aria-label="禁用 HappyClaw 记忆层"
          />
        </div>
      </div>

      <div>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          保存系统参数
        </Button>
      </div>
    </div>
  );
}
