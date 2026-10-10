import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  SettingsField,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import { useBillingStore, type BillingPlan } from '../../stores/billing';

interface PlanFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: BillingPlan | null;
}

interface FormState {
  id: string;
  name: string;
  description: string;
  tier: number;
  sort_order: number;
  monthly_cost_usd: number;
  display_price: string;
  rate_multiplier: number;
  trial_days: string;
  monthly_cost_quota: string;
  monthly_token_quota: string;
  daily_cost_quota: string;
  daily_token_quota: string;
  weekly_cost_quota: string;
  weekly_token_quota: string;
  max_groups: string;
  max_im_channels: string;
  max_mcp_servers: string;
  max_concurrent_containers: string;
  max_storage_mb: string;
  allow_overage: boolean;
  is_default: boolean;
  is_active: boolean;
  highlight: boolean;
  features: string;
}

const INITIAL: FormState = {
  id: '',
  name: '',
  description: '',
  tier: 0,
  sort_order: 0,
  monthly_cost_usd: 0,
  display_price: '',
  rate_multiplier: 1,
  trial_days: '',
  monthly_cost_quota: '',
  monthly_token_quota: '',
  daily_cost_quota: '',
  daily_token_quota: '',
  weekly_cost_quota: '',
  weekly_token_quota: '',
  max_groups: '',
  max_im_channels: '',
  max_mcp_servers: '',
  max_concurrent_containers: '',
  max_storage_mb: '',
  allow_overage: false,
  is_default: false,
  is_active: true,
  highlight: false,
  features: '',
};

function planToForm(plan: BillingPlan): FormState {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description ?? '',
    tier: plan.tier,
    sort_order: plan.sort_order,
    monthly_cost_usd: plan.monthly_cost_usd,
    display_price: plan.display_price ?? '',
    rate_multiplier: plan.rate_multiplier,
    trial_days: plan.trial_days != null ? String(plan.trial_days) : '',
    monthly_cost_quota:
      plan.monthly_cost_quota != null ? String(plan.monthly_cost_quota) : '',
    monthly_token_quota:
      plan.monthly_token_quota != null ? String(plan.monthly_token_quota) : '',
    daily_cost_quota:
      plan.daily_cost_quota != null ? String(plan.daily_cost_quota) : '',
    daily_token_quota:
      plan.daily_token_quota != null ? String(plan.daily_token_quota) : '',
    weekly_cost_quota:
      plan.weekly_cost_quota != null ? String(plan.weekly_cost_quota) : '',
    weekly_token_quota:
      plan.weekly_token_quota != null ? String(plan.weekly_token_quota) : '',
    max_groups: plan.max_groups != null ? String(plan.max_groups) : '',
    max_im_channels:
      plan.max_im_channels != null ? String(plan.max_im_channels) : '',
    max_mcp_servers:
      plan.max_mcp_servers != null ? String(plan.max_mcp_servers) : '',
    max_concurrent_containers:
      plan.max_concurrent_containers != null
        ? String(plan.max_concurrent_containers)
        : '',
    max_storage_mb:
      plan.max_storage_mb != null ? String(plan.max_storage_mb) : '',
    allow_overage: plan.allow_overage,
    is_default: plan.is_default,
    is_active: plan.is_active,
    highlight: plan.highlight,
    features: plan.features.join(', '),
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SettingsSection title={title}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </SettingsSection>
  );
}

function Field({
  id,
  label,
  children,
  span,
}: {
  id: string;
  label: string;
  children: ReactNode;
  span?: boolean;
}) {
  return (
    <SettingsField
      label={label}
      htmlFor={id}
      className={span ? 'sm:col-span-2' : undefined}
    >
      {children}
    </SettingsField>
  );
}

export default function PlanFormDialog({
  open,
  onOpenChange,
  plan,
}: PlanFormDialogProps) {
  const { createPlan, updatePlan } = useBillingStore();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const isEdit = plan !== null;

  useEffect(() => {
    if (open) {
      setForm(plan ? planToForm(plan) : INITIAL);
    }
  }, [open, plan]);

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const optNum = (v: string) => (v.trim() === '' ? null : Number(v));

  const handleSubmit = async () => {
    if (!form.id.trim() || !form.name.trim()) {
      toast.error('套餐 ID 和名称不能为空');
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        id: form.id,
        name: form.name,
        description: form.description || null,
        tier: form.tier,
        sort_order: form.sort_order,
        monthly_cost_usd: form.monthly_cost_usd,
        display_price: form.display_price || null,
        rate_multiplier: form.rate_multiplier,
        trial_days: optNum(form.trial_days),
        monthly_cost_quota: optNum(form.monthly_cost_quota),
        monthly_token_quota: optNum(form.monthly_token_quota),
        daily_cost_quota: optNum(form.daily_cost_quota),
        daily_token_quota: optNum(form.daily_token_quota),
        weekly_cost_quota: optNum(form.weekly_cost_quota),
        weekly_token_quota: optNum(form.weekly_token_quota),
        max_groups: optNum(form.max_groups),
        max_im_channels: optNum(form.max_im_channels),
        max_mcp_servers: optNum(form.max_mcp_servers),
        max_concurrent_containers: optNum(form.max_concurrent_containers),
        max_storage_mb: optNum(form.max_storage_mb),
        allow_overage: form.allow_overage,
        is_default: form.is_default,
        is_active: form.is_active,
        highlight: form.highlight,
        features: form.features
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };

      if (isEdit) {
        await updatePlan(plan.id, payload as Partial<BillingPlan>);
      } else {
        await createPlan(
          payload as Partial<BillingPlan> & { id: string; name: string },
        );
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-2xl"
        aria-describedby={undefined}
      >
        <DialogHeader className="border-b border-surface-border px-4 py-3.5 pr-12">
          <DialogTitle>{isEdit ? '编辑套餐' : '创建套餐'}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
          {/* Basic */}
          <Section title="基本信息">
            <Field id="plan-form-id" label="套餐 ID">
              <Input
                id="plan-form-id"
                value={form.id}
                onChange={(e) => set('id', e.target.value)}
                disabled={isEdit}
                placeholder="如 basic"
              />
            </Field>
            <Field id="plan-form-name" label="名称">
              <Input
                id="plan-form-name"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="套餐名称"
              />
            </Field>
            <Field id="plan-form-description" label="描述" span>
              <Input
                id="plan-form-description"
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="套餐描述"
              />
            </Field>
            <Field id="plan-form-tier" label="Tier">
              <Input
                id="plan-form-tier"
                type="number"
                value={form.tier}
                onChange={(e) => set('tier', Number(e.target.value))}
              />
            </Field>
            <Field id="plan-form-sort-order" label="排序">
              <Input
                id="plan-form-sort-order"
                type="number"
                value={form.sort_order}
                onChange={(e) => set('sort_order', Number(e.target.value))}
              />
            </Field>
          </Section>

          {/* Pricing */}
          <Section title="定价">
            <Field id="plan-form-monthly-cost-usd" label="月费 (USD)">
              <Input
                id="plan-form-monthly-cost-usd"
                type="number"
                step="0.01"
                value={form.monthly_cost_usd}
                onChange={(e) =>
                  set('monthly_cost_usd', Number(e.target.value))
                }
              />
            </Field>
            <Field id="plan-form-display-price" label="展示价格">
              <Input
                id="plan-form-display-price"
                value={form.display_price}
                onChange={(e) => set('display_price', e.target.value)}
                placeholder="如 ¥99/月"
              />
            </Field>
            <Field id="plan-form-rate-multiplier" label="费率倍数">
              <Input
                id="plan-form-rate-multiplier"
                type="number"
                step="0.1"
                value={form.rate_multiplier}
                onChange={(e) => set('rate_multiplier', Number(e.target.value))}
              />
            </Field>
            <Field id="plan-form-trial-days" label="试用天数">
              <Input
                id="plan-form-trial-days"
                type="number"
                value={form.trial_days}
                onChange={(e) => set('trial_days', e.target.value)}
                placeholder="留空=无试用"
              />
            </Field>
          </Section>

          {/* Monthly quota */}
          <Section title="月度配额（留空=无限）">
            <Field id="plan-form-monthly-cost-quota" label="月度费用上限 (USD)">
              <Input
                id="plan-form-monthly-cost-quota"
                type="number"
                step="0.01"
                value={form.monthly_cost_quota}
                onChange={(e) => set('monthly_cost_quota', e.target.value)}
              />
            </Field>
            <Field id="plan-form-monthly-token-quota" label="月度 Token 上限">
              <Input
                id="plan-form-monthly-token-quota"
                type="number"
                value={form.monthly_token_quota}
                onChange={(e) => set('monthly_token_quota', e.target.value)}
              />
            </Field>
          </Section>

          {/* Daily quota */}
          <Section title="日度配额（留空=无限）">
            <Field id="plan-form-daily-cost-quota" label="日度费用上限 (USD)">
              <Input
                id="plan-form-daily-cost-quota"
                type="number"
                step="0.01"
                value={form.daily_cost_quota}
                onChange={(e) => set('daily_cost_quota', e.target.value)}
              />
            </Field>
            <Field id="plan-form-daily-token-quota" label="日度 Token 上限">
              <Input
                id="plan-form-daily-token-quota"
                type="number"
                value={form.daily_token_quota}
                onChange={(e) => set('daily_token_quota', e.target.value)}
              />
            </Field>
          </Section>

          {/* Weekly quota */}
          <Section title="周度配额（留空=无限）">
            <Field id="plan-form-weekly-cost-quota" label="周度费用上限 (USD)">
              <Input
                id="plan-form-weekly-cost-quota"
                type="number"
                step="0.01"
                value={form.weekly_cost_quota}
                onChange={(e) => set('weekly_cost_quota', e.target.value)}
              />
            </Field>
            <Field id="plan-form-weekly-token-quota" label="周度 Token 上限">
              <Input
                id="plan-form-weekly-token-quota"
                type="number"
                value={form.weekly_token_quota}
                onChange={(e) => set('weekly_token_quota', e.target.value)}
              />
            </Field>
          </Section>

          {/* Resource limits */}
          <Section title="资源限制（留空=无限）">
            <Field id="plan-form-max-groups" label="工作区上限">
              <Input
                id="plan-form-max-groups"
                type="number"
                value={form.max_groups}
                onChange={(e) => set('max_groups', e.target.value)}
              />
            </Field>
            <Field id="plan-form-max-im-channels" label="IM 通道上限">
              <Input
                id="plan-form-max-im-channels"
                type="number"
                value={form.max_im_channels}
                onChange={(e) => set('max_im_channels', e.target.value)}
              />
            </Field>
            <Field id="plan-form-max-mcp-servers" label="MCP Server 上限">
              <Input
                id="plan-form-max-mcp-servers"
                type="number"
                value={form.max_mcp_servers}
                onChange={(e) => set('max_mcp_servers', e.target.value)}
              />
            </Field>
            <Field
              id="plan-form-max-concurrent-containers"
              label="并发容器上限"
            >
              <Input
                id="plan-form-max-concurrent-containers"
                type="number"
                value={form.max_concurrent_containers}
                onChange={(e) =>
                  set('max_concurrent_containers', e.target.value)
                }
              />
            </Field>
            <Field id="plan-form-max-storage-mb" label="存储上限 (MB)">
              <Input
                id="plan-form-max-storage-mb"
                type="number"
                value={form.max_storage_mb}
                onChange={(e) => set('max_storage_mb', e.target.value)}
              />
            </Field>
          </Section>

          {/* Toggles */}
          <SettingsSection title="开关">
            <SettingsGroup>
              {(
                [
                  ['allow_overage', '允许超额'],
                  ['is_default', '默认套餐'],
                  ['is_active', '启用'],
                  ['highlight', '高亮推荐'],
                ] as const
              ).map(([key, label]) => (
                <SettingsRow
                  key={key}
                  label={label}
                  htmlFor={`plan-form-${key.replace(/_/g, '-')}`}
                  className="py-2"
                  control={
                    <Switch
                      id={`plan-form-${key.replace(/_/g, '-')}`}
                      checked={form[key]}
                      onCheckedChange={(v) => set(key, v)}
                    />
                  }
                />
              ))}
            </SettingsGroup>
          </SettingsSection>

          {/* Features */}
          <SettingsSection title="特性标签">
            <Input
              id="plan-form-features"
              aria-label="特性标签"
              value={form.features}
              onChange={(e) => set('features', e.target.value)}
              placeholder="逗号分隔，如: 高速响应, 无限对话, 自定义智能体"
            />
          </SettingsSection>
        </div>

        <DialogFooter className="m-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? '保存中...' : isEdit ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
