import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  TaskBudgetConfig,
  TaskBudgetSnapshot,
  BudgetExceededReason,
} from './types.js';

export interface RunnerBudgetOptions {
  runId: string;
  parentRunId?: string | null;
  config?: TaskBudgetConfig | null;
  initialUsage?: {
    currentDurationMs?: number;
    currentToolCalls?: number;
    currentCostUsd?: number;
    retryCount?: number;
  };
  onExceeded?: (
    reason: BudgetExceededReason,
    snapshot: TaskBudgetSnapshot,
  ) => void;
  checkToolCallHandler?: (
    toolName: string,
    agentId?: string,
  ) => Promise<{ allowed: boolean; reason?: string; message?: string }>;
}

export class RunnerBudgetTracker {
  private runId: string;
  private parentRunId: string | null;
  private config: TaskBudgetConfig | null;
  private currentDurationMs: number;
  private currentToolCalls: number;
  private currentCostUsd: number;
  private retryCount: number;
  private status: 'active' | 'exceeded' | 'completed' | 'cancelled';
  private exceededReason: BudgetExceededReason | null;
  private partialResult: string | null = null;
  private startedAt: number;
  private durationTimer: NodeJS.Timeout | null = null;
  private activeInputId: string | null = null;
  private seenUsageEventIds = new Set<string>();
  private checkToolCallHandler?: (
    toolName: string,
    agentId?: string,
  ) => Promise<{ allowed: boolean; reason?: string; message?: string }>;
  private onExceededCallback?: (
    reason: BudgetExceededReason,
    snapshot: TaskBudgetSnapshot,
  ) => void;

  constructor(options: RunnerBudgetOptions) {
    this.runId = options.runId;
    this.activeInputId = options.runId;
    this.parentRunId = options.parentRunId ?? null;
    this.config = options.config ?? null;
    this.currentDurationMs = options.initialUsage?.currentDurationMs ?? 0;
    this.currentToolCalls = options.initialUsage?.currentToolCalls ?? 0;
    this.currentCostUsd = options.initialUsage?.currentCostUsd ?? 0;
    this.retryCount = options.initialUsage?.retryCount ?? 0;
    this.status = 'active';
    this.exceededReason = null;
    this.startedAt = Date.now();
    this.onExceededCallback = options.onExceeded;
    this.checkToolCallHandler = options.checkToolCallHandler;

    this.armDurationTimer();
  }

  public getRunId(): string {
    return this.runId;
  }

  public getParentRunId(): string | null {
    return this.parentRunId;
  }

  public getConfig(): TaskBudgetConfig | null {
    return this.config;
  }

  public getSnapshot(partialResult?: string | null): TaskBudgetSnapshot {
    const elapsed = Math.max(0, Date.now() - this.startedAt);
    return {
      runId: this.runId,
      configured: Boolean(
        this.config &&
        (this.config.maxDurationMs != null ||
          this.config.maxToolCalls != null ||
          this.config.maxCostUsd != null),
      ),
      maxDurationMs: this.config?.maxDurationMs,
      maxToolCalls: this.config?.maxToolCalls,
      maxCostUsd: this.config?.maxCostUsd,
      currentDurationMs: this.currentDurationMs + elapsed,
      currentToolCalls: this.currentToolCalls,
      currentCostUsd: this.currentCostUsd,
      retryCount: this.retryCount,
      status: this.status,
      exceededReason: this.exceededReason,
      partialResult: partialResult ?? this.partialResult,
    };
  }

  public isExceeded(): boolean {
    return this.status === 'exceeded';
  }

  public getExceededReason(): BudgetExceededReason | null {
    return this.exceededReason;
  }

  public getPartialResult(): string | null {
    return this.partialResult;
  }

  public setPartialResult(result: string | null): void {
    this.partialResult = result;
  }

  private armDurationTimer(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }

    if (
      this.config?.maxDurationMs != null &&
      this.config.maxDurationMs > 0 &&
      this.status === 'active'
    ) {
      const remainingMs = Math.max(
        0,
        this.config.maxDurationMs - this.currentDurationMs,
      );
      this.durationTimer = setTimeout(() => {
        this.triggerExceeded('duration');
      }, remainingMs);
    }
  }

  public triggerExceeded(
    reason: BudgetExceededReason,
    partialResult?: string | null,
  ): void {
    if (this.status === 'exceeded') return;
    this.status = 'exceeded';
    this.exceededReason = reason;
    if (partialResult !== undefined) {
      this.partialResult = partialResult;
    }
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.onExceededCallback) {
      this.onExceededCallback(reason, this.getSnapshot(partialResult));
    }
  }

  public setCheckToolCallHandler(
    handler: (
      toolName: string,
      agentId?: string,
    ) => Promise<{ allowed: boolean; reason?: string; message?: string }>,
  ): void {
    this.checkToolCallHandler = handler;
  }

  public async checkToolCall(
    toolName: string,
    agentId?: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (this.status !== 'active') {
      return {
        allowed: false,
        reason: `Task budget already exceeded (${this.exceededReason}); tool execution stopped`,
      };
    }

    if (this.checkToolCallHandler) {
      try {
        const check = await this.checkToolCallHandler(toolName, agentId);
        if (!check.allowed) {
          const reason = (check.reason as BudgetExceededReason) || 'tool_calls';
          this.triggerExceeded(reason);
          return {
            allowed: false,
            reason:
              check.message ||
              check.reason ||
              `Task or ancestor budget exceeded (${reason}); tool execution stopped`,
          };
        }
        this.currentToolCalls++;
        return { allowed: true };
      } catch {
        // Fall back to local check if remote IPC call is unavailable
      }
    }

    return this.checkToolCallLocal(toolName, agentId);
  }

  public checkToolCallLocal(
    _toolName: string,
    _agentId?: string,
  ): { allowed: boolean; reason?: string } {
    if (this.status !== 'active') {
      return {
        allowed: false,
        reason: `Task budget already exceeded (${this.exceededReason}); tool execution stopped`,
      };
    }

    if (
      this.config?.maxToolCalls != null &&
      this.currentToolCalls >= this.config.maxToolCalls
    ) {
      this.triggerExceeded('tool_calls');
      return {
        allowed: false,
        reason: `Task budget exceeded: tool calls limit reached (${this.config.maxToolCalls}); tool execution stopped`,
      };
    }

    // Increment local consumption
    this.currentToolCalls++;
    return { allowed: true };
  }

  public recordUsageCost(costUsd: number): void {
    if (costUsd <= 0) return;
    this.currentCostUsd += costUsd;
    if (
      this.config?.maxCostUsd != null &&
      this.currentCostUsd >= this.config.maxCostUsd
    ) {
      this.triggerExceeded('cost');
    }
  }

  public syncFinalCost(finalCostUsd: number): void {
    if (finalCostUsd > this.currentCostUsd) {
      this.currentCostUsd = finalCostUsd;
    }
    if (
      this.config?.maxCostUsd != null &&
      this.currentCostUsd >= this.config.maxCostUsd
    ) {
      this.triggerExceeded('cost');
    }
  }

  /**
   * Records incremental usage event idempotently. If the new usage causes total cost
   * to reach or exceed the estimated limit, triggers exceeded status immediately.
   */
  public recordIncrementalUsage(
    eventId: string,
    estimatedCostUsd: number,
  ): boolean {
    if (this.seenUsageEventIds.has(eventId)) {
      return false; // Idempotency check: do not double-count replayed events
    }
    this.seenUsageEventIds.add(eventId);
    if (estimatedCostUsd <= 0) return false;
    this.currentCostUsd += estimatedCostUsd;
    if (
      this.config?.maxCostUsd != null &&
      this.currentCostUsd >= this.config.maxCostUsd
    ) {
      this.triggerExceeded('cost');
      return true;
    }
    return false;
  }

  public recordRetry(): void {
    this.retryCount++;
  }

  public recordSubagentToolCall(): void {
    // Parent and subagents share the same tool calls budget!
    this.currentToolCalls++;
    if (
      this.config?.maxToolCalls != null &&
      this.currentToolCalls >= this.config.maxToolCalls
    ) {
      this.triggerExceeded('tool_calls');
    }
  }

  /**
   * Safely switches the tracker to a new input turn.
   * Only resets when the logical input ID actually changes, preserving
   * accumulated usage during retries or within the same turn.
   */
  public switchInputTurn(
    newInputId: string,
    newConfig?: TaskBudgetConfig | null,
    parentRunId?: string | null,
  ): boolean {
    if (this.activeInputId === newInputId) {
      return false; // Same input: do not reset
    }
    this.activeInputId = newInputId;
    this.seenUsageEventIds.clear();
    this.resetForNextInput(newInputId, newConfig, parentRunId);
    return true;
  }

  public resetForNextInput(
    newRunId: string,
    newConfig?: TaskBudgetConfig | null,
    parentRunId?: string | null,
  ): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    this.runId = newRunId;
    this.activeInputId = newRunId;
    this.parentRunId = parentRunId ?? null;
    this.config = newConfig ?? null;
    this.currentDurationMs = 0;
    this.currentToolCalls = 0;
    this.currentCostUsd = 0;
    this.retryCount = 0;
    this.status = 'active';
    this.exceededReason = null;
    this.partialResult = null;
    this.startedAt = Date.now();
    this.armDurationTimer();
  }

  public createPreToolUseHook(): HookCallback {
    return async (input) => {
      const preTool = input as PreToolUseHookInput;
      if (preTool.hook_event_name === 'PreToolUse') {
        const check = await this.checkToolCall(
          preTool.tool_name,
          preTool.agent_id,
        );
        if (!check.allowed) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: check.reason,
            },
          };
        }
      }
      return {};
    };
  }

  public dispose(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
  }
}
