import { AlertTriangle, ChevronRight, ExternalLink } from 'lucide-react';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type {
  ChannelProvider,
  FeishuBrand,
} from '../../../stores/channel-accounts';
import {
  FEISHU_BRAND_OPTIONS,
  feishuBrandOf,
  feishuSetupGuide,
  PAIRING_OWNER_RISK_NOTE,
  providerDefinition,
  type ChannelSetupGuide,
} from '../../../utils/channel-accounts';

interface ProviderConnectionFieldsProps {
  provider: ChannelProvider;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
  idPrefix: string;
  showSecrets?: boolean;
  showGuide?: boolean;
  showOptions?: boolean;
}

export function ProviderConnectionFields({
  provider,
  values,
  onChange,
  disabled = false,
  idPrefix,
  showSecrets = true,
  showGuide,
  showOptions = true,
}: ProviderConnectionFieldsProps) {
  const definition = providerDefinition(provider);
  const shouldShowGuide = showGuide ?? showSecrets;

  if (definition.authMode === 'qr_session') {
    return (
      <div className="space-y-4">
        {shouldShowGuide && (
          <ProviderSetupGuide
            id={`${idPrefix}-setup-guide`}
            guide={definition.setupGuide}
            pairing={definition.supportsPairing}
          />
        )}
        <p className="text-caption leading-5 text-muted-foreground">
          {provider === 'wechat'
            ? '扫码结果由 HappyClaw 安全保存，无需填写 Token、Bot ID 或服务地址。'
            : '账号和会话密钥由 HappyClaw 管理，无需填写手机号或账号标识。'}
        </p>
        {provider === 'wechat' && showOptions && (
          <OptionSwitch
            id={`${idPrefix}-bypass-proxy`}
            label="绕过 HappyClaw HTTP 代理"
            description="开启后不使用 HTTP(S)_PROXY；Clash TUN、VPN 等系统级网络仍可能接管流量。"
            checked={(values.bypassProxy ?? 'true') !== 'false'}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange('bypassProxy', String(checked))
            }
          />
        )}
      </div>
    );
  }

  const feishuBrand = feishuBrandOf(values.domain);
  const guide =
    provider === 'feishu'
      ? feishuSetupGuide(feishuBrand)
      : definition.setupGuide;

  return (
    <div className="space-y-4">
      {showOptions && provider === 'feishu' && (
        <FeishuBrandField
          value={feishuBrand}
          disabled={disabled}
          onChange={(brand) => onChange('domain', brand)}
        />
      )}
      {shouldShowGuide && (
        <ProviderSetupGuide
          id={`${idPrefix}-setup-guide`}
          guide={guide}
          pairing={definition.supportsPairing}
        />
      )}
      {showSecrets && (
        <div className="grid gap-4 sm:grid-cols-2">
          {definition.credentials.map((field) => {
            const id = `${idPrefix}-${field.key}`;
            return (
              <div
                key={field.key}
                className={`space-y-1.5 ${
                  definition.credentials.length === 1 ? 'sm:col-span-2' : ''
                }`}
              >
                <Label htmlFor={id} className="gap-0.5 text-label">
                  {field.label}
                  {field.required && (
                    <span aria-hidden="true" className="text-error">
                      {' '}
                      *
                    </span>
                  )}
                </Label>
                <Input
                  variant="code"
                  id={id}
                  type={field.secret ? 'password' : 'text'}
                  value={values[field.key] ?? ''}
                  disabled={disabled}
                  onChange={(event) => onChange(field.key, event.target.value)}
                  placeholder={field.placeholder}
                  autoComplete={field.secret ? 'new-password' : 'off'}
                  aria-required={field.required}
                  aria-describedby={field.help ? `${id}-help` : undefined}
                />
                {field.help && (
                  <p
                    id={`${id}-help`}
                    className="text-caption leading-5 text-muted-foreground"
                  >
                    {field.help}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showOptions && provider === 'dingtalk' && (
        <OptionSwitch
          id={`${idPrefix}-streaming-card`}
          label="流式卡片"
          description="开启后以卡片实时更新回复；关闭后发送普通文本。"
          checked={(values.streamingMode ?? 'card') === 'card'}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange('streamingMode', checked ? 'card' : 'text')
          }
        />
      )}

      {showOptions && provider === 'telegram' && (
        <OptionSwitch
          id={`${idPrefix}-streaming-edit`}
          label="流式编辑"
          description="开启后回复期间持续编辑一条进度消息，完成后另发最终答复；关闭后完成生成再发送。"
          checked={(values.streamingMode ?? 'edit') === 'edit'}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange('streamingMode', checked ? 'edit' : 'off')
          }
        />
      )}

      {showOptions && provider === 'discord' && (
        <OptionSwitch
          id={`${idPrefix}-streaming-edit`}
          label="流式编辑"
          description="开启后持续编辑同一条消息；关闭后完成生成再发送。"
          checked={(values.streamingMode ?? 'off') === 'edit'}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange('streamingMode', checked ? 'edit' : 'off')
          }
        />
      )}
    </div>
  );
}

function ProviderSetupGuide({
  id,
  guide,
  pairing,
}: {
  id: string;
  guide: ChannelSetupGuide;
  /** The next step pairs chats: say what pairing a direct chat grants. */
  pairing: boolean;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="rounded-lg bg-muted/50 px-4 py-3 ring-1 ring-surface-border"
    >
      <div className="flex flex-col items-start justify-between gap-1 sm:flex-row sm:items-center sm:gap-4">
        <h4 id={`${id}-title`} className="text-title-sm text-foreground">
          {guide.title}
        </h4>
        {guide.action && (
          <a
            href={guide.action.url}
            target="_blank"
            rel="noreferrer"
            className="-mx-1.5 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption font-medium text-primary-text underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-11"
          >
            {guide.action.label}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </div>
      <ol className="mt-2 space-y-1.5">
        {guide.steps.map((step, index) => (
          <li
            key={step}
            className="flex items-start gap-2 text-caption leading-5 text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-background text-micro font-medium text-foreground ring-1 ring-surface-border tabular-nums"
            >
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {guide.checklists?.map((checklist) => (
        <SetupChecklist
          key={checklist.title}
          title={checklist.title}
          items={checklist.items}
        />
      ))}
      <p className="mt-2.5 border-t border-surface-border pt-2.5 text-caption leading-5 text-muted-foreground">
        <span className="font-medium text-foreground">创建后：</span>
        {guide.nextStep}
      </p>
      {pairing && (
        <p className="mt-1.5 flex items-start gap-1.5 text-caption leading-5 text-warning">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          {PAIRING_OWNER_RISK_NOTE}
        </p>
      )}
    </section>
  );
}

function SetupChecklist({
  title,
  items,
}: {
  title: string;
  items: NonNullable<ChannelSetupGuide['checklists']>[number]['items'];
}) {
  return (
    <details className="group mt-2 rounded-md bg-background/60 ring-1 ring-surface-border">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-1.5 text-caption font-medium text-foreground select-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        {title}
        <span className="text-faint-foreground tabular-nums">
          {items.length}
        </span>
      </summary>
      <ul className="space-y-2 border-t border-surface-border px-2.5 py-2">
        {items.map((item) => (
          <li key={item.name} className="text-caption leading-5">
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-micro text-foreground">
              {item.name}
            </code>{' '}
            <span className="text-foreground">{item.label}</span>
            <span className="block text-muted-foreground">{item.effect}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function FeishuBrandField({
  value,
  disabled,
  onChange,
}: {
  value: FeishuBrand;
  disabled?: boolean;
  onChange: (brand: FeishuBrand) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-label font-medium text-foreground">平台</p>
      <SegmentedControl
        label="平台"
        value={value}
        options={FEISHU_BRAND_OPTIONS}
        onChange={(next) => !disabled && onChange(next)}
      />
      <p className="text-caption leading-5 text-muted-foreground">
        国际版租户（larksuite.com）请选择
        Lark；连接、测试和开发者后台链接都会使用对应域名。
      </p>
    </div>
  );
}

function OptionSwitch({
  id,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-4 py-3 ring-1 ring-surface-border">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-body font-medium">
          {label}
        </Label>
        <p className="mt-1 text-caption leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
