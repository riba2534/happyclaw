import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useBillingStore } from '../../stores/billing';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/common';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import {
  SettingsStickySaveBar,
  SettingsSwitchRow,
} from '@/components/settings/SettingsFormControls';

interface BillingAdminConfig {
  enabled: boolean;
  minStartBalanceUsd: number;
  currency: string;
  currencyRate: number;
}

interface BillingDraft {
  billingEnabled: boolean;
  billingMinStartBalanceUsd: string;
  billingCurrency: string;
  billingCurrencyRate: string;
}

function toDraft(config: BillingAdminConfig): BillingDraft {
  return {
    billingEnabled: config.enabled,
    billingMinStartBalanceUsd: String(config.minStartBalanceUsd),
    billingCurrency: config.currency,
    billingCurrencyRate: String(config.currencyRate),
  };
}

export default function AdminBillingSettings() {
  const loadBillingStatus = useBillingStore((state) => state.loadBillingStatus);
  const [saved, setSaved] = useState<BillingDraft | null>(null);
  const [draft, setDraft] = useState<BillingDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<
    Partial<Record<keyof BillingDraft, boolean>>
  >({});

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<BillingAdminConfig>(
        '/api/billing/admin/config',
      );
      const next = toDraft(data);
      setSaved(next);
      setDraft(next);
      setSubmitted(false);
      setTouched({});
    } catch (error) {
      setLoadError(
        error instanceof Error && error.message
          ? error.message
          : '无法读取计费设置，请检查网络后重试。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const errors = useMemo(() => {
    if (!draft) return {};
    const next: Partial<Record<keyof BillingDraft, string>> = {};
    const minBalance = Number(draft.billingMinStartBalanceUsd);
    if (
      !draft.billingMinStartBalanceUsd.trim() ||
      !Number.isFinite(minBalance)
    ) {
      next.billingMinStartBalanceUsd = '请输入有效金额。';
    } else if (minBalance < 0 || minBalance > 1_000_000) {
      next.billingMinStartBalanceUsd = '请输入 0–1,000,000 USD。';
    }

    const currency = draft.billingCurrency.trim();
    if (!currency) {
      next.billingCurrency = '请输入显示货币代码。';
    } else if (currency.length > 10) {
      next.billingCurrency = '货币代码不能超过 10 个字符。';
    }

    const rate = Number(draft.billingCurrencyRate);
    if (!draft.billingCurrencyRate.trim() || !Number.isFinite(rate)) {
      next.billingCurrencyRate = '请输入有效汇率。';
    } else if (rate < 0.01 || rate > 1000) {
      next.billingCurrencyRate = '请输入 0.01–1000。';
    }
    return next;
  }, [draft]);

  const dirty =
    !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);

  const handleSave = async () => {
    if (!draft) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      const data = await api.put<BillingAdminConfig>(
        '/api/billing/admin/config',
        {
          enabled: draft.billingEnabled,
          minStartBalanceUsd: Number(draft.billingMinStartBalanceUsd),
          currency: draft.billingCurrency.trim(),
          currencyRate: Number(draft.billingCurrencyRate),
        },
      );
      const next = toDraft(data);
      setSaved(next);
      setDraft(next);
      setSubmitted(false);
      setTouched({});
      await loadBillingStatus();
      toast.success('计费设置已保存');
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : '计费设置保存失败，请稍后重试。',
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div
        className="flex min-h-48 items-center justify-center"
        aria-label="正在加载计费设置"
      >
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (loadError || !draft) {
    return (
      <EmptyState
        icon={AlertCircle}
        title="计费设置加载失败"
        description={loadError ?? undefined}
        className="rounded-xl border border-dashed border-surface-border"
        action={
          <Button
            variant="outline"
            onClick={() => void loadConfig()}
            className="pointer-coarse:min-h-11"
          >
            <RotateCcw aria-hidden="true" />
            重新加载
          </Button>
        }
      />
    );
  }

  const fieldError = (key: keyof BillingDraft) =>
    submitted || touched[key] ? errors[key] : undefined;

  return (
    <div>
      <SettingsSection
        title="计费设置"
        description="管理计费开关、最低起用余额和前端显示货币。套餐和默认套餐请在“套餐管理”中配置。"
      >
        <SettingsGroup>
          <SettingsSwitchRow
            label="启用计费"
            htmlFor="billing-admin-enabled"
            description={
              <span id="billing-admin-enabled-description">
                开启后，普通用户需要满足余额和套餐限制才能发送消息或运行任务。
              </span>
            }
            control={
              <Switch
                id="billing-admin-enabled"
                checked={draft.billingEnabled}
                onCheckedChange={(checked) =>
                  setDraft((current) =>
                    current ? { ...current, billingEnabled: checked } : current,
                  )
                }
                aria-describedby="billing-admin-enabled-description"
              />
            }
          />

          <SettingsRow
            label="最低可用余额"
            htmlFor="billing-admin-min-balance"
            description={
              <span id="billing-admin-min-balance-description">
                普通用户余额低于该值时，消息和任务会被阻止。
              </span>
            }
            control={
              <div className="w-full sm:w-48">
                <div className="relative">
                  <Input
                    id="billing-admin-min-balance"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={1_000_000}
                    step={0.01}
                    value={draft.billingMinStartBalanceUsd}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              billingMinStartBalanceUsd: event.target.value,
                            }
                          : current,
                      )
                    }
                    onBlur={() =>
                      setTouched((current) => ({
                        ...current,
                        billingMinStartBalanceUsd: true,
                      }))
                    }
                    aria-invalid={!!fieldError('billingMinStartBalanceUsd')}
                    aria-describedby={`billing-admin-min-balance-description${fieldError('billingMinStartBalanceUsd') ? ' billing-admin-min-balance-error' : ''}`}
                    className="pr-12 tabular-nums"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-caption text-muted-foreground">
                    USD
                  </span>
                </div>
                {fieldError('billingMinStartBalanceUsd') && (
                  <p
                    id="billing-admin-min-balance-error"
                    role="alert"
                    className="mt-1 text-caption text-destructive"
                  >
                    {fieldError('billingMinStartBalanceUsd')}
                  </p>
                )}
              </div>
            }
          />

          <SettingsRow
            label="显示货币代码"
            htmlFor="billing-admin-currency"
            description={
              <span id="billing-admin-currency-description">
                仅影响界面显示，例如 USD、CNY 或 EUR；账本仍以 USD 结算。
              </span>
            }
            control={
              <div className="w-full sm:w-48">
                <Input
                  id="billing-admin-currency"
                  value={draft.billingCurrency}
                  maxLength={10}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            billingCurrency: event.target.value.toUpperCase(),
                          }
                        : current,
                    )
                  }
                  onBlur={() =>
                    setTouched((current) => ({
                      ...current,
                      billingCurrency: true,
                    }))
                  }
                  aria-invalid={!!fieldError('billingCurrency')}
                  aria-describedby={`billing-admin-currency-description${fieldError('billingCurrency') ? ' billing-admin-currency-error' : ''}`}
                />
                {fieldError('billingCurrency') && (
                  <p
                    id="billing-admin-currency-error"
                    role="alert"
                    className="mt-1 text-caption text-destructive"
                  >
                    {fieldError('billingCurrency')}
                  </p>
                )}
              </div>
            }
          />

          <SettingsRow
            label="显示汇率"
            htmlFor="billing-admin-currency-rate"
            description={
              <span id="billing-admin-currency-rate-description">
                将 USD 金额换算为显示货币的乘数，例如 CNY 可填写 7.2。
              </span>
            }
            control={
              <div className="w-full sm:w-48">
                <Input
                  id="billing-admin-currency-rate"
                  type="number"
                  inputMode="decimal"
                  min={0.01}
                  max={1000}
                  step={0.01}
                  value={draft.billingCurrencyRate}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            billingCurrencyRate: event.target.value,
                          }
                        : current,
                    )
                  }
                  onBlur={() =>
                    setTouched((current) => ({
                      ...current,
                      billingCurrencyRate: true,
                    }))
                  }
                  aria-invalid={!!fieldError('billingCurrencyRate')}
                  aria-describedby={`billing-admin-currency-rate-description${fieldError('billingCurrencyRate') ? ' billing-admin-currency-rate-error' : ''}`}
                  className="tabular-nums"
                />
                {fieldError('billingCurrencyRate') && (
                  <p
                    id="billing-admin-currency-rate-error"
                    role="alert"
                    className="mt-1 text-caption text-destructive"
                  >
                    {fieldError('billingCurrencyRate')}
                  </p>
                )}
              </div>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsStickySaveBar
        status={
          <p
            className="truncate text-caption text-muted-foreground"
            aria-live="polite"
          >
            {dirty ? '有尚未保存的计费设置' : '计费设置已保存'}
          </p>
        }
      >
        <Button
          onClick={() => void handleSave()}
          disabled={saving || !dirty || Object.keys(errors).length > 0}
          className="pointer-coarse:min-h-11"
        >
          {saving && <Spinner aria-hidden="true" />}
          保存计费设置
        </Button>
      </SettingsStickySaveBar>
    </div>
  );
}
