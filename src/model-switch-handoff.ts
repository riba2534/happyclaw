import {
  createConversationHandoffSummary,
  getMessagesPage,
} from './db.js';
import { logger } from './logger.js';
import { sdkQuery } from './sdk-query.js';
import type { ConversationHandoffSummary } from './types.js';

const DEFAULT_HANDOFF_MESSAGE_LIMIT = 40;
const HANDOFF_FETCH_LIMIT = 120;
const MAX_TRANSCRIPT_CHARS = 14000;
const MAX_FALLBACK_SUMMARY_CHARS = 6000;

interface HandoffMessage {
  id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

export interface CreateModelSwitchHandoffSummaryInput {
  groupFolder: string;
  agentId?: string | null;
  chatJid: string;
  reason?: string;
  createdBy?: string | null;
  excludeMessageIds?: Set<string>;
  limit?: number;
}

function isResetDivider(message: HandoffMessage): boolean {
  return (
    message.sender === '__system__' &&
    typeof message.content === 'string' &&
    message.content.startsWith('context_reset')
  );
}

function isCommandNoise(message: HandoffMessage): boolean {
  const content = (message.content || '').trim().toLowerCase();
  return content.startsWith('/model');
}

function normalizeMessages(
  chatJid: string,
  excludeMessageIds: Set<string>,
  limit: number,
): HandoffMessage[] {
  const rows = getMessagesPage(chatJid, undefined, HANDOFF_FETCH_LIMIT)
    .reverse()
    .map((message) => ({
      id: message.id,
      sender: message.sender,
      sender_name: message.sender_name,
      content: message.content || '',
      timestamp: message.timestamp,
      is_from_me: message.is_from_me,
    }));

  let start = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (isResetDivider(rows[i])) {
      start = i + 1;
      break;
    }
  }

  return rows
    .slice(start)
    .filter((message) => !excludeMessageIds.has(message.id))
    .filter((message) => !isCommandNoise(message))
    .filter((message) => message.sender !== '__system__')
    .filter((message) => !!message.content.trim())
    .slice(-limit);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}... [truncated]`;
}

function renderTranscript(messages: HandoffMessage[]): string {
  let transcript = '';
  for (const message of messages) {
    const who = message.is_from_me ? 'AI' : message.sender_name || '用户';
    const line = `[${message.timestamp}] ${who}: ${truncate(
      message.content.replace(/\s+/g, ' ').trim(),
      800,
    )}\n`;
    if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) break;
    transcript += line;
  }
  return transcript.trim();
}

function fallbackSummary(messages: HandoffMessage[]): string {
  if (messages.length === 0) {
    return '本次模型切换前没有可用的历史消息。下一轮只需要处理用户的新消息。';
  }
  const lines = messages.map((message) => {
    const who = message.is_from_me ? 'AI' : message.sender_name || '用户';
    const text = truncate(message.content.replace(/\s+/g, ' ').trim(), 220);
    return `- ${who}: ${text}`;
  });
  return truncate(
    [
      `以下是模型切换前最近 ${messages.length} 条消息的压缩记录。LLM 摘要不可用，因此保留为短摘录：`,
      ...lines,
    ].join('\n'),
    MAX_FALLBACK_SUMMARY_CHARS,
  );
}

async function summarizeTranscript(
  transcript: string,
): Promise<string | null> {
  if (!transcript.trim()) return null;
  const prompt = [
    '请把下面这段 HappyClaw 对话压缩成给下一个模型接手用的中文上下文摘要。',
    '要求：',
    '- 只保留用户目标、已达成结论、关键事实、正在进行的任务、未解决问题。',
    '- 不要逐条复述原文，不要写寒暄。',
    '- 不要加入你自己的新判断。',
    '- 输出 5 到 12 条要点，必要时分“已知/待办/风险”。',
    '',
    transcript,
  ].join('\n');
  return sdkQuery(prompt, {
    model: process.env.MODEL_SWITCH_SUMMARY_MODEL || process.env.RECALL_MODEL,
    timeout: 30_000,
  });
}

export async function createModelSwitchHandoffSummary(
  input: CreateModelSwitchHandoffSummaryInput,
): Promise<ConversationHandoffSummary> {
  const limit = input.limit ?? DEFAULT_HANDOFF_MESSAGE_LIMIT;
  const messages = normalizeMessages(
    input.chatJid,
    input.excludeMessageIds ?? new Set<string>(),
    limit,
  );
  const transcript = renderTranscript(messages);
  let summaryText = await summarizeTranscript(transcript);
  let fallbackUsed = false;

  if (!summaryText) {
    fallbackUsed = true;
    summaryText = fallbackSummary(messages);
  }

  const first = messages[0];
  const last = messages[messages.length - 1];
  const summary = createConversationHandoffSummary({
    groupFolder: input.groupFolder,
    agentId: input.agentId || '',
    chatJid: input.chatJid,
    reason: input.reason || 'model_binding_changed',
    summaryText,
    sourceMessageCount: messages.length,
    sourceFirstMessageId: first?.id ?? null,
    sourceLastMessageId: last?.id ?? null,
    sourceLastMessageTimestamp: last?.timestamp ?? null,
    fallbackUsed,
    createdBy: input.createdBy ?? null,
  });

  logger.info(
    {
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      agentId: input.agentId || '',
      summaryId: summary.id,
      messageCount: messages.length,
      summaryLen: summary.summary_text.length,
      fallbackUsed,
    },
    'Model switch handoff summary created',
  );

  return summary;
}
