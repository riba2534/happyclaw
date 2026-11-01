import type { Message } from '../../../stores/chat';
import { withoutUploadedFiles } from '../composer-helpers';
import { sessionIdOf } from '../../../lib/session-jid';

const SENT_HISTORY_LIMIT = 50;

/**
 * What this user sent in a conversation, newest first, for ↑ recall: their
 * own messages only (not IM members or the agent), consecutive repeats once,
 * without the uploaded-file announcement (the files are not attached again).
 */
export function sentMessageHistory(
  state: { agentMessages: Record<string, Message[] | undefined> },
  draftKey: string,
  userId: string | undefined,
): string[] {
  const sessionId = sessionIdOf(draftKey);
  const messages = (sessionId && state.agentMessages[sessionId]) || [];
  const history: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.is_from_me || message.sender === '__system__') continue;
    if (userId && message.sender !== userId) continue;
    const content = withoutUploadedFiles(message.content).trim();
    if (!content || content === history[history.length - 1]) continue;
    history.push(content);
    if (history.length >= SENT_HISTORY_LIMIT) break;
  }
  return history;
}
