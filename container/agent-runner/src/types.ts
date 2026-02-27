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
  groupFolder: string;
  chatJid: string;
  /** @deprecated Use isHome + isAdminHome instead. Kept for backward compatibility with older host processes. */
  isMain?: boolean;
  /** Whether this is the user's home container (admin or member). */
  isHome?: boolean;
  /** Whether this is the admin's home container (full privileges). */
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
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

export interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;
  };
  parent_tool_use_id: null;
  session_id: string;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}
