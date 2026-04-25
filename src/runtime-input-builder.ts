import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { getRuntimeInjectionPolicy } from './runtime-injection-policy.js';
import type { AgentRuntime, RuntimeNativeSession } from './types.js';

export interface RuntimeContextMessage {
  id: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}

export interface RuntimeHandoffSummary {
  id: string;
  text: string;
}

export interface RuntimeContextBuildInput {
  runtime: AgentRuntime | undefined;
  groupFolder: string;
  agentId?: string | null;
  chatJid: string;
  turnId?: string | null;
  basePrompt: string;
  sessionId?: string | null;
  nativeSession?: RuntimeNativeSession;
  privacyMode?: boolean;
  workspaceInstructions?: string | null;
  recentMessages?: RuntimeContextMessage[];
  handoffSummary?: RuntimeHandoffSummary | null;
  suppressRecentHistory?: boolean;
  forceSoftInjectionReason?: string | null;
}

export interface RuntimeContextBuildResult {
  prompt: string;
  resumeMode: 'resume' | 'fresh' | 'soft_inject';
  softInjectionReason: string | null;
  inputContextHash: string;
  workspaceInstructionHash: string | null;
  summaryId: string | null;
  injectedBlockKinds: string[];
}

interface ContextBlock {
  kind: string;
  content: string;
  hash: string;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}... [truncated]`;
}

function determineSoftInjectionReason(
  input: RuntimeContextBuildInput,
): string | null {
  if (input.forceSoftInjectionReason) return input.forceSoftInjectionReason;
  if (!input.sessionId) return 'no_native_session';
  if (!input.nativeSession) return 'legacy_or_unregistered_native_session';
  if (!input.nativeSession.based_on_message_id) {
    return 'native_session_without_based_on_cursor';
  }
  return null;
}

function shouldInjectWorkspaceInstructions(
  runtime: AgentRuntime,
  softInjectionReason: string | null,
): boolean {
  const policy = getRuntimeInjectionPolicy(runtime);
  if (policy.injectWorkspaceInstructions === 'always') return true;
  if (policy.injectWorkspaceInstructions === 'when_soft_inject') {
    return !!softInjectionReason;
  }
  return false;
}

function shouldInjectRecentHistory(
  runtime: AgentRuntime,
  softInjectionReason: string | null,
  hasSessionId: boolean,
): boolean {
  const policy = getRuntimeInjectionPolicy(runtime);
  if (policy.injectRecentHistory === 'never') return false;
  if (policy.injectRecentHistory === 'when_soft_inject') {
    return !!softInjectionReason;
  }
  if (policy.injectRecentHistory === 'when_no_native_session') {
    return !hasSessionId;
  }
  return false;
}

function renderRecentMessages(messages: RuntimeContextMessage[]): string {
  const lines = messages.map((message) => {
    const role = message.is_from_me ? 'assistant' : message.sender_name || 'user';
    const content = truncateText(message.content || '', 1000);
    return `  <message id="${escapeXml(message.id)}" role="${escapeXml(role)}" time="${escapeXml(message.timestamp)}">${escapeXml(content)}</message>`;
  });
  return `<recent-messages>\n${lines.join('\n')}\n</recent-messages>`;
}

function renderHandoffSummary(summary: RuntimeHandoffSummary): string {
  return `<handoff-summary id="${escapeXml(summary.id)}">\n${escapeXml(summary.text)}\n</handoff-summary>`;
}

function renderContext(
  reason: string | null,
  blocks: ContextBlock[],
): string {
  const attrs = reason ? ` reason="${escapeXml(reason)}"` : '';
  return [
    `<happyclaw-context${attrs}>`,
    ...blocks.map((block) => block.content),
    '</happyclaw-context>',
  ].join('\n');
}

export function readWorkspaceInstructions(groupFolder: string): string | null {
  const claudeMdPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  try {
    if (!fs.existsSync(claudeMdPath)) return null;
    const content = fs.readFileSync(claudeMdPath, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function writeDebugDump(
  input: RuntimeContextBuildInput,
  result: RuntimeContextBuildResult,
  contextText: string,
): void {
  if (process.env.HAPPYCLAW_RUNTIME_DEBUG !== '1') return;
  const turnId = input.turnId || `${Date.now()}`;
  const dir = path.join(
    DATA_DIR,
    'runtime-debug',
    input.groupFolder,
    input.agentId || 'main',
    turnId,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'runtime-input-meta.json'),
      JSON.stringify(
        {
          runtime: input.runtime || 'claude',
          chatJid: input.chatJid,
          groupFolder: input.groupFolder,
          agentId: input.agentId || '',
          resumeMode: result.resumeMode,
          softInjectionReason: result.softInjectionReason,
          inputContextHash: result.inputContextHash,
          workspaceInstructionHash: result.workspaceInstructionHash,
          injectedBlockKinds: result.injectedBlockKinds,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(path.join(dir, 'context.md'), contextText);
    fs.writeFileSync(path.join(dir, 'runtime-input.md'), result.prompt);
  } catch {
    // Debug dumps are best-effort and must never break a run.
  }
}

export function buildRuntimePrompt(
  input: RuntimeContextBuildInput,
): RuntimeContextBuildResult {
  const runtime = input.runtime || 'claude';
  const softInjectionReason = determineSoftInjectionReason(input);
  const blocks: ContextBlock[] = [];
  const workspaceInstructions =
    input.workspaceInstructions ?? readWorkspaceInstructions(input.groupFolder);

  if (
    workspaceInstructions &&
    shouldInjectWorkspaceInstructions(runtime, softInjectionReason)
  ) {
    const content = `<workspace-instructions source="CLAUDE.md">\n${escapeXml(workspaceInstructions)}\n</workspace-instructions>`;
    blocks.push({
      kind: 'workspace_instructions',
      content,
      hash: sha256(workspaceInstructions),
    });
  }

  const recentMessages = input.recentMessages || [];
  const handoffSummary = !input.privacyMode && input.handoffSummary?.text.trim()
    ? input.handoffSummary
    : null;
  if (handoffSummary && softInjectionReason) {
    const rendered = renderHandoffSummary(handoffSummary);
    blocks.push({
      kind: 'handoff_summary',
      content: rendered,
      hash: sha256(rendered),
    });
  }
  const modelSwitchWithoutSummary =
    softInjectionReason === 'model_binding_changed' && !handoffSummary;
  if (
    !input.suppressRecentHistory &&
    !handoffSummary &&
    !modelSwitchWithoutSummary &&
    !input.privacyMode &&
    recentMessages.length > 0 &&
    shouldInjectRecentHistory(runtime, softInjectionReason, !!input.sessionId)
  ) {
    const rendered = renderRecentMessages(recentMessages);
    blocks.push({
      kind: 'recent_messages',
      content: rendered,
      hash: sha256(rendered),
    });
  }

  const contextText = blocks.length > 0 ? renderContext(softInjectionReason, blocks) : '';
  const prompt = contextText ? `${contextText}\n\n${input.basePrompt}` : input.basePrompt;
  const inputContextHash = sha256(contextText || '');
  const workspaceInstructionHash = workspaceInstructions
    ? sha256(workspaceInstructions)
    : null;
  const resumeMode = softInjectionReason
    ? 'soft_inject'
    : input.sessionId
      ? 'resume'
      : 'fresh';

  const result: RuntimeContextBuildResult = {
    prompt,
    resumeMode,
    softInjectionReason,
    inputContextHash,
    workspaceInstructionHash,
    summaryId: handoffSummary?.id ?? null,
    injectedBlockKinds: blocks.map((block) => block.kind),
  };
  writeDebugDump(input, result, contextText);
  return result;
}
