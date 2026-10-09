import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';
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
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { IconButton, SegmentedControl } from '@/components/common';
import { SettingsField } from '@/components/settings/SettingsLayout';
import { useBillingStore, type RedeemCode } from '../../stores/billing';
import { useCurrency } from './utils';

interface RedeemCodeCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CodeType = 'balance' | 'subscription' | 'trial';

const TYPE_OPTIONS: { value: CodeType; label: string }[] = [
  { value: 'balance', label: '余额充值' },
  { value: 'subscription', label: '套餐激活' },
  { value: 'trial', label: '试用' },
];

export default function RedeemCodeCreateDialog({
  open,
  onOpenChange,
}: RedeemCodeCreateDialogProps) {
  const { createRedeemCodes, plans, loadAllPlans } = useBillingStore();
  const fmt = useCurrency();

  // Ensure plans are loaded for subscription type dropdown
  useEffect(() => {
    if (open && plans.length === 0) {
      loadAllPlans();
    }
  }, [open, plans.length, loadAllPlans]);

  const [type, setType] = useState<CodeType>('balance');
  const [valueUsd, setValueUsd] = useState(10);
  const [planId, setPlanId] = useState('');
  const [durationDays, setDurationDays] = useState(30);
  const [count, setCount] = useState(1);
  const [prefix, setPrefix] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [expiresHours, setExpiresHours] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<RedeemCode[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const handleCreate = async () => {
    // Client-side validation
    if (count < 1 || count > 100 || !Number.isInteger(count)) {
      toast.error('生成数量须为 1-100 之间的整数');
      return;
    }
    if (type === 'balance' && (!valueUsd || valueUsd <= 0)) {
      toast.error('余额充值类型须设置正数面值');
      return;
    }
    if (type === 'subscription' && !planId) {
      toast.error('套餐激活类型须选择套餐');
      return;
    }
    if ((type === 'subscription' || type === 'trial') && durationDays < 1) {
      toast.error('有效天数须至少为 1');
      return;
    }

    setSubmitting(true);
    try {
      const params: Parameters<typeof createRedeemCodes>[0] = {
        type,
        count,
        max_uses: maxUses,
      };
      if (type === 'balance') {
        params.value_usd = valueUsd;
      }
      if (type === 'subscription') {
        params.plan_id = planId || undefined;
        params.duration_days = durationDays;
      }
      if (type === 'trial') {
        params.duration_days = durationDays;
      }
      if (expiresHours.trim()) {
        params.expires_in_hours = Number(expiresHours);
      }
      if (notes.trim()) {
        params.notes = notes.trim();
      }
      if (prefix.trim()) {
        params.prefix = prefix.trim();
      }
      const codes = await createRedeemCodes(params);
      setGeneratedCodes(codes);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = (code: string, idx: number) => {
    navigator.clipboard.writeText(code);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const handleCopyAll = () => {
    const text = generatedCodes.map((c) => c.code).join('\n');
    navigator.clipboard.writeText(text);
    setCopiedIdx(-1);
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  const handleClose = (v: boolean) => {
    if (!v) {
      setGeneratedCodes([]);
      setCopiedIdx(null);
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {generatedCodes.length > 0 ? '生成完成' : '创建兑换码'}
          </DialogTitle>
        </DialogHeader>

        {generatedCodes.length > 0 ? (
          /* Show generated codes */
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-body text-muted-foreground">
                已生成 {generatedCodes.length} 个兑换码
              </span>
              <Button variant="outline" size="sm" onClick={handleCopyAll}>
                {copiedIdx === -1 ? (
                  <Check className="text-success" />
                ) : (
                  <Copy />
                )}
                复制全部
              </Button>
            </div>
            <div className="max-h-64 divide-y divide-surface-border overflow-y-auto rounded-lg ring-1 ring-surface-border">
              {generatedCodes.map((c, i) => (
                <div
                  key={c.code}
                  className="flex items-center justify-between gap-3 py-1 pr-1 pl-3"
                >
                  <code className="truncate font-mono text-label text-foreground">
                    {c.code}
                  </code>
                  <IconButton
                    label="复制"
                    icon={
                      copiedIdx === i ? (
                        <Check className="text-success" />
                      ) : (
                        <Copy />
                      )
                    }
                    onClick={() => handleCopy(c.code, i)}
                    tooltipSide="left"
                  />
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)}>关闭</Button>
            </DialogFooter>
          </div>
        ) : (
          /* Creation form */
          <div className="space-y-4">
            {/* Type selector */}
            <SegmentedControl
              label="兑换码类型"
              value={type}
              options={TYPE_OPTIONS}
              onChange={setType}
            />

            {/* Type-specific fields */}
            {type === 'balance' && (
              <SettingsField
                label="面值 (USD)"
                htmlFor="redeem-create-value"
                description={`转换后: ${fmt(valueUsd)}`}
              >
                <Input
                  id="redeem-create-value"
                  type="number"
                  step="0.01"
                  min={0}
                  value={valueUsd}
                  onChange={(e) => setValueUsd(Number(e.target.value))}
                />
              </SettingsField>
            )}

            {type === 'subscription' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <SettingsField label="套餐" htmlFor="redeem-create-plan">
                  <NativeSelect
                    id="redeem-create-plan"
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                    className="w-full"
                  >
                    <NativeSelectOption value="">选择套餐</NativeSelectOption>
                    {plans.map((p) => (
                      <NativeSelectOption key={p.id} value={p.id}>
                        {p.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingsField>
                <SettingsField
                  label="有效天数"
                  htmlFor="redeem-create-duration"
                >
                  <Input
                    id="redeem-create-duration"
                    type="number"
                    min={1}
                    value={durationDays}
                    onChange={(e) => setDurationDays(Number(e.target.value))}
                  />
                </SettingsField>
              </div>
            )}

            {type === 'trial' && (
              <SettingsField label="试用天数" htmlFor="redeem-create-trial">
                <Input
                  id="redeem-create-trial"
                  type="number"
                  min={1}
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                />
              </SettingsField>
            )}

            {/* Common fields */}
            <div className="grid gap-3 sm:grid-cols-2">
              <SettingsField label="生成数量" htmlFor="redeem-create-count">
                <Input
                  id="redeem-create-count"
                  type="number"
                  min={1}
                  max={100}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </SettingsField>
              <SettingsField
                label="每码可用次数"
                htmlFor="redeem-create-max-uses"
              >
                <Input
                  id="redeem-create-max-uses"
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => setMaxUses(Number(e.target.value))}
                />
              </SettingsField>
              <SettingsField
                label="前缀（可选）"
                htmlFor="redeem-create-prefix"
              >
                <Input
                  id="redeem-create-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                  placeholder="如 VIP"
                />
              </SettingsField>
              <SettingsField
                label="过期时间（小时，留空=不过期）"
                htmlFor="redeem-create-expires"
              >
                <Input
                  id="redeem-create-expires"
                  type="number"
                  min={1}
                  value={expiresHours}
                  onChange={(e) => setExpiresHours(e.target.value)}
                />
              </SettingsField>
            </div>

            <SettingsField label="备注（可选）" htmlFor="redeem-create-notes">
              <Input
                id="redeem-create-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="内部备注"
              />
            </SettingsField>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => handleClose(false)}
                disabled={submitting}
              >
                取消
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? '生成中...' : `生成 ${count} 个`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
