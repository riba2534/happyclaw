export interface CodexMemoryLifecycleInput {
  isHome: boolean;
  privacyMode: boolean;
  disableMemoryLayer: boolean;
  globalMemoryFile: string;
  workspaceClaudeMdPath: string;
}

/**
 * Codex SDK currently does not expose Claude's PreCompact hook. HappyClaw keeps
 * the memory policy light: Codex gets an explicit prompt-level contract to
 * maintain the same canonical files during the turn instead of waiting for a
 * hidden compaction callback.
 */
export function buildCodexMemoryLifecyclePrompt(
  input: CodexMemoryLifecycleInput,
): string {
  const lines = [
    '<codex-memory-lifecycle>',
    'Codex 当前没有 Claude PreCompact hook；不要等待上下文压缩回调来保存记忆或同步工作区状态。',
    '如果本轮获得了跨会话仍有用的信息，或工作区状态/目录/关键决策发生变化，应在本轮内用可用工具维护同一套 canonical 文件。',
    `工作区规范文件是 ${input.workspaceClaudeMdPath}；需要更新工作区事实时，只维护这个 CLAUDE.md 体系，不要创建 AGENTS.md 或第二套说明文件。`,
  ];

  if (input.privacyMode) {
    lines.push(
      '当前是隐私模式：不要写入全局记忆、日期记忆或 conversations 归档；只在用户明确要求且内容属于当前工作区时更新工作区文件。',
      '</codex-memory-lifecycle>',
    );
    return lines.join('\n');
  }

  if (input.disableMemoryLayer) {
    lines.push(
      'HappyClaw 记忆层已禁用：不要调用 memory_append/memory_search/memory_get；只按当前运行时自身能力和工作区 CLAUDE.md 工作。',
      '</codex-memory-lifecycle>',
    );
    return lines.join('\n');
  }

  if (input.isHome) {
    lines.push(
      `全局长期记忆文件是 ${input.globalMemoryFile}；用户身份、长期偏好、常用项目、明确要求“记住”的内容，应通过 Read/Edit 原地维护这个文件。`,
      '临时进展、当天决策、待办和讨论纪要优先用 memory_append 写入日期记忆。',
      '维护记忆时保持简洁、去重、无模型专属措辞；如果没有值得保存的内容，不要为了维护而调用工具。',
    );
  } else {
    lines.push(
      '当前不是 home 工作区：全局记忆和日期记忆按只读参考处理；需要回忆时使用 memory_search/memory_get，不要尝试写入全局记忆。',
      '如果本工作区的当前状态、目录结构或关键决策变化，可以直接维护工作区 CLAUDE.md。',
    );
  }

  lines.push('</codex-memory-lifecycle>');
  return lines.join('\n');
}
