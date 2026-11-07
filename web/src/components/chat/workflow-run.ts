import type { StreamingTaskRuntimeState } from '../../stores/chat';
import type { WorkflowRunSnapshot } from '../../stream-event.types';

/** A sub-agent task that is a dynamic Workflow, shown as its own card. */
export function isWorkflowTask(task: StreamingTaskRuntimeState): boolean {
  return !!task.workflowRun || task.taskType === 'local_workflow';
}

/** The Workflow card's data for a task: its snapshot, or one made of its state. */
export function workflowRunOf(
  task: StreamingTaskRuntimeState,
): WorkflowRunSnapshot {
  return (
    task.workflowRun ?? {
      taskId: task.id,
      workflowName: task.workflowName,
      summary: task.title,
      status:
        task.status === 'completed'
          ? 'completed'
          : task.status === 'error'
            ? 'failed'
            : task.status === 'stopped'
              ? 'stopped'
              : 'running',
      durationMs: task.usage?.durationMs,
      totalTokens: task.usage?.totalTokens,
      totalToolCalls: task.usage?.toolUses,
      phases: [],
      agents: [],
    }
  );
}
