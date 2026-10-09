import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const WRITE_TOOLS = new Set([
  'mcp__happyclaw__workspace_memory_remember',
  'mcp__happyclaw__workspace_memory_update',
  'mcp__happyclaw__workspace_memory_forget',
]);
const OWNER_PROFILE_TOOLS = new Set([
  'mcp__happyclaw__happyclaw_owner_profile',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PreToolUse matcher (a regular expression on the tool name) for the guard
 * below. Every hook callback costs a control round-trip between Claude Code
 * and the runner, so the guard only runs for the tools it can deny.
 */
export const WORKSPACE_MEMORY_WRITE_GUARD_MATCHER = `^(${[
  ...WRITE_TOOLS,
  ...OWNER_PROFILE_TOOLS,
]
  .map(escapeRegExp)
  .join('|')})$`;

/** Sub-agents inherit the MCP server, so enforce read-only access in a hook. */
export function createWorkspaceMemoryWriteGuard(): HookCallback {
  return async (input) => {
    const preTool = input as PreToolUseHookInput;
    if (
      preTool.hook_event_name === 'PreToolUse' &&
      preTool.agent_id &&
      (WRITE_TOOLS.has(preTool.tool_name) ||
        OWNER_PROFILE_TOOLS.has(preTool.tool_name))
    ) {
      const ownerProfile = OWNER_PROFILE_TOOLS.has(preTool.tool_name);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: ownerProfile
            ? 'Owner Profile is private to the actual owner’s top-level HappyClaw turn and is unavailable to sub-agents.'
            : 'Sub-agents have read-only Workspace Memory access. Return proposed learnings to the top-level session.',
        },
      };
    }
    return {};
  };
}
