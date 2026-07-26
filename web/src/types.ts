export type InteractionMode = 'assistant' | 'proactive';

export interface GroupInfo {
  name: string;
  folder: string;
  added_at: string;
  interaction_mode: InteractionMode;
  kind?: 'home' | 'main' | 'feishu' | 'web';
  is_home?: boolean;
  is_my_home?: boolean;
  can_modify?: boolean;
  editable?: boolean;
  deletable?: boolean;
  lastMessage?: string;
  lastMessageTime?: string;
  execution_mode?: 'container' | 'host';
  custom_cwd?: string;
  created_by?: string;
  pinned_at?: string;
  activation_mode?:
    | 'auto'
    | 'always'
    | 'when_mentioned'
    | 'owner_mentioned'
    | 'disabled';
  require_mention?: boolean;
  conversation_source?: 'manual' | 'native_thread' | 'feishu_thread';
  conversation_nav_mode?: 'horizontal' | 'vertical_threads';
  agent_profile_id?: string;
  agent_profile_name?: string;
  agent_profile_version?: number;
  agent_profile_avatar_emoji?: string | null;
  agent_profile_avatar_color?: string | null;
  agent_profile_avatar_url?: string | null;
}

export interface AgentProfile {
  id: string;
  owner_user_id: string;
  name: string;
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
  prompt_mode: AgentProfilePromptMode;
  /** @deprecated Compatibility alias for prompt_mode === 'append'. */
  include_claude_preset: boolean;
  avatar_emoji: string | null;
  avatar_color: string | null;
  avatar_url: string | null;
  runtime_policy: AgentProfileRuntimePolicy;
  /** Policy after applying system defaults and current authorization. */
  effective_runtime_policy?: AgentProfileRuntimePolicy;
  identity_hash: string;
  version: number;
  is_default: boolean;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export type AgentProfilePromptMode = 'append' | 'replace';

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

export interface AgentProfileRuntimePolicy {
  context?: {
    source: 'managed' | 'host_claude';
    auto_compact_window?: number;
    auto_compact_percentage?: number;
  };
  skills: {
    mode: 'inherit' | 'custom' | 'disabled';
    ids: string[];
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

export type AgentContextSource = NonNullable<
  AgentProfileRuntimePolicy['context']
>['source'];

export function getAgentContextSource(
  policy?: Partial<AgentProfileRuntimePolicy> | null,
): AgentContextSource {
  return policy?.context?.source === 'host_claude' ? 'host_claude' : 'managed';
}

export function withAgentContextSource(
  policy: AgentProfileRuntimePolicy,
  source: AgentContextSource,
): AgentProfileRuntimePolicy {
  return {
    ...policy,
    context: { ...policy.context, source },
  };
}

export interface AgentProfileWorkspaceRuntimeSession {
  runtime_agent_id: string;
  sdk_session_id: string;
  provider_id: string | null;
  agent_profile_id: string | null;
  agent_profile_version: number | null;
  identity_hash: string | null;
  updated_at: string;
}

export interface AgentProfileWorkspace {
  jid: string;
  name: string;
  folder: string;
  is_home: boolean;
  execution_mode: 'container' | 'host';
  added_at: string;
  runtime_sessions: AgentProfileWorkspaceRuntimeSession[];
}

export interface AgentProfileChannelMount {
  channel_jid: string;
  channel_type: string;
  workspace_jid: string;
  workspace_folder: string | null;
  session_id: string | null;
  routing_mode: 'single_session' | 'thread_map';
  reply_policy: 'source_only' | 'mirror';
  activation_mode:
    | 'auto'
    | 'always'
    | 'when_mentioned'
    | 'owner_mentioned'
    | 'disabled';
  audience_mode: 'everyone' | 'owner_only';
  owner_im_id: string | null;
  updated_at: string;
}

export interface AgentProfileGovernance {
  profile: AgentProfile;
  workspaces: AgentProfileWorkspace[];
  channel_mounts: AgentProfileChannelMount[];
}

export type CapabilityLayerSource =
  | 'builtin'
  | 'host'
  | 'project'
  | 'workspace'
  | 'plugin'
  | 'managed'
  | 'system'
  | 'user';

export interface EffectiveCapabilityEntry {
  id: string;
  source: CapabilityLayerSource;
  overrides: CapabilityLayerSource[];
  available: boolean;
  unavailableReason?: 'system_admin_only';
}

export interface AgentCapabilityPreview {
  workspace: { jid: string; name: string; folder: string } | null;
  context: {
    source: 'managed' | 'host_claude';
    claudeMd: boolean;
    rules: number;
    nativeConfig: {
      settingsFiles: string[];
      entries: Array<{
        name: string;
        kind: 'file' | 'directory';
        entryCount?: number;
      }>;
    };
  };
  skills: {
    mode: AgentProfileRuntimePolicy['skills']['mode'];
    host: NonNullable<AgentProfileRuntimePolicy['skills']['host']>;
    manifestHash: string;
    entries: EffectiveCapabilityEntry[];
    conflicts: string[];
  };
  mcp: {
    mode: AgentProfileRuntimePolicy['mcp']['mode'];
    manifestHash: string;
    entries: EffectiveCapabilityEntry[];
    conflicts: string[];
  };
  notes: string[];
}

export interface RunContextSnapshot {
  chatJid: string;
  agentId: string | null;
  turnId: string | null;
  sessionId: string | null;
  capturedAt: string;
  executionMode: 'host' | 'container';
  agentProfile: {
    id: string;
    version: number;
    identityHash: string;
    runtimePolicyHash: string | null;
  } | null;
  prompt: {
    planHash: string | null;
    totalBytes: number;
    estimatedTokens: number | null;
    blocks: Array<{
      id: string;
      version: number | null;
      scope: 'main' | 'subagent' | 'both' | null;
      owner: 'platform' | 'agent_profile' | 'workspace' | 'channel' | null;
      required: boolean | null;
      condition: string | null;
      hash: string | null;
      bytes: number;
      estimatedTokens: number | null;
    }>;
  };
  skills: {
    manifestHash: string | null;
    selectedSkillIds: string[];
    total: number | null;
    included: number | null;
    tokens: number | null;
    sources: Array<{
      name: string;
      count: number | null;
      tokens: number | null;
    }>;
  };
  mcp: { manifestHash: string | null; serverIds: string[] };
  rules: { discovered: number; loaded: number | null };
  claudeMd: { status: string; loaded: boolean | null; tokens: number | null };
  sdkContext: {
    model: string;
    totalTokens: number;
    maxTokens: number;
    percentage: number;
    mcpTools: Array<{ name: string; serverName: string; tokens: number }>;
  } | null;
  budget: {
    status: 'unavailable' | 'ok' | 'warning' | 'hard_exceeded';
    startupTokens?: number;
    totalTokens?: number;
    maxTokens?: number;
    warningThreshold?: number;
    hardThreshold?: number;
    warning?: string;
    error?: string;
  } | null;
  subagentContract: {
    enabled: boolean;
    hash: string;
    sdkCompatibility: string;
    cliCompatibility: string;
  } | null;
  warnings: string[];
}

export type RunContextStatus =
  | 'none'
  | 'current'
  | 'stale_profile'
  | 'stale_config';

export interface AgentInfo {
  id: string;
  name: string;
  prompt: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  kind: 'task' | 'conversation' | 'spawn';
  created_at: string;
  completed_at?: string;
  result_summary?: string;
  linked_im_groups?: Array<{ jid: string; name: string }>;
  source_kind?: 'manual' | 'native_thread' | 'feishu_thread' | 'auto_im' | null;
  thread_id?: string | null;
  root_message_id?: string | null;
  title_source?:
    | 'manual'
    | 'native_root'
    | 'feishu_root'
    | 'auto'
    | 'auto_pending'
    | null;
  title_generating?: boolean;
  last_active_at?: string | null;
  latest_message?: { content: string; timestamp: string } | null;
}

export interface AvailableImGroup {
  jid: string;
  name: string;
  added_at: string;
  channel_account_id?: string | null;
  channel_account_name?: string | null;
  bound_agent_id: string | null;
  bound_session_id?: string | null;
  bound_main_jid: string | null;
  bound_workspace_jid?: string | null;
  bound_target_name: string | null;
  bound_workspace_name: string | null;
  reply_policy?: 'source_only' | 'mirror';
  avatar?: string;
  member_count?: number;
  channel_type: string;
  activation_mode?:
    | 'auto'
    | 'always'
    | 'when_mentioned'
    | 'owner_mentioned'
    | 'disabled';
  audience_mode?: 'everyone' | 'owner_only';
  require_mention?: boolean;
  owner_im_id?: string | null;
  binding_mode?: 'single_context' | 'thread_map';
  routing_mode?: 'single_session' | 'thread_map';
  chat_mode?: string;
  group_message_type?: string;
  is_thread_capable?: boolean;
  conversation_kind?: 'direct' | 'group' | 'unknown';
  sender_allowlist_locked?: boolean;
}

export interface WorkspaceDeleteBindingGroup {
  jid: string;
  name: string;
}

export interface WorkspaceDeleteBindingSession {
  sessionId: string;
  sessionName: string;
  imGroups: WorkspaceDeleteBindingGroup[];
}

export interface WorkspaceDeleteThreadContext extends WorkspaceDeleteBindingGroup {
  context_id: string;
}

export interface WorkspaceDeleteImpact {
  has_channel_bindings: boolean;
  channel_binding_count: number;
  bound_sessions: WorkspaceDeleteBindingSession[];
  bound_main_im_groups: WorkspaceDeleteBindingGroup[];
  bound_thread_contexts: WorkspaceDeleteThreadContext[];
}
