// Zod schemas and validation types for API requests

import { z } from 'zod';
import { ALL_PERMISSIONS } from './permissions.js';
import type { Permission } from './types.js';
import { MAX_GROUP_NAME_LEN } from './web-context.js';

export const TaskPatchSchema = z.object({
  chat_jid: z.string().min(1).optional(),
  prompt: z.string().optional(),
  schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
  schedule_value: z.string().optional(),
  context_mode: z.enum(['group', 'isolated']).optional(),
  execution_type: z.enum(['agent', 'script']).optional(),
  execution_mode: z.enum(['host', 'container']).optional(),
  script_command: z.string().max(4096).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  next_run: z.string().optional(),
  notify_channels: z
    .array(z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord']))
    .nullable()
    .optional(),
});

// Cron 表达式校验：5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）
// 也允许预定义表达式如 @daily, @hourly 等
const CRON_REGEX =
  /^(@(yearly|annually|monthly|weekly|daily|hourly|minutely|secondly)|(\S+\s+){4,5}\S+)$/;

export const TaskCreateSchema = z
  .object({
    group_folder: z.string().min(1).optional(),
    chat_jid: z.string().min(1).optional(),
    prompt: z.string().optional().default(''),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string().min(1),
    context_mode: z.enum(['group', 'isolated']).optional(),
    execution_type: z.enum(['agent', 'script']).optional(),
    execution_mode: z.enum(['host', 'container']).optional(),
    script_command: z.string().max(4096).optional(),
    notify_channels: z
      .array(z.enum(['feishu', 'telegram', 'qq', 'wechat', 'dingtalk', 'discord']))
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    const execType = data.execution_type || 'agent';
    if (execType === 'agent' && !data.prompt?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: 'Agent 模式下 prompt 为必填项',
      });
    }
    if (execType === 'script' && !data.script_command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['script_command'],
        message: '脚本模式下 script_command 为必填项',
      });
    }
    if (data.schedule_type === 'cron') {
      if (!CRON_REGEX.test(data.schedule_value.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Invalid cron expression (expected 5 or 6 fields)',
        });
      }
    } else if (data.schedule_type === 'interval') {
      const num = Number(data.schedule_value);
      if (!Number.isFinite(num) || num <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Interval must be a positive number (milliseconds)',
        });
      }
    } else if (data.schedule_type === 'once') {
      const ts = Date.parse(data.schedule_value);
      if (isNaN(ts)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Once schedule must be a valid ISO 8601 date string',
        });
      }
    }
  });

// 单张图片附件上限 5MB（base64 编码后约 6.67MB）
const MAX_IMAGE_BASE64_LENGTH = (5 * 1024 * 1024 * 4) / 3; // ~6.67M chars

export const MessageAttachmentSchema = z.object({
  type: z.literal('image'),
  data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH),
  mimeType: z
    .string()
    .regex(/^image\//)
    .optional(),
});

export const MessageCreateSchema = z
  .object({
    chatJid: z.string().min(1),
    content: z.string().optional().default(''),
    attachments: z.array(MessageAttachmentSchema).max(10).optional(),
  })
  .superRefine((data, ctx) => {
    const hasContent = data.content.trim().length > 0;
    const hasAttachments = (data.attachments?.length ?? 0) > 0;
    if (!hasContent && !hasAttachments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'content or attachments is required',
      });
    }
  });

export const GroupCreateSchema = z.object({
  name: z.string().min(1).max(MAX_GROUP_NAME_LEN),
  execution_mode: z.enum(['container', 'host']).optional(),
  custom_cwd: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  init_source_path: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  init_git_url: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
});

export const GroupMemberAddSchema = z.object({
  user_id: z.string().min(1),
});

export const MemoryFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const MemoryGlobalSchema = z.object({
  content: z.string(),
});

export const ClaudeConfigSchema = z.object({
  anthropicBaseUrl: z.string(),
  anthropicModel: z.string().max(128).optional(),
});

export const ClaudeThirdPartyProfileCreateSchema = z.object({
  name: z.string().min(1).max(64),
  anthropicBaseUrl: z.string().max(2000),
  anthropicAuthToken: z.string().max(2000),
  anthropicModel: z.string().max(128).optional(),
  customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
});

export const ClaudeThirdPartyProfilePatchSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    anthropicBaseUrl: z.string().max(2000).optional(),
    anthropicModel: z.string().max(128).optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
  })
  .refine(
    (data) =>
      typeof data.name === 'string' ||
      typeof data.anthropicBaseUrl === 'string' ||
      typeof data.anthropicModel === 'string' ||
      data.customEnv !== undefined,
    { message: 'At least one profile field must be provided' },
  );

export const ClaudeThirdPartyProfileSecretsSchema = z
  .object({
    anthropicAuthToken: z.string().max(2000).optional(),
    clearAnthropicAuthToken: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.anthropicAuthToken === 'string' ||
      data.clearAnthropicAuthToken === true,
    { message: 'At least one secret field must be provided' },
  );

export const GroupPatchSchema = z.object({
  name: z.string().min(1).max(MAX_GROUP_NAME_LEN).optional(),
  is_pinned: z.boolean().optional(),
  activation_mode: z
    .enum(['auto', 'always', 'when_mentioned', 'owner_mentioned', 'disabled'])
    .optional(),
  execution_mode: z.enum(['container', 'host']).optional(),
});

export const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const RegisterSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
  display_name: z.string().max(64).optional(),
  invite_code: z.string().min(1).optional(),
});

export const RegistrationConfigSchema = z.object({
  allowRegistration: z.boolean(),
  requireInviteCode: z.boolean(),
});

export const SystemSettingsSchema = z.object({
  containerTimeout: z.number().int().min(60000).max(86400000).optional(),
  idleTimeout: z.number().int().min(60000).max(86400000).optional(),
  containerMaxOutputSize: z
    .number()
    .int()
    .min(1048576)
    .max(104857600)
    .optional(),
  maxConcurrentContainers: z.number().int().min(1).max(100).optional(),
  maxConcurrentHostProcesses: z.number().int().min(1).max(50).optional(),
  maxLoginAttempts: z.number().int().min(1).max(100).optional(),
  loginLockoutMinutes: z.number().int().min(1).max(1440).optional(),
  maxConcurrentScripts: z.number().int().min(1).max(50).optional(),
  scriptTimeout: z.number().int().min(5000).max(600000).optional(),
  billingEnabled: z.boolean().optional(),
  billingMode: z.literal('wallet_first').optional(),
  billingMinStartBalanceUsd: z.number().min(0).max(1000000).optional(),
  billingCurrency: z.string().min(1).max(10).optional(),
  billingCurrencyRate: z.number().min(0.0001).max(1000000).optional(),
  externalClaudeDir: z.string().max(512).optional(),
  autoCompactWindow: z
    .number()
    .int()
    .refine(
      (v) => v === 0 || (v >= 10000 && v <= 2000000),
      'autoCompactWindow must be 0 (disabled) or between 10000 and 2000000',
    )
    .optional(),
  disableMemoryLayerForAdminHost: z.boolean().optional(),
  pluginAutoScan: z.boolean().optional(),
  taskBackfillGraceMs: z
    .number()
    .int()
    .refine(
      (v) => v === 0 || (v >= 1000 && v <= 86400000),
      'taskBackfillGraceMs must be 0 (disabled) or between 1000 (1s) and 86400000 (24h)',
    )
    .optional(),
});

export const AppearanceConfigSchema = z.object({
  appName: z.string().max(32).optional(),
  aiName: z.string().min(1).max(32),
  aiAvatarEmoji: z.string().min(1).max(8),
  aiAvatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const ChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

export const ProfileUpdateSchema = z.object({
  username: z.string().min(3).max(32).optional(),
  display_name: z.string().max(64).optional(),
  avatar_emoji: z.string().max(8).nullable().optional(),
  avatar_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  avatar_url: z
    .string()
    .max(2048)
    .refine((v) => v.startsWith('/api/auth/avatars/'), 'Invalid avatar URL')
    .nullable()
    .optional(),
  ai_name: z.string().min(1).max(32).nullable().optional(),
  ai_avatar_emoji: z.string().max(8).nullable().optional(),
  ai_avatar_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  ai_avatar_url: z
    .string()
    .max(2048)
    .refine((v) => v.startsWith('/api/auth/avatars/'), 'Invalid avatar URL')
    .nullable()
    .optional(),
});

export const PermissionValueSchema = z
  .string()
  .refine(
    (value): value is Permission =>
      (ALL_PERMISSIONS as string[]).includes(value),
    {
      message: 'Invalid permission',
    },
  );

export const AdminCreateUserSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
  display_name: z.string().max(64).optional(),
  role: z.enum(['admin', 'member']).optional(),
  permissions: z
    .array(PermissionValueSchema)
    .max(ALL_PERMISSIONS.length)
    .optional(),
  must_change_password: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

export const AdminPatchUserSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  status: z.enum(['active', 'disabled', 'deleted']).optional(),
  display_name: z.string().max(64).optional(),
  password: z.string().min(8).max(128).optional(),
  permissions: z
    .array(PermissionValueSchema)
    .max(ALL_PERMISSIONS.length)
    .optional(),
  disable_reason: z.string().max(256).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const InviteCreateSchema = z.object({
  role: z.enum(['admin', 'member']).optional(),
  permission_template: z
    .enum(['admin_full', 'member_basic', 'ops_manager', 'user_admin'])
    .optional(),
  permissions: z
    .array(PermissionValueSchema)
    .max(ALL_PERMISSIONS.length)
    .optional(),
  max_uses: z.number().int().min(0).max(1000).optional(),
  expires_in_hours: z.number().int().min(1).max(8760).optional(),
});

export const ClaudeOAuthCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  scopes: z.array(z.string()).default([]),
  subscriptionType: z.string().optional(),
});

export const ClaudeSecretsSchema = z
  .object({
    anthropicAuthToken: z.string().optional(),
    clearAnthropicAuthToken: z.boolean().optional(),
    anthropicApiKey: z.string().optional(),
    clearAnthropicApiKey: z.boolean().optional(),
    claudeCodeOauthToken: z.string().optional(),
    clearClaudeCodeOauthToken: z.boolean().optional(),
    claudeOAuthCredentials: ClaudeOAuthCredentialsSchema.optional(),
    clearClaudeOAuthCredentials: z.boolean().optional(),
  })
  .refine(
    (data) => {
      const hasAnthropicAuthToken =
        typeof data.anthropicAuthToken === 'string' ||
        data.clearAnthropicAuthToken === true;
      const hasAnthropicApiKey =
        typeof data.anthropicApiKey === 'string' ||
        data.clearAnthropicApiKey === true;
      const hasClaudeCodeOauthToken =
        typeof data.claudeCodeOauthToken === 'string' ||
        data.clearClaudeCodeOauthToken === true;
      const hasClaudeOAuthCredentials =
        data.claudeOAuthCredentials !== undefined ||
        data.clearClaudeOAuthCredentials === true;
      return (
        hasAnthropicAuthToken ||
        hasAnthropicApiKey ||
        hasClaudeCodeOauthToken ||
        hasClaudeOAuthCredentials
      );
    },
    { message: 'At least one secret field must be provided' },
  );

export const FeishuConfigSchema = z
  .object({
    appId: z.string().max(2000).optional(),
    appSecret: z.string().max(2000).optional(),
    clearAppSecret: z.boolean().optional(),
    enabled: z.boolean().optional(),
    autoIsolateContext: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.appId === 'string' ||
      typeof data.appSecret === 'string' ||
      data.clearAppSecret === true ||
      typeof data.enabled === 'boolean' ||
      typeof data.autoIsolateContext === 'boolean',
    { message: 'At least one config field must be provided' },
  );

export const TelegramConfigSchema = z
  .object({
    botToken: z.string().max(2000).optional(),
    clearBotToken: z.boolean().optional(),
    proxyUrl: z.string().max(2000).optional(),
    clearProxyUrl: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.botToken === 'string' ||
      data.clearBotToken === true ||
      typeof data.proxyUrl === 'string' ||
      data.clearProxyUrl === true ||
      typeof data.enabled === 'boolean',
    { message: 'At least one config field must be provided' },
  );

export const QQConfigSchema = z
  .object({
    appId: z.string().max(2000).optional(),
    appSecret: z.string().max(2000).optional(),
    clearAppSecret: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.appId === 'string' ||
      typeof data.appSecret === 'string' ||
      data.clearAppSecret === true ||
      typeof data.enabled === 'boolean',
    { message: 'At least one config field must be provided' },
  );

export const ClaudeCustomEnvSchema = z.object({
  customEnv: z.record(z.string().max(256), z.string().max(4096)),
});

export const ContainerEnvSchema = z.object({
  anthropicBaseUrl: z.string().max(2000).optional(),
  anthropicAuthToken: z.string().max(2000).optional(),
  anthropicApiKey: z.string().max(2000).optional(),
  claudeCodeOauthToken: z.string().max(2000).optional(),
  anthropicModel: z.string().max(128).optional(),
  customEnv: z
    .record(z.string().max(256), z.string().max(4096))
    .optional()
    .refine((env) => !env || Object.keys(env).length <= 50, {
      message: 'customEnv must have at most 50 entries',
    }),
});

// Terminal WebSocket message schemas
export const TerminalStartSchema = z.object({
  chatJid: z.string().min(1),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});

export const TerminalInputSchema = z.object({
  chatJid: z.string().min(1),
  data: z.string().min(1).max(8192),
});

export const TerminalResizeSchema = z.object({
  chatJid: z.string().min(1),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
});

export const TerminalStopSchema = z.object({
  chatJid: z.string().min(1),
});

// --- Billing schemas ---

export const BillingPlanCreateSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w-]+$/, 'ID must be alphanumeric with hyphens/underscores'),
  name: z.string().min(1).max(64),
  description: z.string().max(500).nullable().optional(),
  tier: z.number().int().min(0).max(100).optional(),
  monthly_cost_usd: z.number().min(0).optional(),
  monthly_token_quota: z.number().int().min(0).nullable().optional(),
  monthly_cost_quota: z.number().min(0).nullable().optional(),
  daily_cost_quota: z.number().min(0).nullable().optional(),
  weekly_cost_quota: z.number().min(0).nullable().optional(),
  daily_token_quota: z.number().int().min(0).nullable().optional(),
  weekly_token_quota: z.number().int().min(0).nullable().optional(),
  rate_multiplier: z.number().min(0.01).max(100).optional(),
  trial_days: z.number().int().min(1).max(365).nullable().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
  display_price: z.string().max(64).nullable().optional(),
  highlight: z.boolean().optional(),
  max_groups: z.number().int().min(0).nullable().optional(),
  max_concurrent_containers: z.number().int().min(0).nullable().optional(),
  max_im_channels: z.number().int().min(0).nullable().optional(),
  max_mcp_servers: z.number().int().min(0).nullable().optional(),
  max_storage_mb: z.number().int().min(0).nullable().optional(),
  allow_overage: z.boolean().optional(),
  features: z.array(z.string().max(64)).max(50).optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

export const BillingPlanPatchSchema = BillingPlanCreateSchema.omit({
  id: true,
}).partial();

export const AssignPlanSchema = z.object({
  plan_id: z.string().min(1),
  duration_days: z.number().int().min(1).max(3650).optional(),
});

export const AdjustBalanceSchema = z.object({
  amount_usd: z.number().refine((v) => v !== 0, 'Amount cannot be zero'),
  description: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(64).optional(),
});

export const BatchAssignPlanSchema = z.object({
  user_ids: z.array(z.string().min(1)).min(1).max(100),
  plan_id: z.string().min(1),
  duration_days: z.number().int().min(1).max(3650).optional(),
});

export const RedeemCodeCreateSchema = z
  .object({
    type: z.enum(['balance', 'subscription', 'trial']),
    value_usd: z.number().min(0.01).optional(),
    plan_id: z.string().min(1).optional(),
    duration_days: z.number().int().min(1).max(3650).optional(),
    max_uses: z.number().int().min(1).max(10000).optional(),
    count: z.number().int().min(1).max(100).optional(), // 批量生成数量
    prefix: z
      .string()
      .max(16)
      .regex(/^[\w-]*$/)
      .optional(), // 兑换码前缀
    expires_in_hours: z.number().int().min(1).max(87600).optional(),
    notes: z.string().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'balance' && (!data.value_usd || data.value_usd <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value_usd'],
        message: 'Balance type requires a positive value_usd',
      });
    }
    if (data.type === 'subscription' && !data.plan_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plan_id'],
        message: 'Subscription type requires a plan_id',
      });
    }
    if (
      data.type === 'trial' &&
      (!data.duration_days || data.duration_days <= 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duration_days'],
        message: 'Trial type requires a positive duration_days',
      });
    }
  });

export const RedeemCodeSchema = z.object({
  code: z.string().min(1).max(64),
});

// Memory types
export type MemoryType =
  | 'global'
  | 'session'
  | 'date'
  | 'conversation';

export interface MemorySource {
  path: string;
  label: string;
  type: MemoryType;
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
  folder?: string;
}

export interface MemoryFilePayload {
  path: string;
  content: string;
  updatedAt: string | null;
  size: number;
  writable: boolean;
}

export interface MemorySearchHit extends MemorySource {
  hits: number;
  snippet: string;
}

// --- Bug Report schemas ---

// 单张截图上限 5MB（base64 编码后约 6.67MB）
const MAX_SCREENSHOT_BASE64_LENGTH = (5 * 1024 * 1024 * 4) / 3;

export const BugReportGenerateSchema = z.object({
  description: z.string().min(1).max(5000),
  screenshots: z
    .array(z.string().max(MAX_SCREENSHOT_BASE64_LENGTH))
    .max(3)
    .optional(),
});

export const BugReportSubmitSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65536),
});

// ─── 统一供应商 (V4) ────────────────────────────────────────

export const UnifiedProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: z.enum(['official', 'third_party']),
    anthropicBaseUrl: z.string().max(2000).optional(),
    anthropicAuthToken: z.string().max(2000).optional(),
    anthropicModel: z.string().max(128).optional(),
    anthropicApiKey: z.string().max(2000).optional(),
    claudeCodeOauthToken: z.string().max(2000).optional(),
    claudeOAuthCredentials: ClaudeOAuthCredentialsSchema.optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
    weight: z.number().int().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.type === 'third_party' &&
      !data.anthropicBaseUrl?.trim() &&
      !data.anthropicAuthToken?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anthropicBaseUrl'],
        message: '第三方供应商需要提供 Base URL 或 Auth Token',
      });
    }
  });

export const UnifiedProviderPatchSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    anthropicBaseUrl: z.string().max(2000).optional(),
    anthropicModel: z.string().max(128).optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
    weight: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.anthropicBaseUrl !== undefined ||
      data.anthropicModel !== undefined ||
      data.customEnv !== undefined ||
      data.weight !== undefined,
    { message: 'At least one field must be provided' },
  );

export const UnifiedProviderSecretsSchema = z
  .object({
    anthropicAuthToken: z.string().max(2000).optional(),
    clearAnthropicAuthToken: z.boolean().optional(),
    anthropicApiKey: z.string().max(2000).optional(),
    clearAnthropicApiKey: z.boolean().optional(),
    claudeCodeOauthToken: z.string().max(2000).optional(),
    clearClaudeCodeOauthToken: z.boolean().optional(),
    claudeOAuthCredentials: ClaudeOAuthCredentialsSchema.optional(),
    clearClaudeOAuthCredentials: z.boolean().optional(),
  })
  .refine(
    (data) => {
      return (
        typeof data.anthropicAuthToken === 'string' ||
        data.clearAnthropicAuthToken === true ||
        typeof data.anthropicApiKey === 'string' ||
        data.clearAnthropicApiKey === true ||
        typeof data.claudeCodeOauthToken === 'string' ||
        data.clearClaudeCodeOauthToken === true ||
        data.claudeOAuthCredentials !== undefined ||
        data.clearClaudeOAuthCredentials === true
      );
    },
    { message: 'At least one secret field must be provided' },
  );

export const BalancingConfigSchema = z.object({
  strategy: z
    .enum(['round-robin', 'weighted-round-robin', 'failover'])
    .optional(),
  unhealthyThreshold: z.number().int().min(1).max(20).optional(),
  recoveryIntervalMs: z.number().int().min(30000).max(3600000).optional(),
});

export const WeChatConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clearBotToken: z.boolean().optional(),
  bypassProxy: z.boolean().optional(),
});

export const DingTalkConfigSchema = z
  .object({
    clientId: z.string().max(2000).optional(),
    clientSecret: z.string().max(2000).optional(),
    clearClientSecret: z.boolean().optional(),
    enabled: z.boolean().optional(),
    streamingMode: z.enum(['card', 'text']).optional(),
  })
  .refine(
    (data) =>
      typeof data.clientId === 'string' ||
      typeof data.clientSecret === 'string' ||
      data.clearClientSecret === true ||
      typeof data.enabled === 'boolean' ||
      typeof data.streamingMode === 'string',
    { message: 'At least one config field must be provided' },
  );

export const DiscordConfigSchema = z
  .object({
    botToken: z.string().max(2000).optional(),
    clearBotToken: z.boolean().optional(),
    enabled: z.boolean().optional(),
    streamingMode: z.enum(['edit', 'off']).optional(),
  })
  .refine(
    (data) =>
      typeof data.botToken === 'string' ||
      data.clearBotToken === true ||
      typeof data.enabled === 'boolean' ||
      typeof data.streamingMode === 'string',
    { message: 'At least one config field must be provided' },
  );

export const WhatsAppConfigSchema = z
  .object({
    accountId: z.string().max(64).optional(),
    phoneNumber: z.string().max(32).optional(),
    enabled: z.boolean().optional(),
    /** 标记 Baileys 扫码完成 — 由后续 PR 在登录回调中写入，前端不应直接发 true */
    paired: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.accountId === 'string' ||
      typeof data.phoneNumber === 'string' ||
      typeof data.enabled === 'boolean' ||
      typeof data.paired === 'boolean',
    { message: 'At least one config field must be provided' },
  );
