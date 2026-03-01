// Zod schemas and validation types for API requests

import { z } from 'zod';
import { ALL_PERMISSIONS } from './permissions.js';
import type { Permission } from './types.js';
import { MAX_GROUP_NAME_LEN } from './web-context.js';

export const TaskPatchSchema = z.object({
  prompt: z.string().optional(),
  schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
  schedule_value: z.string().optional(),
  context_mode: z.enum(['group', 'isolated']).optional(),
  execution_type: z.enum(['agent', 'script']).optional(),
  script_command: z.string().max(4096).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
  next_run: z.string().optional(),
});

// 简单 cron 表达式验证：5 或 6 段，每段允许 * 和常见 cron 语法
const CRON_REGEX = /^(\S+\s+){4,5}\S+$/;

export const TaskCreateSchema = z.object({
  group_folder: z.string().min(1),
  chat_jid: z.string().min(1),
  prompt: z.string().optional().default(''),
  schedule_type: z.enum(['cron', 'interval', 'once']),
  schedule_value: z.string().min(1),
  context_mode: z.enum(['group', 'isolated']).optional(),
  execution_type: z.enum(['agent', 'script']).optional(),
  script_command: z.string().max(4096).optional(),
}).superRefine((data, ctx) => {
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
const MAX_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024 * 4 / 3; // ~6.67M chars

export const MessageAttachmentSchema = z.object({
  type: z.literal('image'),
  data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH),
  mimeType: z.string().regex(/^image\//).optional(),
});

export const MessageCreateSchema = z.object({
  chatJid: z.string().min(1),
  content: z.string().optional().default(''),
  attachments: z.array(MessageAttachmentSchema).max(10).optional(),
}).superRefine((data, ctx) => {
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
});

export const GroupPatchSchema = z.object({
  name: z.string().min(1).max(MAX_GROUP_NAME_LEN).optional(),
  selected_skills: z.array(z.string().max(128).regex(/^[\w\-]+$/, 'Skill ID must be alphanumeric with hyphens/underscores')).max(200).nullable().optional(),
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
  containerMaxOutputSize: z.number().int().min(1048576).max(104857600).optional(),
  maxConcurrentContainers: z.number().int().min(1).max(100).optional(),
  maxConcurrentHostProcesses: z.number().int().min(1).max(50).optional(),
  maxLoginAttempts: z.number().int().min(1).max(100).optional(),
  loginLockoutMinutes: z.number().int().min(1).max(1440).optional(),
  maxConcurrentScripts: z.number().int().min(1).max(50).optional(),
  scriptTimeout: z.number().int().min(5000).max(600000).optional(),
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
  avatar_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  ai_name: z.string().min(1).max(32).nullable().optional(),
  ai_avatar_emoji: z.string().max(8).nullable().optional(),
  ai_avatar_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  ai_avatar_url: z.string().max(2048)
    .refine(v => v.startsWith('/api/auth/avatars/'), 'Invalid avatar URL')
    .nullable().optional(),
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
        hasAnthropicAuthToken || hasAnthropicApiKey || hasClaudeCodeOauthToken || hasClaudeOAuthCredentials
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
  })
  .refine(
    (data) =>
      typeof data.appId === 'string' ||
      typeof data.appSecret === 'string' ||
      data.clearAppSecret === true ||
      typeof data.enabled === 'boolean',
    { message: 'At least one config field must be provided' },
  );

export const TelegramConfigSchema = z
  .object({
    botToken: z.string().max(2000).optional(),
    clearBotToken: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.botToken === 'string' ||
      data.clearBotToken === true ||
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

// Memory types
export interface MemorySource {
  path: string;
  label: string;
  scope: 'user-global' | 'main' | 'flow' | 'session';
  kind: 'claude' | 'note' | 'session';
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
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
