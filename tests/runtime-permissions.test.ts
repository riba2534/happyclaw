import { describe, expect, it } from 'vitest';

import {
  CLAUDEMD_UPDATE_ALLOWED_TOOLS,
  CLAUDEMD_UPDATE_DISALLOWED_TOOLS,
  DEFAULT_ALLOWED_TOOLS,
  MEMORY_FLUSH_ALLOWED_TOOLS,
  MEMORY_FLUSH_DISALLOWED_TOOLS,
  resolveClaudePermissionOptions,
  resolveCodexPermissionOptions,
} from '../container/agent-runner/src/runtime-permissions.js';

describe('runtime permission policy', () => {
  it('translates the default HappyClaw policy to Claude SDK options', () => {
    const options = resolveClaudePermissionOptions();

    expect(options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(options.allowedTools).toEqual(DEFAULT_ALLOWED_TOOLS);
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'mcp__happyclaw__*']),
    );
    expect(options.disallowedTools).toBeUndefined();
  });

  it('preserves maintenance-mode allow and deny lists for Claude SDK', () => {
    const options = resolveClaudePermissionOptions({
      allowedTools: MEMORY_FLUSH_ALLOWED_TOOLS,
      disallowedTools: MEMORY_FLUSH_DISALLOWED_TOOLS,
    });

    expect(options.allowedTools).toEqual(
      expect.arrayContaining([
        'Read',
        'Edit',
        'mcp__happyclaw__memory_append',
      ]),
    );
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'mcp__happyclaw__send_message',
        'mcp__happyclaw__schedule_task',
      ]),
    );
  });

  it('keeps CLAUDE.md maintenance scoped to file edits only', () => {
    const options = resolveClaudePermissionOptions({
      allowedTools: CLAUDEMD_UPDATE_ALLOWED_TOOLS,
      disallowedTools: CLAUDEMD_UPDATE_DISALLOWED_TOOLS,
    });

    expect(options.allowedTools).toEqual(['Read', 'Edit']);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'mcp__happyclaw__send_message',
        'mcp__happyclaw__memory_append',
      ]),
    );
  });

  it('translates the HappyClaw policy to Codex SDK/CLI options', () => {
    const options = resolveCodexPermissionOptions({ privacyMode: true });

    expect(options).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
  });
});
