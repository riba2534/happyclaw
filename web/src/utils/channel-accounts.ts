import type {
  ChannelAccount,
  ChannelOnboardingState,
  ChannelAccountCreateInput,
  ChannelAccountPatchInput,
  ChannelProvider,
  FeishuBrand,
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

/** One required event or permission, and what breaks without it. */
export interface ChannelSetupChecklistItem {
  name: string;
  label: string;
  effect: string;
}

export interface ChannelSetupGuide {
  title: string;
  steps: string[];
  checklists?: Array<{ title: string; items: ChannelSetupChecklistItem[] }>;
  action?: {
    label: string;
    url: string;
  };
  nextStep: string;
}

/** Events HappyClaw handles over the Feishu long connection. */
export const FEISHU_EVENT_SUBSCRIPTIONS: ChannelSetupChecklistItem[] = [
  {
    name: 'im.message.receive_v1',
    label: '接收消息',
    effect: '必需；缺失时 Bot 收不到任何消息。',
  },
  {
    name: 'card.action.trigger',
    label: '卡片回传交互（在“回调配置”中订阅）',
    effect: '缺失时卡片上的停止、排队消息处理和问答按钮点了没有反应。',
  },
  {
    name: 'im.message.recalled_v1',
    label: '撤回消息',
    effect: '缺失时撤回的消息仍会被执行，正在运行的任务也不会因撤回而停止。',
  },
  {
    name: 'im.chat.member.bot.added_v1',
    label: '机器人进群',
    effect: '缺失时把 Bot 拉进群后，HappyClaw 不会自动登记这个群。',
  },
  {
    name: 'im.chat.member.bot.deleted_v1',
    label: '机器人被移出群',
    effect: '缺失时 Bot 被移出后，该群的绑定不会自动清理。',
  },
  {
    name: 'im.chat.disbanded_v1',
    label: '群解散',
    effect: '缺失时群解散后，该群的绑定不会自动清理。',
  },
];

/** Scopes behind the calls HappyClaw makes; optional ones are marked. */
export const FEISHU_PERMISSIONS: ChannelSetupChecklistItem[] = [
  {
    name: 'im:message',
    label: '获取与发送单聊、群组消息',
    effect: '必需；用于回复、编辑与撤回 Bot 自己的消息和读取引用的消息。',
  },
  {
    name: 'im:message.p2p_msg:readonly',
    label: '读取用户发给机器人的单聊消息',
    effect: '必需；缺失时私聊收不到消息。',
  },
  {
    name: 'im:message.group_at_msg:readonly',
    label: '接收群聊中 @ 机器人的消息',
    effect: '必需；缺失时群里 @Bot 没有反应。',
  },
  {
    name: 'im:message:send_as_bot',
    label: '以应用的身份发消息',
    effect: '必需；缺失时 Bot 无法回复。',
  },
  {
    name: 'im:resource',
    label: '获取与上传图片或文件资源',
    effect: '缺失时收不到图片和文件，也发不出图片和文件。',
  },
  {
    name: 'cardkit:card:write',
    label: '创建与更新卡片',
    effect: '缺失时回复无法以卡片流式更新。',
  },
  {
    name: 'im:chat:readonly',
    label: '获取群组信息',
    effect: '缺失时读不到群名和群类型，群类型无法确定时绑定会被拒绝。',
  },
  {
    name: 'im:message.reactions:write_only',
    label: '发送、删除消息表情回复',
    effect: '缺失时不会在正在处理的消息上显示表情。',
  },
  {
    name: 'im:message.group_msg',
    label: '获取群组中所有消息（可选，敏感权限）',
    effect: '普通群设为“无需 @”时需要；否则只能收到 @Bot 的消息。',
  },
  {
    name: 'im:chat.members:read',
    label: '查看群成员（可选）',
    effect: '缺失时群消息的发送人可能显示为 open_id。',
  },
  {
    name: 'contact:user.base:readonly',
    label: '获取用户基本信息（可选）',
    effect: '缺失时群外成员的发送人显示为 open_id。',
  },
];

export const FEISHU_BRAND_OPTIONS: Array<{
  value: FeishuBrand;
  label: string;
}> = [
  { value: 'feishu', label: '飞书' },
  { value: 'lark', label: 'Lark（国际版）' },
];

/** Developer console home of the brand, where apps are created. */
export function feishuDeveloperConsoleUrl(brand: FeishuBrand): string {
  return brand === 'lark'
    ? 'https://open.larksuite.com/app'
    : 'https://open.feishu.cn/app';
}

/** Anything but an explicit 'lark' is the Feishu brand (the default). */
export function feishuBrandOf(domain: string | undefined): FeishuBrand {
  return domain === 'lark' ? 'lark' : 'feishu';
}

export function feishuBrandName(brand: FeishuBrand): string {
  return brand === 'lark' ? 'Lark' : '飞书';
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
    description:
      '通过飞书或 Lark 自建应用接收消息，Owner 会在首次私聊时自动识别。',
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
        '在飞书开放平台（Lark 在 open.larksuite.com）创建企业自建应用，并启用“机器人”能力。',
        '在“凭证与基础信息”复制 App ID 和 App Secret。',
        '在“事件与回调”中选择长连接接收，订阅下列事件；卡片回传交互在“回调配置”中订阅。',
        '在“权限管理”开通下列权限，然后创建版本并发布应用。',
      ],
      checklists: [
        {
          title: '需要订阅的事件（长连接）',
          items: FEISHU_EVENT_SUBSCRIPTIONS,
        },
        { title: '需要开通的权限', items: FEISHU_PERMISSIONS },
      ],
      action: {
        label: '打开飞书开放平台',
        url: feishuDeveloperConsoleUrl('feishu'),
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

/** Provider name of one account; a Lark account is not called "飞书". */
export function channelAccountLabel(account: ChannelAccount): string {
  return account.provider === 'feishu'
    ? feishuBrandName(feishuBrandOf(account.options?.domain))
    : providerLabel(account.provider);
}

export function feishuSetupGuide(brand: FeishuBrand): ChannelSetupGuide {
  const guide = providerDefinition('feishu').setupGuide;
  return brand === 'lark'
    ? {
        ...guide,
        title: '先创建 Lark 企业自建应用',
        action: {
          label: '打开 Lark 开放平台',
          url: feishuDeveloperConsoleUrl('lark'),
        },
      }
    : guide;
}

/** Joins copy fragments, spacing a Latin provider name from adjacent CJK text. */
export function spacedLabel(...parts: string[]) {
  return parts.reduce((text, part) =>
    /[A-Za-z0-9]$/.test(text) || /^[A-Za-z0-9]/.test(part)
      ? `${text} ${part}`
      : text + part,
  );
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

/**
 * A paired direct chat's sender is recorded as the account owner: in the bot
 * they are you, on every workspace (docs/ACL-MATRIX.md, Owner Claim).
 */
export const PAIRING_OWNER_RISK_NOTE =
  '用私聊配对后，对方在机器人里等同于你本人，可以查看和切换到你的全部工作区（包括宿主机工作区）。只给你自己的账号配对。';

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
