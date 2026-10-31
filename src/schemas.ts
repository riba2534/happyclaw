// Zod schemas and validation types for API requests

import { z } from 'zod';
import { AGENT_EFFORT_LEVELS } from './agent-effort.js';
import { ALL_PERMISSIONS } from './permissions.js';
import type { Permission } from './types.js';
import { MAX_GROUP_NAME_LEN } from './group-constants.js';
import { AUTOMATION_LIMITS } from './automation.js';
import {
  getModelPreset,
  isValidModelId,
  MAX_CONTEXT_WINDOW,
  MAX_PROVIDER_MODEL_ID_LENGTH,
  MAX_PROVIDER_MODELS,
  MIN_CONTEXT_WINDOW,
  MODEL_EFFORTS,
} from './model-providers.js';

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

/** Start a one-click Feishu/Lark app creation (device-code registration). */
export const FeishuAppRegistrationCreateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  brand: z.enum(['feishu', 'lark']).optional().default('feishu'),
});

const AutomationScheduleSchema = z.object({
  kind: z.enum(['cron', 'interval', 'once', 'manual']),
  cronExpr: z.string().max(200).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  intervalMs: z.number().int().positive().nullable().optional(),
  runAt: z.string().max(64).nullable().optional(),
});

const AutomationPreRunCheckSchema = z.object({
  command: z.string().max(AUTOMATION_LIMITS.scriptCommandMax * 2),
  timeoutMs: z.number().int().positive().nullable().optional(),
});

/**
 * Shape and a generous size cap only: the automation service applies the
 * shared validateAutomationDraft rules, cron syntax and the permission
 * checks, so REST and the agent tools reject the same drafts with the same
 * messages.
 */
const AutomationDraftFields = {
  name: z.string().max(200),
  prompt: z
    .string()
    .max(AUTOMATION_LIMITS.promptMax * 2)
    .nullable()
    .optional(),
  stopWhen: z.string().max(2000).nullable().optional(),
  schedule: AutomationScheduleSchema,
  endAt: z.string().max(64).nullable().optional(),
  silentWhenIdle: z.boolean().optional(),
  preRunCheck: AutomationPreRunCheckSchema.nullable().optional(),
  scriptCommand: z
    .string()
    .max(AUTOMATION_LIMITS.scriptCommandMax * 2)
    .nullable()
    .optional(),
};

const AutomationSessionModeSchema = z.enum(['fresh', 'persistent', 'bound']);

export const AutomationCreateSchema = z.object({
  ...AutomationDraftFields,
  workspaceJid: z.string().min(1).max(512),
  sessionMode: AutomationSessionModeSchema,
  targetSessionJid: z.string().max(512).nullable().optional(),
  execution: z.enum(['agent', 'script']).optional(),
});

export const AutomationPatchSchema = z
  .object(AutomationDraftFields)
  .partial()
  .extend({
    expectedRevision: z.number().int().positive(),
    sessionMode: AutomationSessionModeSchema.optional(),
    targetSessionJid: z.string().max(512).nullable().optional(),
  });

export const AutomationMarkReadSchema = z.object({
  runIds: z.array(z.string().min(1).max(128)).max(500).optional(),
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
    // Idempotency key minted by the client for one logical send and reused
    // when it resends after a timeout, so a slow network never stores (and
    // bills) the same message twice.
    clientMessageId: z.string().uuid().optional(),
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

/** How much of a proactive turn's process the Web shows (see ProcessVisibility). */
export const ProcessVisibilitySchema = z.enum(['hidden', 'activity', 'full']);

export const ChannelMountInteractionModePatchSchema = z
  .object({
    interaction_mode_override: z.enum(['assistant', 'proactive']).nullable(),
  })
  .strict();

export const ChannelMountDelegatePutSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

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
  process_visibility: ProcessVisibilitySchema.optional(),
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

/**
 * Chat composer model picker: null returns the conversation to the default.
 * `model` picks inside any configuration, `effort` only inside a ChatGPT one;
 * the request replaces the whole choice, so leaving them out follows the
 * configuration's defaults. The configuration's model list (a ChatGPT
 * catalog) decides which values are valid, so they are plain strings here.
 */
export const SessionModelSelectionSchema = z.object({
  agentId: z.string().trim().min(1).max(128).nullable().optional(),
  modelConfigId: z.string().trim().min(1).max(128).nullable(),
  model: z
    .string()
    .trim()
    .min(1)
    .max(MAX_PROVIDER_MODEL_ID_LENGTH)
    .nullable()
    .optional(),
  effort: z.string().trim().min(1).max(32).nullable().optional(),
});

/**
 * An Agent's model within its configuration; null runs the configuration's
 * default. Whether the configuration offers it is checked by the route.
 */
const AgentProfileModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PROVIDER_MODEL_ID_LENGTH)
  .nullable()
  .optional();

const AgentProfileRuntimePolicyModeSchema = z.enum([
  'inherit',
  'custom',
  'disabled',
]);

/**
 * An MCP server id, bare or scoped as `system:`/`user:`; the scope does not
 * count against the id's own limit, so an exported reference imports back.
 */
const McpPolicyReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (reference) => reference.replace(/^(?:system|user):/, '').length <= 128,
    'MCP id is too long',
  );

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
        ids: z.array(McpPolicyReferenceSchema).max(100).optional(),
      })
      .optional(),
  })
  .strict();

/** Per-section limit of an Agent's four prompts, in UTF-16 code units. */
export const AGENT_PROMPT_MAX_CHARS = 20000;
const AgentPromptTextSchema = z.string().max(AGENT_PROMPT_MAX_CHARS);
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

/** Per-Agent name limit, in UTF-16 code units. */
export const AGENT_NAME_MAX_CHARS = 80;
/**
 * Invisible characters that only serve to make two names look the same:
 * zero-width space and word joiner, soft hyphen, BOM, Mongolian vowel
 * separator, combining grapheme joiner, and bidi embedding / isolate
 * controls. Emoji joiners (ZWJ) and variation selectors stay allowed: they
 * are how names such as "❤️ 助手" or "👨‍💻 Coder" are written. Uniqueness
 * still ignores every default-ignorable code point.
 */
const DECEPTIVE_NAME_CHARACTERS =
  /[\u00AD\u034F\u180E\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/u;
const AgentProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AGENT_NAME_MAX_CHARS)
  .refine(
    (name) => !DECEPTIVE_NAME_CHARACTERS.test(name),
    '名称不能包含不可见字符',
  )
  .refine(
    (name) => /[^\p{Default_Ignorable_Code_Point}\s]/u.test(name),
    '名称至少需要一个可见字符',
  );

/**
 * What an Agent is apart from its owner, model binding and Workspaces: the
 * part a create request and an export file share.
 */
const AgentProfileDefinitionFields = {
  name: AgentProfileNameSchema,
  identity_prompt: AgentPromptTextSchema.optional(),
  soul_prompt: AgentPromptTextSchema.optional(),
  agents_prompt: AgentPromptTextSchema.optional(),
  tools_prompt: AgentPromptTextSchema.optional(),
  prompt_mode: AgentPromptModeSchema.optional(),
  avatar_emoji: z.string().max(8).nullable().optional(),
  avatar_color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  runtime_policy: AgentProfileRuntimePolicySchema.optional(),
};

export const AgentProfileCreateSchema = z
  .object({
    ...AgentProfileDefinitionFields,
    /** Explicitly disambiguates four-part clients from legacy identity_prompt. */
    prompt_schema_version: z.literal(2).optional(),
    include_claude_preset: z.boolean().optional(),
    model_config_id: z.string().trim().min(1).max(128).nullable().optional(),
    model: AgentProfileModelSchema,
  })
  .superRefine(validatePromptModeCompatibility);

export const AgentProfilePatchSchema = z
  .object({
    name: AgentProfileNameSchema.optional(),
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
    model: AgentProfileModelSchema,
    runtime_policy: AgentProfileRuntimePolicySchema.optional(),
  })
  .superRefine(validatePromptModeCompatibility);

export const AgentProfileMigrateAndDeleteSchema = z.object({
  target_agent_profile_id: z.string().trim().min(1),
});

/**
 * The `agent` part of a file written by GET /api/agent-profiles/:id/export.
 * Skills and MCP are referenced by name; a model configuration, host paths
 * and credentials never leave the instance.
 */
export const AgentProfileExportAgentSchema = z.object(
  AgentProfileDefinitionFields,
);

export const AgentProfileImportSchema = z.object({
  data: z.unknown(),
  /** Overrides the exported name, e.g. after a name conflict. */
  name: AgentProfileNameSchema.optional(),
  /** Create without the Skills/MCP this account does not have. */
  drop_missing: z.boolean().optional(),
  /** An admin agreed to the host context / host Skills the file grants. */
  confirm_host_grants: z.boolean().optional(),
});

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

export const WorkspaceMemoryProposalAnswerSchema = z
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

export const GroupPatchSchema = z.object({
  name: z.string().min(1).max(MAX_GROUP_NAME_LEN).optional(),
  is_pinned: z.boolean().optional(),
  activation_mode: z
    .enum(['auto', 'always', 'when_mentioned', 'owner_mentioned', 'disabled'])
    .optional(),
  execution_mode: z.enum(['container', 'host']).optional(),
  interaction_mode: InteractionModeSchema.optional(),
  process_visibility: ProcessVisibilitySchema.optional(),
});

export const LoginSchema = z.object({
  // Real usernames are ≤32 chars (validateUsername); 64 leaves headroom while
  // bounding the rate-limiter keys a failed attempt can create.
  username: z.string().min(1).max(64),
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
    allowMemberGuests: z.boolean().optional(),
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

/** Workspace JIDs granted to a guest: `web:*` workspace records only. */
const GuestWorkspaceJidsSchema = z
  .array(
    z
      .string()
      .min(5)
      .max(256)
      .regex(/^web:[^#]+$/),
  )
  .max(200);

export const GuestCreateSchema = z.object({
  username: z.string().min(3).max(32),
  password: z.string().min(8).max(128),
  display_name: z.string().max(64).optional(),
  workspace_jids: GuestWorkspaceJidsSchema,
});

export const GuestPatchSchema = z
  .object({
    display_name: z.string().max(64).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    workspace_jids: GuestWorkspaceJidsSchema.optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'No fields to update',
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

const ClaudeOAuthCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  scopes: z.array(z.string()).default([]),
  subscriptionType: z.string().optional(),
});

/**
 * Raw paste for an official provider: `.credentials.json` content or a
 * setup-token. Parsed server-side by parseClaudeCredentialInput.
 */
const ClaudeCredentialInputSchema = z.string().min(1).max(65536);

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

const ProviderAuthModeSchema = z.enum(['bearer', 'x-api-key']);

const ProviderModelIdSchema = z
  .string()
  .trim()
  .refine(isValidModelId, { message: '模型名无效' });

/** '' is a pass-through relay: Claude Code picks the model itself. */
const ProviderDefaultModelSchema = z
  .string()
  .max(MAX_PROVIDER_MODEL_ID_LENGTH)
  .refine((value) => !value.trim() || isValidModelId(value.trim()), {
    message: '模型名无效',
  });

/**
 * The whole list a connection offers; the connection's model need not be in
 * it. A `[1m]` id from an older client reads as a 1M window.
 */
const ProviderModelListSchema = z
  .array(
    z.object({
      id: ProviderModelIdSchema,
      contextWindow: z
        .number()
        .int()
        .min(MIN_CONTEXT_WINDOW)
        .max(MAX_CONTEXT_WINDOW)
        .optional(),
      efforts: z
        .array(z.enum(MODEL_EFFORTS))
        .max(MODEL_EFFORTS.length)
        .optional(),
      defaultEffort: z.enum(MODEL_EFFORTS).optional(),
    }),
  )
  .max(MAX_PROVIDER_MODELS);

/** Each role names one of the connection's models; others are dropped. */
const ConnectionModelRolesSchema = z.object({
  subagent: ProviderDefaultModelSchema.optional(),
  smallFast: ProviderDefaultModelSchema.optional(),
  opus: ProviderDefaultModelSchema.optional(),
  sonnet: ProviderDefaultModelSchema.optional(),
});

const ProviderPresetIdSchema = z
  .string()
  .trim()
  .refine((value) => !!getModelPreset(value), { message: '未知的厂商预设' });

export const UnifiedProviderCreateSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: z.enum(['official', 'third_party']),
    anthropicBaseUrl: ProviderBaseUrlSchema.optional(),
    anthropicAuthToken: z.string().max(2000).optional(),
    anthropicAuthMode: ProviderAuthModeSchema.optional(),
    anthropicModel: ProviderDefaultModelSchema.optional(),
    models: ProviderModelListSchema.optional(),
    presetId: ProviderPresetIdSchema.optional(),
    anthropicApiKey: z.string().max(2000).optional(),
    claudeCodeOauthToken: z.string().max(2000).optional(),
    claudeOAuthCredentials: ClaudeOAuthCredentialsSchema.optional(),
    claudeCredentialInput: ClaudeCredentialInputSchema.optional(),
    roles: ConnectionModelRolesSchema.optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
    /** Accepted from older clients and ignored. */
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
    /** Null goes back to inferring the header style from the token. */
    anthropicAuthMode: ProviderAuthModeSchema.nullable().optional(),
    anthropicModel: ProviderDefaultModelSchema.optional(),
    /** The whole new list; models left out are removed. */
    models: ProviderModelListSchema.optional(),
    presetId: ProviderPresetIdSchema.nullable().optional(),
    roles: ConnectionModelRolesSchema.optional(),
    customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
    /** Accepted from older clients and ignored. */
    weight: z.number().int().min(1).max(100).optional(),
    // Third-party edits save the token with the other fields in one request,
    // so a failed half can never leave the endpoint and its key out of sync.
    anthropicAuthToken: z.string().trim().min(1).max(2000).optional(),
    clearAnthropicAuthToken: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.anthropicBaseUrl !== undefined ||
      data.anthropicAuthMode !== undefined ||
      data.anthropicModel !== undefined ||
      data.models !== undefined ||
      data.presetId !== undefined ||
      data.roles !== undefined ||
      data.customEnv !== undefined ||
      data.weight !== undefined ||
      data.anthropicAuthToken !== undefined ||
      data.clearAnthropicAuthToken === true,
    { message: 'At least one field must be provided' },
  );

/**
 * A connection to list models from: a saved one by providerId, or a draft
 * that is not saved yet. With a providerId, blank fields fall back to the
 * stored connection — including its credential, which is never sent back to
 * the client. A draft without a type is a third-party endpoint.
 */
export const ProviderDiscoverModelsSchema = z.object({
  providerId: z.string().trim().min(1).max(64).optional(),
  type: z.enum(['official', 'third_party']).optional(),
  presetId: ProviderPresetIdSchema.optional(),
  anthropicBaseUrl: ProviderBaseUrlSchema.optional(),
  anthropicAuthToken: z.string().max(2000).optional(),
  anthropicAuthMode: ProviderAuthModeSchema.optional(),
  anthropicApiKey: z.string().max(2000).optional(),
  /** A pasted setup-token or .credentials.json; checked, never saved. */
  claudeCredentialInput: ClaudeCredentialInputSchema.optional(),
  /** A draft's env; its ANTHROPIC_CUSTOM_HEADERS go with every request. */
  customEnv: z.record(z.string().max(256), z.string().max(4096)).optional(),
});

/**
 * A connection to test: as for listing models, plus the model it runs and a
 * draft's roles (its background model is probed too).
 */
export const ProviderConnectivityTestSchema =
  ProviderDiscoverModelsSchema.extend({
    anthropicModel: ProviderDefaultModelSchema.optional(),
    roles: ConnectionModelRolesSchema.optional(),
  });
export type ProviderConnectivityTestInput = z.infer<
  typeof ProviderConnectivityTestSchema
>;

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
    claudeCredentialInput: ClaudeCredentialInputSchema.optional(),
  })
  .refine(
    (data) => {
      return (
        typeof data.claudeCredentialInput === 'string' ||
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
