import type { StreamEvent } from './stream-event.types.js';

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
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
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export type ExecutionMode = 'container' | 'host';

export interface RegisteredGroup {
  name: string;
  folder: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  executionMode?: ExecutionMode; // 默认 'container'
  customCwd?: string; // 宿主机模式的自定义工作目录（绝对路径）
  initSourcePath?: string; // 容器模式下复制来源的宿主机绝对路径
  initGitUrl?: string; // 容器模式下 clone 来源的 Git URL
  created_by?: string;
  is_home?: boolean; // 用户主容器标记
  selected_skills?: string[] | null; // null = 全部启用
}

export interface GroupMember {
  user_id: string;
  role: 'owner' | 'member';
  added_at: string;
  added_by?: string;
  username: string;
  display_name: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: string;
}

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
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  created_by?: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
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
  | 'view_audit_log';

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
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
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
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
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
  | 'register_success';

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
export type AgentKind = 'task' | 'conversation';

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
}

// WebSocket message types
export type WsMessageOut =
  | {
      type: 'new_message';
      chatJid: string;
      message: NewMessage & { is_from_me: boolean };
      agentId?: string;
    }
  | { type: 'agent_reply'; chatJid: string; text: string; timestamp: string; agentId?: string }
  | { type: 'typing'; chatJid: string; isTyping: boolean; agentId?: string }
  | {
      type: 'status_update';
      activeContainers: number;
      activeHostProcesses: number;
      activeTotal: number;
      queueLength: number;
    }
  | { type: 'stream_event'; chatJid: string; event: StreamEvent; agentId?: string }
  | {
      type: 'agent_status';
      chatJid: string;
      agentId: string;
      status: AgentStatus;
      kind?: AgentKind;
      name: string;
      prompt: string;
      resultSummary?: string;
    }
  | { type: 'terminal_output'; chatJid: string; data: string }
  | { type: 'terminal_started'; chatJid: string }
  | { type: 'terminal_stopped'; chatJid: string; reason?: string }
  | { type: 'terminal_error'; chatJid: string; error: string };

export type WsMessageIn =
  | { type: 'send_message'; chatJid: string; content: string; attachments?: MessageAttachment[]; agentId?: string }
  | { type: 'terminal_start'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_input'; chatJid: string; data: string }
  | { type: 'terminal_resize'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_stop'; chatJid: string };

// --- Streaming event types (canonical source: shared/stream-event.ts) ---
export type { StreamEventType } from './stream-event.types.js';
export type { StreamEvent };
