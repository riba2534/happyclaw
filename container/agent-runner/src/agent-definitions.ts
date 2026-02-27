/**
 * Predefined SubAgent definitions for HappyClaw.
 *
 * These agents are registered via the SDK `agents` option in query(),
 * making them available as Task tool targets within the agent session.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export const PREDEFINED_AGENTS: Record<string, AgentDefinition> = {
  'code-reviewer': {
    description: 'Code review agent that analyzes code quality, best practices, and potential issues',
    prompt:
      'You are a strict code reviewer. Focus on correctness, security, performance, and maintainability. ' +
      'Point out specific issues with file:line references. Be concise and actionable.',
    tools: ['Read', 'Glob', 'Grep'],
    maxTurns: 15,
  },
  'web-researcher': {
    description: 'Web research agent that searches and extracts information from web pages',
    prompt:
      'You are an efficient web researcher. Search for information, extract key facts, and summarize findings. ' +
      'Always cite sources with URLs. Prefer authoritative sources.',
    tools: ['WebSearch', 'WebFetch', 'Read', 'Write'],
    maxTurns: 20,
  },
};
