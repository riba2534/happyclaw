import type { IpcInputMessage } from './ipc-delivery.js';

/** Claude-specific account/usage-limit phrases (not generic API errors). */
const CLAUDE_LIMIT_PHRASE_PATTERNS = [
  /\bout of extra usage\b/i,
  // Optional qualifier before "limit" so the real Claude banner "you've hit
  // your SESSION limit" (also "weekly"/"usage") matches, not just "your limit".
  // Keep in sync with the copy in src/agent-output-parser.ts.
  /\byou(?:'ve|'re| are)\s+(?:hit|out of|reached)\s+(?:your\s+)?(?:\w+\s+)?(?:limit|extra usage)\b/i,
  /\busage\s+limit\s+reached\b/i,
  /\bupgrade\s+to\s+(?:increase|raise)\s+your\s+usage\s+limit\b/i,
  /\byour\s+(?:usage\s+)?limit\s+will\s+reset\b/i,
];

const CLAUDE_LIMIT_RESET_PATTERN =
  /\bresets?\b[^.\n]*?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*\([^)]*\)/i;
const CLAUDE_LIMIT_NOTICE_MAX_LEN = 200;

/** Keep this deliberately strict; a match triggers a transparent model retry. */
export function isProviderLimitNotice(result: string | null): boolean {
  if (!result) return false;
  const trimmed = result.trim();
  if (!trimmed) return false;
  const hasLimitPhrase = CLAUDE_LIMIT_PHRASE_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
  return (
    hasLimitPhrase &&
    (CLAUDE_LIMIT_RESET_PATTERN.test(trimmed) ||
      trimmed.length <= CLAUDE_LIMIT_NOTICE_MAX_LEN)
  );
}

/**
 * Per-process model state. Once the primary tier is exhausted, all later warm
 * IPC turns stay on the fallback tier instead of paying one failed call each.
 */
export class ProviderFallbackModelState {
  readonly primaryModel: string;
  readonly fallbackModel: string;
  private fallbackActive = false;

  constructor(primaryModel: string, fallbackModel?: string) {
    this.primaryModel = primaryModel.trim();
    this.fallbackModel = fallbackModel?.trim() ?? '';
  }

  get activeModelOverride(): string | undefined {
    return this.fallbackActive ? this.fallbackModel : undefined;
  }

  get canActivateFallback(): boolean {
    return (
      !this.fallbackActive &&
      !!this.fallbackModel &&
      this.fallbackModel !== this.primaryModel
    );
  }

  activateForResult(result: string | null): boolean {
    if (!this.canActivateFallback || !isProviderLimitNotice(result)) {
      return false;
    }
    this.fallbackActive = true;
    return true;
  }
}

export interface ProviderFallbackRetryTurn {
  prompt: string;
  images?: Array<{ data: string; mimeType?: string }>;
  ipcMessages: IpcInputMessage[];
  laterIpcMessages: IpcInputMessage[];
  turnId?: string;
  sessionIdBeforeTurn?: string;
  resumeAt?: string;
}

function inputFromMessages(messages: IpcInputMessage[]): {
  prompt: string;
  images?: Array<{ data: string; mimeType?: string }>;
} {
  const images = messages.flatMap((message) => message.images || []);
  return {
    prompt: messages.map((message) => message.text).join('\n'),
    images: images.length > 0 ? images : undefined,
  };
}

/**
 * Tracks the exact input and transcript anchor of the SDK turn that will
 * complete next. It deliberately does not own receipt completion; the existing
 * IpcTurnDeliveryTracker remains the single authority for ACK semantics.
 */
export class ProviderFallbackTurnLedger {
  private current: {
    prompt: string;
    images?: Array<{ data: string; mimeType?: string }>;
    sessionIdBeforeTurn?: string;
    resumeAt?: string;
  };
  private nextSessionId?: string;
  private nextResumeAt?: string;

  constructor(input: {
    prompt: string;
    images?: Array<{ data: string; mimeType?: string }>;
    sessionId?: string;
    resumeAt?: string;
  }) {
    this.current = {
      prompt: input.prompt,
      images: input.images,
      sessionIdBeforeTurn: input.sessionId,
      resumeAt: input.resumeAt,
    };
    this.nextSessionId = input.sessionId;
    this.nextResumeAt = input.resumeAt;
  }

  /** Call when an idle stream accepts the first message of its next turn. */
  acceptCurrentTurn(messages: IpcInputMessage[]): void {
    this.current = {
      ...inputFromMessages(messages),
      sessionIdBeforeTurn: this.nextSessionId,
      resumeAt: this.nextResumeAt,
    };
  }

  /** Advance the transcript anchor after one healthy SDK result. */
  completeHealthyTurn(input: {
    sessionId?: string;
    resumeAt?: string;
    nextTurnMessages: IpcInputMessage[];
  }): void {
    this.nextSessionId = input.sessionId;
    this.nextResumeAt = input.resumeAt || this.nextResumeAt;
    if (input.nextTurnMessages.length > 0) {
      this.acceptCurrentTurn(input.nextTurnMessages);
    }
  }

  snapshotFailure(input: {
    ipcMessages: IpcInputMessage[];
    laterIpcMessages: IpcInputMessage[];
    turnId?: string;
  }): ProviderFallbackRetryTurn {
    return {
      ...this.current,
      ipcMessages: [...input.ipcMessages],
      laterIpcMessages: [...input.laterIpcMessages],
      turnId: input.turnId,
    };
  }
}
