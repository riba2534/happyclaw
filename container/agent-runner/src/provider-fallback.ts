import type {
  SDKAssistantMessageError,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';
import type { IpcInputMessage } from './ipc-delivery.js';

export type ProviderLimitScope = 'account' | 'model';

export type ProviderRateLimitType = NonNullable<
  SDKRateLimitInfo['rateLimitType']
>;

const MODEL_LIMIT_LABELS = new Set(['opus', 'sonnet', 'fable 5']);
const ACCOUNT_LIMIT_LABELS = new Set([
  '',
  'session',
  'weekly',
  'usage',
  'monthly spend',
  'org monthly',
  'organization monthly',
]);

/**
 * `seven_day_overage_included` is the rateLimitType emitted by current Claude
 * Code for the Fable 5 model-specific limit. It therefore belongs with the
 * explicit Opus/Sonnet model limits: callers may switch models, but must not
 * quarantine the whole OAuth profile.
 */
export function classifyProviderRateLimitType(
  rateLimitType: ProviderRateLimitType | undefined,
): ProviderLimitScope {
  switch (rateLimitType) {
    case 'seven_day_opus':
    case 'seven_day_sonnet':
    case 'seven_day_overage_included':
      return 'model';
    case 'five_hour':
    case 'seven_day':
    case 'overage':
    default:
      // A rejected structured event is authoritative even when an older SDK
      // omits the type. Unknown/absent types must fail safe as account-wide.
      return 'account';
  }
}

function hasKnownNoticeTail(tail: string): boolean {
  const normalized = tail.trim();
  if (!normalized || /^[.!]$/.test(normalized)) return true;
  if (/^[.!]?\s*\/model\s+to\s+switch\s+models?[.!]?$/i.test(normalized)) {
    return true;
  }
  return /^[.!]?\s*(?:[·•—–-]\s*)?resets?\b.{0,160}$/i.test(normalized);
}

/**
 * Text fallback for older Claude Code versions which do not expose
 * `rate_limit_event`. The banner must begin with a known Claude phrase and
 * use an explicit account/model label. Arbitrary qualifiers are intentionally
 * rejected: short normal replies such as "You've reached your storage limit"
 * must never change provider health.
 */
export function classifyProviderLimitNotice(
  result: string | null,
): ProviderLimitScope | null {
  if (!result) return null;
  const normalized = result.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 400) return null;

  const direct = normalized.match(
    /^you(?:'ve| have)\s+(?:hit|reached)\s+your(?:\s+(session|weekly|usage|monthly\s+spend|org\s+monthly|organization\s+monthly|opus|sonnet|fable\s+5))?\s+limit\b(.*)$/i,
  );
  if (direct && hasKnownNoticeTail(direct[2] ?? '')) {
    const label = (direct[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
    if (MODEL_LIMIT_LABELS.has(label)) return 'model';
    if (ACCOUNT_LIMIT_LABELS.has(label)) return 'account';
  }

  if (/^you(?:'re| are)\s+out\s+of\s+extra\s+usage\b(.*)$/i.test(normalized)) {
    const tail = normalized.replace(
      /^you(?:'re| are)\s+out\s+of\s+extra\s+usage\b/i,
      '',
    );
    return hasKnownNoticeTail(tail) ? 'account' : null;
  }
  if (
    /^(?:claude\s+)?usage\s+limit\s+reached\b(?:[.!]?\s+your\s+(?:usage\s+)?limit\s+will\s+reset(?:\s+at)?\b.{0,160})?[.!]?$/i.test(
      normalized,
    )
  ) {
    return 'account';
  }
  if (
    /^upgrade\s+to\s+(?:increase|raise)\s+your\s+usage\s+limit\b(.*)$/i.test(
      normalized,
    )
  ) {
    const tail = normalized.replace(
      /^upgrade\s+to\s+(?:increase|raise)\s+your\s+usage\s+limit\b/i,
      '',
    );
    return hasKnownNoticeTail(tail) ? 'account' : null;
  }
  if (
    /^your\s+(?:usage\s+)?limit\s+will\s+reset(?:\s+at)?\b.{0,160}$/i.test(
      normalized,
    )
  ) {
    return 'account';
  }
  return null;
}

export type ProviderLimitAction =
  | 'none'
  | 'provider_failure'
  | 'model_fallback'
  | 'surface_result';

/**
 * Resolve one SDK result using a structured rejection when present. Keeping
 * this policy pure makes the two safety properties explicit and testable:
 * unknown account banners still quarantine the account, while a model wall
 * with no configured fallback remains visible to the user.
 */
export function decideProviderLimitAction(input: {
  structuredRejection?: { rateLimitType?: ProviderRateLimitType };
  result: string | null;
  canFallback: boolean;
}): { scope: ProviderLimitScope | null; action: ProviderLimitAction } {
  const scope = input.structuredRejection
    ? classifyProviderRateLimitType(input.structuredRejection.rateLimitType)
    : classifyProviderLimitNotice(input.result);
  if (scope === 'account') {
    return { scope, action: 'provider_failure' };
  }
  if (scope === 'model') {
    return {
      scope,
      action: input.canFallback ? 'model_fallback' : 'surface_result',
    };
  }
  return { scope: null, action: 'none' };
}

/** Keep this deliberately strict; a match triggers a transparent model retry. */
export function isProviderLimitNotice(result: string | null): boolean {
  return classifyProviderLimitNotice(result) !== null;
}

const ACCOUNT_PROVIDER_ASSISTANT_ERRORS = new Set<SDKAssistantMessageError>([
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'rate_limit',
  'overloaded',
  'model_not_found',
  'server_error',
]);

/**
 * Third-party Anthropic-compatible endpoints can emit an AssistantMessage
 * carrying `error` without ever following it with rate_limit_event/result.
 * Treat provider/account failures as terminal control-plane signals instead of
 * waiting indefinitely for a Result that may never arrive.
 */
export function isAccountProviderAssistantError(
  error: SDKAssistantMessageError | undefined,
): error is SDKAssistantMessageError {
  return !!error && ACCOUNT_PROVIDER_ASSISTANT_ERRORS.has(error);
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

  activateForScope(scope: ProviderLimitScope): boolean {
    if (scope !== 'model' || !this.canActivateFallback) {
      return false;
    }
    this.fallbackActive = true;
    return true;
  }

  activateForResult(result: string | null): boolean {
    const scope = classifyProviderLimitNotice(result);
    return scope !== null && this.activateForScope(scope);
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
