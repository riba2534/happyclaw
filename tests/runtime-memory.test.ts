import { describe, expect, it } from 'vitest';

import { buildCodexMemoryLifecyclePrompt } from '../container/agent-runner/src/runtime-memory.js';

describe('Codex memory lifecycle prompt', () => {
  it('tells home Codex runs to maintain canonical memory during the turn', () => {
    const prompt = buildCodexMemoryLifecyclePrompt({
      isHome: true,
      privacyMode: false,
      disableMemoryLayer: false,
      globalMemoryFile: '/workspace/global/CLAUDE.md',
      workspaceClaudeMdPath: '/workspace/group/CLAUDE.md',
    });

    expect(prompt).toContain('没有 Claude PreCompact hook');
    expect(prompt).toContain('/workspace/group/CLAUDE.md');
    expect(prompt).toContain('/workspace/global/CLAUDE.md');
    expect(prompt).toContain('memory_append');
    expect(prompt).toContain('不要创建 AGENTS.md');
  });

  it('keeps non-home Codex runs from writing global memory', () => {
    const prompt = buildCodexMemoryLifecyclePrompt({
      isHome: false,
      privacyMode: false,
      disableMemoryLayer: false,
      globalMemoryFile: '/workspace/global/CLAUDE.md',
      workspaceClaudeMdPath: '/workspace/group/CLAUDE.md',
    });

    expect(prompt).toContain('只读参考');
    expect(prompt).toContain('不要尝试写入全局记忆');
    expect(prompt).toContain('工作区 CLAUDE.md');
  });

  it('disables durable memory writes in privacy or disabled-memory modes', () => {
    const privacyPrompt = buildCodexMemoryLifecyclePrompt({
      isHome: true,
      privacyMode: true,
      disableMemoryLayer: false,
      globalMemoryFile: '/workspace/global/CLAUDE.md',
      workspaceClaudeMdPath: '/workspace/group/CLAUDE.md',
    });
    const disabledPrompt = buildCodexMemoryLifecyclePrompt({
      isHome: true,
      privacyMode: false,
      disableMemoryLayer: true,
      globalMemoryFile: '/workspace/global/CLAUDE.md',
      workspaceClaudeMdPath: '/workspace/group/CLAUDE.md',
    });

    expect(privacyPrompt).toContain('不要写入全局记忆');
    expect(disabledPrompt).toContain('记忆层已禁用');
    expect(disabledPrompt).toContain('不要调用 memory_append');
  });
});
