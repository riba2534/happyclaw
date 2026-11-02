/**
 * When a conversation's context is cleared, so the Web can empty its context
 * ring at once. Kept apart from session-context-usage, which reads
 * transcripts and provider configuration, so the command paths that clear a
 * session stay light.
 */
type ClearedListener = (groupFolder: string, agentId: string) => void;
const clearedListeners = new Set<ClearedListener>();

/** Called whenever a conversation's context is cleared (the Web is told). */
export function onConversationContextCleared(
  listener: ClearedListener,
): () => void {
  clearedListeners.add(listener);
  return () => clearedListeners.delete(listener);
}

/** A /clear, /fresh or session reset emptied this conversation's context. */
export function notifyConversationContextCleared(
  groupFolder: string,
  agentId: string,
): void {
  for (const listener of clearedListeners) listener(groupFolder, agentId);
}
