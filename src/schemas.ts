// Zod schemas and validation types for API requests

import { z } from 'zod';
import { AGENT_EFFORT_LEVELS } from './agent-effort.js';
import { ALL_PERMISSIONS } from './permissions.js';
import type { Permission } from './types.js';
import { MAX_GROUP_NAME_LEN } from './web-context.js';

export const ChannelProviderSchema = z.enum([
  'feishu',
  'telegram',
  'qq',
  'wechat',
  'wecom',
  'dingtalk',
  'discord',
  'whatsapp',
]);

const ChannelCredentialsSchema = z
  .record(z.string(), z.string().max(8192))
  .refine(
    (value) => Object.keys(value).length <= 16,
    'Too many credential fields',
  );

export const ChannelAccountCreateSchema = z.object({
  provider: ChannelProviderSchema,
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().optional().default(true),
  is_default: z.boolean().optional().default(false),
  default_workspace_jid: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .nullable()
    .optional(),
  credentials: ChannelCredentialsSchema.optional().default({}),
});

export const ChannelAccountPatchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
  default_workspace_jid: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .nullable()
    .optional(),
  credentials: ChannelCredentialsSchema.optional(),
});

/**
 * A schedule's prompt is replayed on a timer, so it is stored content with no
 * natural bound.
 *
 * Exported because the REST schemas are not the only writers: the MCP/IPC
 * `schedule_task` and `update_task` handlers call createTask/updateTask
 * directly. The Agent path is the one this cap exists for, so it must use the
 * same number rather than leave the hole open.
 */
export const MAX_TASK_PROMPT_LENGTH = 16384;

/** Same reasoning as MAX_TASK_PROMPT_LENGTH, for script tasks. */
export const MAX_TASK_SCRIPT_COMMAND_LENGTH = 4096;

export const TaskPatchSchema = z.object({
  chat_jid: z.string().min(1).optional(),
  // Same bound as TaskCreateSchema; an update must not be a way around it.
  prompt: z.string().max(MAX_TASK_PROMPT_LENGTH).optional(),
  schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
  schedule_value: z.string().optional(),
  context_mode: z.enum(['group', 'isolated']).optional(),
  execution_type: z.enum(['agent', 'script']).optional(),
  execution_mode: z.enum(['host', 'container']).optional(),
  script_command: z
    .string()
    .max(MAX_TASK_SCRIPT_COMMAND_LENGTH)
    .nullable()
    .optional(),
  status: z.enum(['active', 'paused']).optional(),
  // next_run 必须是可解析的 ISO 日期。schedule_value 在 PATCH 路由里随
  // schedule_type 决定语义（cron/interval/once 各有要求），路由层会单独检查。
  // 这里只兜底 next_run 的格式，避免 garbage-in 让 scheduler computeNextRun 抛
  // RangeError 把任务永久卡死在 runningTaskIds（高危 bug 修复）。
  next_run: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), 'next_run must be ISO 8601')
    .optional(),
  notify_channels: z
    .array(
      z.enum([
        'feishu',
        'telegram',
        'qq',
        'wechat',
        'wecom',
        'dingtalk',
        'discord',
        'whatsapp',
      ]),
    )
    .nullable()
    .optional(),
});

export const TaskPurgeSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(128),
        expected_revision: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(500),
});

// Cron 表达式校验：5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）
// 也允许预定义表达式如 @daily, @hourly 等
const CRON_REGEX =
  /^(@(yearly|annually|monthly|weekly|daily|hourly|minutely|secondly)|(\S+\s+){4,5}\S+)$/;

// interval 调度上限：1 年毫秒数。再大就接近 JS Date 的安全范围边界，
// `new Date(Date.now() + ms).toISOString()` 会抛 RangeError。1 年内任何场景
// 都该用 cron 而不是 interval，所以这是合理的硬上限。
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

// JS Date 安全上限（约 8.64e15ms after 1970）。once 任务给 100 年余量足够。
const MAX_ONCE_TIMESTAMP_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export const TaskCreateSchema = z
  .object({
    group_folder: z.string().min(1).optional(),
    chat_jid: z.string().min(1).optional(),
    // See MAX_TASK_PROMPT_LENGTH: the same bound applies on every writer.
    prompt: z.string().max(MAX_TASK_PROMPT_LENGTH).optional().default(''),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string().min(1),
    context_mode: z.enum(['group', 'isolated']).optional(),
    execution_type: z.enum(['agent', 'script']).optional(),
    execution_mode: z.enum(['host', 'container']).optional(),
    script_command: z.string().max(MAX_TASK_SCRIPT_COMMAND_LENGTH).optional(),
    notify_channels: z
      .array(
        z.enum([
          'feishu',
          'telegram',
          'qq',
          'wechat',
          'wecom',
          'dingtalk',
          'discord',
          'whatsapp',
        ]),
      )
      .nullable()
      .optional(),
  })
  .superRefine((data, ctx) => {
    const execType = data.execution_type || 'agent';
    if (execType === 'agent' && !data.prompt?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: '智能体模式下 prompt 为必填项',
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
      if (!Number.isFinite(num) || num < MIN_INTERVAL_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Interval must be at least 60000 milliseconds',
        });
      } else if (num > MAX_INTERVAL_MS) {
        // 防止 `new Date(Date.now() + ms).toISOString()` 抛 RangeError 让请求 500
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: `Interval exceeds maximum (${MAX_INTERVAL_MS} ms = 1 year). Use cron for longer schedules.`,
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
      } else if (Math.abs(ts) > MAX_ONCE_TIMESTAMP_MS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['schedule_value'],
          message: 'Once schedule out of representable range',
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
    // 实际 image MIME 都是 image/png, image/jpeg, image/svg+xml 这种 ≤30 字符；
    // 加 cap 防止 mimeType: 'image/' + 'a'.repeat(N) 配合 attachments.max(10)
    // 做请求体放大攻击。
    .max(128)
    .optional(),
});

// 单条消息文本上限 64 KB：覆盖正常超长粘贴 / 长 prompt（远超普通 IM 的 4-5KB
// 限制），但又远低于 WS frame 上限和 attachments 上限，配合 ws maxPayload 8MiB
// 防止认证 DoS（详见 src/web.ts setupWebSocket 注释）。
const MAX_MESSAGE_CONTENT_LENGTH = 64 * 1024;

export const MessageCreateSchema = z
  .object({
    chatJid: z.string().min(1).max(512),
    agentId: z.string().uuid().optional(),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH).optional().default(''),
    attachments: z.array(MessageAttachmentSchema).max(10).optional(),
    followUpBehavior: z.enum(['queue', 'steer']).optional().default('queue'),
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

const InteractionModeSchema = z
  .enum(['assistant', 'proactive', 'persona'])
  .transform((mode) => (mode === 'persona' ? 'proactive' : mode));

export const AdditionalMountCreateSchema = z
  .object({
    host_path: z.string().trim().min(1).max(4096),
    container_path: z.string().trim().min(1).max(512),
    readonly: z.boolean().optional().default(true),
  })
  .strict();

export const GroupCreateSchema = z.object({
  name: z.string().min(1).max(MAX_GROUP_NAME_LEN),
  agent_profile_id: z
    .string()
    .optional()
    .transform((val) => (val && val.trim() ? val.trim() : undefined)),
  execution_mode: z.enum(['container', 'host']).optional(),
  interaction_mode: InteractionModeSchema.optional(),
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
  additional_mounts: z.array(AdditionalMountCreateSchema).max(8).optional(),
});

export const GroupAgentProfilePatchSchema = z.object({
  agent_profile_id: z.string().trim().min(1),
});

const AgentProfileRuntimePolicyModeSchema = z.enum([
  'inherit',
  'custom',
  'disabled',
]);

export const AgentProfileRuntimePolicySchema = z
  .object({
    reasoning: z
      .object({
        effort: z.enum(AGENT_EFFORT_LEVELS).optional(),
      })
      .optional(),
    context: z
      .object({
        source: z.enum(['managed', 'host_claude']).optional(),
        auto_compact_window: z
          .number()
          .int()
          .refine(
            (value) => value === 0 || (value >= 100000 && value <= 1000000),
            'auto_compact_window must be 0 or between 100000 and 1000000',
          )
          .optional(),
        auto_compact_percentage: z
          .number()
          .int()
          .refine(
            (value) => value === 0 || (value >= 50 && value <= 90),
            'auto_compact_percentage must be 0 or between 50 and 90',
          )
          .optional(),
      })
      .optional(),
    skills: z
      .object({
        mode: AgentProfileRuntimePolicyModeSchema.optional(),
        ids: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
        host: z
          .object({
            mode: AgentProfileRuntimePolicyModeSchema.optional(),
            ids: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
          })
          .optional(),
      })
      .optional(),
    mcp: z
      .object({
        mode: AgentProfileRuntimePolicyModeSchema.optional(),
        ids: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      })
      .optional(),
  })
  .strict();

const AgentPromptTextSchema = z.string().max(20000);
const AgentPromptModeSchema = z.enum(['append', 'replace']);
const AgentPromptSectionsSchema = z.object({
  identity_prompt: AgentPromptTextSchema,
  soul_prompt: AgentPromptTextSchema,
  agents_prompt: AgentPromptTextSchema,
  tools_prompt: AgentPromptTextSchema,
});

function validatePromptModeCompatibility(
  value: {
    prompt_mode?: 'append' | 'replace';
    include_claude_preset?: boolean;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    value.prompt_mode !== undefined &&
    value.include_claude_preset !== undefined &&
    (value.prompt_mode === 'append') !== value.include_claude_preset
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['include_claude_preset'],
      message: 'include_claude_preset conflicts with prompt_mode',
    });
  }
}

export const AgentProfileCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    /** Explicitly disambiguates four-part clients from legacy identity_prompt. */
    prompt_schema_version: z.literal(2).optional(),
    identity_prompt: AgentPromptTextSchema.optional(),
    soul_prompt: AgentPromptTextSchema.optional(),
    agents_prompt: AgentPromptTextSchema.optional(),
    tools_prompt: AgentPromptTextSchema.optional(),
    prompt_mode: AgentPromptModeSchema.optional(),
    include_claude_preset: z.boolean().optional(),
    avatar_emoji: z.string().max(8).nullable().optional(),
    avatar_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    model_config_id: z.string().trim().min(1).max(128).nullable().optional(),
    runtime_policy: AgentProfileRuntimePolicySchema.optional(),
  })
  .superRefine(validatePromptModeCompatibility);

export const AgentProfilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    /** Explicitly disambiguates four-part clients from legacy identity_prompt. */
    prompt_schema_version: z.literal(2).optional(),
    identity_prompt: AgentPromptTextSchema.optional(),
    soul_prompt: AgentPromptTextSchema.optional(),
    agents_prompt: AgentPromptTextSchema.optional(),
    tools_prompt: AgentPromptTextSchema.optional(),
    prompt_mode: AgentPromptModeSchema.optional(),
    include_claude_preset: z.boolean().optional(),
    avatar_emoji: z.string().max(8).nullable().optional(),
    avatar_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    model_config_id: z.string().trim().min(1).max(128).nullable().optional(),
    runtime_policy: AgentProfileRuntimePolicySchema.optional(),
  })
  .superRefine(validatePromptModeCompatibility);

export const AgentProfileGenerateSchema = z.object({
  description: z.string().trim().min(1).max(4000),
});

export const AgentProfileRefinePromptSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    section: z.enum(['identity', 'soul', 'agents', 'tools']).optional(),
    current_prompts: AgentPromptSectionsSchema.optional(),
    /** @deprecated Legacy all-in-one prompt, interpreted as AGENTS. */
    current_prompt: AgentPromptTextSchema.optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().trim().min(1).max(4000),
        }),
      )
      .max(12)
      .optional()
      .default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.current_prompts && value.current_prompt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['current_prompts'],
        message: 'current_prompts or current_prompt is required',
      });
    }
  });

const WorkspaceMemoryKindSchema = z.enum([
  'fact',
  'decision',
  'lesson',
  'open_loop',
]);
const WorkspaceMemoryStatusSchema = z.enum([
  'active',
  'proposed',
  'conflicted',
  'superseded',
  'deleted',
]);
const WritableWorkspaceMemoryStatusSchema = WorkspaceMemoryStatusSchema.exclude(
  ['deleted'],
);
const WorkspaceMemoryTimestampSchema = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    'Invalid ISO timestamp',
  );
const WorkspaceMemoryOptionalTimestampSchema =
  WorkspaceMemoryTimestampSchema.nullable().optional();

export const WorkspaceMemoryProvenanceSchema = z
  .object({
    sourceId: z.string().trim().min(1).max(512).nullable().optional(),
    sessionId: z.string().trim().min(1).max(512).nullable().optional(),
    observedAt: WorkspaceMemoryOptionalTimestampSchema,
  })
  .strict();

const WorkspaceMemoryValueFields = {
  kind: WorkspaceMemoryKindSchema,
  title: z.string().trim().min(1).max(500).nullable().optional(),
  content: z.string().trim().min(1).max(32_768),
  canonicalKey: z.string().trim().min(1).max(500).nullable().optional(),
  status: WritableWorkspaceMemoryStatusSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  validFrom: WorkspaceMemoryOptionalTimestampSchema,
  validUntil: WorkspaceMemoryOptionalTimestampSchema,
  expiresAt: WorkspaceMemoryOptionalTimestampSchema,
} as const;

function validateWorkspaceMemoryValidity(
  value: { validFrom?: string | null; validUntil?: string | null },
  ctx: z.RefinementCtx,
): void {
  if (
    value.validFrom &&
    value.validUntil &&
    Date.parse(value.validFrom) >= Date.parse(value.validUntil)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['validUntil'],
      message: 'validUntil must be later than validFrom',
    });
  }
}

export const WorkspaceMemoryCreateSchema = z
  .object({
    ...WorkspaceMemoryValueFields,
    provenance: WorkspaceMemoryProvenanceSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine(validateWorkspaceMemoryValidity);

export const WorkspaceMemoryPatchSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
    kind: WorkspaceMemoryKindSchema.optional(),
    title: WorkspaceMemoryValueFields.title,
    content: WorkspaceMemoryValueFields.content.optional(),
    canonicalKey: WorkspaceMemoryValueFields.canonicalKey,
    status: WritableWorkspaceMemoryStatusSchema.optional(),
    importance: WorkspaceMemoryValueFields.importance,
    confidence: WorkspaceMemoryValueFields.confidence,
    validFrom: WorkspaceMemoryValueFields.validFrom,
    validUntil: WorkspaceMemoryValueFields.validUntil,
    expiresAt: WorkspaceMemoryValueFields.expiresAt,
    provenance: WorkspaceMemoryProvenanceSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateWorkspaceMemoryValidity(value, ctx);
    if (
      ![
        'kind',
        'title',
        'content',
        'canonicalKey',
        'status',
        'importance',
        'confidence',
        'validFrom',
        'validUntil',
        'expiresAt',
      ].some((key) => Object.prototype.hasOwnProperty.call(value, key))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one memory field must be provided',
      });
    }
  });

export const WorkspaceMemoryForgetSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
    reason: z.string().trim().min(1).max(1000).nullable().optional(),
    provenance: WorkspaceMemoryProvenanceSchema.optional(),
  })
  .strict();

export const WorkspaceMemoryListQuerySchema = z
  .object({
    status: WorkspaceMemoryStatusSchema.optional(),
    kind: WorkspaceMemoryKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const WorkspaceMemorySearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(500),
    kind: WorkspaceMemoryKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const WorkspaceMemoryVersionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const HappyClawOwnerProfileMutationSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('set'),
        preferredAddress: z.string().trim().min(1).max(200),
        expectedRevision: z.number().int().min(0).optional(),
        idempotencyKey: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('clear'),
        expectedRevision: z.number().int().positive(),
        idempotencyKey: z.string().trim().min(1).max(128).optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('skip'),
        expectedOnboardingRevision: z.number().int().min(0).optional(),
      })
      .strict(),
  ],
);

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
  interaction_mode: InteractionModeSchema.optional(),
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

export const SystemSettingsSchema = z
  .object({
    containerTimeout: z.number().int().min(60000).max(86400000).optional(),
    idleTimeout: z.number().int().min(60000).max(86400000).optional(),
    containerMaxOutputSize: z
      .number()
      .int()
      .min(1048576)
      .max(104857600)
      .optional(),
    maxConcurrentContainers: z.number().int().min(1).max(100).optional(),
    // Deprecated compatibility input. Host execution is serialized only by
    // Session; the route accepts and discards this key for stale clients.
    maxConcurrentHostProcesses: z.number().int().min(1).max(50).optional(),
    // Retired automation controls. Accept arbitrary legacy values so a stale
    // browser tab cannot make an otherwise valid save fail after deployment;
    // the route strips every key before normalization and persistence.
    maxConcurrentScripts: z.unknown().optional(),
    scriptTimeout: z.unknown().optional(),
    taskBackfillGraceMs: z.unknown().optional(),
    maxRepliesPerTurn: z.unknown().optional(),
    maxTasksPerUser: z.unknown().optional(),
    maxLoginAttempts: z.number().int().min(1).max(100).optional(),
    loginLockoutMinutes: z.number().int().min(1).max(1440).optional(),
    fallbackModel: z.string().max(64).optional(),
  })
  .strict();

export const HostIntegrationSettingsSchema = z
  .object({
    externalClaudeDir: z.string().max(512).optional(),
    pluginAutoScan: z.boolean().optional(),
    adminHostOnlyMode: z.boolean().optional(),
    mainAgentContextSource: z.enum(['managed', 'host_claude']).optional(),
    mainAgentAutoCompactWindow: z
      .number()
      .int()
      .refine(
        (value) => value === 0 || (value >= 100000 && value <= 1000000),
        'mainAgentAutoCompactWindow must be 0 or between 100000 and 1000000',
      )
      .optional(),
    mainAgentAutoCompactPercentage: z
      .number()
      .int()
      .refine(
        (value) => value === 0 || (value >= 50 && value <= 90),
        'mainAgentAutoCompactPercentage must be 0 or between 50 and 90',
      )
      .optional(),
  })
  .strict();

export const BillingSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    minStartBalanceUsd: z.number().min(0).max(1000000).optional(),
    currency: z.string().trim().min(1).max(10).optional(),
    currencyRate: z.number().min(0.0001).max(1000000).optional(),
  })
  .strict();

export const AppearanceConfigSchema = z.object({
  appName: z.string().min(1).max(32).optional(),
  // Compatibility field names; these now describe the global main Agent.
  aiName: z.string().min(1).max(32).optional(),
  aiAvatarEmoji: z.string().min(1).max(8).optional(),
  aiAvatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  aiAvatarUrl: z
    .string()
    .regex(/^\/api\/auth\/avatars\/[a-zA-Z0-9._-]+$/)
    .nullable()
    .optional(),
  aiAvatarMode: z.enum(['brand', 'emoji']).optional(),
  brandIconUrl: z
    .string()
    .regex(/^\/api\/config\/brand-assets\/brand-icon-[a-f0-9]{8}\.(?:jpg|png)$/)
    .nullable()
    .optional(),
  brandBannerUrl: z
    .string()
    .regex(
      /^\/api\/config\/brand-assets\/brand-banner-[a-f0-9]{8}\.(?:jpg|png)$/,
    )
    .nullable()
    .optional(),
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
  default_require_mention: z.boolean().optional(),
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

// 飞书/Lark 官方 appId 形如 `cli_xxxxxxxxxxxxxxxx`(cli_ 前缀 + 小写字母数字)。
// 历史上有用户把用户名 / 手机号 / 邮箱前缀填进去,后端不校验直接存,飞书 SDK 拿这串
// 错误的 appId 反复重试拿 token,导致日志被 axios error dump 灌爆(实测 ~2.5G/天)。
// 这里挡掉格式不对的;真实的"凭据错配"留给保存前的 testFeishuCredentials 兜底。
const FEISHU_APP_ID_REGEX = /^cli_[a-z0-9]+$/;

export const FeishuConfigSchema = z
  .object({
    appId: z
      .string()
      .max(2000)
      // refine 内先 trim 再匹配,与下游 routes/config.ts 的 trim() 行为对齐
      // (per PR #572 review minor):粘贴带首尾空白的合法 appId 不被误拒
      .refine(
        (v) => {
          const trimmed = v.trim();
          return trimmed === '' || FEISHU_APP_ID_REGEX.test(trimmed);
        },
        {
          message:
            'appId must be in Feishu/Lark official format (cli_ prefix + lowercase alphanumeric)',
        },
      )
      .optional(),
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

const ProviderBaseUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (value) => {
      if (!value.trim()) return true;
      try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Base URL must be an HTTP(S) URL' },
  );

export const UnifiedProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: z.enum(['official', 'third_party']),
    anthropicBaseUrl: ProviderBaseUrlSchema.optional(),
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
    anthropicBaseUrl: ProviderBaseUrlSchema.optional(),
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
    accountId: z
      .union([
        z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        // Historical clients may submit an empty value to mean "default".
        z.literal(''),
      ])
      .optional(),
    phoneNumber: z.string().max(32).optional(),
    enabled: z.boolean().optional(),
    // `paired` 由 Baileys 登录回调（saveUserWhatsAppConfig 内部）写入，
    // 不在 HTTP 层接受 —— 否则用户 PUT { paired: true } 可以伪装扫码完成。
    // 移除 schema 字段后，路由 handler 已通过解构忽略上行字段，
    // refine 也只校验剩下三个真实字段。
  })
  .refine(
    (data) =>
      typeof data.accountId === 'string' ||
      typeof data.phoneNumber === 'string' ||
      typeof data.enabled === 'boolean',
    { message: 'At least one config field must be provided' },
  );
