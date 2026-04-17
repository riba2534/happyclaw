/**
 * Shared types for HappyClaw Agent Runner.
 *
 * These types are used across index.ts, stream-processor.ts, and mcp-tools.ts.
 */

// Streaming event types (canonical source: shared/stream-event.ts)
export type { StreamEventType, StreamEvent } from './stream-event.types.js';
import type { StreamEvent } from './stream-event.types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  turnId?: string;
  groupFolder: string;
  chatJid: string;
  /** @deprecated Use isHome + isAdminHome instead. Kept for backward compatibility with older host processes. */
  isMain?: boolean;
  /** Whether this is the user's home container (admin or member). */
  isHome?: boolean;
  /** Whether this is the admin's home container (full privileges). */
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** If the last unprocessed message was emitted by a scheduled task prompt,
   * this is that task's ID; used to tag MCP send_message outputs so the host
   * routes results to the task's configured chat_jid / notify channels. */
  messageTaskId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: 'sdk_final' | 'sdk_send_message' | 'interrupt_partial' | 'overflow_partial' | 'compact_partial' | 'legacy' | 'auto_continue';
  finalizationReason?: 'completed' | 'interrupted' | 'error';
}

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }>;
  };
  parent_tool_use_id: null;
  session_id: string;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}
