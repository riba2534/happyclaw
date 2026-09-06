export type TemplateParameterType = 'string' | 'number' | 'date' | 'path';

export interface TemplateParameterDefinition {
  name: string;
  label: string;
  type: TemplateParameterType;
  required: boolean;
  default_value?: string;
  description?: string;
}

export interface TaskTemplate {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  prompt_template: string;
  parameter_definitions: TemplateParameterDefinition[];
  default_schedule_type: 'cron' | 'interval' | 'once';
  default_schedule_value: string;
  default_context_mode: 'group' | 'isolated';
  default_execution_type: 'agent' | 'script';
  default_execution_mode?: 'host' | 'container' | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRunArtifact {
  id: string;
  run_id: string;
  task_id: string;
  workspace_jid: string;
  workspace_folder: string;
  name: string;
  original_path: string;
  storage_path: string;
  file_hash: string;
  file_size: number;
  mime_type: string;
  created_by?: string | null;
  created_at: string;
}

export interface TaskDraft {
  source_type: 'run' | 'template';
  source_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  execution_type: 'agent' | 'script';
  execution_mode: 'host' | 'container' | null;
  script_command: string | null;
  chat_jid: string;
  suggested_workspace_jid?: string;
  notify_channels: null;
  delivery_route_jid: null;
  template_parameters?: Record<string, string>;
  parameter_definitions?: TemplateParameterDefinition[];
}
