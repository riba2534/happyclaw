import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__happyclaw__*',
];

export const MEMORY_FLUSH_ALLOWED_TOOLS = [
  'mcp__happyclaw__memory_search',
  'mcp__happyclaw__memory_get',
  'mcp__happyclaw__memory_append',
  'Read',
  'Edit',
];

export const MEMORY_FLUSH_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'WebSearch',
  'WebFetch',
  'Glob',
  'Grep',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__happyclaw__send_message',
  'mcp__happyclaw__schedule_task',
  'mcp__happyclaw__list_tasks',
  'mcp__happyclaw__pause_task',
  'mcp__happyclaw__resume_task',
  'mcp__happyclaw__cancel_task',
  'mcp__happyclaw__register_group',
];

export const CLAUDEMD_UPDATE_ALLOWED_TOOLS = ['Read', 'Edit'];

export const CLAUDEMD_UPDATE_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'WebSearch',
  'WebFetch',
  'Glob',
  'Grep',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__happyclaw__send_message',
  'mcp__happyclaw__send_image',
  'mcp__happyclaw__send_file',
  'mcp__happyclaw__schedule_task',
  'mcp__happyclaw__list_tasks',
  'mcp__happyclaw__pause_task',
  'mcp__happyclaw__resume_task',
  'mcp__happyclaw__cancel_task',
  'mcp__happyclaw__register_group',
  'mcp__happyclaw__install_skill',
  'mcp__happyclaw__uninstall_skill',
  'mcp__happyclaw__memory_append',
  'mcp__happyclaw__memory_search',
  'mcp__happyclaw__memory_get',
];

export interface RuntimePermissionInput {
  privacyMode?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface ClaudePermissionOptions {
  allowedTools: string[];
  disallowedTools?: string[];
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions: boolean;
}

export interface CodexPermissionOptions {
  sandboxMode: 'danger-full-access';
  approvalPolicy: 'never';
}

/**
 * HappyClaw owns product-level permissions through workspace mounts, IPC
 * handlers, and MCP side-effect boundaries. Runtime permission flags are just
 * adapter translations of that policy.
 */
export function resolveClaudePermissionOptions(
  input: RuntimePermissionInput = {},
): ClaudePermissionOptions {
  return {
    allowedTools: input.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
    ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
}

export function resolveCodexPermissionOptions(
  _input: RuntimePermissionInput = {},
): CodexPermissionOptions {
  return {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
  };
}
