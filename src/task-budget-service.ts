import { logger } from './logger.js';
import {
  createTaskBudget,
  getTaskBudget,
  getTaskBudgetStatus,
  updateTaskBudgetUsage,
  resumeTaskBudget as dbResumeTaskBudget,
} from './db.js';
import type {
  TaskBudgetConfig,
  TaskBudgetRecord,
  TaskBudgetStatus,
  BudgetExceededReason,
} from './types.js';
import type { TaskBudgetSnapshot } from './stream-event.types.js';

export interface InitBudgetOptions {
  runId: string;
  parentRunId?: string | null;
  taskId?: string | null;
  chatJid?: string | null;
  groupFolder?: string | null;
  userId?: string | null;
  config?: TaskBudgetConfig | null;
}

export class TaskBudgetService {
  /**
   * Initializes or recovers the budget record for a logical run identity.
   * If a record already exists in the persistent store (e.g. after server restart),
   * it is recovered with its current consumption intact.
   */
  public initBudget(options: InitBudgetOptions): TaskBudgetRecord {
    const existing = getTaskBudget(options.runId);
    if (existing) {
      logger.info(
        {
          runId: options.runId,
          parentRunId: existing.parent_run_id,
          status: existing.status,
          currentToolCalls: existing.current_tool_calls,
          currentDurationMs: existing.current_duration_ms,
          currentCostUsd: existing.current_cost_usd,
        },
        'Recovered existing task budget from persistent store',
      );
      return existing;
    }

    const now = new Date().toISOString();
    const config = options.config;
    const record: TaskBudgetRecord = {
      run_id: options.runId,
      parent_run_id: options.parentRunId ?? null,
      task_id: options.taskId ?? null,
      chat_jid: options.chatJid ?? null,
      group_folder: options.groupFolder ?? null,
      user_id: options.userId ?? null,
      max_duration_ms:
        config?.maxDurationMs != null && config.maxDurationMs > 0
          ? config.maxDurationMs
          : null,
      max_tool_calls:
        config?.maxToolCalls != null && config.maxToolCalls > 0
          ? config.maxToolCalls
          : null,
      max_cost_usd:
        config?.maxCostUsd != null && config.maxCostUsd > 0
          ? config.maxCostUsd
          : null,
      current_duration_ms: 0,
      current_tool_calls: 0,
      current_cost_usd: 0,
      retry_count: 0,
      status: 'active',
      exceeded_reason: null,
      partial_result: null,
      resumed_at: null,
      created_at: now,
      updated_at: now,
    };

    createTaskBudget(record);
    return record;
  }

  /**
   * Evaluates whether a tool call can proceed under the budget limits.
   * If allowed, atomically increments tool call consumption for this run
   * and any parent run.
   */
  public checkAndConsumeToolCall(
    runId: string,
    toolName: string,
  ): {
    allowed: boolean;
    status: TaskBudgetStatus;
    reason?: BudgetExceededReason;
    message?: string;
  } {
    const current = getTaskBudget(runId);
    if (!current) {
      return {
        allowed: true,
        status: {
          runId,
          configured: false,
          currentDurationMs: 0,
          currentToolCalls: 0,
          currentCostUsd: 0,
          retryCount: 0,
          status: 'active',
        },
      };
    }

    // If already exceeded or cancelled, block immediately
    if (current.status !== 'active') {
      const status = getTaskBudgetStatus(runId)!;
      return {
        allowed: false,
        status,
        reason: current.exceeded_reason ?? undefined,
        message: `Task budget already exceeded (${current.exceeded_reason ?? current.status}); tool execution blocked`,
      };
    }

    // If parent budget exists, check parent status too
    if (current.parent_run_id) {
      const parent = getTaskBudget(current.parent_run_id);
      if (parent && parent.status !== 'active') {
        const status = getTaskBudgetStatus(runId)!;
        return {
          allowed: false,
          status,
          reason: parent.exceeded_reason ?? undefined,
          message: `Parent task budget exceeded (${parent.exceeded_reason ?? parent.status}); delegated tool execution blocked`,
        };
      }
      if (
        parent &&
        parent.max_tool_calls != null &&
        parent.current_tool_calls >= parent.max_tool_calls
      ) {
        updateTaskBudgetUsage(current.parent_run_id, {
          status: 'exceeded',
          exceededReason: 'tool_calls',
        });
        const status = getTaskBudgetStatus(runId)!;
        return {
          allowed: false,
          status,
          reason: 'tool_calls',
          message: `Parent task budget tool limit (${parent.max_tool_calls}) reached; tool execution blocked`,
        };
      }
    }

    // Check own tool limit
    if (
      current.max_tool_calls != null &&
      current.current_tool_calls >= current.max_tool_calls
    ) {
      updateTaskBudgetUsage(runId, {
        status: 'exceeded',
        exceededReason: 'tool_calls',
      });
      const status = getTaskBudgetStatus(runId)!;
      return {
        allowed: false,
        status,
        reason: 'tool_calls',
        message: `Task budget tool limit (${current.max_tool_calls}) reached; tool execution blocked`,
      };
    }

    // Atomically increment tool call count
    updateTaskBudgetUsage(runId, { toolCallsDelta: 1 });
    const status = getTaskBudgetStatus(runId)!;
    return {
      allowed: true,
      status,
    };
  }

  /**
   * Records incremental usage cost and checks against estimated cost threshold.
   */
  public recordCost(
    runId: string,
    costUsd: number,
  ): {
    exceeded: boolean;
    status: TaskBudgetStatus;
    reason?: BudgetExceededReason;
  } {
    if (costUsd <= 0) {
      const status = getTaskBudgetStatus(runId);
      return {
        exceeded: status?.status === 'exceeded',
        status: status ?? {
          runId,
          configured: false,
          currentDurationMs: 0,
          currentToolCalls: 0,
          currentCostUsd: 0,
          retryCount: 0,
          status: 'active',
        },
      };
    }

    updateTaskBudgetUsage(runId, { costUsdDelta: costUsd });
    const status = getTaskBudgetStatus(runId)!;
    const exceeded = status.status === 'exceeded';
    return {
      exceeded,
      status,
      reason: status.exceededReason ?? undefined,
    };
  }

  /**
   * Records elapsed duration and evaluates duration limits.
   */
  public recordDuration(
    runId: string,
    durationMsDelta: number,
  ): {
    exceeded: boolean;
    status: TaskBudgetStatus;
    reason?: BudgetExceededReason;
  } {
    if (durationMsDelta <= 0) {
      const status = getTaskBudgetStatus(runId);
      return {
        exceeded: status?.status === 'exceeded',
        status: status ?? {
          runId,
          configured: false,
          currentDurationMs: 0,
          currentToolCalls: 0,
          currentCostUsd: 0,
          retryCount: 0,
          status: 'active',
        },
      };
    }

    updateTaskBudgetUsage(runId, {
      durationMsDelta,
    });
    const status = getTaskBudgetStatus(runId)!;
    const exceeded = status.status === 'exceeded';
    return {
      exceeded,
      status,
      reason: status.exceededReason ?? undefined,
    };
  }

  /**
   * Records a Provider retry attempt without resetting cumulative consumption.
   */
  public recordRetry(runId: string): void {
    updateTaskBudgetUsage(runId, { retryIncrement: true });
    logger.debug({ runId }, 'Recorded provider retry for budget accounting');
  }

  /**
   * Marks the run as budget exceeded, stops further execution, and preserves partial results.
   */
  public markExceededAndSavePartial(
    runId: string,
    reason: BudgetExceededReason,
    partialResult?: string | null,
  ): TaskBudgetStatus {
    updateTaskBudgetUsage(runId, {
      status: 'exceeded',
      exceededReason: reason,
      partialResult: partialResult ?? undefined,
    });
    return getTaskBudgetStatus(runId)!;
  }

  /**
   * Completes a task budget run normally.
   */
  public completeBudget(runId: string, finalResult?: string | null): void {
    const current = getTaskBudget(runId);
    if (!current) return;
    if (current.status === 'active') {
      updateTaskBudgetUsage(runId, {
        status: 'completed',
        partialResult: finalResult ?? undefined,
      });
    }
  }

  /**
   * Explicitly resumes an exceeded budget, optionally granting additional quota.
   */
  public resumeBudget(
    runId: string,
    additionalBudget?: TaskBudgetConfig,
  ): TaskBudgetStatus | undefined {
    const resumed = dbResumeTaskBudget(runId, additionalBudget);
    if (!resumed) return undefined;
    logger.info(
      {
        runId,
        newMaxDuration: resumed.max_duration_ms,
        newMaxToolCalls: resumed.max_tool_calls,
        newMaxCost: resumed.max_cost_usd,
      },
      'Resumed task budget with new limits',
    );
    return getTaskBudgetStatus(runId);
  }

  /**
   * Returns current budget status for a run ID.
   */
  public getStatus(runId: string): TaskBudgetStatus | undefined {
    return getTaskBudgetStatus(runId);
  }

  /**
   * Converts a TaskBudgetStatus into a user-facing TaskBudgetSnapshot for stream events.
   */
  public toSnapshot(status: TaskBudgetStatus): TaskBudgetSnapshot {
    return {
      configured: status.configured,
      maxDurationMs: status.maxDurationMs,
      maxToolCalls: status.maxToolCalls,
      maxCostUsd: status.maxCostUsd,
      currentDurationMs: status.currentDurationMs,
      currentToolCalls: status.currentToolCalls,
      currentCostUsd: status.currentCostUsd,
      retryCount: status.retryCount,
      status: status.status,
      exceededReason: status.exceededReason,
      partialResult: status.partialResult,
    };
  }
}

export const taskBudgetService = new TaskBudgetService();
