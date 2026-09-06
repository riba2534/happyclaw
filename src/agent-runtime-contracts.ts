import type {
  MessageSourceKind,
  StreamEvent,
  TaskBudgetSnapshot,
} from './types.js';

/**
 * One passive SDK rate-limit observation. SDK `utilization` is a 0..1
 * fraction; OAuth `/usage` buckets use 0..100 and intentionally live in a
 * separate response field.
 */
export interface ProviderQuotaObservation {
  source: 'sdk_rate_limit_event';
  /** Event observation time, Unix epoch milliseconds. */
  observedAt: number;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string;
  utilization?: number;
  /** Anthropic unified-header reset time, Unix epoch seconds. */
  resetsAt?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  /** Anthropic overage reset time, Unix epoch seconds. */
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
  surpassedThreshold?: number;
  errorCode?: string;
  canUserPurchaseCredits?: boolean;
  hasChargeableSavedPaymentMethod?: boolean;
}

/** Framed host/runner output shared without coupling the parser to a launcher. */
export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  proactiveFinalCandidate?: string;
  newSessionId?: string;
  error?: string;
  providerFailure?: boolean;
  /** Control-plane only; consumed by the host and never projected to chat. */
  providerQuotaObservation?: ProviderQuotaObservation;
  providerRateLimitResetsAt?: number;
  providerFailureNotice?: string;
  providerRateLimitScope?: 'account' | 'model';
  providerRateLimitModel?: string;
  providerFailureClass?: 'account' | 'transient' | 'config';
  providerFailureTerminal?: boolean;
  providerFailureRetrying?: boolean;
  providerFailureMaintenance?: boolean;
  providerLivenessTimeout?: boolean;
  streamEvent?: StreamEvent;
  readonly inputTurnId?: string;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  finalizationReason?:
    | 'completed'
    | 'interrupted'
    | 'error'
    | 'truncated'
    | 'budget_exceeded';
  budgetExceeded?: boolean;
  budgetSnapshot?: TaskBudgetSnapshot;
  pendingBgTasks?: number;
  inputTurnCompleted?: boolean;
  queryIdle?: boolean;
  ipcReceipts?: RuntimeIpcReceipt[];
  activeIpcReceipts?: RuntimeIpcReceipt[];
}

export interface RuntimeIpcReceipt {
  deliveryId: string;
  chatJid: string;
  coveredCursors?: RuntimeIpcCursor[];
  cursor: RuntimeIpcCursor;
}

export interface RuntimeIpcCursor {
  timestamp: string;
  id: string;
  sequence?: number;
  sourceJid?: string;
}
