import type {
  ChannelOnboardingState,
  ChannelAccountCreateInput,
  ChannelAccountPatchInput,
  ChannelProvider,
} from '../stores/channel-accounts';

export type ChannelAuthMode = 'credentials' | 'bot_token' | 'qr_session';

export interface CredentialField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ChannelSetupGuide {
  title: string;
  steps: string[];
  action?: {
    label: string;
    url: string;
  };
  nextStep: string;
}

export interface ChannelProviderOption {
  value: ChannelProvider;
  label: string;
  description: string;
  authMode: ChannelAuthMode;
  credentials: CredentialField[];
  setupGuide: ChannelSetupGuide;
  supportsTest: boolean;
  supportsPairing: boolean;
}

/**
 * The account list is shared, while every provider keeps its real onboarding
 * protocol. In particular, QR results are server-managed protocol output and
 * must never be exposed as editable credentials.
 */
export const CHANNEL_PROVIDER_OPTIONS: ChannelProviderOption[] = [
  {
    value: 'feishu',
    label: '飞书',
    description: '通过飞书自建应用接收消息，Owner 会在首次私聊时自动识别。',
    authMode: 'credentials',
    credentials: [
      {
        key: 'appId',
        label: '飞书应用 App ID',
        required: true,
        help: '在企业自建应用的“凭证与基础信息”中复制。',
      },
      {
        key: 'appSecret',
        label: '飞书应用 App Secret',
        required: true,
        secret: true,
        help: '与 App ID 在同一页；请不要填写 Verification Token。',
      },
    ],
    setupGuide: {
      title: '先创建飞书企业自建应用',
      steps: [
        '在飞书开放平台创建企业自建应用，并启用“机器人”能力。',
        '在“凭证与基础信息”复制 App ID 和 App Secret。',
        '事件订阅选择长连接，添加 im.message.receive_v1，申请消息与资源权限后发布应用。',
        '可选：开通“查看群成员”或“获取用户基本信息”权限，消息会显示发送人名字而不是 open_id。',
      ],
      action: {
        label: '打开飞书开放平台',
        url: 'https://open.feishu.cn/app',
      },
      nextStep:
        '发布后在飞书里给 Bot 发起私聊，HappyClaw 会自动识别账号 Owner。',
    },
    supportsTest: true,
    supportsPairing: false,
  },
  {
    value: 'telegram',
    label: 'Telegram',
    description: '使用 Bot Token 接入；保存后通过配对码授权具体聊天。',
    authMode: 'bot_token',
    credentials: [
      {
        key: 'botToken',
        label: 'Telegram Bot Token',
        required: true,
        secret: true,
        help: '@BotFather 完成 /newbot 后返回的 Token，不是 Telegram API ID。',
      },
      {
        key: 'proxyUrl',
        label: '代理 URL（可选）',
        placeholder: 'http://127.0.0.1:7897 或 socks5://127.0.0.1:7897',
        help: '只有当服务器无法直连 Telegram 时才需要填写。',
      },
    ],
    setupGuide: {
      title: '先在 Telegram 创建 Bot',
      steps: [
        '打开官方 @BotFather，发送 /newbot。',
        '按提示设置名称和以 bot 结尾的用户名。',
        '复制 BotFather 返回的 Token；如需读取群里未 @ Bot 的消息，还要关闭 Privacy Mode。',
      ],
      action: {
        label: '打开 @BotFather',
        url: 'https://t.me/BotFather',
      },
      nextStep:
        '连接成功后生成配对码，在 Bot 私聊或目标群聊中发送 /pair <配对码>。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
  {
    value: 'qq',
    label: 'QQ',
    description: '使用 QQ Bot 应用凭证接入；保存后通过配对码授权聊天。',
    authMode: 'credentials',
    credentials: [
      {
        key: 'appId',
        label: 'QQ 机器人 AppID',
        required: true,
        help: 'QQ 开放平台生成的机器人应用 ID，不是 QQ 号。',
      },
      {
        key: 'appSecret',
        label: 'QQ 机器人 AppSecret',
        required: true,
        secret: true,
        help: '创建或重置机器人时显示的密钥，不是 QQ 密码。',
      },
    ],
    setupGuide: {
      title: '先创建 QQ 官方机器人',
      steps: [
        '用手机 QQ 扫码登录 QQ 开放平台，点击“创建机器人”。',
        '在机器人页面复制 AppID 和 AppSecret。',
        '保存 AppSecret；丢失后需要在 QQ 开放平台重置。',
      ],
      action: {
        label: '打开 QQ 开放平台',
        url: 'https://q.qq.com/qqbot/openclaw/index.html',
      },
      nextStep:
        '连接成功后生成配对码，在 QQ Bot 私聊或目标群聊中发送 /pair <配对码>。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
  {
    value: 'wechat',
    label: '微信',
    description: '创建账号后使用微信扫码授权，再通过配对码授权具体微信会话。',
    authMode: 'qr_session',
    credentials: [],
    setupGuide: {
      title: '创建后使用微信扫码',
      steps: [
        '填写账号名称，连接后再选择渠道会话的绑定目标。',
        '点击“创建并扫码”，HappyClaw 会生成微信登录二维码。',
        '用手机微信扫码确认；如微信要求验证码，直接在 HappyClaw 中输入。',
      ],
      nextStep:
        '扫码授权只建立渠道账号；连接后还需要生成配对码，授权具体微信会话。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
  {
    value: 'wecom',
    label: '企业微信',
    description: '使用企业微信智能机器人的 Bot ID 和 Secret 建立长连接。',
    authMode: 'credentials',
    credentials: [
      {
        key: 'botId',
        label: '智能机器人 Bot ID',
        required: true,
        help: '在企业微信管理后台的智能机器人详情中复制。',
      },
      {
        key: 'secret',
        label: '智能机器人 Secret',
        required: true,
        secret: true,
        help: '仅用于长连接鉴权，请勿填写企业应用 Secret。',
      },
      {
        key: 'corpId',
        label: '企业 ID（可选）',
        help: '可在企业微信“我的企业”页面底部找到。',
      },
    ],
    setupGuide: {
      title: '先创建企业微信智能机器人',
      steps: [
        '在企业微信管理后台创建智能机器人并启用 API 模式。',
        '选择长连接接收消息，复制 Bot ID 和 Secret。',
        '保存后等待连接成功，再用配对码授权具体单聊或群聊。',
      ],
      action: {
        label: '查看企业微信开发文档',
        url: 'https://developer.work.weixin.qq.com/document/path/101039',
      },
      nextStep:
        '连接成功后生成配对码，在目标会话中发送 /pair <配对码> 完成授权。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
  {
    value: 'dingtalk',
    label: '钉钉',
    description: '通过钉钉企业内部应用的机器人凭证接入。',
    authMode: 'credentials',
    credentials: [
      {
        key: 'clientId',
        label: 'AppKey（Client ID）',
        required: true,
        help: '企业内部应用的 Client ID，旧版控制台称为 AppKey。',
      },
      {
        key: 'clientSecret',
        label: 'AppSecret（Client Secret）',
        required: true,
        secret: true,
        help: '与 Client ID 属于同一个企业内部应用。',
      },
    ],
    setupGuide: {
      title: '先创建钉钉企业内部应用',
      steps: [
        '在钉钉开发者后台创建企业内部应用，并添加机器人能力。',
        '机器人消息接收模式选择 Stream 模式，无需填写公网回调地址。',
        '在应用凭证页复制 Client ID（AppKey）和 Client Secret（AppSecret）。',
      ],
      action: {
        label: '打开钉钉开发者后台',
        url: 'https://open-dev.dingtalk.com/fe/app',
      },
      nextStep:
        '连接成功后发布应用，将 Bot 添加到目标会话，再使用 /pair <配对码> 授权。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
  {
    value: 'discord',
    label: 'Discord',
    description: '使用 Discord Developer Portal 中的 Bot Token 接入。',
    authMode: 'bot_token',
    credentials: [
      {
        key: 'botToken',
        label: 'Discord Bot Token',
        required: true,
        secret: true,
        help: '在应用的“Bot”页面复制或重置；不是 Client Secret。',
      },
    ],
    setupGuide: {
      title: '先创建 Discord Bot',
      steps: [
        '在 Discord Developer Portal 创建 Application，然后在“Bot”页添加 Bot 并复制 Token。',
        '在“Privileged Gateway Intents”开启 Message Content Intent。',
        '在“Installation”或 OAuth2 生成安装链接，将 Bot 加入服务器并授予读取、发送消息及附件权限。',
      ],
      action: {
        label: '打开 Discord Developer Portal',
        url: 'https://discord.com/developers/applications',
      },
      nextStep:
        '连接成功后生成配对码，在 Bot 私聊或目标频道中发送 /pair <配对码>。',
    },
    supportsTest: true,
    supportsPairing: true,
  },
  {
    value: 'whatsapp',
    label: 'WhatsApp',
    description: '创建账号后使用 WhatsApp 扫码关联设备，无需填写账号标识。',
    authMode: 'qr_session',
    credentials: [],
    setupGuide: {
      title: '创建后关联 WhatsApp 设备',
      steps: [
        '填写账号名称，连接后再选择渠道会话的绑定目标。',
        '点击“创建并扫码”，等待 HappyClaw 生成关联设备二维码。',
        '在手机 WhatsApp 中打开“已关联设备”（iOS 在设置中，Android 在右上角菜单中），点击“关联设备”扫码。',
      ],
      nextStep:
        '设备关联只建立渠道账号；连接后还需要生成配对码，授权具体 WhatsApp 会话。',
    },
    supportsTest: false,
    supportsPairing: true,
  },
];

export function providerDefinition(provider: ChannelProvider) {
  return CHANNEL_PROVIDER_OPTIONS.find((item) => item.value === provider)!;
}

export function providerLabel(provider: ChannelProvider): string {
  return providerDefinition(provider)?.label ?? provider;
}

export function providerAuthMode(provider: ChannelProvider): ChannelAuthMode {
  return providerDefinition(provider)?.authMode ?? 'credentials';
}

export function supportsChannelConnectionTest(
  provider: ChannelProvider,
): boolean {
  return providerDefinition(provider)?.supportsTest ?? false;
}

export function supportsChannelPairing(provider: ChannelProvider): boolean {
  return providerDefinition(provider)?.supportsPairing ?? false;
}

export type WhatsAppStatusEvent = Partial<ChannelOnboardingState> & {
  status?: ChannelOnboardingState['status'];
};

/** Apply one account-scoped WhatsApp socket event without retaining stale QR
 * or online state after the transport has gone away. */
export function mergeWhatsAppOnboardingState(
  current: ChannelOnboardingState,
  event: WhatsAppStatusEvent,
): ChannelOnboardingState {
  const next: ChannelOnboardingState = { ...current, ...event };
  if (event.status !== 'qr') next.qrDataUrl = undefined;

  switch (event.status) {
    case 'qr':
      return {
        ...next,
        auth_status: 'awaiting_scan',
        transport_status: 'disconnected',
      };
    case 'connected':
      return {
        ...next,
        auth_status: 'authorized',
        transport_status: 'connected',
      };
    case 'connecting':
      return { ...next, transport_status: 'connecting' };
    case 'disconnected':
      return { ...next, transport_status: 'disconnected' };
    case 'logged_out':
      return {
        ...next,
        auth_status: 'revoked',
        transport_status: 'disconnected',
      };
    case 'error':
      return {
        ...next,
        auth_status:
          current.auth_status === 'authorized' ? 'authorized' : 'error',
        transport_status: 'error',
      };
    default:
      return next;
  }
}

export function normalizeCredentials(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0),
  );
}

export interface AccountFormValues {
  provider: ChannelProvider;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  defaultWorkspaceJid: string;
  credentials: Record<string, string>;
  replaceCredentials: boolean;
}

export function buildChannelAccountPayload(
  values: AccountFormValues,
  mode: 'create' | 'edit',
): ChannelAccountCreateInput | ChannelAccountPatchInput {
  const common = {
    name: values.name.trim(),
    enabled: values.enabled,
    is_default: values.isDefault,
    default_workspace_jid:
      values.defaultWorkspaceJid === 'none' ? null : values.defaultWorkspaceJid,
  };
  const credentials = normalizeCredentials(values.credentials);
  if (mode === 'create')
    return { ...common, provider: values.provider, credentials };
  return values.replaceCredentials ? { ...common, credentials } : common;
}

export function validateChannelAccountForm(
  values: AccountFormValues,
  mode: 'create' | 'edit',
) {
  if (!values.name.trim()) return '请输入账号名称';
  if (mode === 'edit' && !values.replaceCredentials) return null;
  const fields = providerDefinition(values.provider)?.credentials ?? [];
  const missing = fields.filter(
    (field) => field.required && !values.credentials[field.key]?.trim(),
  );
  return missing.length
    ? `请填写：${missing.map((field) => field.label).join('、')}`
    : null;
}

export interface AccountScopedChannel {
  channel_account_id?: string | null;
  channel_account_name?: string | null;
}

export function channelAccountKey(channel: AccountScopedChannel): string {
  return channel.channel_account_id || 'legacy-default';
}

export function buildChannelAccountFilterOptions(
  channels: AccountScopedChannel[],
) {
  const options = new Map<string, string>();
  for (const channel of channels) {
    const key = channelAccountKey(channel);
    if (!options.has(key)) {
      options.set(key, channel.channel_account_name || '默认账号（旧版）');
    }
  }
  return Array.from(options, ([id, name]) => ({ id, name }));
}
