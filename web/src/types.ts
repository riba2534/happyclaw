export interface GroupInfo {
  name: string;
  folder: string;
  added_at: string;
  kind?: 'home' | 'main' | 'feishu' | 'web';
  is_home?: boolean;
  is_my_home?: boolean;
  is_shared?: boolean;
  member_role?: 'owner' | 'member';
  member_count?: number;
  editable?: boolean;
  deletable?: boolean;
  lastMessage?: string;
  lastMessageTime?: string;
  execution_mode?: 'container' | 'host';
  custom_cwd?: string;
  created_by?: string;
  pinned_at?: string;
  activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled';
  conversation_source?: 'manual' | 'feishu_thread';
  conversation_nav_mode?: 'horizontal' | 'vertical_threads';
}

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
  source_kind?: 'manual' | 'feishu_thread' | null;
  thread_id?: string | null;
  root_message_id?: string | null;
  title_source?: 'manual' | 'feishu_root' | 'auto' | 'auto_pending' | null;
  title_generating?: boolean;
  last_active_at?: string | null;
  latest_message?: { content: string; timestamp: string } | null;
}

export interface AvailableImGroup {
  jid: string;
  name: string;
  bound_agent_id: string | null;
  bound_main_jid: string | null;
  bound_target_name: string | null;
  bound_workspace_name: string | null;
  reply_policy?: 'source_only' | 'mirror';
  avatar?: string;
  member_count?: number;
  channel_type: string;
  activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled';
  owner_im_id?: string | null;
  binding_mode?: 'single_context' | 'thread_map';
  chat_mode?: string;
  group_message_type?: string;
  is_thread_capable?: boolean;
  sender_allowlist_locked?: boolean;
}

export interface GroupMember {
  user_id: string;
  role: 'owner' | 'member';
  added_at: string;
  added_by?: string;
  username: string;
  display_name: string;
}
