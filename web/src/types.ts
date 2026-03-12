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
  selected_skills?: string[] | null;
  pinned_at?: string;
  activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
}

export interface AgentInfo {
  id: string;
  name: string;
  prompt: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  kind: 'task' | 'conversation';
  created_at: string;
  completed_at?: string;
  result_summary?: string;
  linked_im_groups?: Array<{ jid: string; name: string }>;
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
}

export interface GroupMember {
  user_id: string;
  role: 'owner' | 'member';
  added_at: string;
  added_by?: string;
  username: string;
  display_name: string;
}
