/**
 * Predefined SubAgent definitions for HappyClaw.
 *
 * These agents are registered via the SDK `agents` option in query(),
 * making them available as Task tool targets within the agent session.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

// SubAgent 模型：默认 inherit（继承主会话模型，与不指定 model 行为一致，不擅自改变）。
// 由 SystemSettings.subagentModel 经 SUBAGENT_MODEL 注入，可在设置页改成
// 'sonnet' / 'opus' / 'haiku' 或完整 model ID（第三方 provider 需配 ANTHROPIC_DEFAULT_* 别名映射）。
const SUBAGENT_MODEL = process.env.SUBAGENT_MODEL || 'inherit';

export const PREDEFINED_AGENTS: Record<string, AgentDefinition> = {
  'code-reviewer': {
    description: 'Code review agent that analyzes code quality, best practices, and potential issues',
    prompt:
      'You are a strict code reviewer. Focus on correctness, security, performance, and maintainability. ' +
      'Point out specific issues with file:line references. Be concise and actionable.',
    tools: ['Read', 'Glob', 'Grep'],
    model: SUBAGENT_MODEL,
    maxTurns: 15,
  },
  'web-researcher': {
    description: 'Web research agent that searches and extracts information from web pages',
    prompt:
      'You are an efficient web researcher. Search for information, extract key facts, and summarize findings. ' +
      'Always cite sources with URLs. Prefer authoritative sources.',
    tools: ['WebSearch', 'WebFetch', 'Read', 'Write'],
    model: SUBAGENT_MODEL,
    maxTurns: 20,
  },
};
