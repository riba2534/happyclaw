import { describe, expect, test } from 'vitest';
import {
  describeToolActivity,
  describeToolName,
  shortenPath,
  stripShellWrapper,
} from '../web/src/components/chat/ToolActivityCard';

describe('tool activity presentation', () => {
  test('keeps the interesting end of long paths', () => {
    expect(shortenPath('web/src/App.tsx')).toBe('web/src/App.tsx');
    expect(
      shortenPath(
        '/workspace/group/happyclaw/web/src/components/chat/SessionSidebar.tsx',
      ),
    ).toBe('…/chat/SessionSidebar.tsx');
  });

  test('strips login-shell wrappers from commands', () => {
    expect(stripShellWrapper("bash -lc 'npm test'")).toBe('npm test');
    expect(stripShellWrapper('/bin/zsh -c "make build"')).toBe('make build');
    expect(stripShellWrapper('npm test')).toBe('npm test');
  });

  test('names tools with verbs and keeps MCP tools recognisable', () => {
    expect(describeToolName('Bash').verb).toBe('运行');
    expect(describeToolName('Skill', 'ui-optimizer').verb).toBe('ui-optimizer');
    expect(describeToolName('mcp__happyclaw__send_message').verb).toBe(
      'happyclaw.send_message',
    );
    expect(describeToolName('CustomTool').verb).toBe('CustomTool');
    expect(describeToolActivity('Edit')).toBe('正在修改文件');
    expect(describeToolActivity('Unknown')).toBe('正在调用工具');
  });
});
