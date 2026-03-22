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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {generatedCodes.length > 0 ? '生成完成' : '创建兑换码'}
          </DialogTitle>
        </DialogHeader>

        {generatedCodes.length > 0 ? (
          /* Show generated codes */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-500">
                已生成 {generatedCodes.length} 个兑换码
              </span>
              <Button variant="outline" size="xs" onClick={handleCopyAll}>
                {copiedIdx === -1 ? (
                  <Check className="w-3 h-3 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                复制全部
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1">
              {generatedCodes.map((c, i) => (
                <div
                  key={c.code}
                  className="flex items-center justify-between px-3 py-2 bg-zinc-50 dark:bg-zinc-900 rounded-md"
                >
                  <code className="text-sm font-mono">{c.code}</code>
                  <button
                    onClick={() => handleCopy(c.code, i)}
                    className="p-1 text-zinc-400 hover:text-primary"
                  >
                    {copiedIdx === i ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
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
            <div className="flex gap-1 p-1 bg-zinc-100 dark:bg-zinc-900 rounded-md">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setType(opt.value)}
                  className={`flex-1 px-3 py-1.5 text-sm rounded transition-colors ${
                    type === opt.value
                      ? 'bg-white dark:bg-zinc-800 shadow-sm font-medium'
                      : 'text-zinc-500 hover:text-zinc-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Type-specific fields */}
            {type === 'balance' && (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  面值 (USD)
                </label>
                <Input
                  type="number"
                  step="0.01"
                  min={0}
                  value={valueUsd}
                  onChange={(e) => setValueUsd(Number(e.target.value))}
                />
                <span className="text-xs text-zinc-400 mt-1 block">
                  转换后: {fmt(valueUsd)}
                </span>
              </div>
            )}

            {type === 'subscription' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    套餐
                  </label>
                  <select
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                    className="w-full h-9 px-3 text-sm border border-zinc-300 dark:border-zinc-600 rounded-md bg-transparent"
                  >
                    <option value="">选择套餐</option>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">
                    有效天数
                  </label>
                  <Input
                    type="number"
                    min={1}
                    value={durationDays}
                    onChange={(e) => setDurationDays(Number(e.target.value))}
                  />
                </div>
              </div>
            )}

            {type === 'trial' && (
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  试用天数
                </label>
                <Input
                  type="number"
                  min={1}
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                />
              </div>
            )}

            {/* Common fields */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  生成数量
                </label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  每码可用次数
                </label>
                <Input
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => setMaxUses(Number(e.target.value))}
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  前缀（可选）
                </label>
                <Input
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                  placeholder="如 VIP"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">
                  过期时间（小时，留空=不过期）
                </label>
                <Input
                  type="number"
                  min={1}
                  value={expiresHours}
                  onChange={(e) => setExpiresHours(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-500 mb-1">
                备注（可选）
              </label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="内部备注"
              />
            </div>

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
