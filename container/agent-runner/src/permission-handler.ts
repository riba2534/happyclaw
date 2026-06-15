import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';

const PLAN_MODE_ALLOWED_PERMISSION_TOOLS = new Set([
  'ExitPlanMode',
  'EnterPlanMode',
]);

export interface PermissionDecisionInput {
  mode: PermissionMode;
  toolName: string;
  toolUseID?: string;
  suggestions?: PermissionUpdate[];
  decisionReason?: string;
  blockedPath?: string;
}

export interface CanUseToolHandlerOptions {
  getPermissionMode: () => PermissionMode;
  log?: (message: string) => void;
  emitStatus?: (statusText: string) => void;
}

export function decidePermissionRequest(input: PermissionDecisionInput): PermissionResult {
  const { mode, toolName, toolUseID, suggestions, decisionReason, blockedPath } = input;

  if (mode === 'plan' && !PLAN_MODE_ALLOWED_PERMISSION_TOOLS.has(toolName)) {
    return {
      behavior: 'deny',
      message: [
        `Plan mode is active, so HappyClaw did not run ${toolName}.`,
        decisionReason ? `Reason: ${decisionReason}.` : '',
        blockedPath ? `Blocked path: ${blockedPath}.` : '',
        'Switch to Code mode or approve the plan before running execution tools.',
      ].filter(Boolean).join(' '),
      interrupt: false,
      toolUseID,
    };
  }

  if (mode === 'dontAsk') {
    return {
      behavior: 'deny',
      message: [
        `Permission request for ${toolName} was denied because permission mode is dontAsk.`,
        decisionReason ? `Reason: ${decisionReason}.` : '',
      ].filter(Boolean).join(' '),
      interrupt: false,
      toolUseID,
    };
  }

  return {
    behavior: 'allow',
    updatedPermissions: suggestions && suggestions.length > 0 ? suggestions : undefined,
    toolUseID,
  };
}

export function createCanUseToolHandler(options: CanUseToolHandlerOptions): CanUseTool {
  return async (toolName, _input, requestOptions) => {
    const mode = options.getPermissionMode();

    if (requestOptions.signal.aborted) {
      options.log?.(`Permission request aborted before decision for ${toolName}`);
      return {
        behavior: 'deny',
        message: `Permission request for ${toolName} was aborted.`,
        interrupt: true,
        toolUseID: requestOptions.toolUseID,
      };
    }

    const result = decidePermissionRequest({
      mode,
      toolName,
      toolUseID: requestOptions.toolUseID,
      suggestions: requestOptions.suggestions,
      decisionReason: requestOptions.decisionReason,
      blockedPath: requestOptions.blockedPath,
    });

    options.log?.(`Permission request: ${result.behavior} ${toolName} in ${mode} mode`);
    options.emitStatus?.(`permission_${result.behavior}:${toolName}`);

    return result;
  };
}
