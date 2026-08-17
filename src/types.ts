import type { StreamEvent, WorkflowRunSnapshot } from './stream-event.types.js';

export interface AdditionalMount {
  hostPath: string; // Absolute canonical path on host
  containerPath: string; // Relative suffix mounted below /workspace/extra
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * Stored at config/mount-allowlist.json in the project root.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  version?: 1;
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export type ExecutionMode = 'container' | 'host';
/** User-visible interaction contract owned by one Workspace↔Agent binding. */
export type InteractionMode = 'assistant' | 'proactive';
export type ConversationSource = 'manual' | 'native_thread' | 'feishu_thread';
export type ConversationNavMode = 'horizontal' | 'vertical_threads';
export type ImBindingMode = 'single_context' | 'thread_map';
export type ChannelRoutingMode = 'single_session' | 'thread_map';
export type AudienceMode = 'everyone' | 'owner_only';

/** Provider-proven relation between two physical inbound messages. */
export interface ChannelContentLink {
  kind: 'forward_bundle' | 'rapid_topic_bundle';
  /** Stable identity for one forward operation, normally its root message id. */
  bundleId: string;
  role: 'forwarded_content' | 'forwarder_comment';
  relatedMessageId?: string;
}

/**
 * Provider-fetched context for a message referenced by the current inbound
 * turn. The text is prompt-only metadata: `NewMessage.content` remains scoped
 * to the current turn and its own attachment markers.
 */
export interface ChannelReferencedMessage {
  id: string;
  sender?: string;
  text: string;
  /** Structural relation asserted by the provider adapter, never inferred from text. */
  contentLink?: ChannelContentLink;
  /** Provider material was fetched beyond a placeholder-only forward shell. */
  materialResolved?: boolean;
  /** Prompt hints for referenced files/images that were materialized locally. */
  attachmentHints?: string[];
  /**
   * Raw `messages.attachments` indexes owned by this reference. The host uses
   * them to avoid resending quoted image bytes when the referenced turn is
   * already present in the active session.
   */
  attachmentIndexes?: number[];
}

/**
 * Sanitized provider context for one inbound turn.
 *
 * This object is safe to persist and expose to the Agent. It intentionally
 * contains public routing identifiers only: credentials, access tokens and
 * application secrets must never be added here.
 */
export interface ChannelTurnContext {
  schemaVersion: 1;
  provider: string;
  channelAccountId: string | null;
  sourceJid: string;
  targetJid?: string;
  workspaceJid?: string;
  sessionAgentId?: string | null;
  bot?: {
    appId?: string;
    openId?: string;
    name?: string;
    avatarUrl?: string;
  };
  chat: {
    id: string;
    type?: 'p2p' | 'group';
    name?: string;
    mode?: string;
    groupMessageType?: string;
    isTopicStyle?: boolean;
  };
  message: {
    id: string;
    rootId?: string;
    parentId?: string;
    threadId?: string;
    type?: string;
    /** Structural relation asserted by the provider adapter. */
    contentLink?: ChannelContentLink;
    referencedMessages?: ChannelReferencedMessage[];
  };
  sender?: {
    openId?: string;
    userId?: string;
    unionId?: string;
    name?: string;
    tenantKey?: string;
    type?: string;
  };
  mentions?: Array<{
    key?: string;
    name?: string;
    openId?: string;
    userId?: string;
    unionId?: string;
  }>;
  /** Capability names are populated by the host broker, never by the model. */
  capabilities?: string[];
}

export interface ChannelMount {
  channel_jid: string;
  channel_account_id?: string | null;
  channel_type: string;
  workspace_jid: string;
  session_id?: string | null;
  routing_mode: ChannelRoutingMode;
  reply_policy: 'source_only' | 'mirror';
  activation_mode:
    | 'auto'
    | 'always'
    | 'when_mentioned'
    | 'owner_mentioned'
    | 'disabled';
  audience_mode: AudienceMode;
  owner_im_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Provider-native topic/thread metadata used by workspace thread_map routing. */
export interface ChannelMessageMeta {
  provider?: string;
  chatType?: 'p2p' | 'group';
  mentionedBot?: boolean;
  nativeContextType?: 'thread';
  contextId?: string;
  threadId?: string;
  rootId?: string;
  parentId?: string;
  messageId?: string;
  text?: string;
  title?: string;
  channelContext?: ChannelTurnContext;
}

/** @deprecated Use ChannelMessageMeta. Kept for connector compatibility. */
export type FeishuMessageMeta = ChannelMessageMeta;

export interface RegisteredGroup {
  name: string;
  folder: string;
  added_at: string;
  /** Provider-hosted avatar URL for an external IM chat. */
  avatar_url?: string;
  containerConfig?: ContainerConfig;
  /** Invalid persisted JSON is retained as a runtime safety block, never ignored. */
  containerConfigError?: string;
  executionMode?: ExecutionMode; // 默认 'container'
  customCwd?: string; // 宿主机模式的自定义工作目录（绝对路径）
  initSourcePath?: string; // 容器模式下复制来源的宿主机绝对路径
  initGitUrl?: string; // 容器模式下 clone 来源的 Git URL
  created_by?: string;
  /** Channel account that owns this external chat. Null means legacy/default. */
  channel_account_id?: string;
  is_home?: boolean; // 用户主容器标记
  /** Direct-chat binding target: a specific workspace conversation session. */
  target_agent_id?: string;
  /**
   * Binding target stored as the canonical workspace JID.
   * Group chats own the workspace main context. Direct chats must not use
   * this slot — they bind through `target_agent_id` so they do not share
   * the workspace main channel-owner key with a group.
   */
  target_main_jid?: string;
  reply_policy?: 'source_only' | 'mirror'; // IM 绑定的回复策略
  require_mention?: boolean; // 群聊是否需要 @机器人 才响应（默认 false）
  activation_mode?:
    | 'auto'
    | 'always'
    | 'when_mentioned'
    | 'owner_mentioned'
    | 'disabled'; // 消息门控模式（默认 'auto'，兼容 require_mention）
  audience_mode?: AudienceMode; // 响应对象，与是否需要 @ 独立（默认 everyone）
  owner_im_id?: string; // audience_mode 为 owner_only 时，仅此 IM 标识符的发送者被响应
  /** Provenance for privileged owner workflows. Weak automatic/explicit claims
   * and credential-transfer quarantine cannot authorize Agent Builder. */
  owner_claim_source?:
    | 'explicit'
    | 'configured'
    | 'trusted_direct'
    | 'auto_feishu'
    | 'transfer_reset';
  sender_allowlist?: string[] | null; // null/undefined = 不限制，[] = 仅 owner 可触发（未 /claim 时无人可触发），[ids] = 白名单
  mcp_mode?: 'inherit' | 'custom'; // MCP 配置模式（默认 'inherit' 继承用户配置）
  selected_mcps?: string[] | null; // custom 模式下选中的 MCP server IDs
  conversation_source?: ConversationSource; // 工作区会话来源（默认 manual）
  conversation_nav_mode?: ConversationNavMode; // 工作区会话导航模式（默认 horizontal）
  binding_mode?: ImBindingMode; // IM 绑定模式（默认 single_context）
  native_context_type?: 'none' | 'thread'; // 渠道原生上下文能力（如飞书话题、Telegram Forum）
  feishu_chat_mode?: string; // 飞书群模式：group/topic/p2p 等
  feishu_group_message_type?: string; // 飞书群消息形式：chat/thread
}

export type ChannelProvider =
  | 'feishu'
  | 'telegram'
  | 'qq'
  | 'wechat'
  | 'wecom'
  | 'dingtalk'
  | 'discord'
  | 'whatsapp';

export type ChannelAuthMode = 'credentials' | 'bot_token' | 'qr_session';
export type ChannelAuthStatus =
  | 'draft'
  | 'awaiting_scan'
  | 'authorized'
  | 'revoked'
  | 'error';
export type ChannelTransportStatus =
  | 'disconnected'
  | 'connecting'
  | 'reconnecting'
  | 'connected'
  | 'error';

/** Public metadata only. Credentials live behind secret_ref and are never serialized. */
export interface ChannelAccount {
  id: string;
  owner_user_id: string;
  provider: ChannelProvider;
  name: string;
  secret_ref: string;
  enabled: boolean;
  is_default: boolean;
  /** Legacy singleton keeps unscoped JIDs so existing history/bindings survive. */
  is_legacy_default: boolean;
  /** How this provider authorizes an account. Derived at creation and immutable. */
  auth_mode: ChannelAuthMode;
  /** Authorization lifecycle; separate from the live transport connection. */
  auth_status: ChannelAuthStatus;
  /** Live socket/stream lifecycle. */
  transport_status: ChannelTransportStatus;
  /** @deprecated Compatibility projection of transport_status. */
  status:
    | 'disconnected'
    | 'connecting'
    | 'reconnecting'
    | 'connected'
    | 'error';
  default_agent_profile_id: string | null;
  default_workspace_jid: string | null;
  last_error: string | null;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelAccountPublic extends Omit<
  ChannelAccount,
  'secret_ref' | 'default_agent_profile_id'
> {
  has_credentials: boolean;
  options?: {
    bypassProxy?: boolean;
    streamingMode?: 'card' | 'text' | 'edit' | 'off';
    phoneNumber?: string;
  };
}

export interface AgentProfile {
  id: string;
  owner_user_id: string;
  name: string;
  /** IDENTITY: concise role and public identity. */
  identity_prompt: string;
  /** SOUL: values, temperament, and durable judgment principles. */
  soul_prompt: string;
  /** AGENTS: operating rules, workflows, and collaboration behavior. */
  agents_prompt: string;
  /** TOOLS: tool-selection and tool-usage guidance. */
  tools_prompt: string;
  /** Append to or replace the Claude Code preset. Platform runtime instructions remain. */
  prompt_mode: AgentProfilePromptMode;
  /** @deprecated Compatibility alias for prompt_mode === 'append'. */
  include_claude_preset: boolean;
  avatar_emoji: string | null;
  avatar_color: string | null;
  avatar_url: string | null;
  /** Null means inherit the system default model configuration. */
  model_config_id: string | null;
  runtime_policy: AgentProfileRuntimePolicy;
  identity_hash: string;
  version: number;
  is_default: boolean;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export type AgentProfilePromptMode = 'append' | 'replace';

export type AgentEffortLevel =
  | 'inherit'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface AgentProfilePrompts {
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
  prompt_mode: AgentProfilePromptMode;
}

export interface AgentProfilePromptVersion extends AgentProfilePrompts {
  id: string;
  agent_profile_id: string;
  version: number;
  name: string;
  identity_hash: string;
  change_source: 'create' | 'update' | 'restore' | 'migration';
  restored_from_version: number | null;
  created_at: string;
}

/** Durable Workspace↔AgentProfile binding and its interaction contract. */
export interface WorkspaceAgentProfileBinding {
  group_folder: string;
  agent_profile_id: string;
  interaction_mode: InteractionMode;
  created_at: string;
  updated_at: string;
}

export interface AgentProfileRuntimePolicy {
  reasoning: {
    /** Inherit Provider customEnv first, then the SDK model-aware default. */
    effort: AgentEffortLevel;
  };
  context: {
    source: 'managed' | 'host_claude';
    auto_compact_window: number;
    auto_compact_percentage: number;
  };
  skills: {
    mode: 'inherit' | 'custom' | 'disabled';
    ids: string[];
    /**
     * Native host ~/.claude/skills selection. Missing is a legacy sentinel:
     * follow the effective context source (host_claude => inherit, otherwise
     * disabled). New profiles persist this field explicitly.
     */
    host?: {
      mode: 'inherit' | 'custom' | 'disabled';
      ids: string[];
    };
  };
  mcp: {
    mode: 'inherit' | 'custom' | 'disabled';
    ids: string[];
  };
}

export interface AgentBuilderDefinition extends AgentProfilePrompts {
  name: string;
  avatar_emoji: string | null;
  avatar_color: string | null;
  runtime_policy: AgentProfileRuntimePolicy;
}

export interface AgentBuilderDraft {
  id: string;
  owner_user_id: string;
  source_group: string;
  source_chat_jid: string;
  target_agent_profile_id: string | null;
  base_agent_version: number | null;
  revision: number;
  state: 'ready' | 'published' | 'discarded';
  definition: AgentBuilderDefinition;
  assumptions: string[];
  prepared_turn_id: string | null;
  confirmation_phrase: string;
  published_agent_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: string;
  token_usage?: string;
  /** Sanitized provider-native identifiers for this exact inbound turn. */
  channel_context?: ChannelTurnContext;
  /** Session-derived Claude Code Workflow snapshots for historical replay. */
  workflow_runs?: WorkflowRunSnapshot[];
  turn_id?: string | null;
  session_id?: string | null;
  sdk_message_uuid?: string | null;
  source_kind?: MessageSourceKind | null;
  finalization_reason?: MessageFinalizationReason | null;
  task_id?: string | null;
  delivery_mode?: FollowUpMode | null;
  delivery_status?: FollowUpStatus | null;
  delivery_run_id?: string | null;
  delivery_priority?: number | null;
  delivery_updated_at?: string | null;
}

export type FollowUpMode = 'queue' | 'steer';

export type FollowUpStatus =
  | 'queued'
  | 'promoting'
  | 'released'
  | 'cancelled'
  /** Preserved in history, but already delivered through a linked physical input. */
  | 'subsumed';

export interface QueuedFollowUp {
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: string;
  channel_context?: ChannelTurnContext;
  delivery_mode: FollowUpMode;
  delivery_status: 'queued' | 'promoting';
  delivery_run_id?: string | null;
  delivery_priority: number;
}

export interface FollowUpTransition {
  id: string;
  delivery_status: 'released' | 'cancelled';
  delivery_run_id?: string | null;
  delivery_updated_at: string;
}

export interface FollowUpDisposition {
  disposition: 'started' | 'queued' | 'steered';
  runId?: string;
  position?: number;
}

export type FollowUpAction = 'steer' | 'cancel' | 'interrupt_and_run';

export interface FollowUpActionResult {
  ok: boolean;
  state?: 'steered' | 'cancelled' | 'interrupting' | 'queued';
  message: string;
  item?: QueuedFollowUp;
}

export type MessageSourceKind =
  | 'sdk_final'
  | 'sdk_send_message'
  | 'proactive_sdk_fallback'
  | 'input_rejection_warning'
  | 'interrupt_partial'
  | 'overflow_partial'
  | 'compact_partial'
  | 'user_command'
  | 'scheduled_task_prompt'
  | 'scheduled_task_result'
  | 'legacy'
  | 'auto_continue'
  | 'truncation_continue';

export type MessageFinalizationReason =
  | 'completed'
  | 'delivery_uncertain'
  | 'interrupted'
  | 'error'
  | 'shutdown'
  | 'crash_recovery'
  | 'truncated';

export interface MessageAttachment {
  type: 'image';
  data: string; // base64 编码的图片数据
  mimeType?: string; // 如 'image/png'、'image/jpeg'
}

export interface MessageCursor {
  timestamp: string;
  id: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  execution_type: 'agent' | 'script';
  script_command: string | null;
  execution_mode?: 'host' | 'container' | null;
  workspace_jid?: string | null;
  workspace_folder?: string | null;
  running_until?: string | null;
  runner_id?: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed' | 'parsing';
  created_at: string;
  created_by?: string;
  notify_channels?: string[] | null;
  /**
   * Concrete delivery route captured when the task was created.
   *
   * `chat_jid` is workspace-level, so execution used to re-derive its target and
   * could fall back to another group in the same folder. This JID carries the
   * whole binding — provider, external chat, channel account and Feishu
   * thread/root — so a run either reaches the place it was scheduled from or
   * fails; it never silently picks somewhere else.
   */
  delivery_route_jid?: string | null;
  /** Optimistic-concurrency revision for edits made through REST/MCP/UI. */
  revision: number;
  updated_at: string;
  /** Soft deletion keeps task history queryable while removing future fires. */
  deleted_at: string | null;
}

export type TaskRunTrigger = 'scheduled' | 'manual' | 'backfill';

export type TaskRunStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'missed'
  | 'delivered';

export type TaskRunNotificationStatus =
  | 'pending'
  | 'success'
  | 'partial_failed'
  | 'failed'
  | 'skipped';

export interface TaskRunNotificationSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  failed_channels: string[];
}

export interface TaskRunNotificationReceipt {
  status: Exclude<TaskRunNotificationStatus, 'pending'>;
  summary: TaskRunNotificationSummary;
  error?: string | null;
}

/**
 * Immutable, non-secret definition used by one occurrence. A queued/retried run
 * must never silently switch to a newer task definition.
 */
export interface TaskRunDefinitionSnapshot {
  prompt: string;
  group_folder: string;
  chat_jid: string;
  delivery_route_jid: string | null;
  context_mode: 'group' | 'isolated';
  execution_type: 'agent' | 'script';
  execution_mode: 'host' | 'container' | null;
  script_command: string | null;
  notify_channels: string[] | null;
  /**
   * Delivery contract frozen when a group-mode occurrence crosses the durable
   * workspace-prompt hand-off.  It is intentionally absent on historical and
   * isolated runs; consumers fall back to the workspace mode only for those
   * legacy rows.
   */
  interaction_mode?: InteractionMode;
}

/** Durable state for one scheduled/manual occurrence. */
export interface TaskRun {
  id: string;
  task_id: string;
  trigger_type: TaskRunTrigger;
  idempotency_key: string | null;
  scheduled_for: string;
  definition_revision: number;
  definition_snapshot: TaskRunDefinitionSnapshot;
  status: TaskRunStatus;
  attempt: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  duration_ms: number;
  result: string | null;
  error: string | null;
  notification_status: TaskRunNotificationStatus;
  notification_error: string | null;
  notification_summary: TaskRunNotificationSummary | null;
  notification_attempt: number;
  notification_available_at: string | null;
}

export interface ClaimedTaskRun extends TaskRun {
  status: 'running';
  lease_owner: string;
  lease_expires_at: string;
}

export interface TaskRunLog {
  id?: number;
  run_id?: string;
  task_id: string;
  run_at: string;
  duration_ms: number;
  /** `queued` means a group-mode prompt was delivered to the workspace queue;
   * it does not claim that the Agent has finished executing it. */
  status: 'running' | 'queued' | 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Auth types ---

export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled' | 'deleted';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: 'active' | 'disabled' | 'deleted';
  display_name: string;
  permissions: Permission[];
  must_change_password: boolean;
}

export type Permission =
  | 'manage_system_config'
  | 'manage_group_env'
  | 'manage_users'
  | 'manage_invites'
  | 'view_audit_log'
  | 'manage_billing';

export type PermissionTemplateKey =
  | 'admin_full'
  | 'member_basic'
  | 'ops_manager'
  | 'user_admin';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  avatar_url: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
  /**
   * Per-user default for require_mention on auto-registered IM group chats.
   * When true, newly auto-registered Feishu/Telegram/etc groups start with
   * require_mention=1 (only @bot triggers a response). false preserves the
   * legacy default of responding to every owner-sent message in the group.
   * Existing groups are not retroactively changed.
   */
  default_require_mention: boolean;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
}

export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  avatar_url: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
  default_require_mention: boolean;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
  deleted_at: string | null;
}

export interface UserSession {
  id: string;
  user_id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  last_active_at: string;
}

export interface UserSessionWithUser extends UserSession {
  username: string;
  role: UserRole;
  status: UserStatus;
  display_name: string;
  permissions: Permission[];
  must_change_password: boolean;
}

export interface InviteCode {
  code: string;
  created_by: string;
  role: UserRole;
  permission_template: PermissionTemplateKey | null;
  permissions: Permission[];
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface InviteCodeWithCreator extends InviteCode {
  creator_username: string;
}

export type AuthEventType =
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'password_changed'
  | 'profile_updated'
  | 'user_created'
  | 'user_disabled'
  | 'user_enabled'
  | 'user_deleted'
  | 'user_restored'
  | 'user_updated'
  | 'role_changed'
  | 'session_revoked'
  | 'invite_created'
  | 'invite_deleted'
  | 'invite_used'
  | 'recovery_reset'
  | 'register_success'
  | 'system_settings_updated'
  | 'host_integration_updated';

export interface AuthAuditLog {
  id: number;
  event_type: AuthEventType;
  username: string;
  actor_username: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

// --- Sub-Agent types ---

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';
export type AgentKind = 'task' | 'conversation' | 'spawn';

export interface SubAgent {
  id: string;
  group_folder: string;
  chat_jid: string;
  name: string;
  prompt: string;
  status: AgentStatus;
  kind: AgentKind;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  result_summary: string | null;
  last_im_jid: string | null;
  /** 发起 /spawn 命令的源会话 JID，用于完成后结果回注 */
  spawned_from_jid: string | null;
  source_kind?:
    | 'manual'
    | 'native_thread'
    | 'feishu_thread'
    | 'auto_im'
    | 'channel_direct'
    | null;
  thread_id?: string | null;
  root_message_id?: string | null;
  title_source?:
    | 'manual'
    | 'native_root'
    | 'feishu_root'
    | 'auto'
    | 'auto_pending'
    | null;
  last_active_at?: string | null;
}

export interface ImContextBinding {
  source_jid: string;
  context_type: 'thread';
  context_id: string;
  workspace_jid: string;
  agent_id: string;
  root_message_id: string | null;
  title: string | null;
  last_active_at: string;
  created_at: string;
  updated_at: string;
}

export interface ActiveRunSnapshot {
  chatJid: string;
  runId: string;
  startedAt: string;
  // No 'queued': a queued message has no exact attempt identity yet, so it can
  // never receive a matching run_finished terminal. Queued chats travel in
  // `queuedChatJids` on the snapshot message instead.
  phase: 'preparing' | 'running';
}

export type RunFinishReason =
  | 'completed'
  | 'released'
  | 'runner_exit'
  | 'stopped';

// WebSocket message types
export type WsMessageOut =
  | {
      type: 'new_message';
      chatJid: string;
      message: NewMessage & { is_from_me: boolean };
      agentId?: string;
      source?: string;
    }
  | {
      type: 'agent_reply';
      chatJid: string;
      text: string;
      timestamp: string;
      agentId?: string;
    }
  | { type: 'typing'; chatJid: string; isTyping: boolean; agentId?: string }
  | {
      type: 'status_update';
      activeContainers: number;
      activeHostProcesses: number;
      activeTotal: number;
      queueLength: number;
    }
  | {
      type: 'stream_event';
      chatJid: string;
      event: StreamEvent;
      agentId?: string;
      /** Exact GroupQueue attempt that owns this stream event. */
      runId?: string;
    }
  | {
      type: 'agent_status';
      chatJid: string;
      agentId: string;
      status: AgentStatus;
      kind?: AgentKind;
      name: string;
      prompt: string;
      resultSummary?: string;
      titleGenerating?: boolean;
    }
  | {
      type: 'runner_state';
      chatJid: string;
      state: 'idle' | 'running';
    }
  | {
      type: 'run_started';
      chatJid: string;
      runId: string;
      startedAt: string;
      phase: 'preparing';
    }
  | {
      type: 'run_finished';
      chatJid: string;
      runId: string;
      finishedAt: string;
      reason: RunFinishReason;
    }
  | {
      type: 'active_run_snapshot';
      runs: ActiveRunSnapshot[];
      /**
       * Chats whose message is enqueued behind a busy runner. They have no run
       * identity yet, so they cannot be `runs` entries — but the client still
       * has to show a wait state, otherwise a user who reloads mid-queue sees
       * an idle composer and sends the same message twice.
       */
      queuedChatJids: string[];
    }
  | {
      type: 'follow_up_update';
      chatJid: string;
      items: QueuedFollowUp[];
      agentId?: string;
      transition?: FollowUpTransition;
    }
  | {
      type: 'task_state';
      chatJid: string;
      taskId: string;
      status: 'running' | 'completed' | 'error';
      name: string;
      prompt: string;
      resultSummary?: string;
      kind?: AgentKind;
    }
  | { type: 'terminal_output'; chatJid: string; data: string }
  | { type: 'terminal_started'; chatJid: string }
  | { type: 'terminal_stopped'; chatJid: string; reason?: string }
  | { type: 'terminal_error'; chatJid: string; error: string }
  | { type: 'group_created'; jid: string; folder: string; name: string }
  | { type: 'docker_pull_log'; line: string }
  | { type: 'docker_pull_complete'; success: boolean; error?: string }
  | {
      type: 'whatsapp_status';
      userId: string;
      accountId?: string;
      status: 'connecting' | 'qr' | 'connected' | 'disconnected' | 'logged_out';
      qr?: string;
      qrDataUrl?: string;
      error?: string;
      meJid?: string;
      meName?: string;
    }
  | {
      type: 'channel_account_status';
      userId: string;
      accountId: string;
      transportStatus: ChannelTransportStatus;
      lastError?: string | null;
      connectedAt?: string | null;
      errorCode?: string;
      consecutiveFailures?: number;
      nextRetryMs?: number;
    }
  | {
      type: 'billing_update';
      userId: string;
      usage: BillingAccessResult;
    }
  | { type: 'ws_error'; error: string; chatJid?: string }
  | {
      type: 'stream_snapshot';
      chatJid: string;
      /** Exact GroupQueue attempt that owns this reconnect snapshot. */
      runId?: string;
      snapshot: {
        partialText: string;
        thinkingText?: string;
        activeTools: Array<{
          toolName: string;
          toolUseId: string;
          startTime: number;
          toolInputSummary?: string;
          parentToolUseId?: string | null;
        }>;
        recentEvents: Array<{
          id: string;
          timestamp: number;
          text: string;
          kind:
            | 'tool'
            | 'skill'
            | 'hook'
            | 'status'
            | 'task'
            | 'memory'
            | 'debug'
            | 'context'
            | 'permission';
        }>;
        traceEvents?: Array<{
          id: string;
          timestamp: number;
          kind:
            | 'tool'
            | 'skill'
            | 'hook'
            | 'status'
            | 'task'
            | 'memory'
            | 'debug'
            | 'context'
            | 'permission';
          scope?: StreamEvent['agentScope'];
          title: string;
          summary?: string;
          detail?: string;
          taskId?: string;
          toolUseId?: string;
          parentToolUseId?: string | null;
          displayLevel?: StreamEvent['displayLevel'];
        }>;
        taskStates?: Record<string, unknown>;
        contextAudit?: StreamEvent['contextAudit'];
        todos?: Array<{ id: string; content: string; status: string }>;
        systemStatus: string | null;
        isThinking?: boolean;
        activeHook?: { hookName: string; hookEvent: string } | null;
        turnId?: string;
      };
    };

export type WsMessageIn =
  | {
      type: 'send_message';
      chatJid: string;
      content: string;
      attachments?: MessageAttachment[];
      agentId?: string;
      followUpBehavior?: FollowUpMode;
    }
  | { type: 'terminal_start'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_input'; chatJid: string; data: string }
  | { type: 'terminal_resize'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_stop'; chatJid: string };

// --- Streaming event types (canonical source: shared/stream-event.ts) ---
export type { StreamEventType } from './stream-event.types.js';
export type { StreamEvent };

// --- Billing types ---

export interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  tier: number; // 0=免费, 10=基础, 20=专业, 30=企业
  monthly_cost_usd: number;
  monthly_token_quota: number | null; // null=无限
  monthly_cost_quota: number | null; // null=无限
  daily_cost_quota: number | null; // null=无限
  weekly_cost_quota: number | null; // null=无限
  daily_token_quota: number | null; // null=无限
  weekly_token_quota: number | null; // null=无限
  rate_multiplier: number; // 费用倍率，默认 1.0
  trial_days: number | null; // 试用天数
  sort_order: number; // 排序权重
  display_price: string | null; // 展示价格文本（如 "¥99/月"）
  highlight: boolean; // 推荐标记
  max_groups: number | null;
  max_concurrent_containers: number | null;
  max_im_channels: number | null;
  max_mcp_servers: number | null;
  max_storage_mb: number | null;
  allow_overage: boolean;
  features: string[]; // JSON 特性标签
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'expired' | 'cancelled';
  started_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  trial_ends_at: string | null;
  notes: string | null;
  auto_renew: boolean;
  created_at: string;
}

export interface UserBalance {
  user_id: string;
  balance_usd: number;
  total_deposited_usd: number;
  total_consumed_usd: number;
  updated_at: string;
}

export type BalanceTransactionType =
  | 'deposit'
  | 'deduction'
  | 'refund'
  | 'adjustment'
  | 'redeem';
export type BalanceTransactionSource =
  | 'admin_manual_recharge'
  | 'admin_manual_deduct'
  | 'usage_charge'
  | 'redeem_code'
  | 'migration_opening'
  | 'refund'
  | 'subscription_renewal'
  | 'system_adjustment';
export type BalanceOperatorType = 'system' | 'admin' | 'user';
export type BalanceReferenceType =
  | 'message'
  | 'usage_event'
  | 'task'
  | 'subscription'
  | 'redeem_code'
  | 'admin_adjust';

export interface BalanceTransaction {
  id: number;
  user_id: string;
  type: BalanceTransactionType;
  amount_usd: number; // 正=入账, 负=扣除
  balance_after: number;
  description: string | null;
  reference_type: BalanceReferenceType | null;
  reference_id: string | null;
  actor_id: string | null;
  source: BalanceTransactionSource;
  operator_type: BalanceOperatorType;
  notes: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface MonthlyUsage {
  user_id: string;
  month: string; // YYYY-MM
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
  updated_at: string;
}

export type RedeemCodeType = 'balance' | 'subscription' | 'trial';

export interface RedeemCode {
  code: string;
  type: RedeemCodeType;
  value_usd: number | null;
  plan_id: string | null;
  duration_days: number | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_by: string;
  notes: string | null;
  batch_id: string | null;
  created_at: string;
}

export interface RedeemCodeUsage {
  id: number;
  code: string;
  user_id: string;
  redeemed_at: string;
}

export type BillingAuditEventType =
  | 'plan_created'
  | 'plan_updated'
  | 'plan_deleted'
  | 'subscription_assigned'
  | 'subscription_cancelled'
  | 'subscription_expired'
  | 'balance_adjusted'
  | 'manual_recharge'
  | 'manual_deduct'
  | 'balance_deducted'
  | 'code_created'
  | 'code_redeemed'
  | 'code_deleted'
  | 'wallet_blocked'
  | 'wallet_unblocked'
  | 'quota_exceeded'
  | 'billing_settings_updated';

export interface BillingAuditLog {
  id: number;
  event_type: BillingAuditEventType;
  user_id: string;
  actor_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DailyUsage {
  user_id: string;
  date: string; // YYYY-MM-DD
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
}

export interface QuotaWindowUsage {
  costUsed: number;
  costQuota: number | null;
  tokenUsed: number;
  tokenQuota: number | null;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  exceededWindow?: 'daily' | 'weekly' | 'monthly'; // 哪个窗口超限
  resetAt?: string; // 下次重置时间 ISO
  warningPercent?: number; // 当前用量百分比 (0-100+)
  usage?: QuotaWindowUsage & {
    daily?: QuotaWindowUsage;
    weekly?: QuotaWindowUsage;
  };
}

export type BillingBlockType =
  | 'insufficient_balance'
  | 'plan_inactive'
  | 'quota_exceeded'
  | 'resource_limit';

export interface BillingAccessResult {
  allowed: boolean;
  blockType?: BillingBlockType;
  reason?: string;
  balanceUsd: number;
  minBalanceUsd: number;
  balanceMissingUsd?: number;
  planId: string | null;
  planName: string | null;
  subscriptionStatus: 'active' | 'expired' | 'cancelled' | 'default' | null;
  warningPercent?: number;
  usage?: QuotaCheckResult['usage'];
  exceededWindow?: QuotaCheckResult['exceededWindow'];
  resetAt?: string;
}
